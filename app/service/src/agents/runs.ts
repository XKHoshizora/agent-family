import type { FastifyBaseLogger } from "fastify";
import { z } from "zod";
import { lockAccount, siteDayStart } from "../accounts/store.ts";
import type { Config } from "../config.ts";
import { currentMembership, lockForWrite, peekConversation, type ConversationType, type WriteLock } from "../conversations/store.ts";
import { appendSystem } from "../conversations/system.ts";
import type { Queryable, Tx } from "../db.ts";
import { AppError, notFound } from "../errors.ts";
import type { StoredMessage } from "../messages/model.ts";
import { mentionedHandles } from "./mentions.ts";
import { lockAgent, type AgentRow } from "./store.ts";

/**
 * Reply runs (`agent_runs` rows of purpose `reply`) as the routes and the send path see them: the trigger, retry, stop,
 * dismiss, the latest run of a conversation, and what a group's members may know of its Agents' replies (`groupRuns`,
 * `runAudience`: the owner the run, everyone else its state). The worker's side is `port-impl.ts`. A run belongs to
 * one conversation (`conversation_id`), and everything here acts on that one: an Agent has at most one queued or
 * running run per conversation, and a message is folded only into the active run of its own conversation. In a group
 * a message calls Agents by `@handle` (`triggerInGroup`, `triggerFromAgent`), under brakes on Agents calling Agents
 * (the chain limit, the halt, the chain budget) and, on what other people's calls spend of an owner's points, the
 * Agent's others' daily budget (`othersBudgetSpent`). Lock order everywhere: the run's conversation row → `agents` rows
 * (`lockAgent`; several in id order) → run rows → `accounts` rows (several in id order).
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

/**
 * What a member of a group who does not own the Agent is told of its reply there (wire contract "Run state"): replying
 * while its run is queued or running, unavailable while it failed and its owner has not dismissed it, else nothing.
 */
export type GroupRunState = "replying" | "unavailable" | null;

export function groupRunState(r: Pick<RunRow, "status" | "dismissed_at"> | null | undefined): GroupRunState {
  if (!r) return null;
  if (r.status === "queued" || r.status === "running") return "replying";
  return r.status === "failed" && r.dismissed_at === null ? "unavailable" : null;
}

/**
 * The run that decides what a group shows of an Agent member: the latest reply run of the member `m` (a `memberships`
 * alias, spliced into SQL: only these literals) in its conversation during that stay — one covering a message after it
 * joined, so a run from before it last left and came back is not it. A `lateral` subquery in the shape of `RunRow`.
 */
type StayAlias = "m" | "am";
const latestInStay = (m: StayAlias): string =>
  `lateral (select x.id, x.status, x.error, x.resets_at, x.dismissed_at from agent_runs x
             where x.agent_id = ${m}.principal_id and x.conversation_id = ${m}.conversation_id and x.purpose = 'reply'
               and x.covers_seq > ${m}.joined_seq
             order by x.created_at desc, x.id desc limit 1)`;

/** One Agent's line in `GET /api/conversations/:id/runs`. */
export interface GroupRunEntry {
  agentId: string;
  state: Exclude<GroupRunState, null>;
  /** Only for the Agent's owner. */
  run?: WireRun;
}

/**
 * `GET /api/conversations/:id/runs` for `readerId` (wire contract "Run state"): 404, as for a conversation that does not
 * exist, unless it is a group the reader is a current member of. One entry per current Agent member whose latest run
 * there in its current stay (`latestInStay`) has a state, in `agentId` order; the run itself on the reader's own
 * Agents' entries only.
 */
export async function groupRuns(q: Queryable, readerId: string, conversationId: string): Promise<GroupRunEntry[]> {
  if ((await peekConversation(q, conversationId))?.type !== "group" || !(await currentMembership(q, conversationId, readerId))) throw notFound();
  const { rows } = await q.query<RunRow & { agent_id: string; owner_id: string }>(
    `select m.principal_id as agent_id, p.owner_id, ${RUN_COLUMNS}
       from memberships m
       join principals p on p.id = m.principal_id and p.kind = 'agent'
       join ${latestInStay("m")} r on true
      where m.conversation_id = $1 and m.left_seq is null
      order by m.principal_id`,
    [conversationId],
  );
  const entries: GroupRunEntry[] = [];
  for (const row of rows) {
    const state = groupRunState(row);
    if (state !== null) entries.push({ agentId: row.agent_id, state, ...(row.owner_id === readerId ? { run: toWireRun(row) } : {}) });
  }
  return entries;
}

/** Who is told what of a run, read when its push is delivered (`Hub.pushRun`). */
export interface RunAudience {
  type: ConversationType;
  agentId: string;
  /** The run's owner (`agent_runs.owner_id`): the one principal ever pushed the run itself. */
  ownerId: string;
  /** A group's current members, people and Agents; empty in any other conversation. */
  memberIds: string[];
  /** In a group, what its members other than the run's owner are told: the Agent's state there now. */
  state: GroupRunState;
}

/**
 * One statement for one delivery of run `runId` of `conversationId`, however many members the conversation has: its
 * type, the run's Agent and owner, and in a group its current members and the Agent's state there now — that of its
 * latest run in its current stay (`latestInStay`), null once it is not a member. Null when there is no such run.
 */
export async function runAudience(q: Queryable, conversationId: string, runId: string): Promise<RunAudience | null> {
  const { rows } = await q.query<{
    type: ConversationType;
    agent_id: string;
    owner_id: string;
    members: string[] | null;
    status: RunStatus | null;
    dismissed_at: Date | null;
  }>(
    `select c.type, a.agent_id, a.owner_id,
            case when c.type = 'group'
                 then array(select ms.principal_id from memberships ms where ms.conversation_id = c.id and ms.left_seq is null) end as members,
            r.status, r.dismissed_at
       from agent_runs a
       join conversations c on c.id = a.conversation_id
       left join memberships am on c.type = 'group' and am.conversation_id = c.id and am.principal_id = a.agent_id and am.left_seq is null
       left join ${latestInStay("am")} r on true
      where a.id = $1 and a.conversation_id = $2`,
    [runId, conversationId],
  );
  const row = rows[0];
  if (!row) return null;
  const latest = row.status === null ? null : { status: row.status, dismissed_at: row.dismissed_at };
  return { type: row.type, agentId: row.agent_id, ownerId: row.owner_id, memberIds: row.members ?? [], state: groupRunState(latest) };
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
 * The limits on replies started a minute — an owner's own lane, the others' (every other lane together), one caller's —
 * and the site's time zone, whose day the others' daily budget is counted in (`othersBudgetSpent`).
 */
export type RunLimits = Pick<Config, "agentRunsPerMinute" | "agentOthersRunsPerMinute" | "agentCallerRunsPerMinute" | "siteTimezone">;

/**
 * Replies `ownerId` has started in the last minute in one lane: their own (`own`, `agentRunsPerMinute`), or else
 * every other together — what others called for, and what nobody did (`agentOthersRunsPerMinute`) — so neither uses up
 * the other. Counted under the owner's `accounts` row lock — the last lock of the order, taken here before counting and
 * held until the caller's transaction (which inserts the run) ends — so that two replies started at once, to two of the
 * owner's Agents, are counted one after the other. A run refused by this limit (`rate_limited`) started nothing and is
 * not counted.
 */
async function startedLastMinute(t: Tx, ownerId: string, own: boolean): Promise<number> {
  await lockAccount(t, ownerId);
  const { rows } = await t.query<{ n: number }>(
    `select count(*)::int as n from agent_runs
      where owner_id = $1 and purpose = 'reply' and created_at > now() - interval '1 minute'
        and error is distinct from 'rate_limited' and (lane = 'own') = $2`,
    [ownerId, own],
  );
  return rows[0]!.n;
}

/** Whether `ownerId` has started their replies a minute in `lane` (`startedLastMinute`): over it, a reply is refused. */
async function overLaneLimit(t: Tx, ownerId: string, lane: Lane, config: RunLimits): Promise<boolean> {
  const own = lane === "own";
  return (await startedLastMinute(t, ownerId, own)) >= (own ? config.agentRunsPerMinute : config.agentOthersRunsPerMinute);
}

/**
 * Calls person `callerId` has made in the last minute on other people's Agents (`agentCallerRunsPerMinute`),
 * themselves or through their own Agents, whoever's Agents they were: the replies they are the caller of that are not
 * their owner's own (so a call on one of their own Agents never counts). A run an owner's limit refused
 * (`rate_limited`) started nothing and is not counted; nor is a mention folded into a reply under way, which starts
 * none. Counted under the caller's `accounts` row lock (`reachAgents` takes it with the owners', in id order), so two
 * calls the same person makes at once are counted one after the other.
 */
async function calledLastMinute(t: Tx, callerId: string): Promise<number> {
  await lockAccount(t, callerId);
  const { rows } = await t.query<{ n: number }>(
    `select count(*)::int as n from agent_runs
      where caller_id = $1 and lane <> 'own' and purpose = 'reply' and created_at > now() - interval '1 minute'
        and error is distinct from 'rate_limited'`,
    [callerId],
  );
  return rows[0]!.n;
}

/**
 * Why an Agent's running reply was cut short (`agent_runs.interrupted`): by the Agent's pause or delete, because the
 * Agent left the run's conversation (`agent_removed`), or because a member of the group halted Agents calling each
 * other and an Agent's message had called for it (`halted`, `haltAgents`).
 */
export type Interruption = "agent_paused" | "agent_deleted" | "agent_removed" | "halted";

/** Whose message called for a run (`agent_runs.triggered_by`): a person's, or an Agent's in a group. */
export type TriggeredBy = "human" | "agent";

/**
 * A run's lane (`agent_runs.lane`), which the limits read: `own` when the Agent's owner called for it — themselves, or
 * through one of their own Agents; so is every reply in the Agent's own conversation, a retry and a persona draft —
 * `others` when someone else did, `proactive` when nobody did (batch 2D: nothing here records it).
 */
export type Lane = "own" | "others" | "proactive";

/**
 * Who called for a run (`agent_runs.caller_id`: the person behind it, an Agent's call being its owner's; nobody for a
 * follow-up in a group none of whose callers it can see any more, `followUp`), and its lane.
 */
export type Caller = { id: string | null; lane: Lane };

/** The call person `personId` makes on an Agent of `ownerId`'s: the owner's own, or someone else's. */
export function callerOf(ownerId: string, personId: string): Caller {
  return { id: personId, lane: personId === ownerId ? "own" : "others" };
}

/**
 * In the pause's (or delete's) own transaction, which holds `lockAgent`: the Agent's active replies, in every
 * conversation, end for good. A queued one is cancelled at once (it never reached a model: nothing to settle). A
 * running one is marked `interrupted`: `postAsAgent` refuses it and `finish` records it `cancelled` with that reason —
 * even if the Agent is resumed before the worker notices — and what was noted on it (`pending_seq`) is dropped: nothing
 * written before the pause gets a follow-up. Whatever is noted on it from now on came after a resume (nothing is noted
 * while the Agent is paused; what an Agent's message in a group writes for it as the pause commits, which this cannot
 * see, the resume ends: `endWhatPauseMissed`) and is followed up as usual (`finish`). Returns the cancelled runs to
 * announce, each with its own conversation, and the running ones to stop.
 */
export async function interruptRuns(
  t: Tx,
  agent: AgentRow,
  reason: Exclude<Interruption, "agent_removed" | "halted">,
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

/**
 * In the resume's own transaction, which holds `lockAgent` and found the Agent paused: what the pause could not see
 * ends now, before the Agent can answer again. An Agent's message in a group reads the Agents it calls without locking
 * them (`triggerFromAgent`), so a pause that commits inside that message's transaction misses what it then writes — a
 * run it queues (none other can be queued while the Agent is paused: a person's mention, a retry, a follow-up and
 * recovery all refuse a paused Agent), and a mention its fold notes on a reply the pause interrupted. So, in every
 * conversation: a queued run of the Agent is `cancelled` `agent_paused` (it never reached a model), and so is one the
 * worker claimed meanwhile (it does not look at the pause): every running run not marked yet is marked `interrupted`
 * `agent_paused`, as the pause marked the others, and nothing noted on a running one is followed up. Returns, as
 * `interruptRuns` does, the cancelled runs to announce and the newly marked ones to stop.
 */
export async function endWhatPauseMissed(t: Tx, agent: AgentRow): Promise<{ cancelled: Announced[]; running: string[] }> {
  const queued = await t.query<RunRow & { conversation_id: string }>(
    `update agent_runs as r set status = 'cancelled', error = 'agent_paused', finished_at = now()
      where r.agent_id = $1 and r.status = 'queued' returning ${RUN_COLUMNS}, r.conversation_id`,
    [agent.id],
  );
  const claimed = await t.query<{ id: string }>(
    "update agent_runs set interrupted = 'agent_paused' where agent_id = $1 and status = 'running' and interrupted is null returning id",
    [agent.id],
  );
  await t.query("update agent_runs set pending_seq = null where agent_id = $1 and status = 'running' and pending_seq is not null", [agent.id]);
  return {
    cancelled: queued.rows.map((r) => ({ ownerId: agent.ownerId, conversationId: r.conversation_id, run: toWireRun(r) })),
    running: claimed.rows.map((r) => r.id),
  };
}

/** The Agent as a run row names it. */
type RunAgent = Pick<AgentRow, "id" | "ownerId">;

/**
 * Queues a reply of the Agent in `conversationId` answering up to `coversSeq` (a seq of that conversation), called for
 * by a person's message unless `triggeredBy` says an Agent's, by `caller` and in its lane. Under that conversation's row
 * lock, which every writer of the Agent's runs there holds: the Agent has no active run there
 * (`agent_runs_one_active_per_agent_conversation` would refuse a second).
 */
export async function queueRun(t: Tx, agent: RunAgent, conversationId: string, coversSeq: number, triggeredBy: TriggeredBy, caller: Caller): Promise<Announced> {
  const { rows } = await t.query<RunRow>(
    `insert into agent_runs as r (purpose, conversation_id, agent_id, owner_id, status, covers_seq, triggered_by, caller_id, lane)
     values ('reply', $1, $2, $3, 'queued', $4, $5, $6, $7) returning ${RUN_COLUMNS}`,
    [conversationId, agent.id, agent.ownerId, coversSeq, triggeredBy, caller.id, caller.lane],
  );
  return { ownerId: agent.ownerId, conversationId, run: toWireRun(rows[0]!) };
}

/**
 * A reply in `conversationId` the owner's replies a minute in its lane refused (`overLaneLimit`): recorded `failed`,
 * `rate_limited` (retryable), covering `coversSeq`, with whose message and which `caller` called for it, so the owner
 * sees it and can retry. It never reached a model: no hold, no usage record, and it is not active (it takes no
 * concurrency slot, and the Agent's one active run there stays free).
 */
async function recordRateLimited(t: Tx, agent: RunAgent, conversationId: string, coversSeq: number, triggeredBy: TriggeredBy, caller: Caller): Promise<Announced> {
  const { rows } = await t.query<RunRow>(
    `insert into agent_runs as r (purpose, conversation_id, agent_id, owner_id, status, error, covers_seq, finished_at, triggered_by, caller_id, lane)
     values ('reply', $1, $2, $3, 'failed', 'rate_limited', $4, now(), $5, $6, $7) returning ${RUN_COLUMNS}`,
    [conversationId, agent.id, agent.ownerId, coversSeq, triggeredBy, caller.id, caller.lane],
  );
  return { ownerId: agent.ownerId, conversationId, run: toWireRun(rows[0]!) };
}

/**
 * `recordRateLimited` in a group (plan ruling 7): one such run per Agent there, not one per mention. When the Agent's
 * latest run in the group is a `rate_limited` failure its owner has not dismissed, that run now covers `coversSeq` too
 * (and is announced again) — a person's once a person's message is recorded on it, its owner's own once its owner's
 * call is (else it keeps its caller and lane); otherwise a new one is recorded. So repeated mentions over the limit
 * show one line.
 */
async function rateLimitedInGroup(t: Tx, agent: RunAgent, conversationId: string, coversSeq: number, triggeredBy: TriggeredBy, caller: Caller): Promise<Announced> {
  const latest = await t.query<{ id: string; reusable: boolean }>(
    `select id, (status = 'failed' and error is not distinct from 'rate_limited' and dismissed_at is null) as reusable
       from agent_runs where agent_id = $1 and conversation_id = $2 order by created_at desc, id desc limit 1`,
    [agent.id, conversationId],
  );
  const row = latest.rows[0];
  if (!row?.reusable) return recordRateLimited(t, agent, conversationId, coversSeq, triggeredBy, caller);
  const { rows } = await t.query<RunRow>(
    `update agent_runs as r
        set covers_seq = greatest(r.covers_seq, $2), finished_at = now(),
            triggered_by = case when $3 = 'human' then 'human' else r.triggered_by end,
            lane = case when $4 = 'own' then 'own' else r.lane end,
            caller_id = case when $4 = 'own' then $5::uuid else r.caller_id end
      where r.id = $1 returning ${RUN_COLUMNS}`,
    [row.id, coversSeq, triggeredBy, caller.lane, caller.id],
  );
  return { ownerId: agent.ownerId, conversationId, run: toWireRun(rows[0]!) };
}

const textOf = (message: StoredMessage): string => (typeof message.body.text === "string" ? message.body.text : "");

/**
 * A call on someone else's Agent refused by its caller's limit (`agentCallerRunsPerMinute`): it started nothing and
 * nothing of it is recorded — no run, no `rate_limited` line, no notice; it is only logged, after commit
 * (`logCallerLimited`).
 */
export interface CallerLimited {
  callerId: string;
  agentId: string;
  conversationId: string;
}

/**
 * An Agent whose others' daily budget refused a call and told the group so (`othersBudgetSpent` appended its notice):
 * after commit its owner is pushed the Agent again (`Hub.pushAgentChanged`), so the spend their view shows is current.
 */
export interface BudgetReached {
  ownerId: string;
  agentId: string;
}

/**
 * What a message called for, to act on after commit: runs to announce, calls their caller's limit refused, to log, the
 * notices it led to in its group, to publish after it, and the Agents whose others' daily budget it found spent and told
 * the group of, whose owners are pushed the Agent again.
 */
export interface Triggered {
  runs: Announced[];
  callerLimited: CallerLimited[];
  notices: StoredMessage[];
  budgetReached: BudgetReached[];
}

/** A message that called for nothing. */
export function noneTriggered(): Triggered {
  return { runs: [], callerLimited: [], notices: [], budgetReached: [] };
}

/** One line per call its caller's limit refused (`caller_rate_limited`): how often the limit holds someone back. */
export function logCallerLimited(log: Pick<FastifyBaseLogger, "info">, limited: readonly CallerLimited[]): void {
  for (const { callerId, agentId, conversationId } of limited) {
    log.info({ metric: "caller_rate_limited", callerId, agentId, conversationId }, "a call on someone else's Agent over its caller's replies a minute started nothing");
  }
}

/**
 * In a group, under its row lock: the message at `seq` reaches each of `agents` (in id order; whether each may be
 * called is decided already, the others' daily budget included), called for by `caller(agent)`. It is folded into the
 * Agent's active run in the group — a queued one now covers it, becomes a person's when a person's message is folded
 * in, and its owner's own (`lane` `own`, the owner its caller) when its owner's call is, else keeps its caller and lane;
 * a running one notes it (`pending_seq`), and stays as it is: its follow-up answers what was noted, in a lane of its own
 * (`followUp`). A mention folded so is never refused by the limits below (a spent others' daily budget refused it
 * before it came here). Failing that, a call on someone else's Agent (any lane but `own`) first meets
 * its caller's limit (`calledLastMinute`): over it, nothing at all — the call is returned in `callerLimited`, to log.
 * Then the owner's replies a minute in the call's lane decide (`overLaneLimit`): a reply is queued, or the reusable
 * `rate_limited` run records it (`rateLimitedInGroup`). The owners' `accounts` rows, and the caller's when they call
 * someone else's Agent, are locked once the run rows are done with, all of them in id order, before any is counted
 * (the lock order's last step). Returns what to announce and what to log after commit.
 */
async function reachAgents(
  t: Tx,
  conversationId: string,
  agents: readonly RunAgent[],
  seq: number,
  triggeredBy: TriggeredBy,
  caller: (agent: RunAgent) => Caller,
  config: RunLimits,
): Promise<Triggered> {
  const unfolded: RunAgent[] = [];
  for (const agent of agents) {
    const by = caller(agent);
    const folded = await t.query(
      `update agent_runs
          set covers_seq = case when status = 'queued' then greatest(covers_seq, $3) else covers_seq end,
              pending_seq = case when status = 'running' then greatest(pending_seq, $3) else pending_seq end,
              triggered_by = case when status = 'queued' and $4 = 'human' then 'human' else triggered_by end,
              lane = case when status = 'queued' and $5 = 'own' then 'own' else lane end,
              caller_id = case when status = 'queued' and $5 = 'own' then $6::uuid else caller_id end
        where agent_id = $1 and conversation_id = $2 and status in ('queued', 'running')`,
      [agent.id, conversationId, seq, triggeredBy, by.lane, by.id],
    );
    if (!folded.rowCount) unfolded.push(agent);
  }
  // A call on someone else's Agent is counted for its caller: theirs is a call whose lane is not `own`.
  const othersCaller = (agent: RunAgent): string | null => {
    const by = caller(agent);
    return by.lane === "own" ? null : by.id;
  };
  const accounts = unfolded.flatMap((agent) => {
    const callerId = othersCaller(agent);
    return callerId === null ? [agent.ownerId] : [agent.ownerId, callerId];
  });
  for (const id of [...new Set(accounts)].sort()) await lockAccount(t, id);
  const triggered = noneTriggered();
  for (const agent of unfolded) {
    const by = caller(agent);
    const callerId = othersCaller(agent);
    if (callerId !== null && (await calledLastMinute(t, callerId)) >= config.agentCallerRunsPerMinute) {
      triggered.callerLimited.push({ callerId, agentId: agent.id, conversationId });
      continue;
    }
    const over = await overLaneLimit(t, agent.ownerId, by.lane, config);
    triggered.runs.push(
      over ? await rateLimitedInGroup(t, agent, conversationId, seq, triggeredBy, by) : await queueRun(t, agent, conversationId, seq, triggeredBy, by),
    );
  }
  return triggered;
}

/**
 * What calls by people other than its owner have spent today of the owner's points on Agent `agentId` (`dayStart`: when
 * the site day began, `siteDayStart`): what its replies in lane `others` were charged (`free_micro + balance_micro`) by
 * the usage records written since then, and what its running replies in that lane hold now (a running reply has no
 * usage record yet: its hold stands for it). Its owner's own replies (`own`) and those nobody called for (`proactive`)
 * do not count.
 */
export async function othersSpentToday(q: Queryable, agentId: string, dayStart: Date): Promise<bigint> {
  return (await othersSpentTodayOf(q, [agentId], dayStart)).get(agentId) ?? 0n;
}

/** `othersSpentToday` of each of `agentIds` (an owner's list of them), in one statement. */
export async function othersSpentTodayOf(q: Queryable, agentIds: readonly string[], dayStart: Date): Promise<Map<string, bigint>> {
  const { rows } = await q.query<{ id: string; spent: string }>(
    `select a.id,
            ((select coalesce(sum(u.free_micro + u.balance_micro), 0)
                from usage_records u join agent_runs r on r.id = u.run_id
               where u.agent_id = a.id and u.created_at >= $2 and r.lane = 'others')
           + (select coalesce(sum(r.hold_micro), 0) from agent_runs r where r.agent_id = a.id and r.status = 'running' and r.lane = 'others'))::text as spent
       from unnest($1::uuid[]) as a (id)`,
    [agentIds, dayStart],
  );
  return new Map(rows.map((r) => [r.id, BigInt(r.spent)]));
}

/**
 * Whether the conversation was told since `dayStart` that Agent `agentId`'s others' daily budget is spent (a notice's
 * sender is its `actorId`: here the Agent).
 */
async function toldBudgetReachedSince(t: Tx, conversationId: string, agentId: string, dayStart: Date): Promise<boolean> {
  const { rowCount } = await t.query(
    `select 1 from messages
      where conversation_id = $1 and sender_id = $2 and kind = 'system' and body ->> 'event' = 'agent_daily_budget_reached' and created_at >= $3
      limit 1`,
    [conversationId, agentId, dayStart],
  );
  return rowCount !== 0;
}

/**
 * The others' daily budget of `agent` (its owner's `othersBudget`) for a call on it in `conversationId` by someone other
 * than its owner (lane `others`; the caller checks the lane): spent once what such calls spent today
 * (`othersSpentToday`, the site day beginning at `dayStart`) has reached it — never while it is null (no limit; nothing
 * is read then). Once spent, the conversation is told by an `agent_daily_budget_reached` notice about the Agent,
 * appended now unless one about it was today already (once a site day per conversation and Agent): `notice` is the one
 * appended, else null. The caller holds the conversation's row lock (`appendSystem`).
 */
export async function othersBudgetSpent(
  t: Tx,
  conversationId: string,
  agent: Pick<AgentRow, "id" | "othersBudgetMicro">,
  dayStart: Date,
): Promise<{ spent: boolean; notice: StoredMessage | null }> {
  const budget = agent.othersBudgetMicro;
  if (budget === null || (await othersSpentToday(t, agent.id, dayStart)) < budget) return { spent: false, notice: null };
  if (await toldBudgetReachedSince(t, conversationId, agent.id, dayStart)) return { spent: true, notice: null };
  return { spent: true, notice: await appendSystem(t, conversationId, { event: "agent_daily_budget_reached", actorId: agent.id, agentId: agent.id }) };
}

/** When today began, for the others' daily budget: the site day's start (`siteDayStart`). */
const today = (config: Pick<Config, "siteTimezone">): Date => siteDayStart(new Date(), config.siteTimezone, 0);

/**
 * Whether a call on `agent` by someone other than its owner is refused by its others' daily budget
 * (`othersBudgetSpent`); the notice that appended, if any, goes into `told`, with the Agent's owner to push it to.
 */
async function refusedByOthersBudget(
  t: Tx,
  conversationId: string,
  agent: Pick<AgentRow, "id" | "ownerId" | "othersBudgetMicro">,
  dayStart: Date,
  told: Pick<Triggered, "notices" | "budgetReached">,
): Promise<boolean> {
  const { spent, notice } = await othersBudgetSpent(t, conversationId, agent, dayStart);
  if (notice) {
    told.notices.push(notice);
    told.budgetReached.push({ ownerId: agent.ownerId, agentId: agent.id });
  }
  return spent;
}

/**
 * A person's message in a group (plan rulings 6–8): no handle in its text (`mentionedHandles`; a file's caption is its
 * text) → nothing, not even a query. Otherwise one query finds the group's current Agent members with those handles
 * whose owner and the sender have no block between them, in either direction (`blocks`, read as a send reads it and
 * as a direct chat reads it: neither of the two calls the other's Agents, nor spends the other's points); each, in id order, is locked (`lockAgent` on the group, whose row the send already holds) and called unless it is
 * deleted, paused or has no model, or only its owner may call it (`groupMentions` `owner`) and this is someone else's
 * message. `replyMode` plays no part in a group. Someone else's message is then held to the Agent's others' daily
 * budget, read under the Agent's row lock (`othersBudgetSpent`): once it is spent the Agent is not called — not even
 * folded into a reply of its under way — and the group is told once a day (the notice returned, to publish, and the
 * Agent's owner to push it to). Its owner's message never is. Then `reachAgents`, each called for by the sender
 * (`callerOf`).
 */
async function triggerInGroup(t: Tx, conversationId: string, message: StoredMessage, config: RunLimits): Promise<Triggered> {
  const handles = mentionedHandles(textOf(message));
  if (handles.length === 0) return noneTriggered();
  const { rows } = await t.query<{ id: string }>(
    `select p.id from memberships m
       join principals p on p.id = m.principal_id
       join agents a on a.principal_id = p.id
      where m.conversation_id = $1 and m.left_seq is null and p.kind = 'agent' and p.handle = any($2::citext[])
        and not exists (select 1 from blocks b where (b.blocker_id = p.owner_id and b.blocked_id = $3) or (b.blocker_id = $3 and b.blocked_id = p.owner_id))
      order by p.id`,
    [conversationId, handles, message.senderId],
  );
  const dayStart = today(config);
  const told: Pick<Triggered, "notices" | "budgetReached"> = { notices: [], budgetReached: [] };
  const called: AgentRow[] = [];
  for (const { id } of rows) {
    const agent = await lockAgent(t, id, conversationId);
    if (agent.deleted || agent.paused || agent.model === null) continue;
    if (agent.groupMentions === "owner" && message.senderId !== agent.ownerId) continue;
    const others = callerOf(agent.ownerId, message.senderId).lane === "others";
    if (others && (await refusedByOthersBudget(t, conversationId, agent, dayStart, told))) continue;
    called.push(agent);
  }
  const reached = await reachAgents(t, conversationId, called, message.seq, "human", (agent) => callerOf(agent.ownerId, message.senderId), config);
  return { ...reached, notices: [...reached.notices, ...told.notices], budgetReached: [...reached.budgetReached, ...told.budgetReached] };
}

/** The seq of the group's latest message from a person (a notice is nobody's message), 0 when there is none. */
async function latestHumanSeq(t: Tx, conversationId: string): Promise<number> {
  const { rows } = await t.query<{ seq: string }>(
    `select m.seq::text as seq from messages m join principals p on p.id = m.sender_id
      where m.conversation_id = $1 and m.kind <> 'system' and p.kind = 'human'
      order by m.seq desc limit 1`,
    [conversationId],
  );
  return rows[0] ? Number(rows[0].seq) : 0;
}

/** Whether Agents are halted in the group (ruling 11): its latest message from a person is at or before the halt. */
async function isHalted(t: Tx, conversationId: string, latestHuman: number): Promise<boolean> {
  const { rows } = await t.query<{ halted: string | null }>("select agents_halted_seq::text as halted from conversations where id = $1", [conversationId]);
  const halted = rows[0]?.halted ?? null;
  return halted !== null && latestHuman <= Number(halted);
}

/**
 * Whether the group was halted at or after seq `seq` (`agents_halted_seq` ≥ it): a message up to it came before the
 * latest halt, whether or not a person has written since and so lifted it for what comes next.
 */
async function haltedSince(t: Tx, conversationId: string, seq: number): Promise<boolean> {
  const { rows } = await t.query<{ halted: string | null }>("select agents_halted_seq::text as halted from conversations where id = $1", [conversationId]);
  const halted = rows[0]?.halted ?? null;
  return halted !== null && seq <= Number(halted);
}

/** Whether a notice of `event` (about Agent `agentId`, when given) was appended to the group after seq `since`. */
async function toldSince(t: Tx, conversationId: string, since: number, event: string, agentId: string | null = null): Promise<boolean> {
  const { rowCount } = await t.query(
    `select 1 from messages
      where conversation_id = $1 and seq > $2 and kind = 'system' and body ->> 'event' = $3 and ($4::text is null or body ->> 'agentId' = $4)
      limit 1`,
    [conversationId, since, event, agentId],
  );
  return rowCount !== 0;
}

/** What Agent `agentId`'s owner was charged for its replies in the group covering messages after seq `since`. */
async function chargedSince(t: Tx, agentId: string, conversationId: string, since: number): Promise<bigint> {
  const { rows } = await t.query<{ charged: string }>(
    `select coalesce(sum(u.free_micro + u.balance_micro), 0)::text as charged
       from agent_runs r join usage_records u on u.run_id = r.id
      where r.agent_id = $1 and r.conversation_id = $2 and r.purpose = 'reply' and r.covers_seq > $3`,
    [agentId, conversationId, since],
  );
  return BigInt(rows[0]!.charged);
}

/**
 * The chain budget (ruling 12) of Agent `agentId` in the group whose latest message from a person is at seq `human`:
 * null while what its owner was charged for its replies there covering messages after it is under `budgetMicro`; once
 * it has reached it, the `agent_budget_reached` notice about the Agent — appended now, unless one was since that
 * message: then null in its place.
 */
async function chainBudgetSpent(
  t: Tx,
  conversationId: string,
  agentId: string,
  budgetMicro: bigint,
  human: number,
): Promise<{ notice: StoredMessage | null } | null> {
  if ((await chargedSince(t, agentId, conversationId, human)) < budgetMicro) return null;
  if (await toldSince(t, conversationId, human, "agent_budget_reached", agentId)) return { notice: null };
  return { notice: await appendSystem(t, conversationId, { event: "agent_budget_reached", actorId: agentId, agentId }) };
}

/**
 * An Agent's own message in a group (plan rulings 10–12), in `postAsAgent`'s transaction, which holds the group's row
 * and the poster's `agents` row. The handles it names, less its own (an Agent never calls itself); no handle → nothing.
 * One query finds the group's current Agent members with those handles that an Agent may call: not deleted, not
 * paused, with a model, `groupMentions` `members`, and of an owner with no block between them and the poster's owner, in either
 * direction (neither calls the other's Agents, through their own Agent no more than themselves). Their `agents` rows are read, not locked: the poster's is held
 * already, and locking another's after it could take two Agents' rows out of id order — two Agents calling each other
 * from two groups at once would deadlock. The fold-or-insert decision needs no target's row: the group's row, which
 * this transaction holds, orders it with every other trigger, retry, follow-up and halt in this group (the one-active-run
 * index backs that). A pause or delete that commits meanwhile takes the target's row, not the group's, and cannot see
 * the run this inserts or the mention it notes (no predicate lock): a deleted Agent's run is ended by the worker without
 * a call (`begin`), and a paused one's by the resume, before the Agent answers again (`endWhatPauseMissed`; the worker's
 * `begin` too while it is still paused) — unless both the pause and the resume commit inside this transaction's few
 * queries: then the resume cannot see it either. With nobody to call, nothing more.
 * Then, in turn:
 * - halted (ruling 11): the group's latest message from a person is at or before `agents_halted_seq` → nothing;
 * - the chain limit (ruling 10): the group's last `agentChainLimit` messages that are not notices were all Agents' (this
 *   one among them) → nobody is called, and an `agent_chain_paused` notice is appended unless one was since a person
 *   last wrote;
 * - the chain budget (ruling 12), per Agent: what its owner was charged for its replies in this group covering
 *   messages after a person's latest has reached its `chainBudget` → it is not called, and an `agent_budget_reached`
 *   notice about it is appended unless one was since a person last wrote;
 * - the others' daily budget, per Agent of an owner other than the poster's: once it is spent (`othersBudgetSpent`, read
 *   from the row read above, not locked) → it is not called, and an `agent_daily_budget_reached` notice about it is
 *   appended unless one was today (its owner is returned, to push the Agent to).
 * The rest are reached as a person's message reaches them (`reachAgents`), as an Agent's (`triggered_by` `agent`),
 * called for by the poster's owner (`callerOf`: its own when they are the target's owner too) — so a call on someone
 * else's Agent counts toward that owner's caller limit, as their own call would.
 */
export async function triggerFromAgent(
  t: Tx,
  conversationId: string,
  message: StoredMessage,
  poster: AgentRow,
  config: RunLimits & Pick<Config, "agentChainLimit">,
): Promise<Triggered> {
  const own = poster.handle.toLowerCase();
  const handles = mentionedHandles(textOf(message)).filter((h) => h !== own);
  if (handles.length === 0) return noneTriggered();
  const { rows: targets } = await t.query<{ id: string; owner_id: string; budget: string; others_budget: string | null }>(
    `select p.id, p.owner_id, a.chain_budget_micro::text as budget, a.others_budget_micro::text as others_budget
       from memberships m
       join principals p on p.id = m.principal_id
       join agents a on a.principal_id = p.id
      where m.conversation_id = $1 and m.left_seq is null and p.kind = 'agent' and p.handle = any($2::citext[]) and p.id <> $3
        and a.deleted_at is null and not a.paused and a.model_source is not null and a.group_mentions = 'members'
        and not exists (select 1 from blocks b where (b.blocker_id = p.owner_id and b.blocked_id = $4) or (b.blocker_id = $4 and b.blocked_id = p.owner_id))
      order by p.id`,
    [conversationId, handles, poster.id, poster.ownerId],
  );
  if (targets.length === 0) return noneTriggered();

  const human = await latestHumanSeq(t, conversationId);
  if (await isHalted(t, conversationId, human)) return noneTriggered();
  const limit = config.agentChainLimit;
  // Every message after a person's latest that is not a notice is an Agent's.
  const inARow = await t.query<{ n: number }>(
    `select count(*)::int as n from (select 1 from messages where conversation_id = $1 and seq > $2 and kind <> 'system' limit $3) x`,
    [conversationId, human, limit],
  );
  if (inARow.rows[0]!.n >= limit) {
    if (await toldSince(t, conversationId, human, "agent_chain_paused")) return noneTriggered();
    return { ...noneTriggered(), notices: [await appendSystem(t, conversationId, { event: "agent_chain_paused", actorId: poster.id, limit })] };
  }

  const dayStart = today(config);
  const told: Pick<Triggered, "notices" | "budgetReached"> = { notices: [], budgetReached: [] };
  const called: RunAgent[] = [];
  for (const target of targets) {
    const spent = await chainBudgetSpent(t, conversationId, target.id, BigInt(target.budget), human);
    if (spent) {
      if (spent.notice) told.notices.push(spent.notice);
      continue;
    }
    const agent = { id: target.id, ownerId: target.owner_id, othersBudgetMicro: target.others_budget === null ? null : BigInt(target.others_budget) };
    const others = callerOf(agent.ownerId, poster.ownerId).lane === "others";
    if (others && (await refusedByOthersBudget(t, conversationId, agent, dayStart, told))) continue;
    called.push(agent);
  }
  const reached = await reachAgents(t, conversationId, called, message.seq, "agent", (agent) => callerOf(agent.ownerId, poster.ownerId), config);
  return { ...reached, notices: [...reached.notices, ...told.notices], budgetReached: [...reached.budgetReached, ...told.budgetReached] };
}

/** What a run's end calls for in its conversation, to act on after commit (`followUp`). */
export interface FollowUp {
  /** The follow-up queued — or, over the owner's replies a minute, the Agent's reusable `rate_limited` run — to announce. */
  run: Announced | null;
  /** Notices it appended to the group, to publish. */
  notices: StoredMessage[];
  /** The Agent, when its others' daily budget refused the follow-up and told the group: its owner is pushed it again. */
  budgetReached: BudgetReached[];
}

const NO_FOLLOW_UP: FollowUp = { run: null, notices: [], budgetReached: [] };

/**
 * The follow-up of a run of `agent` in `conversationId` that ended having noted messages up to `pending` beyond what it
 * covered (`covers`), under that conversation's row and the Agent's (`finish`, recovery): a queued reply answering up
 * to `pending`. In the Agent's own conversation it is its owner's, as always, and is queued whatever the owner's
 * replies a minute (it answers what its owner wrote meanwhile; README "Replies started"). In a group it is a person's
 * when a person's message in (covers, pending] calls the Agent (one its `groupMentions` lets call it, from a person with no block between them and its owner, in either direction); otherwise only
 * Agents' messages called for it: it is an Agent's, and is not queued at all when the latest of them (`pending`) came
 * at or before the group's latest halt (`agents_halted_seq`, ruling 11), even if a person has written since: what
 * Agents asked before a halt is not answered after it (what a person asked is); nor once the Agent's chain budget is
 * spent (ruling 12, the same rule and notice as for an Agent's mention, `chainBudgetSpent`) — checked again here
 * because the reply that just ended was settled after it was called, so a chain overshoots its budget by at most the
 * one reply that was under way. A follow-up in lane `others` (see below) is not queued either once the Agent's others'
 * daily budget is spent — the same rule and notice as for someone else's mention (`othersBudgetSpent`; the reply that
 * just ended is settled by now) — and the Agent's owner is returned, to push it to; its owner's own is never held to
 * it. A group's follow-up, a person's or an Agent's, is a reply started like any other, so
 * the owner's replies a minute in its lane decide as for a mention (`overLaneLimit`; its caller's limit does not: what
 * it answers was folded into a reply under way, never refused): counted under the owner's `accounts` row (the lock
 * order's last step; the caller holds the group's row, the Agent's and the run's), and over it the Agent's reusable
 * `rate_limited` run in the group records it instead (`rateLimitedInGroup`), so a member who keeps mentioning an Agent
 * while it replies cannot keep it replying past its owner's limit. Its lane and caller come from what it
 * answers, not from the run that ended: the messages in (covers, pending] that call the Agent — a person's, as above,
 * or another Agent's while its `groupMentions` lets members call it, which is that Agent's owner's call (with no block
 * between them and the Agent's owner, as for a person) — make it its owner's own when the owner or one of the owner's
 * Agents is among them, else the earliest caller's. When none of them is left (a block since, or the Agent no longer
 * lets members call it) it is others', with no caller: a call its owner no longer allows does not ride the owner's own
 * lane.
 */
export async function followUp(
  t: Tx,
  agent: AgentRow,
  conversationId: string,
  covers: number,
  pending: number,
  config: RunLimits,
): Promise<FollowUp> {
  const owners = callerOf(agent.ownerId, agent.ownerId);
  if (conversationId === agent.conversationId) return { ...NO_FOLLOW_UP, run: await queueRun(t, agent, conversationId, pending, "human", owners) };
  // The person behind each message: its sender, or an Agent's owner.
  const { rows } = await t.query<{ kind: "human" | "agent"; sender_id: string; caller_id: string; text: string | null }>(
    `select p.kind, m.sender_id, coalesce(p.owner_id, p.id) as caller_id, m.body ->> 'text' as text
       from messages m join principals p on p.id = m.sender_id
      where m.conversation_id = $1 and m.seq > $2 and m.seq <= $3 and m.kind <> 'system' and m.sender_id <> $5
        and not exists (select 1 from blocks b where (b.blocker_id = $4 and b.blocked_id = coalesce(p.owner_id, p.id)) or (b.blocker_id = coalesce(p.owner_id, p.id) and b.blocked_id = $4))
      order by m.seq`,
    [conversationId, covers, pending, agent.ownerId, agent.id],
  );
  const handle = agent.handle.toLowerCase();
  // An Agent's message calls no Agent only its owner may call (`triggerFromAgent`).
  const calls = rows.filter(
    (r) => (agent.groupMentions === "members" || (r.kind === "human" && r.sender_id === agent.ownerId)) && mentionedHandles(r.text ?? "").includes(handle),
  );
  const asked = calls.some((r) => r.kind === "human");
  const first = calls[0];
  const caller: Caller =
    first === undefined ? { id: null, lane: "others" } : calls.some((r) => r.caller_id === agent.ownerId) ? owners : callerOf(agent.ownerId, first.caller_id);
  if (!asked) {
    if (await haltedSince(t, conversationId, pending)) return NO_FOLLOW_UP;
    // The chain budget again, now that the reply that just ended is settled: it may have spent it.
    const spent = await chainBudgetSpent(t, conversationId, agent.id, agent.chainBudgetMicro, await latestHumanSeq(t, conversationId));
    if (spent) return { ...NO_FOLLOW_UP, notices: spent.notice ? [spent.notice] : [] };
  }
  if (caller.lane === "others") {
    const told: Pick<FollowUp, "notices" | "budgetReached"> = { notices: [], budgetReached: [] };
    if (await refusedByOthersBudget(t, conversationId, agent, today(config), told)) return { run: null, ...told };
  }
  const by: TriggeredBy = asked ? "human" : "agent";
  if (await overLaneLimit(t, agent.ownerId, caller.lane, config)) {
    return { ...NO_FOLLOW_UP, run: await rateLimitedInGroup(t, agent, conversationId, pending, by, caller) };
  }
  return { ...NO_FOLLOW_UP, run: await queueRun(t, agent, conversationId, pending, by, caller) };
}

/** What a halt did, to act on after it commits. */
export interface Halted {
  /** The `agents_halted` notice, or null when the group was halted already. */
  notice: StoredMessage | null;
  /** Queued runs it cancelled, each to announce to its owner. */
  cancelled: Announced[];
  /** Running runs it interrupted, whose calls this process abandons (`DbAgentPort.interruptRuns`). */
  running: string[];
}

/**
 * `POST /api/conversations/:id/agents/halt` (ruling 11), by `actorId`: unless the conversation is a group, 404 before
 * any lock; then under the group's row (`lockForWrite`: 404 unless a current member of an open conversation)
 * `agents_halted_seq` becomes the group's current seq, so Agents' messages call nobody until a person writes again. The
 * runs Agents' messages called for end: a queued one is `cancelled`, `halted` (it never reached a model); a running one
 * is marked `interrupted` `halted` — never posted, it ends `cancelled` with that reason and is settled as any; what a
 * person asked of it meanwhile still gets its follow-up (`followUp`). Runs a person called for are left alone. The
 * `agents_halted` notice is appended unless the group was halted already (no person has written since the last halt):
 * then nothing changes. Lock order: the group's row, then run rows; no `agents` or `accounts` row.
 */
export async function haltAgents(t: Tx, conversationId: string, actorId: string): Promise<Halted> {
  if ((await peekConversation(t, conversationId))?.type !== "group") throw notFound();
  const lock = await lockForWrite(t, conversationId, actorId);
  const already = await isHalted(t, conversationId, await latestHumanSeq(t, conversationId));
  await t.query("update conversations set agents_halted_seq = greatest(coalesce(agents_halted_seq, 0), $2) where id = $1", [conversationId, lock.conversation.seq]);
  const queued = await t.query<RunRow & { owner_id: string }>(
    `update agent_runs as r set status = 'cancelled', error = 'halted', finished_at = now()
      where r.conversation_id = $1 and r.status = 'queued' and r.triggered_by = 'agent' returning ${RUN_COLUMNS}, r.owner_id`,
    [conversationId],
  );
  const running = await t.query<{ id: string }>(
    `update agent_runs set interrupted = 'halted'
      where conversation_id = $1 and status = 'running' and triggered_by = 'agent' and interrupted is null returning id`,
    [conversationId],
  );
  return {
    notice: already ? null : await appendSystem(t, conversationId, { event: "agents_halted", actorId }),
    cancelled: queued.rows.map((r) => ({ ownerId: r.owner_id, conversationId, run: toWireRun(r) })),
    running: running.rows.map((r) => r.id),
  };
}

/**
 * The trigger (spec 6.5): in the send transaction, after a person's `message` was stored (not a repeat), under the
 * send's locks. In a group: `triggerInGroup`, the Agent members its text names by `@handle`. In an Agent conversation
 * only a message from the owner counts, and nothing happens when the Agent is paused, deleted or has no model, or
 * answers only when called (`replyMode` `mention`) and the text calls it neither by `@handle` nor by `@name`. With a
 * reply of the Agent already active in this conversation the message is folded into it: a queued one now covers it, a
 * running one notes it in `pending_seq` (one follow-up answers everything that came meanwhile); a reply active in
 * another conversation is not touched. Otherwise a reply is queued here — unless the owner has started their own
 * `agentRunsPerMinute` in the last minute (every reply here is their own: `overLaneLimit`): then a `failed` run,
 * `rate_limited`, is recorded instead (`recordRateLimited`; the message stays sent). Returns the runs to announce and,
 * in a group, the calls their caller's limit refused, to log, and what the others' daily budget appended — the notices
 * to publish after the message, the owners to push their Agents to — after commit (nothing in a direct chat).
 */
export async function maybeTrigger(t: Tx, lock: WriteLock, message: StoredMessage, config: RunLimits): Promise<Triggered> {
  if (message.kind === "system") return noneTriggered();
  if (lock.conversation.type === "group") return triggerInGroup(t, lock.conversation.id, message, config);
  if (lock.conversation.type !== "agent") return noneTriggered();
  const conversationId = lock.conversation.id;
  const found = await t.query<{ agent_id: string }>("select agent_id from agent_conversations where conversation_id = $1", [conversationId]);
  if (!found.rows[0]) return noneTriggered();
  const agent = await lockAgent(t, found.rows[0].agent_id, conversationId);
  if (message.senderId !== agent.ownerId || agent.paused || agent.deleted || agent.model === null) return noneTriggered();
  if (agent.replyMode === "mention" && !mentions(textOf(message), agent)) return noneTriggered();
  // Its owner's message: every reply here is the owner's own.
  const caller = callerOf(agent.ownerId, message.senderId);

  const folded = await t.query(
    `update agent_runs
        set covers_seq = case when status = 'queued' then greatest(covers_seq, $3) else covers_seq end,
            pending_seq = case when status = 'running' then greatest(pending_seq, $3) else pending_seq end
      where agent_id = $1 and conversation_id = $2 and status in ('queued', 'running')`,
    [agent.id, conversationId, message.seq],
  );
  if (folded.rowCount) return noneTriggered();
  const over = await overLaneLimit(t, agent.ownerId, caller.lane, config);
  const run = over ? await recordRateLimited(t, agent, conversationId, message.seq, "human", caller) : await queueRun(t, agent, conversationId, message.seq, "human", caller);
  return { ...noneTriggered(), runs: [run] };
}

/**
 * In a group, under its row (`lockForWrite`: 404 unless `ownerId` is a current member of it): the Agent `agentId` names,
 * when it is `ownerId`'s — 400 without `agentId` (it is required in a group), 404 as for an Agent that does not exist
 * for anyone else's, a person's or an unknown id — and the seq it joined the group at in its current stay, or null when
 * it is not in the group now.
 */
async function ownAgentInGroup(
  t: Tx,
  ownerId: string,
  conversationId: string,
  agentId: string | undefined,
): Promise<{ agentId: string; joinedSeq: number | null }> {
  await lockForWrite(t, conversationId, ownerId);
  if (agentId === undefined) throw new AppError(400, "invalid_request");
  const { rows } = await t.query<{ joined: string | null }>(
    `select (select m.joined_seq::text from memberships m where m.conversation_id = $3 and m.principal_id = p.id and m.left_seq is null) as joined
       from principals p join agents a on a.principal_id = p.id
      where p.id = $2 and p.kind = 'agent' and p.owner_id = $1`,
    [ownerId, agentId, conversationId],
  );
  if (!rows[0]) throw notFound();
  return { agentId, joinedSeq: rows[0].joined === null ? null : Number(rows[0].joined) };
}

/**
 * The Agent's latest reply run in the conversation (whatever its stay): what it covered (`covers`), that and what was
 * noted on it besides (`answers`: the greater of `covers_seq` and `pending_seq`), and whose message called for it.
 */
async function latestRunOf(
  q: Queryable,
  agentId: string,
  conversationId: string,
): Promise<(RunRow & { covers: string | null; answers: string | null; triggered_by: TriggeredBy }) | null> {
  const { rows } = await q.query<RunRow & { covers: string | null; answers: string | null; triggered_by: TriggeredBy }>(
    `select ${RUN_COLUMNS}, r.covers_seq::text as covers, greatest(r.covers_seq, coalesce(r.pending_seq, 0))::text as answers, r.triggered_by
       from agent_runs r
      where r.agent_id = $1 and r.conversation_id = $2 and r.purpose = 'reply' order by r.created_at desc, r.id desc limit 1`,
    [agentId, conversationId],
  );
  return rows[0] ?? null;
}

const isGroup = async (q: Queryable, conversationId: string): Promise<boolean> => (await peekConversation(q, conversationId))?.type === "group";

/**
 * `POST …/runs/retry`: a new queued reply answering up to the owner's last message, only when the conversation's
 * latest run failed. 404 unless it is the caller's Agent conversation; 409 `agent_deleted` / `agent_paused`; 409
 * `busy_run` while a reply is queued or running; 400 when the latest run did not fail (or there is none) or the Agent
 * has no model; 429 over the owner's own `agentRunsPerMinute`. In a group, for the Agent `agentId` names
 * (`retryInGroup`); elsewhere `agentId` plays no part. A retry is its owner's call: the owner's own (`lane` `own`),
 * wherever it is, held to their own lane's limit.
 */
export async function retryRun(t: Tx, ownerId: string, conversationId: string, agentId: string | undefined, config: RunLimits): Promise<Announced> {
  if (await isGroup(t, conversationId)) return retryInGroup(t, ownerId, conversationId, agentId, config);
  const ownAgentId = await ownedAgentOf(t, ownerId, conversationId);
  if (!ownAgentId) throw notFound();
  const agent = await lockAgent(t, ownAgentId, conversationId);
  if (agent.deleted) throw new AppError(409, "agent_deleted");
  if (agent.paused) throw new AppError(409, "agent_paused");
  const latest = await latestRun(t, conversationId);
  if (latest?.status === "queued" || latest?.status === "running") throw new AppError(409, "busy_run");
  if (latest?.status !== "failed" || agent.model === null) throw new AppError(400, "invalid_request");
  if (await overLaneLimit(t, ownerId, "own", config)) throw new AppError(429, "rate_limited");
  const last = await t.query<{ seq: string | null }>(
    "select max(seq)::text as seq from messages where conversation_id = $1 and sender_id = $2 and kind <> 'system'",
    [conversationId, ownerId],
  );
  if (last.rows[0]?.seq == null) throw new AppError(400, "invalid_request");
  return queueRun(t, agent, conversationId, Number(last.rows[0].seq), "human", callerOf(ownerId, ownerId));
}

/**
 * Retry in a group (wire contract "Run state"): the owner's Agent's latest run there, when it failed in the Agent's
 * current stay, is answered again — a new queued run covering what it covered and what was noted on it (the greater of
 * its `covers_seq` and `pending_seq`: a run recovery or a release failed is not followed up), called for by whoever
 * called the failed one (`triggered_by` kept: one an Agent's message called for is still an Agent's, so a member's
 * halt still ends it), and its owner's own whoever's the failed one was (its owner asked again). Not for an Agent that
 * is not in the group now, nor for a run from before it last joined; a run a halt or the Agent's leaving cancelled
 * (`halted`, `agent_removed`) did not fail: 400 like any other; 429 over the owner's own `agentRunsPerMinute`. Lock
 * order: the group's row → the Agent's → run rows → the owner's `accounts` row.
 */
async function retryInGroup(t: Tx, ownerId: string, conversationId: string, agentId: string | undefined, config: RunLimits): Promise<Announced> {
  const own = await ownAgentInGroup(t, ownerId, conversationId, agentId);
  const joinedSeq = own.joinedSeq;
  const agent = await lockAgent(t, own.agentId, conversationId);
  if (agent.deleted) throw new AppError(409, "agent_deleted");
  if (agent.paused) throw new AppError(409, "agent_paused");
  const latest = await latestRunOf(t, agent.id, conversationId);
  if (latest?.status === "queued" || latest?.status === "running") throw new AppError(409, "busy_run");
  const covers = latest?.covers == null ? null : Number(latest.covers);
  if (latest?.status !== "failed" || agent.model === null || joinedSeq === null || covers === null || covers <= joinedSeq) {
    throw new AppError(400, "invalid_request");
  }
  if (await overLaneLimit(t, ownerId, "own", config)) throw new AppError(429, "rate_limited");
  return queueRun(t, agent, conversationId, Number(latest.answers), latest.triggered_by, callerOf(ownerId, ownerId));
}

/**
 * `POST …/runs/:runId/stop`: a queued run is stopped at once (it never reached a model: nothing to settle); a running
 * one is reported, so the caller can flag it for the worker working on it, or release it when nobody here is; a
 * finished one is left as it is. 404 unless the run is of the caller's Agent conversation — or, in a group the caller is
 * a current member of (whose row is locked first, `lockForWrite`, as every writer of runs there does), one of the
 * caller's Agents' runs there: another member's Agent's run is the 404 of a run that does not exist.
 */
export async function stopRun(t: Tx, ownerId: string, conversationId: string, runId: string): Promise<{ stopped: Announced | null; running: boolean }> {
  if (await isGroup(t, conversationId)) await lockForWrite(t, conversationId, ownerId);
  else if (!(await ownedAgentOf(t, ownerId, conversationId))) throw notFound();
  const { rows } = await t.query<{ status: RunStatus }>(
    "select status from agent_runs where id = $1 and conversation_id = $2 and owner_id = $3 and purpose = 'reply' for update",
    [runId, conversationId, ownerId],
  );
  const status = rows[0]?.status;
  if (status === undefined) throw notFound();
  if (status !== "queued") return { stopped: null, running: status === "running" };
  const stopped = await t.query<RunRow>(
    `update agent_runs as r set status = 'stopped', finished_at = now() where r.id = $1 returning ${RUN_COLUMNS}`,
    [runId],
  );
  return { stopped: { ownerId, conversationId, run: toWireRun(stopped.rows[0]!) }, running: false };
}

/** A failure its owner dismissed in a group: the others are told its Agent's state again (`Hub.pushRunState`). */
export interface Dismissed {
  conversationId: string;
  runId: string;
}

/**
 * `POST …/runs/dismiss`: the latest run, if it failed, is no longer shown by `GET …/run`. 404 unless the caller's. In a
 * group (`agentId` required; `ownAgentInGroup`): the latest run of that Agent there, also when the Agent has left the
 * group since; returns it when this dismissed it, so the other members can be told. Elsewhere `agentId` plays no part.
 */
export async function dismissRun(t: Tx, ownerId: string, conversationId: string, agentId: string | undefined): Promise<Dismissed | null> {
  if (await isGroup(t, conversationId)) {
    const own = await ownAgentInGroup(t, ownerId, conversationId, agentId);
    const { rows } = await t.query<{ id: string }>(
      `update agent_runs set dismissed_at = now()
        where id = (select id from agent_runs where agent_id = $1 and conversation_id = $2 and purpose = 'reply' order by created_at desc, id desc limit 1)
          and status = 'failed' and dismissed_at is null
        returning id`,
      [own.agentId, conversationId],
    );
    return rows[0] ? { conversationId, runId: rows[0].id } : null;
  }
  if (!(await ownedAgentOf(t, ownerId, conversationId))) throw notFound();
  await t.query(
    `update agent_runs set dismissed_at = now()
      where id = (select id from agent_runs where conversation_id = $1 order by created_at desc, id desc limit 1)
        and status = 'failed' and dismissed_at is null`,
    [conversationId],
  );
  return null;
}
