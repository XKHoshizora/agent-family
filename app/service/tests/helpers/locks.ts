import { expect, vi } from "vitest";
import type { Db } from "../../src/db.ts";

/**
 * Two-connection lock-order tests: another connection holds a row as a send (or any other path) would, while the path under test
 * runs into it; then, released, it asks for what that path holds. With the path taking its locks in the service's order nothing
 * waits in a circle and both commit; out of order, Postgres finds the cycle and aborts one of them (40P01).
 */

type Statement = readonly [sql: string, params: readonly unknown[]];

/**
 * In a transaction of its own: runs `first` (it takes a lock), says so (`locked`), waits for `release`, then runs `then` (it asks for
 * another) and commits (`done`; rejected when it was the one a deadlock aborted).
 */
export function holdThen(db: Db, first: Statement, then: Statement): { locked: Promise<void>; release: () => void; done: Promise<void> } {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let locked!: () => void;
  const isLocked = new Promise<void>((r) => (locked = r));
  const done = db.tx(async (t) => {
    await t.query(first[0], [...first[1]]);
    locked();
    await held;
    await t.query(then[0], [...then[1]]);
  });
  return { locked: isLocked, release, done };
}

/** A send in group `g` holds the group's row (`for update`) and then, as a mention does, asks for the Agent's row. */
export const holdGroupThenAgent = (db: Db, g: string, agentId: string) =>
  holdThen(db, ["select 1 from conversations where id = $1 for update", [g]], ["select 1 from agents where principal_id = $1 for update", [agentId]]);

/**
 * At least `n` statements of this database are waiting for a lock, each one whose text matches one of `like` (`ilike` patterns): the
 * statement under test, not some other waiter (a reviewer's or a sweep's).
 */
export const someoneWaits = (db: Db, like: readonly string[], n = 1) =>
  vi.waitFor(
    async () => {
      const { rows } = await db.query<{ n: number }>(
        "select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query ilike any($1::text[])",
        [like],
      );
      expect(rows[0]!.n).toBeGreaterThanOrEqual(n);
    },
    { timeout: 5000 },
  );
