import { ModelError, type ModelGateway } from "../../models/gateway.ts";
import { cleanModelText, hasVisibleText } from "../../schemas.ts";
import { isRunEnd, type AgentPort, type Prepared, type Reply, type RunEnd, type RunErrorCode, type RunTicket, type Usage } from "./port.ts";
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
   * Stops: no more claims; calls in flight are abandoned without posting and their runs left `running` (recovered at
   * the next start); replies already being posted finish. Resolves once nothing runs any more.
   */
  stop(): Promise<void>;
}

type Interruption = "stop" | "timeout" | "shutdown";

const NO_OUTPUT = { inputChars: 0, outputChars: 0 };
const UNAVAILABLE: RunEnd = { status: "failed", error: "provider_unavailable" };

export function createAgentWorker(opts: WorkerOptions): AgentWorker {
  const { port, models, log } = opts;
  const inFlight = new Set<Promise<void>>();
  const shutdowns = new Map<string, () => void>();
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

  async function post(run: RunTicket, reply: Reply): Promise<"posted" | "refused" | "failed"> {
    try {
      return await port.post(run, reply);
    } catch (err) {
      log.error({ err, runId: run.id }, "agent run: could not post the reply");
      return "failed";
    }
  }

  /** The end of a run whose reply was offered to `post`. */
  const ended = (posted: "posted" | "refused" | "failed", ok: RunEnd): RunEnd =>
    posted === "posted" ? ok : posted === "refused" ? { status: "cancelled" } : UNAVAILABLE;

  /** Streams the model's answer to the owner; how the stream ended and what it produced. */
  async function call(run: RunTicket, prepared: Prepared) {
    const controller = new AbortController();
    let why: Interruption | null = null;
    const interrupt = (reason: Interruption): void => {
      if (why !== null) return;
      why = reason;
      controller.abort(new Error(`agent run interrupted: ${reason}`));
    };
    const stopCheck = setInterval(() => port.shouldStop(run) && interrupt("stop"), STOP_CHECK_MS);
    const deadline = setTimeout(() => interrupt("timeout"), opts.runTimeoutMs);
    stopCheck.unref();
    deadline.unref();
    shutdowns.set(run.id, () => interrupt("shutdown"));
    if (closing) interrupt("shutdown");
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
      shutdowns.delete(run.id);
    }
    return { out, finished, failure, why: why as Interruption | null };
  }

  async function execute(run: RunTicket): Promise<void> {
    let prepared: Prepared | RunEnd;
    try {
      prepared = await port.begin(run);
    } catch (err) {
      log.error({ err, runId: run.id }, "agent run: could not start");
      return finish(run, UNAVAILABLE, null, NO_OUTPUT);
    }
    if (isRunEnd(prepared)) return finish(run, prepared, null, NO_OUTPUT);

    const { out, finished, failure, why } = await call(run, prepared);
    // The service is closing: nothing is posted and the run stays running, to be recovered at the next start.
    if (finished === null && why === "shutdown") return out.discard();
    out.flush();

    const usage = finished?.usage ?? null;
    const fallback = { inputChars: prepared.inputChars, outputChars: out.outputChars() };
    if (failure !== null) return finish(run, { status: "failed", error: failure }, usage, fallback);

    const text = cleanModelText(out.text);
    const reasoning = cleanModelText(out.reasoning);
    const said = hasVisibleText(text) || hasVisibleText(reasoning);
    if (finished === null && why === "stop") {
      // Stopped by its owner (or by a pause or delete, which `post` and `finish` find out): what was said so far.
      if (!said) return finish(run, { status: "stopped" }, usage, fallback);
      const posted = await post(run, { text, reasoning, stopped: true, truncated: false });
      return finish(run, ended(posted, { status: "stopped" }), usage, fallback);
    }
    // A complete answer, or one cut off by the time limit. Nothing said, or a stream that ended without its finish: failed.
    if (!said || (finished === null && why !== "timeout")) return finish(run, UNAVAILABLE, usage, fallback);
    const posted = await post(run, { text, reasoning, stopped: false, truncated: finished === null || finished.truncated });
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
      for (const interrupt of shutdowns.values()) interrupt();
      await pumping;
      await Promise.all([...inFlight]);
    },
  };
}
