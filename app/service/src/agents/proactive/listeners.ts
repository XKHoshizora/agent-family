import type { Queryable } from "../../db.ts";
import { labelName } from "../runtime/prompt.ts";

/**
 * The Agents that listen in a group for what is said about their owner (the memory plan, Task 8): the judgement that
 * decides who replies unasked is also asked, on their behalf, whether someone else just said something lasting about the
 * owner (`hearsay`) and whether the owner just said something lasting about themselves (`own`). A listener is one owner:
 * all that owner's Agents in the group share the questions. What the answers raise are rows of `memory_flags`, read later
 * by the reviewer; nothing here writes a note.
 */

/** The most owners one judgement listens for: two questions each, and a judgement holds only so many. */
export const MAX_LISTENERS = 20;

/** One owner whose Agents listen in the group. */
export interface Listener {
  /** `h1`, `h2`, … in owner id order; the hearsay question's key (the owner's own question is `{key}o`). */
  key: string;
  ownerId: string;
  /** The owner's name as a label shows it (`labelName`). */
  ownerName: string;
  /** The owner's Agents in the group that listen (memory on), in id order. */
  agentIds: string[];
  /** The latest seq any of them joined at: nothing from before it may be shown. */
  joinedSeq: number;
  /** The Agent that reviews the owner's own remarks here: memory on, shared notes on, the lowest id; null: none. */
  reviewerId: string | null;
}

/** A flagged message, as `memory_flags` stores it. */
export interface MemoryFlag {
  agentId: string;
  conversationId: string;
  seq: number;
  kind: "hearsay" | "own";
}

/**
 * The owners whose Agents listen to the group at message `seq`: current Agent members that joined before it, with memory
 * on, not paused or deleted — one listener per owner, at most `MAX_LISTENERS` (those judged here least recently, never
 * first: `agent_group_state.judged_at`), keyed and returned in owner id order.
 */
export async function listenersFor(q: Queryable, conversationId: string, seq: number): Promise<Listener[]> {
  const { rows } = await q.query<{ owner_id: string; name: string; handle: string; agent_ids: string[]; joined_seq: string; reviewer_id: string | null }>(
    `select x.* from (
       select o.id as owner_id, o.display_name as name, o.handle::text as handle,
              array_agg(p.id order by p.id) as agent_ids, max(m.joined_seq)::text as joined_seq,
              (array_agg(p.id order by p.id) filter (where a.shared_notes))[1] as reviewer_id
         from memberships m
         join principals p on p.id = m.principal_id
         join agents a on a.principal_id = p.id
         join principals o on o.id = p.owner_id
         left join agent_group_state s on s.agent_id = p.id and s.conversation_id = m.conversation_id
        where m.conversation_id = $1 and m.left_seq is null and m.joined_seq < $2 and p.kind = 'agent'
          and a.memory and not a.paused and a.deleted_at is null
        group by o.id, o.display_name, o.handle
        order by min(coalesce(s.judged_at, '-infinity'::timestamptz)), o.id
        limit $3) x
      order by x.owner_id`,
    [conversationId, seq, MAX_LISTENERS],
  );
  return rows.map((r, i) => ({
    key: `h${i + 1}`,
    ownerId: r.owner_id,
    ownerName: labelName(r.name, r.handle),
    agentIds: r.agent_ids,
    joinedSeq: Number(r.joined_seq),
    reviewerId: r.reviewer_id,
  }));
}

/**
 * Writes `flags` (rows already there are left as they are) and returns those it wrote. A flag for an Agent that no longer
 * listens (left, memory off, deleted) or a conversation that is gone is not written: the flag would be read by nobody.
 */
export async function writeFlags(q: Queryable, flags: readonly MemoryFlag[]): Promise<MemoryFlag[]> {
  if (flags.length === 0) return [];
  const { rows } = await q.query<{ agent_id: string; conversation_id: string; seq: string; kind: "hearsay" | "own" }>(
    `insert into memory_flags (agent_id, conversation_id, seq, kind)
     select f.agent_id, f.conversation_id, f.seq, f.kind
       from unnest($1::uuid[], $2::uuid[], $3::bigint[], $4::text[]) as f (agent_id, conversation_id, seq, kind)
       join agents a on a.principal_id = f.agent_id and a.memory and a.deleted_at is null
       join memberships m on m.principal_id = f.agent_id and m.conversation_id = f.conversation_id and m.left_seq is null
     on conflict do nothing
     returning agent_id, conversation_id, seq::text as seq, kind`,
    [flags.map((f) => f.agentId), flags.map((f) => f.conversationId), flags.map((f) => f.seq), flags.map((f) => f.kind)],
  );
  return rows
    .map((r) => ({ agentId: r.agent_id, conversationId: r.conversation_id, seq: Number(r.seq), kind: r.kind }))
    .sort((a, b) => a.seq - b.seq || a.kind.localeCompare(b.kind) || a.agentId.localeCompare(b.agentId));
}
