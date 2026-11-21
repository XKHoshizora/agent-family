import { VISIBLE_JOIN } from "../../conversations/store.ts";
import type { Queryable } from "../../db.ts";
import { notAcknowledgement, type AttachmentRef } from "../../messages/model.ts";
import { postingRun } from "../../messages/read.ts";
import { handleOf } from "../../principals/store.ts";

/**
 * The rolling summary's rows (migration 052; README "The rolling summary"): one per conversation and Agent. What reads it
 * is the reply's context (agents/context.ts `loadContext`, which decides whether a reply may be shown it) and the job that
 * updates it (job.ts); what deletes it, a new topic and the end of the Agent's membership of a group. Nothing else reads
 * it: no route, no search, no tool, no memory review.
 *
 * Also the one reader of the messages a summary is made of (`readPlaced`, `countPlaced`): by their *place* — a message's
 * seq, and for an Agent's reply posted by a run the seq that run covered (messages/read.ts `postingRun`), as the reply's
 * context orders them (agents/context.ts `loadPage`'s `answers`) — so that a reply always falls on the side of the question it
 * answered: a boundary of what is summarised never splits an exchange. A tool call and its result are never among them: they
 * live in one reply's rounds (agents/runtime/loop.ts) and are never stored as messages.
 */

/**
 * Whose messages are read for Agent `agentId`'s summary of `conversationId` (`group`: a group's), with the Agent as reader
 * (`VISIBLE_JOIN`: nothing from before it joined): in its own conversation its owner's (`ownerId`) and its own, in a group
 * everyone's; text and file messages only, never a notice nor the fixed greeting.
 */
export interface PlacedReader {
  agentId: string;
  ownerId: string;
  conversationId: string;
  group: boolean;
}

/** `$1` the Agent, `$2` the conversation, `$3`/`$4` the places (after, up to and with), `$5` group, `$6` the owner. */
const PLACED_FROM = `from messages m ${VISIBLE_JOIN}
  left join agent_runs r on m.sender_id = $1 and ${postingRun("m", "r")}`;
const PLACED_WHERE = `where m.conversation_id = $2 and m.kind in ('text', 'file') and (m.body -> 'fixed') is distinct from 'true'::jsonb
    and ${notAcknowledgement("m")}
    and m.seq > $3 and coalesce(r.covers_seq, m.seq) > $3 and coalesce(r.covers_seq, m.seq) <= $4
    and ($5::boolean or m.sender_id in ($1, $6))`;

const placedParams = (r: PlacedReader, after: number, upto: number) => [r.agentId, r.conversationId, after, upto, r.group, r.ownerId];

/**
 * How many messages `r` reads whose place is after `after` and at most `upto` — of them, with `maxSeq`, only those stored at
 * or before seq `maxSeq` (a read bounded on both sides; agents/context.ts counts the rest from what it loaded).
 */
export async function countPlaced(q: Queryable, r: PlacedReader, after: number, upto: number, maxSeq?: number): Promise<number> {
  if (upto <= after) return 0;
  const { rows } = await q.query<{ n: number }>(`select count(*)::int as n ${PLACED_FROM} ${PLACED_WHERE} and ($7::bigint is null or m.seq <= $7::bigint)`, [
    ...placedParams(r, after, upto),
    maxSeq ?? null,
  ]);
  return rows[0]?.n ?? 0;
}

/** Everyone `r` reads a message of whose place is after `after` and at most `upto`: their name, handle (as everyone is shown it, `handleOf`: an Agent's is `owner.name`) and kind, each once. */
export async function placedSpeakers(q: Queryable, r: PlacedReader, after: number, upto: number): Promise<Array<{ id: string; name: string; handle: string; kind: "human" | "agent" }>> {
  if (upto <= after) return [];
  const { rows } = await q.query<{ id: string; name: string; handle: string; kind: "human" | "agent" }>(
    `select distinct sp.id, sp.display_name as name, ${handleOf("sp")} as handle, sp.kind
       ${PLACED_FROM}
       join principals sp on sp.id = m.sender_id
      ${PLACED_WHERE}`,
    placedParams(r, after, upto),
  );
  return rows;
}

/** A message as a summary reads it: its place, who sent it (their name, handle as `placedSpeakers` reads it, and kind), its text and its attachment. */
export interface PlacedMessage {
  at: number;
  seq: number;
  senderId: string;
  name: string;
  handle: string;
  kind: "human" | "agent";
  text: string;
  attachment: AttachmentRef | null;
}

/** The first `limit` messages `r` reads whose place is after `after` and at most `upto`, by place and then seq. */
export async function readPlaced(q: Queryable, r: PlacedReader, after: number, upto: number, limit: number): Promise<PlacedMessage[]> {
  if (upto <= after) return [];
  const { rows } = await q.query<{ at: string; seq: string; sender_id: string; name: string; handle: string; kind: "human" | "agent"; text: string | null; attachment: AttachmentRef | null }>(
    `select coalesce(r.covers_seq, m.seq)::text as at, m.seq::text as seq, m.sender_id, sp.display_name as name, ${handleOf("sp")} as handle, sp.kind,
            m.body ->> 'text' as text, m.body -> 'attachment' as attachment
       ${PLACED_FROM}
       join principals sp on sp.id = m.sender_id
      ${PLACED_WHERE}
      order by coalesce(r.covers_seq, m.seq), m.seq
      limit $7`,
    [...placedParams(r, after, upto), limit],
  );
  return rows.map((row) => ({
    at: Number(row.at),
    seq: Number(row.seq),
    senderId: row.sender_id,
    name: row.name,
    handle: row.handle,
    kind: row.kind,
    text: row.text ?? "",
    attachment: row.attachment,
  }));
}

/**
 * Agent `agentId`'s current stay in `conversationId`, in one read: where its membership began (`joined`, the visibility rule's
 * `joined_seq`) and the latest new topic it can see there (`topic`, the seq of the latest `topic_reset` after it; 0 when none).
 * Null when it is not a member there now. What a reply's context starts after (agents/context.ts `loadContext`) and where
 * a summary may begin (`summaryBase`) are both read from it.
 */
export async function stayOf(q: Queryable, agentId: string, conversationId: string): Promise<{ joined: number; topic: number } | null> {
  const { rows } = await q.query<{ joined: string; topic: string }>(
    `select ms.joined_seq::text as joined,
            coalesce((select max(m.seq) from messages m
                       where m.conversation_id = ms.conversation_id and m.seq > ms.joined_seq
                         and m.kind = 'system' and m.body ->> 'event' = 'topic_reset'), 0)::text as topic
       from memberships ms
      where ms.conversation_id = $2 and ms.principal_id = $1 and ms.left_seq is null`,
    [agentId, conversationId],
  );
  return rows[0] ? { joined: Number(rows[0].joined), topic: Number(rows[0].topic) } : null;
}

/** Where a stay's summary may begin: after the later of its joining and its latest new topic (`stayOf`); null with no stay. */
export const baseOf = (stay: { joined: number; topic: number } | null): number | null => (stay === null ? null : Math.max(stay.joined, stay.topic));

/** `baseOf` the Agent's current stay, read now: a summary covers only what is after it. Null when the Agent is not a member there. */
export const summaryBase = async (q: Queryable, agentId: string, conversationId: string): Promise<number | null> => baseOf(await stayOf(q, agentId, conversationId));

/**
 * A pair's summary: `text` covers the messages its Agent could see whose place in the conversation (`position`: a message's
 * seq; an Agent's reply, the seq its run covered) is from `fromSeq` to `uptoSeq`, both included.
 */
export interface Summary {
  fromSeq: number;
  uptoSeq: number;
  text: string;
}

/** The summary of Agent `agentId` in `conversationId`, or null. A plain read. */
export async function readSummary(q: Queryable, conversationId: string, agentId: string): Promise<Summary | null> {
  const { rows } = await q.query<{ from_seq: string; upto_seq: string; text: string }>(
    "select from_seq::text, upto_seq::text, text from conversation_summaries where conversation_id = $1 and agent_id = $2",
    [conversationId, agentId],
  );
  const row = rows[0];
  return row ? { fromSeq: Number(row.from_seq), uptoSeq: Number(row.upto_seq), text: row.text } : null;
}

/** Stores the pair's summary as `s` (inserted, or replacing the one there), in the caller's transaction. */
export async function writeSummary(q: Queryable, conversationId: string, agentId: string, s: Summary): Promise<void> {
  await q.query(
    `insert into conversation_summaries (conversation_id, agent_id, from_seq, upto_seq, text, updated_at)
     values ($1, $2, $3, $4, $5, now())
     on conflict (conversation_id, agent_id) do update
       set from_seq = excluded.from_seq, upto_seq = excluded.upto_seq, text = excluded.text, updated_at = now()`,
    [conversationId, agentId, s.fromSeq, s.uptoSeq, s.text],
  );
}

/**
 * Deletes the summaries of `conversationId` of whichever of `principalIds` are Agents, in the caller's transaction: a new
 * topic (its Agent), and the end of memberships of a group (everyone who left: only an Agent has one).
 */
export async function forgetSummaries(q: Queryable, conversationId: string, principalIds: readonly string[]): Promise<void> {
  if (principalIds.length === 0) return;
  await q.query("delete from conversation_summaries where conversation_id = $1 and agent_id = any($2::uuid[])", [conversationId, [...new Set(principalIds)]]);
}
