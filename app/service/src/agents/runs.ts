import { z } from "zod";
import { lockAccount } from "../accounts/store.ts";
import type { Config } from "../config.ts";
import type { WriteLock } from "../conversations/store.ts";
import type { Queryable, Tx } from "../db.ts";
import { AppError, notFound } from "../errors.ts";
import type { StoredMessage } from "../messages/model.ts";
import { lockAgent, type AgentRow } from "./store.ts";

/**
 * Reply runs (`agent_runs` rows of purpose `reply`) as the routes and the send path see them: the trigger, retry, stop,
 * dismiss and the latest run of a conversation. The worker's side is `port-impl.ts`. A run belongs to one conversation
 * (`conversation_id`), and everything here acts on that one: an Agent has at most one queued or running run per
 * conversation, and a message is folded only into the active run of its own conversation. Lock order everywhere: the
 * run's conversation row → the `agents` row (`lockAgent`) → the run row → the `accounts` row.
 */

export const RUN_STATUSES = ["queued", "running", "done", "failed", "stopped", "cancelled"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/**
 * Errors after which trying again unchanged does not help (the key, the address, the Agent itself, a context too small
 * for the persona: the owner must change something first).
 */
const NOT_RETRYABLE: ReadonlySet<string> = new Set(["provider_rejected", "address_not_allowed", "agent_deleted", "context_too_small"]);

/** A run on the wire (README "Wire shapes"). */
export const wireRunSchema = z.object({
  id: z.string(),
  status: z.enum(RUN_STATUSES),
  error: z.string().optional(),
  retryable: z.boolean(),
  resetsAt: z.string().optional(),
});
export type WireRun = z.infer<typeof wireRunSchema>;

export interface RunRow {
  id: string;
  status: RunStatus;
  error: string | null;
  resets_at: Date | null;
  dismissed_at: Date | null;
}

/** Columns of `agent_runs r` in the shape of `RunRow`. */
export const RUN_COLUMNS = "r.id, r.status, r.error, r.resets_at, r.dismissed_at";

/**
 * `retryable`: the run failed and trying again as it is may work — not after the provider refused the key or the
 * address, and never for a run that did not fail. `resetsAt` only for `no_quota` on a free-tier model.
 */
export function toWireRun(r: RunRow): WireRun {
  return {
    id: r.id,
    status: r.status,
    ...(r.error === null ? {} : { error: r.error }),
    retryable: r.status === "failed" && !NOT_RETRYABLE.has(r.error ?? ""),
    ...(r.error === "no_quota" && r.resets_at ? { resetsAt: r.resets_at.toISOString() } : {}),
  };
}

/** A run to push to its owner after the transaction that changed it commits. */
export interface Announced {
  ownerId: string;
  /** The run's own conversation. */
  conversationId: string;
  run: WireRun;
}

/** Whether `text` calls the Agent: `@` and its handle or its current name, case ignored (spec 6.5 "触发"). */
export function mentions(text: string, agent: Pick<AgentRow, "handle" | "name">): boolean {
  const lower = text.toLowerCase();
  return lower.includes(`@${agent.handle.toLowerCase()}`) || lower.includes(`@${agent.name.toLowerCase()}`);
}

/** The Agent of `conversationId` when it is an Agent conversation of `ownerId`'s, else null. */
export async function ownedAgentOf(q: Queryable, ownerId: string, conversationId: string): Promise<string | null> {
  const { rows } = await q.query<{ agent_id: string }>(
    "select agent_id from agent_conversations where conversation_id = $1 and owner_id = $2",
    [conversationId, ownerId],
  );
  return rows[0]?.agent_id ?? null;
}

/** The conversation's newest run (there is at most one active, and it is the newest). */
export async function latestRun(q: Queryable, conversationId: string): Promise<RunRow | null> {
  const { rows } = await q.query<RunRow>(
    `select ${RUN_COLUMNS} from agent_runs r where r.conversation_id = $1 order by r.created_at desc, r.id desc limit 1`,
    [conversationId],
  );
  return rows[0] ?? null;
}

/**
 * Replies `ownerId` has started in the last minute (`agentRunsPerMinute`), counted under the owner's `accounts` row
 * lock — the last lock of the order, taken here before counting and held until the caller's transaction (which inserts
 * the run) ends — so that two replies started at once, to two of the owner's Agents, are counted one after the other.
 * A run refused by this limit (`rate_limited`) started nothing and is not counted.
 */
async function startedLastMinute(t: Tx, ownerId: string): Promise<number> {
  await lockAccount(t, ownerId);
  const { rows } = await t.query<{ n: number }>(
    `select count(*)::int as n from agent_runs
      where owner_id = $1 and purpose = 'reply' and created_at > now() - interval '1 minute'
        and error is distinct from 'rate_limited'`,
    [ownerId],
  );
  return rows[0]!.n;
}

/**
 * Why an Agent's running reply was cut short (`agent_runs.interrupted`): by the Agent's pause or delete, or because the
 * Agent left the run's conversation (`agent_removed`).
 */
export type Interruption = "agent_paused" | "agent_deleted" | "agent_removed";

/**
 * In the pause's (or delete's) own transaction, which holds `lockAgent`: the Agent's active replies, in every
 * conversation, end for good. A queued one is cancelled at once (it never reached a model: nothing to settle). A
 * running one is marked `interrupted`: `postAsAgent` refuses it and `finish` records it `cancelled` with that reason —
 * even if the Agent is resumed before the worker notices — and what was noted on it (`pending_seq`) is dropped: nothing
 * written before the pause gets a follow-up. Whatever is noted on it from now on came after a resume (nothing is noted
 * while the Agent is paused) and is followed up as usual (`finish`). Returns the cancelled runs to announce, each with
 * its own conversation, and the running ones to stop.
 */
export async function interruptRuns(
  t: Tx,
  agent: AgentRow,
  reason: Exclude<Interruption, "agent_removed">,
): Promise<{ cancelled: Announced[]; running: string[] }> {
  const queued = await t.query<RunRow & { conversation_id: string }>(
    `update agent_runs as r set status = 'cancelled', error = $2, finished_at = now()
      where r.agent_id = $1 and r.status = 'queued' returning ${RUN_COLUMNS}, r.conversation_id`,
    [agent.id, reason],
  );
  const running = await t.query<{ id: string }>(
    "update agent_runs set interrupted = $2, pending_seq = null where agent_id = $1 and status = 'running' returning id",
    [agent.id, reason],
  );
  return {
    cancelled: queued.rows.map((r) => ({ ownerId: agent.ownerId, conversationId: r.conversation_id, run: toWireRun(r) })),
    running: running.rows.map((r) => r.id),
  };
}

/** Queues a reply of the locked Agent in `conversationId` answering up to `coversSeq` (a seq of that conversation). */
export async function queueRun(t: Tx, agent: AgentRow, conversationId: string, coversSeq: number): Promise<Announced> {
  const { rows } = await t.query<RunRow>(
    `insert into agent_runs as r (purpose, conversation_id, agent_id, owner_id, status, covers_seq)
     values ('reply', $1, $2, $3, 'queued', $4) returning ${RUN_COLUMNS}`,
    [conversationId, agent.id, agent.ownerId, coversSeq],
  );
  return { ownerId: agent.ownerId, conversationId, run: toWireRun(rows[0]!) };
}

/**
 * A reply in `conversationId` the owner's `agentRunsPerMinute` refused: recorded `failed`, `rate_limited` (retryable),
 * covering `coversSeq`, so the owner sees it and can retry. It never reached a model: no hold, no usage record, and it
 * is not active (it takes no concurrency slot, and the Agent's one active run there stays free).
 */
async function recordRateLimited(t: Tx, agent: AgentRow, conversationId: string, coversSeq: number): Promise<Announced> {
  const { rows } = await t.query<RunRow>(
    `insert into agent_runs as r (purpose, conversation_id, agent_id, owner_id, status, error, covers_seq, finished_at)
     values ('reply', $1, $2, $3, 'failed', 'rate_limited', $4, now()) returning ${RUN_COLUMNS}`,
    [conversationId, agent.id, agent.ownerId, coversSeq],
  );
  return { ownerId: agent.ownerId, conversationId, run: toWireRun(rows[0]!) };
}

/**
 * The trigger (spec 6.5): in the send transaction, after `message` was stored (not a repeat), under the send's locks.
 * Only a message from the owner in an Agent conversation counts, and nothing happens when the Agent is paused, deleted
 * or has no model, or answers only when called (`replyMode` `mention`) and the text calls it neither by `@handle` nor
 * by `@name`. With a reply of the Agent already active in this conversation the message is folded into it: a queued
 * one now covers it, a running one notes it in `pending_seq` (one follow-up answers everything that came meanwhile); a
 * reply active in another conversation is not touched. Otherwise a reply is queued here — unless the owner has started
 * `agentRunsPerMinute` in the last minute: then a `failed` run, `rate_limited`, is recorded instead
 * (`recordRateLimited`; the message stays sent). Returns the run to announce after commit, or null.
 */
export async function maybeTrigger(
  t: Tx,
  lock: WriteLock,
  message: StoredMessage,
  config: Pick<Config, "agentRunsPerMinute">,
): Promise<Announced | null> {
  if (lock.conversation.type !== "agent" || message.kind === "system") return null;
  const conversationId = lock.conversation.id;
  const found = await t.query<{ agent_id: string }>("select agent_id from agent_conversations where conversation_id = $1", [conversationId]);
  if (!found.rows[0]) return null;
  const agent = await lockAgent(t, found.rows[0].agent_id, conversationId);
  if (message.senderId !== agent.ownerId || agent.paused || agent.deleted || agent.model === null) return null;
  const text = typeof message.body.text === "string" ? message.body.text : "";
  if (agent.replyMode === "mention" && !mentions(text, agent)) return null;

  const folded = await t.query(
    `update agent_runs
        set covers_seq = case when status = 'queued' then greatest(covers_seq, $3) else covers_seq end,
            pending_seq = case when status = 'running' then greatest(pending_seq, $3) else pending_seq end
      where agent_id = $1 and conversation_id = $2 and status in ('queued', 'running')`,
    [agent.id, conversationId, message.seq],
  );
  if (folded.rowCount) return null;
  if ((await startedLastMinute(t, agent.ownerId)) >= config.agentRunsPerMinute) return recordRateLimited(t, agent, conversationId, message.seq);
  return queueRun(t, agent, conversationId, message.seq);
}

/**
 * `POST …/runs/retry`: a new queued reply answering up to the owner's last message, only when the conversation's
 * latest run failed. 404 unless it is the caller's Agent conversation; 409 `agent_deleted` / `agent_paused`; 409
 * `busy_run` while a reply is queued or running; 400 when the latest run did not fail (or there is none) or the Agent
 * has no model; 429 over `agentRunsPerMinute`.
 */
export async function retryRun(t: Tx, ownerId: string, conversationId: string, config: Pick<Config, "agentRunsPerMinute">): Promise<Announced> {
  const agentId = await ownedAgentOf(t, ownerId, conversationId);
  if (!agentId) throw notFound();
  const agent = await lockAgent(t, agentId, conversationId);
  if (agent.deleted) throw new AppError(409, "agent_deleted");
  if (agent.paused) throw new AppError(409, "agent_paused");
  const latest = await latestRun(t, conversationId);
  if (latest?.status === "queued" || latest?.status === "running") throw new AppError(409, "busy_run");
  if (latest?.status !== "failed" || agent.model === null) throw new AppError(400, "invalid_request");
  if ((await startedLastMinute(t, ownerId)) >= config.agentRunsPerMinute) throw new AppError(429, "rate_limited");
  const last = await t.query<{ seq: string | null }>(
    "select max(seq)::text as seq from messages where conversation_id = $1 and sender_id = $2 and kind <> 'system'",
    [conversationId, ownerId],
  );
  if (last.rows[0]?.seq == null) throw new AppError(400, "invalid_request");
  return queueRun(t, agent, conversationId, Number(last.rows[0].seq));
}

/**
 * `POST …/runs/:runId/stop`: a queued run is stopped at once (it never reached a model: nothing to settle); a running
 * one is reported, so the caller can flag it for the worker working on it, or release it when nobody here is; a
 * finished one is left as it is. 404 unless the run is of the caller's Agent conversation.
 */
export async function stopRun(t: Tx, ownerId: string, conversationId: string, runId: string): Promise<{ stopped: Announced | null; running: boolean }> {
  if (!(await ownedAgentOf(t, ownerId, conversationId))) throw notFound();
  const { rows } = await t.query<{ status: RunStatus }>("select status from agent_runs where id = $1 and conversation_id = $2 for update", [
    runId,
    conversationId,
  ]);
  const status = rows[0]?.status;
  if (status === undefined) throw notFound();
  if (status !== "queued") return { stopped: null, running: status === "running" };
  const stopped = await t.query<RunRow>(
    `update agent_runs as r set status = 'stopped', finished_at = now() where r.id = $1 returning ${RUN_COLUMNS}`,
    [runId],
  );
  return { stopped: { ownerId, conversationId, run: toWireRun(stopped.rows[0]!) }, running: false };
}

/** `POST …/runs/dismiss`: the latest run, if it failed, is no longer shown by `GET …/run`. 404 unless the caller's. */
export async function dismissRun(q: Queryable, ownerId: string, conversationId: string): Promise<void> {
  if (!(await ownedAgentOf(q, ownerId, conversationId))) throw notFound();
  await q.query(
    `update agent_runs set dismissed_at = now()
      where id = (select id from agent_runs where conversation_id = $1 order by created_at desc, id desc limit 1)
        and status = 'failed' and dismissed_at is null`,
    [conversationId],
  );
}
