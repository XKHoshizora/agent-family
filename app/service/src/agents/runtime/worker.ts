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
/**
 * How long the service's stop gives the runs it was working on to end (their calls abandoned, each ended as recovery
 * would end it, `AgentPort.release`), and the persona drafts under way likewise; what has not ended by then is left
 * `running`, for the stale-run sweep or the next start.
 */
export const SHUTDOWN_GRACE_MS = 5_000;

/** Whether `promise` settled within `ms` (it is not stopped when it did not). */
export async function within(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([promise.then(() => true, () => true), late]);
  } finally {
    clearTimeout(timer);
  }
}

export interface WorkerLog {
  info(details: Record<string, unknown>, msg: string): void;
  error(details: Record<string, unknown>, msg: string): void;
  warn(details: Record<string, unknown>, msg: string): void;
}

export interface WorkerOptions {
  port: AgentPort;
  models: Pick<ModelGateway, "stream">;
  /** A reply still streaming after this long is ended: posted as truncated if it said something, else failed. */
  runTimeoutMs: number;
  /**
   * Replies the background loop runs at once in the whole service (`AGENT_MAX_RUNS_IN_FLIGHT`): each holds its
   * attachments in memory and an outbound call (see the guard's own cap). `runOnce` is not counted against it.
   */
  maxRunsInFlight: number;
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
  /** Whether this worker is working on the run now (from its claim until its `finish` has returned). */
  isWorking(runId: string): boolean;
  /** `runOnce` until nothing is queued (follow-ups included); how many ran. */
  drain(): Promise<number>;
  /**
   * Stops (once; later calls wait for the same stop): no more claims; calls in flight, and replies still reading their
   * attachments, are abandoned without posting or admitting, and each such run is ended here as recovery would end it
   * (`AgentPort.release`); replies already being posted finish. Resolves once nothing runs any more, or after
   * `SHUTDOWN_GRACE_MS` at most: a run whose end could not be written by then (or at all) stays `running`, for the
   * stale-run sweep or the next start.
   */
  stop(): Promise<void>;
}

type Interruption = "stop" | "timeout" | "shutdown";

export function createAgentWorker(opts: WorkerOptions): AgentWorker {
  const { port, models, log, maxRunsInFlight } = opts;
  const inFlight = new Set<Promise<void>>();
  /** Per run being worked on: aborts when the service closes. */
  const shutdowns = new Map<string, AbortController>();
  let started = false;
  let closing = false;
  let pumping: Promise<void> | null = null;
  let stopping: Promise<void> | null = null;
  let again = false;
  let timer: NodeJS.Timeout | null = null;

  async function finish(run: RunTicket, end: RunEnd, usage: Usage | null, fallback: { inputChars: number; outputChars: number }): Promise<void> {
    try {
      await port.finish(run, end, usage, fallback);
    } catch (err) {
      log.error({ err, runId: run.id }, "agent run: could not record how it ended; it stays running until the stale-run sweep or the next start releases it");
    }
  }

  /** The service is closing: the run is ended here, as recovery would end it, instead of being left for the next start. */
  async function release(run: RunTicket): Promise<void> {
    try {
      await port.release(run);
    } catch (err) {
      log.error({ err, runId: run.id }, "agent run: could not be ended as the service closed; it stays running until the stale-run sweep or the next start releases it");
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
    /** Whether the model was called at all: a stop, pause or close before it means no call was made. */
    let opened = false;
    try {
      if (why === null) {
        opened = true;
        for await (const event of models.stream({ ...prepared.call, signal: controller.signal })) {
          if (event.type === "finish") {
            finished = { usage: event.usage, truncated: event.truncated };
            break;
          }
          if (event.type === "tool_call") continue; // the call offers no tools: none comes
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
        // A failure the upstream reported usage for (`thinking_exhausted`: the model did finish) is charged that usage.
        if (err instanceof ModelError && err.usage) finished = { usage: err.usage, truncated: true };
        if (!(err instanceof ModelError)) log.error({ err, runId: run.id }, "agent run: the model call failed unexpectedly");
        // An upstream that refused (429) or failed (5xx) is counted: an operator reads how often from the log.
        const status = err instanceof ModelError ? err.upstreamStatus : undefined;
        if (status !== undefined && (status === 429 || status >= 500)) log.info({ metric: "upstream_refused", status }, "agent run: the upstream refused the call");
      }
    } finally {
      clearInterval(stopCheck);
      clearTimeout(deadline);
      shutdown.removeEventListener("abort", onShutdown);
    }
    return { out, finished, failure, why: why as Interruption | null, opened };
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
      // The service is closing before the call was admitted (nothing was): the run is ended here.
      if (shutdown.aborted) return release(run);
      // Ended elsewhere meanwhile (another instance's recovery, or the stale-run sweep): expected, not an error; `finish`
      // then finds it ended and changes nothing.
      if (err instanceof RunNotRunning) log.warn({ runId: run.id, status: err.status }, "agent run: ended elsewhere before it could start; nothing is called");
      else log.error({ err, runId: run.id }, "agent run: could not start");
      return finish(run, BUSY, null, NOTHING);
    }
    if (isRunEnd(prepared)) return finish(run, prepared, null, NOTHING);

    const { out, finished, failure, why, opened } = await call(run, prepared, shutdown);
    // The service is closing: nothing is posted, and the run is ended here as recovery would end it (no charge).
    if (finished === null && why === "shutdown") {
      out.discard();
      return release(run);
    }
    out.end();

    const usage = finished?.usage ?? null;
    // A call never made (a stop or pause landed between `begin` and it) costs nothing, not even its input.
    const fallback = opened ? { inputChars: prepared.inputChars, outputChars: out.outputChars() } : NOTHING;
    // A failed call is charged only what the upstream reported: what it said is discarded and not counted.
    const failed = (end: RunEnd) => finish(run, end, usage, { ...fallback, outputChars: 0 });
    if (failure !== null) return failed({ status: "failed", error: failure });
    // The upstream ended the stream without its finish (cut off midway).
    if (finished === null && why === null) return failed(UNAVAILABLE);

    const text = cleanModelText(out.text);
    const reasoning = cleanModelText(out.reasoning);
    const said = hasVisibleText(text) || hasVisibleText(reasoning);
    // In a group `post` takes the run's mark out of what is kept of the reply (the port keeps the mark from `begin`), and
    // a reply that was nothing but the mark and labels is then "empty". Nothing of a group's reply was streamed
    // (`AgentPort.emit`).
    if (finished === null && why === "stop") {
      // Stopped by its owner (or by a pause or delete, which `post` and `finish` find out): what was said so far.
      if (!said) return finish(run, { status: "stopped" }, usage, fallback);
      const posted = await post(run, { text, reasoning, stopped: true, truncated: false });
      // All it said was inside a persona block it never finished (in a group, also: it only thought, or said only the
      // mark and labels): as a stop with nothing said.
      if (posted === "empty") return finish(run, { status: "stopped" }, usage, fallback);
      return finish(run, ended(posted, { status: "stopped" }), usage, fallback);
    }
    // A complete answer, or one cut off by the time limit (posted as truncated). Nothing said: failed.
    if (!said) return failed(UNAVAILABLE);
    const posted = await post(run, { text, reasoning, stopped: false, truncated: finished === null || finished.truncated });
    // All it said was inside a persona block that a limit cut off (in a group, also: it only thought, or said only the
    // mark and labels): as an answer that said nothing, failed `provider_unavailable`.
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
    const pump = (async () => {
      try {
        do {
          again = false;
          while (!closing && inFlight.size < maxRunsInFlight) {
            const run = await port.claimNext();
            if (!run) break;
            void track(run);
          }
        } while (again && !closing);
      } catch (err) {
        log.error({ err }, "agent worker: could not claim a reply; trying again shortly");
      }
    })();
    // Cleared once the pump has ended, never before it is set: a pump with every place taken ends without awaiting
    // anything, and a `finally` inside it would run before this assignment and leave the worker stuck for good. A
    // wake-up that came after the pump's last look is answered by a new one.
    pumping = pump.finally(() => {
      pumping = null;
      if (again) wake();
    });
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
    isWorking: (runId) => shutdowns.has(runId),
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
    stop() {
      stopping ??= (async () => {
        closing = true;
        if (timer) clearInterval(timer);
        for (const shutdown of shutdowns.values()) shutdown.abort(new Error("the service is closing"));
        const ended = (async () => {
          await pumping;
          await Promise.all([...inFlight]);
        })();
        if (!(await within(ended, SHUTDOWN_GRACE_MS))) {
          log.warn(
            { runIds: [...shutdowns.keys()] },
            `agent worker: replies not ended within ${SHUTDOWN_GRACE_MS} ms of the stop; they stay running until the stale-run sweep or the next start releases them`,
          );
        }
      })();
      return stopping;
    },
  };
}
