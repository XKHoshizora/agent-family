import type { ModelCall } from "../../models/gateway.ts";

/**
 * `AgentPort`: the reply worker's whole view of the system (README "Agents and runs"). Everything under
 * `src/agents/runtime/` reaches the database only through it (`tests/agent-port-boundary.test.ts`); its implementation,
 * where the SQL is, lives outside (`src/agents/port-impl.ts`). It is the shape an external Agent's connection would
 * have: read what the Agent may see, post as the Agent, report how a reply ended.
 */

/** A reply run the worker has claimed (it is `running`). */
export interface RunTicket {
  readonly id: string;
  readonly agentId: string;
  readonly ownerId: string;
  readonly conversationId: string;
}

/** A run ready for its model call: the call (everything but its abort signal) and its input size. */
export interface Prepared {
  /** Holds a provider's key in plaintext: hand it to the gateway and nowhere else. */
  readonly call: Omit<ModelCall, "signal">;
  /**
   * Characters of the system text and the turns, images and PDFs at their token estimate: what settlement counts when
   * the upstream reports no usage. A whole number of 0 or more.
   */
  readonly inputChars: number;
}

/**
 * Why a reply failed, as the owner is told (`Run.error`). `busy`: the service's own trouble (the reply could not be
 * started or stored, or it had nothing to answer and no new topic explains why); such a run is charged nothing.
 * `context_too_small`: the model's context, less its output limit and the system text, cannot hold the owner's newest
 * message (or 200 tokens of it); no call is made.
 */
export type RunErrorCode = "provider_rejected" | "provider_unavailable" | "address_not_allowed" | "no_quota" | "busy" | "context_too_small";

/**
 * How a run ends, as the worker saw it. `finish` records what is true under the Agent's lock: a reply that was posted
 * stands (`done`, or `stopped` by its owner), and a run its Agent's pause or delete interrupted is `cancelled` with that
 * reason — the worker cannot tell an owner's stop from a pause, and a refused post looks the same. `cancelled` with no
 * error from `begin`: everything the reply was to answer is before a new topic its owner started.
 */
export type RunEnd =
  | { readonly status: "done" }
  | { readonly status: "stopped" }
  | { readonly status: "cancelled"; readonly error?: "agent_paused" | "agent_deleted" }
  | { readonly status: "failed"; readonly error: RunErrorCode; readonly resetsAt?: string };

/** The provider could not be reached or gave nothing usable (also how a run the previous process left running ends). */
export const UNAVAILABLE: RunEnd = { status: "failed", error: "provider_unavailable" };
/** The service's own trouble: the reply could not be started or stored, or had nothing to answer. Charged nothing. */
export const BUSY: RunEnd = { status: "failed", error: "busy" };
/** No tokens at all: what a run that never called a model, or one recovered at start-up, is settled on. */
export const NOTHING: Readonly<{ inputChars: number; outputChars: number }> = { inputChars: 0, outputChars: 0 };

/**
 * The run is no longer `running`: something else ended it meanwhile — another instance's recovery at its start (a
 * deploy where old and new instances overlap), or the stale-run sweep. `begin` and `post` refuse it so; nothing more of
 * it is called, posted or recorded, and it stays as that recovery recorded it.
 */
export class RunNotRunning extends Error {
  constructor(
    readonly runId: string,
    readonly status: string | null,
  ) {
    super(`run ${runId} is ${status ?? "gone"}, not running`);
    this.name = "RunNotRunning";
  }
}

/** A piece of the reply on its way to the owner's sockets. */
export interface Delta {
  text?: string;
  reasoning?: string;
}

/** What the worker posts as the Agent's message. */
export interface Reply {
  text: string;
  reasoning: string;
  stopped: boolean;
  truncated: boolean;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface AgentPort {
  /** The oldest queued reply whose owner has fewer than `agentMaxConcurrentRuns` running, now `running`; null when none. */
  claimNext(): Promise<RunTicket | null>;
  /**
   * Resolves the model, builds what the model is shown (never no turn at all), admits the call and marks the Agent's
   * read position — or says why the run ends at once; rejects with `RunNotRunning` when the run was ended elsewhere
   * meanwhile. Reading the attachments stops between files once the run should
   * stop (it then ends as `shouldStop` says) and is bounded by the run's time limit (`failed`, `busy`). `closing`
   * aborts when the service is closing: before the call is admitted, `begin` then rejects with its reason and records
   * nothing — the run is still `running`, unadmitted, and the caller ends it (`release`).
   */
  begin(run: RunTicket, closing?: AbortSignal): Promise<Prepared | RunEnd>;
  /**
   * Pushes a piece of the reply to the owner's sockets; nothing is stored. Dropped once the Agent's pause or delete
   * interrupted the run — also a piece that was already waiting to be delivered, whenever it is delivered.
   */
  emit(run: RunTicket, delta: Delta): void;
  /**
   * Posts the reply as the Agent's message: "refused" when the Agent is paused or deleted, or its pause or delete
   * interrupted the run, or the run is no longer running (another instance's recovery ended it; `finish` then leaves it
   * as that recorded it); "empty", storing nothing, when nothing of it is left to show (a reply stopped or cut inside a
   * persona block it never finished, with nothing before it).
   */
  post(run: RunTicket, out: Reply): Promise<"posted" | "refused" | "empty">;
  /**
   * Settles the call and records how the run ended (one transaction), then queues the follow-up for messages that came
   * meanwhile. `usage` is what the upstream reported; with none, `fallback` is what settlement counts.
   */
  finish(run: RunTicket, end: RunEnd, usage: Usage | null, fallback: { inputChars: number; outputChars: number }): Promise<void>;
  /**
   * Ends a run that will not be finished here (the service is closing) exactly as recovery at start-up ends one: its
   * reply posted → `done` (`stopped` when its message says so); interrupted by its Agent's pause or delete →
   * `cancelled`; else `failed`, `provider_unavailable`, retryable — its hold released by a settlement on no tokens, which
   * costs nothing, and the follow-up queued by the one rule. Its owner is told. Nothing when it had ended already.
   * Rejects when that cannot be written: the run then stays `running`, for the stale-run sweep or the next start.
   */
  release(run: RunTicket): Promise<void>;
  /** Whether the run should stop now: its owner asked, or the Agent was paused or deleted. */
  shouldStop(run: RunTicket): boolean;
}

/** `begin`'s answer is a run end rather than a prepared call. */
export function isRunEnd(x: Prepared | RunEnd): x is RunEnd {
  return "status" in x;
}
