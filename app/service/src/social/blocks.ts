import type { Queryable, Tx } from "../db.ts";
import { lockPair, orderedPair } from "./pair.ts";

/** Any block between the two, either direction. If both block, `a`'s own block is reported. */
export async function blockBetween(t: Queryable, a: string, b: string): Promise<null | { blocker: string }> {
  const { rows } = await t.query<{ blocker_id: string }>(
    `select blocker_id from blocks
      where (blocker_id = $1 and blocked_id = $2) or (blocker_id = $2 and blocked_id = $1)
      order by (blocker_id = $1) desc limit 1`,
    [a, b],
  );
  return rows[0] ? { blocker: rows[0].blocker_id } : null;
}

export async function areFriends(t: Queryable, a: string, b: string): Promise<boolean> {
  const [lo, hi] = orderedPair(a, b);
  const { rowCount } = await t.query("select 1 from friendships where a_id = $1 and b_id = $2", [lo, hi]);
  return (rowCount ?? 0) > 0;
}

/** Why a direct message between the two must be refused, or null. A block wins over missing friendship. */
export async function canDirectSend(
  t: Queryable,
  a: string,
  b: string,
): Promise<null | "not_friends" | "blocked"> {
  if (await blockBetween(t, a, b)) return "blocked";
  if (!(await areFriends(t, a, b))) return "not_friends";
  return null;
}

export interface BlockResult {
  /** False when the block already existed. */
  created: boolean;
  /** Pending requests this block cancelled (withdrawn if the blocker sent it, rejected if received). */
  cancelledRequestIds: string[];
}

/** Blocking is one-directional, leaves any friendship alone, and cancels pending requests between the pair. */
export async function blockPrincipal(t: Tx, blocker: string, blocked: string): Promise<BlockResult> {
  await lockPair(t, blocker, blocked);
  const ins = await t.query(
    "insert into blocks (blocker_id, blocked_id) values ($1, $2) on conflict do nothing",
    [blocker, blocked],
  );
  const cancelled = await t.query<{ id: string }>(
    `update friend_requests
        set status = case when from_id = $1 then 'withdrawn' else 'rejected' end, resolved_at = now()
      where status = 'pending'
        and least(from_id, to_id) = least($1::uuid, $2::uuid) and greatest(from_id, to_id) = greatest($1::uuid, $2::uuid)
      returning id`,
    [blocker, blocked],
  );
  return { created: (ins.rowCount ?? 0) > 0, cancelledRequestIds: cancelled.rows.map((r) => r.id) };
}

/** Restores nothing but the ability to interact. Returns whether a block was removed. */
export async function unblockPrincipal(t: Tx, blocker: string, blocked: string): Promise<{ removed: boolean }> {
  await lockPair(t, blocker, blocked);
  const del = await t.query("delete from blocks where blocker_id = $1 and blocked_id = $2", [blocker, blocked]);
  return { removed: (del.rowCount ?? 0) > 0 };
}
