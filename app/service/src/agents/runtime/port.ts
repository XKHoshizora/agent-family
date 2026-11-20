import type { ModelCall, ToolCall, ToolSpec } from "../../models/gateway.ts";

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
  /** The run's own conversation (`agent_runs.conversation_id`), not necessarily the Agent's dedicated one. */
  readonly conversationId: string;
}

/** A run ready for its model call: the call (everything but its abort signal), its input size, and the tools it offers. */
export interface Prepared {
  /** Holds a provider's key in plaintext: hand it to the gateway and nowhere else. Never carries `tools` itself. */
  readonly call: Omit<ModelCall, "signal">;
  /**
   * The call's input estimate: the system text and the turns in weight, corrected by the model's learned ratio, images
   * and PDFs at their constants (metering/tokens.ts) — what settlement counts when the upstream reports no usage (and
   * charges at most what admission held, the input's bound: `holdTokens`). A whole number of 0 or more. Without the
   * tools' definitions and the rounds: a reply that offers tools adds those per round (worker.ts).
   */
  readonly inputChars: number;
  /**
   * The tools the model is offered. Empty: none — the reply is exactly one call, as before tools existed, and `toolRun`
   * is null. Otherwise the reply runs the tool loop (worker.ts), bounded by `toolRun`.
   */
  readonly tools: readonly ToolSpec[];
  readonly toolRun: ToolRun | null;
}

/** What bounds a reply's tool rounds besides the site's `TOOLS` (the worker's `ToolLimits`): the run's own numbers. */
export interface ToolRun {
  /** At most how many calls of each tool, by name, one reply runs (loop.ts `LoopGuard`); a tool not named has only the round cap. */
  readonly perTool: Readonly<Record<string, number>>;
  /** The model's context, in tokens. */
  readonly contextTokens: number;
  /** The images and PDFs the call shows, at their constants (metering/prices.ts): sent, and held, in every round. */
  readonly fixedTokens: number;
  /** The model's learned ratio: a round's added text is estimated at it when no usage is reported, as `inputChars` is. */
  readonly ratio: number;
  /**
   * The ratio the context was planned at (metering/tokens.ts `planRatio`) and the call's input as planned at it (its text
   * times that ratio, images and PDFs at their constants): what the rounds may add is what the plan's limit leaves.
   */
  readonly planRatio: number;
  readonly planned: number;
}

/** The status a tool's work shows while a reply runs tools. */
export type Activity = "search" | "file" | "time";

/** What a tool call gave: its output (JSON-serialisable) and what kind of work it was. */
export interface ToolOutcome {
  output: unknown;
  activity: Activity;
}

/**
 * What calls are counted at when their upstream reports no usage: tokens by the weight estimate (input times the
 * model's learned ratio; metering/tokens.ts), whole numbers of 0 or more — what settlement falls back on (settle.ts
 * `fallback`). The field names are settlement's own.
 */
export interface Estimated {
  inputChars: number;
  outputChars: number;
}

/**
 * Why a reply failed, as the owner is told (`Run.error`). `busy`: the service's own trouble (the reply could not be
 * started or stored, or it had nothing to answer and no new topic explains why); such a run is charged nothing.
 * `context_too_small`: the model's context, less its output limit and the system text, cannot hold the owner's newest
 * message (or 200 tokens of it); no call is made. `rate_limited`: the owner had started their replies a minute in the
 * run's lane (`agentRunsPerMinute` for their own, `agentOthersRunsPerMinute` for everyone else's); the run was recorded
 * failed by the trigger (runs.ts), never by the worker, and nothing was called.
 * `thinking_exhausted`: the model stopped at its output limit having only thought, no answer (charged what the
 * upstream reported).
 */
export type RunErrorCode =
  | "provider_rejected"
  | "provider_unavailable"
  | "address_not_allowed"
  | "no_quota"
  | "busy"
  | "context_too_small"
  | "rate_limited"
  | "thinking_exhausted";

/**
 * How a run ends, as the worker saw it. `finish` records what is true under the Agent's lock: a reply that was posted
 * stands (`done`, or `stopped` by its owner), and a run its Agent's pause, delete or removal from the run's conversation
 * (`agent_removed`), or a group member's halt (`halted`: an Agent's message had called for it), interrupted is
 * `cancelled` with that reason — the worker cannot tell an owner's stop from a pause, and a refused post looks the
 * same. `cancelled` with no error from `begin`: everything the reply was to answer is before a new topic its owner
 * started, or (a reply someone else called for) the Agent's others' daily budget was spent by the time it was admitted.
 */
export type RunEnd =
  | { readonly status: "done" }
  | { readonly status: "stopped" }
  | { readonly status: "cancelled"; readonly error?: "agent_paused" | "agent_deleted" | "agent_removed" | "halted" }
  | { readonly status: "failed"; readonly error: RunErrorCode; readonly resetsAt?: string };

/**
 * The provider could not be reached or gave nothing usable (also how a run the previous process left running ends, and
 * how a persona draft fails then). Its literal type is kept: a draft's failure must stay a `ModelErrorCode`.
 */
export const UNAVAILABLE = { status: "failed", error: "provider_unavailable" } as const satisfies RunEnd;
/** The service's own trouble: the reply could not be started or stored, or had nothing to answer. Charged nothing. */
export const BUSY = { status: "failed", error: "busy" } as const satisfies RunEnd;
/** No tokens at all: what a run that never called a model, or one recovered at start-up, is settled on. */
export const NOTHING: Readonly<Estimated> = { inputChars: 0, outputChars: 0 };

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
   * Pushes a piece of the reply to the owner's sockets; nothing is stored. Dropped once the Agent's pause, delete or
   * removal from the run's conversation interrupted the run — also a piece that was already waiting to be delivered,
   * whenever it is delivered.
   */
  emit(run: RunTicket, delta: Delta): void;
  /**
   * Posts the reply as the Agent's message: "refused" when the Agent is paused or deleted, or its pause, delete or
   * removal from the run's conversation, or a group member's halt, interrupted the run, or the run is no longer running (another instance's
   * recovery ended it; `finish` then leaves it as that recorded it); "empty", storing nothing, when nothing of it is
   * left to show (a reply stopped or cut inside a persona block it never finished, with nothing before it; in a group,
   * also one that was nothing but the mark `begin` drew for the run, which the port keeps and takes out, and labels).
   */
  post(run: RunTicket, out: Reply): Promise<"posted" | "refused" | "empty">;
  /**
   * Settles the call and records how the run ended (one transaction), then queues the follow-up for messages that came
   * meanwhile. `usage` is what the upstream reported; with none, `fallback` is what settlement counts.
   */
  finish(run: RunTicket, end: RunEnd, usage: Usage | null, fallback: Estimated): Promise<void>;
  /**
   * Runs one tool call of the reply: a call of a tool `begin` offered whose input fits the tool's schema (the worker
   * checks both, and runs each call at most once). Never rejects for a call it cannot answer: its output then says why
   * (`{ error: "…" }`). `signal` aborts when the owner stops the reply, its time is up, or the tool has taken
   * `AGENT_RUN_TIMEOUT_MS`; a tool still running then is abandoned (its outcome is not used).
   */
  tool(run: RunTicket, call: ToolCall, signal: AbortSignal): Promise<ToolOutcome>;
  /**
   * Between two rounds of a reply that offers tools, in one transaction under the run's lock: whether, and how, the
   * reply may go on — what it has cost so far (`spent`, the rounds' summed usage, or with any round unreported null and
   * then `estimated`; nothing for a provider's model) and the most its next call can cost (`nextInputTokens`, the bound of
   * what it will send, and its whole output limit) are held for it. "ok": another round that may call tools; "final":
   * one last call, which calls none (the reply's spend, or a budget of its lane, has reached its cap; or only such a call
   * can be held); "stop": no further call (nothing more can be held, or the run is no longer running) — the worker posts
   * what the reply wrote, or with nothing written the run fails `no_quota`.
   */
  extend(run: RunTicket, spent: Usage | null, estimated: Estimated, nextInputTokens: number): Promise<"ok" | "final" | "stop">;
  /**
   * What the reply's tools are doing, for its status line: after each tool that ran, what it did; null once the reply's
   * tool phase is over (its last call, or it ended). Nothing is stored.
   */
  activity(run: RunTicket, activity: Activity | null): void;
  /**
   * The reply's model cannot use the tools: its upstream refused them ("refused", in the first round), or it made two
   * calls that could not be run ("garbled"). The reply goes on without them either way.
   */
  toolsUnusable(run: RunTicket, why: "refused" | "garbled"): Promise<void>;
  /**
   * Ends a run that will not be finished here (the service is closing) exactly as recovery at start-up ends one: its
   * reply posted → `done` (`stopped` when its message says so); interrupted by its Agent's pause, delete or removal from
   * the run's conversation → `cancelled`; else `failed`, `provider_unavailable`, retryable — its hold released by a
   * settlement on no tokens, which
   * costs nothing, and the follow-up queued by the one rule. Its owner is told. Nothing when it had ended already.
   * Rejects when that cannot be written: the run then stays `running`, for the stale-run sweep or the next start.
   */
  release(run: RunTicket): Promise<void>;
  /** Whether the run should stop now: its owner asked, or the Agent was paused, deleted or taken out of the run's conversation. */
  shouldStop(run: RunTicket): boolean;
}

/** `begin`'s answer is a run end rather than a prepared call. */
export function isRunEnd(x: Prepared | RunEnd): x is RunEnd {
  return "status" in x;
}
