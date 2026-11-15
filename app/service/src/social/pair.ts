import type { Tx } from "../db.ts";

/** Canonical (low, high) order of an unordered pair; matches uuid ordering in Postgres. */
export function orderedPair(a: string, b: string): [string, string] {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x < y ? [x, y] : [y, x];
}

/**
 * Serialises every social mutation on this pair until the transaction ends. Lock order everywhere:
 * pair lock first, then the conversation row, then anything else.
 *
 * One deliberate exception: social mutations write `friend_requests`, `friendships` and `blocks` rows
 * (taking their row locks) before they lock the pair's direct conversation row to append a notice. That
 * cannot deadlock: every writer of those three tables holds this pair lock first, so they are already
 * serialised, and no holder of a conversation row lock writes or row-locks those tables (sends and
 * membership changes only read them with plain selects, which take no row locks).
 */
export async function lockPair(t: Tx, a: string, b: string): Promise<void> {
  const [lo, hi] = orderedPair(a, b);
  await t.query("select pg_advisory_xact_lock(hashtext($1))", [lo + hi]);
}

/**
 * Several pair locks in one transaction, taken in ascending lock-key order so that two such
 * transactions can never deadlock each other. Same keys as `lockPair`.
 */
export async function lockPairs(t: Tx, pairs: ReadonlyArray<readonly [string, string]>): Promise<void> {
  const keys = pairs.map(([a, b]) => orderedPair(a, b).join(""));
  const { rows } = await t.query<{ key: number }>(
    "select distinct hashtext(k) as key from unnest($1::text[]) as k order by key",
    [keys],
  );
  for (const { key } of rows) await t.query("select pg_advisory_xact_lock($1::int)", [key]);
}
