import type { Tx } from "../db.ts";

/** Canonical (low, high) order of an unordered pair; matches uuid ordering in Postgres. */
export function orderedPair(a: string, b: string): [string, string] {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x < y ? [x, y] : [y, x];
}

/** Serialises every social mutation on this pair until the transaction ends. */
export async function lockPair(t: Tx, a: string, b: string): Promise<void> {
  const [lo, hi] = orderedPair(a, b);
  await t.query("select pg_advisory_xact_lock(hashtext($1))", [lo + hi]);
}
