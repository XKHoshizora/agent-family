import type { Db, Queryable, Tx } from "../../db.ts";
import { NO_STATE, type GroupState } from "./threshold.ts";

/**
 * An Agent's state in a group as `agent_group_state` stores it (batch 2D): what its threshold rises and falls by
 * (threshold.ts), the message its surcharge was stamped after, and when it was last judged there — read, locked and
 * written here alone, for the decision (decide.ts). Its rows are only ever locked in Agent id order (`stampJudged`,
 * `lockStates`), so two decisions never wait on each other's rows in a cycle.
 */

/** An Agent's state in the group as stored: the threshold's, and the message its surcharge was stamped after. */
export interface Stored {
  state: GroupState;
  surchargeSeq: number | null;
}

/**
 * Whether the message at `seq` already led to a proactive reply in the group: a surcharge of any Agent there was stamped
 * after it. Read before the judgement is asked (such a message is not judged again) and again under the group's row,
 * where it is certain (every writer of `surcharge_seq` holds that row): a decision racing this one may have led to it.
 */
export async function decidedAlready(q: Queryable, conversationId: string, seq: number): Promise<boolean> {
  const { rowCount } = await q.query("select 1 from agent_group_state where conversation_id = $1 and surcharge_seq >= $2 limit 1", [conversationId, seq]);
  return rowCount !== 0;
}

/**
 * After a judgement, whatever came of it: each of `agentIds` stamped as judged in the group now (`judged_at`), and, when
 * the judgement was answered, as judged up to the message at `answeredSeq` (`judged_seq`, never lowered; null: it was
 * not answered, and what it was shown is new to the next one still). The rows not there yet are inserted first, on their
 * own: a new row waits for the group's row (its foreign key) while holding no other. Then every one is locked in id order
 * and stamped.
 */
export async function stampJudged(db: Db, conversationId: string, agentIds: readonly string[], answeredSeq: number | null): Promise<void> {
  await db.query(
    "insert into agent_group_state (agent_id, conversation_id, judged_at) select unnest($1::uuid[]), $2, now() on conflict (agent_id, conversation_id) do nothing",
    [agentIds, conversationId],
  );
  await db.query(
    `with locked as (select agent_id from agent_group_state where conversation_id = $2 and agent_id = any($1::uuid[]) order by agent_id for update)
     update agent_group_state s set judged_at = now(), judged_seq = greatest(s.judged_seq, $3::bigint)
       from locked where s.conversation_id = $2 and s.agent_id = locked.agent_id`,
    [agentIds, conversationId, answeredSeq],
  );
}

/**
 * The message the options were last judged up to in the group: the latest `judged_seq` among `agentIds`, null when none
 * was ever judged there with an answer.
 */
export async function judgedUpTo(q: Queryable, conversationId: string, agentIds: readonly string[]): Promise<number | null> {
  const { rows } = await q.query<{ seq: string | null }>(
    "select max(judged_seq)::text as seq from agent_group_state where conversation_id = $1 and agent_id = any($2::uuid[])",
    [conversationId, agentIds],
  );
  return rows[0]?.seq == null ? null : Number(rows[0].seq);
}

/**
 * The state of each of `ids` (in id order) in the group, its row locked before anything is written: every row in id
 * order, as `stampJudged` locks them (rows are written in other orders — the winner's last — so locking them only as each
 * is written could deadlock with another decision's stamp). `stampJudged` inserted them; one missing (none stored:
 * `NO_STATE`) is inserted first, in the same order.
 */
export async function lockStates(t: Tx, conversationId: string, ids: readonly string[]): Promise<Map<string, Stored>> {
  if (ids.length === 0) return new Map();
  await t.query("insert into agent_group_state (agent_id, conversation_id) select unnest($1::uuid[]), $2 on conflict (agent_id, conversation_id) do nothing", [
    ids,
    conversationId,
  ]);
  const { rows } = await t.query<{
    agent_id: string;
    surcharge: number;
    surcharge_at: Date | null;
    surcharge_seq: string | null;
    quiet: number;
    quiet_half_life_s: number | null;
    quiet_at: Date | null;
  }>(
    `select agent_id, surcharge, surcharge_at, surcharge_seq::text as surcharge_seq, quiet, quiet_half_life_s, quiet_at
       from agent_group_state where conversation_id = $1 and agent_id = any($2::uuid[])
      order by agent_id
        for update`,
    [conversationId, ids],
  );
  const found = new Map(
    rows.map((r): [string, Stored] => [
      r.agent_id,
      {
        state: { surcharge: r.surcharge, surchargeAt: r.surcharge_at, othersSince: 0, quiet: r.quiet, quietHalfLifeS: r.quiet_half_life_s, quietAt: r.quiet_at },
        surchargeSeq: r.surcharge_seq === null ? null : Number(r.surcharge_seq),
      },
    ]),
  );
  return new Map(ids.map((id) => [id, found.get(id) ?? { state: NO_STATE, surchargeSeq: null }]));
}

/** Writes the Agent's state in the group (all but `judged_at`, which `stampJudged` alone writes). */
export async function saveState(t: Tx, agentId: string, conversationId: string, s: Stored): Promise<void> {
  await t.query(
    `insert into agent_group_state (agent_id, conversation_id, surcharge, surcharge_at, surcharge_seq, quiet, quiet_half_life_s, quiet_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (agent_id, conversation_id) do update
       set surcharge = excluded.surcharge, surcharge_at = excluded.surcharge_at, surcharge_seq = excluded.surcharge_seq,
           quiet = excluded.quiet, quiet_half_life_s = excluded.quiet_half_life_s, quiet_at = excluded.quiet_at`,
    [agentId, conversationId, s.state.surcharge, s.state.surchargeAt, s.surchargeSeq, s.state.quiet, s.state.quietHalfLifeS, s.state.quietAt],
  );
}

/**
 * Messages that are not notices, by anyone but Agent `agentId`, after its surcharge was stamped, up to `seq`: what halves
 * its surcharge every `halfMessages`. Not counted past 20 halvings (a millionth is left); nothing to count without one.
 */
export async function othersSinceSurcharge(t: Tx, conversationId: string, agentId: string, stored: Stored, seq: number, halfMessages: number): Promise<number> {
  if (stored.surchargeSeq === null || !(stored.state.surcharge > 0)) return 0;
  const { rows } = await t.query<{ n: number }>(
    `select count(*)::int as n from (
       select 1 from messages
        where conversation_id = $1 and seq > $2 and seq <= $3 and kind <> 'system' and sender_id <> $4
        limit $5) x`,
    [conversationId, stored.surchargeSeq, seq, agentId, halfMessages * 20],
  );
  return rows[0]!.n;
}
