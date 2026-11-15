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

export type DirectRefusal = "not_friends" | "blocked";

/** Why a direct message between the two must be refused, or null. A block wins over missing friendship. */
export async function canDirectSend(t: Queryable, a: string, b: string): Promise<null | DirectRefusal> {
  const verdict = (await canDirectSendMany(t, a, [b])).get(b.toLowerCase());
  return verdict === undefined ? "not_friends" : verdict; // no answer is a refusal, never a permission
}

/**
 * `canDirectSend` between `a` and each of `others` in one query (keys are lower-case ids): the one place
 * the rule is written. A block in either direction wins over a missing friendship.
 */
export async function canDirectSendMany(t: Queryable, a: string, others: string[]): Promise<Map<string, null | DirectRefusal>> {
  if (others.length === 0) return new Map();
  const { rows } = await t.query<{ other: string; blocked: boolean; friends: boolean }>(
    `select o.id as other,
            exists (select 1 from blocks b
                     where (b.blocker_id = $1 and b.blocked_id = o.id) or (b.blocker_id = o.id and b.blocked_id = $1)) as blocked,
            exists (select 1 from friendships f
                     where f.a_id = least($1::uuid, o.id) and f.b_id = greatest($1::uuid, o.id)) as friends
       from unnest($2::uuid[]) as o (id)`,
    [a, others],
  );
  return new Map(rows.map((r) => [r.other, r.blocked ? "blocked" : r.friends ? null : "not_friends"]));
}
