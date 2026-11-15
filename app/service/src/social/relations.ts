import type { Queryable } from "../db.ts";
import { orderedPair } from "./pair.ts";

// Read-only questions about a pair. A leaf module, so conversations can ask them without importing
// the social mutations (which in turn write notices into conversations).

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
