import { ModelError, type ModelGateway } from "../../models/gateway.ts";
import { cleanModelText, hasVisibleText } from "../../schemas.ts";
import { BUSY, isRunEnd, NOTHING, RunNotRunning, UNAVAILABLE, type AgentPort, type Prepared, type Reply, type RunEnd, type RunErrorCode, type RunTicket, type Usage } from "./port.ts";
import { ReplyStream } from "./stream.ts";

/**
 * The reply worker (README "Agents and runs"): claims queued replies, calls the model, streams the reply to the owner
 * and posts it, all through `AgentPort`. It runs in the service's process; it never holds a database transaction open
 * across a model call (begin, post and finish are each their own).
 */

/** How often the worker looks for queued replies besides being woken by a trigger. */
export const POLL_MS = 2_000;
/** How often a reply in flight checks whether it should stop (owner's stop, pause, delete). */
export const STOP_CHECK_MS = 50;
/** Replies in flight at once in the whole service (each holds an outbound call; see the guard's own cap). */
export const MAX_RUNS_IN_FLIGHT = 8;

export interface WorkerLog {
  error(details: Record<string, unknown>, msg: string): void;
  warn(details: Record<string, unknown>, msg: string): void;
}

export interface WorkerOptions {
  port: AgentPort;
  models: Pick<ModelGateway, "stream">;
  /** A reply still streaming after this long is ended: posted as truncated if it said something, else failed. */
  runTimeoutMs: number;
  /** False: no background loop; replies run only through `runOnce` / `drain` (tests drive the worker by hand). */
  background: boolean;
  log: WorkerLog;
}

export interface AgentWorker {
  /** Starts the background loop (when there is one). */
  start(): void;
  /** Looks for queued replies now: a trigger's post-commit signal. */
  wake(): void;
  /** Claims the oldest queued reply and runs it to its end; false when none was queued. */
  runOnce(): Promise<boolean>;
  /** `runOnce` until nothing is queued (follow-ups included); how many ran. */
  drain(): Promise<number>;
  /**
   * Stops: no more claims; calls in flight, and replies still reading their attachments, are abandoned without posting
   * or admitting and their runs left `running` (recovered at the next start); replies already being posted finish.
   * Resolves once nothing runs any more.
   */
  stop(): Promise<void>;
}

type Interruption = "stop" | "timeout" | "shutdown";

export function createAgentWorker(opts: WorkerOptions): AgentWorker {
  const { port, models, log } = opts;
  const inFlight = new Set<Promise<void>>();
  /** Per run being worked on: aborts when the service closes. */
  const shutdowns = new Map<string, AbortController>();
  let started = false;
  let closing = false;
  let pumping: Promise<void> | null = null;
  let again = false;
  let timer: NodeJS.Timeout | null = null;

  async function finish(run: RunTicket, end: RunEnd, usage: Usage | null, fallback: { inputChars: number; outputChars: number }): Promise<void> {
    try {
      await port.finish(run, end, usage, fallback);
    } catch (err) {
      log.error({ err, runId: run.id }, "agent run: could not record how it ended; it stays running until the next start");
    }
  }

  async function post(run: RunTicket, reply: Reply): Promise<"posted" | "refused" | "empty" | "failed"> {
    try {
      return await port.post(run, reply);
    } catch (err) {
      log.error({ err, runId: run.id }, "agent run: could not post the reply");
      return "failed";
    }
  }

  /** The end of a run whose reply was offered to `post`; a reply that could not be stored is our failure, not the provider's. */
  const ended = (posted: "posted" | "refused" | "failed", ok: RunEnd): RunEnd =>
    posted === "posted" ? ok : posted === "refused" ? { status: "cancelled" } : BUSY;

  /** Streams the model's answer to the owner; how the stream ended and what it produced. */
  async function call(run: RunTicket, prepared: Prepared, shutdown: AbortSignal) {
    const controller = new AbortController();
    let why: Interruption | null = null;
    const interrupt = (reason: Interruption): void => {
      if (why !== null) return;
      why = reason;
      controller.abort(new Error(`agent run interrupted: ${reason}`));
    };
    const onShutdown = () => interrupt("shutdown");
    const stopCheck = setInterval(() => port.shouldStop(run) && interrupt("stop"), STOP_CHECK_MS);
    const deadline = setTimeout(() => interrupt("timeout"), opts.runTimeoutMs);
    stopCheck.unref();
    deadline.unref();
    shutdown.addEventListener("abort", onShutdown, { once: true });
    if (shutdown.aborted) interrupt("shutdown");
    if (port.shouldStop(run)) interrupt("stop");

    const out = new ReplyStream((delta) => port.emit(run, delta));
    let finished: { usage: Usage | null; truncated: boolean } | null = null;
    let failure: RunErrorCode | null = null;
    try {
      if (why === null) {
        for await (const event of models.stream({ ...prepared.call, signal: controller.signal })) {
          if (event.type === "finish") {
            finished = { usage: event.usage, truncated: event.truncated };
            break;
          }
          out.add(event.type, event.delta);
          if (port.shouldStop(run)) {
            interrupt("stop");
            break;
          }
        }
      }
    } catch (err) {
      if (why === null) {
        failure = err instanceof ModelError ? err.code : "provider_unavailable";
        if (!(err instanceof ModelError)) log.error({ err, runId: run.id }, "agent run: the model call failed unexpectedly");
      }
    } finally {
      clearInterval(stopCheck);
      clearTimeout(deadline);
      shutdown.removeEventListener("abort", onShutdown);
    }
    return { out, finished, failure, why: why as Interruption | null };
  }

  async function execute(run: RunTicket): Promise<void> {
    const shutdown = new AbortController();
    shutdowns.set(run.id, shutdown);
    if (closing) shutdown.abort(new Error("the service is closing"));
    try {
      await work(run, shutdown.signal);
    } finally {
      shutdowns.delete(run.id);
    }
  }

  async function work(run: RunTicket, shutdown: AbortSignal): Promise<void> {
    let prepared: Prepared | RunEnd;
    try {
      prepared = await port.begin(run, shutdown);
    } catch (err) {
      // The service is closing before the call was admitted: the run stays running, to be recovered at the next start.
      if (shutdown.aborted) return;
      // Ended elsewhere meanwhile (another instance's recovery, or the stale-run sweep): expected, not an error; `finish`
      // then finds it ended and changes nothing.
      if (err instanceof RunNotRunning) log.warn({ runId: run.id, status: err.status }, "agent run: ended elsewhere before it could start; nothing is called");
      else log.error({ err, runId: run.id }, "agent run: could not start");
      return finish(run, BUSY, null, NOTHING);
    }
    if (isRunEnd(prepared)) return finish(run, prepared, null, NOTHING);

    const { out, finished, failure, why } = await call(run, prepared, shutdown);
    // The service is closing: nothing is posted and the run stays running, to be recovered at the next start.
    if (finished === null && why === "shutdown") return out.discard();
    out.end();

    const usage = finished?.usage ?? null;
    const fallback = { inputChars: prepared.inputChars, outputChars: out.outputChars() };
    // A failed call is charged only what the upstream reported: what it said is discarded and not counted.
    const failed = (end: RunEnd) => finish(run, end, usage, { ...fallback, outputChars: 0 });
    if (failure !== null) return failed({ status: "failed", error: failure });
    // The upstream ended the stream without its finish (cut off midway).
    if (finished === null && why === null) return failed(UNAVAILABLE);

    const text = cleanModelText(out.text);
    const reasoning = cleanModelText(out.reasoning);
    const said = hasVisibleText(text) || hasVisibleText(reasoning);
    if (finished === null && why === "stop") {
      // Stopped by its owner (or by a pause or delete, which `post` and `finish` find out): what was said so far.
      if (!said) return finish(run, { status: "stopped" }, usage, fallback);
      const posted = await post(run, { text, reasoning, stopped: true, truncated: false });
      // All it said was inside a persona block it never finished: as a stop with nothing said.
      if (posted === "empty") return finish(run, { status: "stopped" }, usage, fallback);
      return finish(run, ended(posted, { status: "stopped" }), usage, fallback);
    }
    // A complete answer, or one cut off by the time limit (posted as truncated). Nothing said: failed.
    if (!said) return failed(UNAVAILABLE);
    const posted = await post(run, { text, reasoning, stopped: false, truncated: finished === null || finished.truncated });
    // All it said was inside a persona block that a limit cut off: as an answer that said nothing.
    if (posted === "empty") return failed(UNAVAILABLE);
    return finish(run, ended(posted, { status: "done" }), usage, fallback);
  }

  function track(run: RunTicket): Promise<void> {
    const running = execute(run).catch((err: unknown) => log.error({ err, runId: run.id }, "agent run failed"));
    inFlight.add(running);
    void running.then(() => {
      inFlight.delete(running);
      wake(); // its follow-up, or a reply that waited for a free place
    });
    return running;
  }

  function wake(): void {
    if (!opts.background || !started || closing) return;
    if (pumping) {
      again = true;
      return;
    }
    pumping = (async () => {
      try {
        do {
          again = false;
          while (!closing && inFlight.size < MAX_RUNS_IN_FLIGHT) {
            const run = await port.claimNext();
            if (!run) break;
            void track(run);
          }
        } while (again && !closing);
      } catch (err) {
        log.error({ err }, "agent worker: could not claim a reply; trying again shortly");
      } finally {
        pumping = null;
      }
    })();
  }

  return {
    start() {
      if (started || closing) return;
      started = true;
      if (!opts.background) return;
      timer = setInterval(wake, POLL_MS);
      timer.unref();
      wake();
    },
    wake,
    async runOnce() {
      if (closing) return false;
      const run = await port.claimNext();
      if (!run) return false;
      await track(run);
      return true;
    },
    async drain() {
      let n = 0;
      while (await this.runOnce()) n++;
      return n;
    },
    async stop() {
      closing = true;
      if (timer) clearInterval(timer);
      for (const shutdown of shutdowns.values()) shutdown.abort(new Error("the service is closing"));
      await pumping;
      await Promise.all([...inFlight]);
    },
  };
}
