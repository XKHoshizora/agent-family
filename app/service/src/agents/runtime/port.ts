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
  /** Characters of the system text and the turns: what settlement counts when the upstream reports no usage. */
  readonly inputChars: number;
}

/** Why a reply failed, as the owner is told (`Run.error`). */
export type RunErrorCode = "provider_rejected" | "provider_unavailable" | "address_not_allowed" | "no_quota";

/**
 * How a run ends. `stopped` and `cancelled` without an `error` are the worker's view of an interrupted run; `finish`
 * records it as `cancelled` with `agent_paused` / `agent_deleted` when that is why (the worker cannot tell a stop
 * request from a pause).
 */
export type RunEnd =
  | { readonly status: "done" }
  | { readonly status: "stopped" }
  | { readonly status: "cancelled"; readonly error?: "agent_paused" | "agent_deleted" }
  | { readonly status: "failed"; readonly error: RunErrorCode; readonly resetsAt?: string };

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
  /** Resolves the model, builds what the model is shown, admits the call and marks the Agent's read position — or says why the run ends at once. */
  begin(run: RunTicket): Promise<Prepared | RunEnd>;
  /** Pushes a piece of the reply to the owner's sockets; nothing is stored. */
  emit(run: RunTicket, delta: Delta): void;
  /** Posts the reply as the Agent's message: "refused" when the Agent is paused or deleted by now. */
  post(run: RunTicket, out: Reply): Promise<"posted" | "refused">;
  /** Settles the call and records how the run ended (one transaction), then queues the follow-up for messages that came meanwhile. */
  finish(run: RunTicket, end: RunEnd, usage: Usage | null, fallback: { inputChars: number; outputChars: number }): Promise<void>;
  /** Whether the run should stop now: its owner asked, or the Agent was paused or deleted. */
  shouldStop(run: RunTicket): boolean;
}

/** `begin`'s answer is a run end rather than a prepared call. */
export function isRunEnd(x: Prepared | RunEnd): x is RunEnd {
  return "status" in x;
}
