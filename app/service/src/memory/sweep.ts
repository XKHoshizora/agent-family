import type { Queryable } from "../db.ts";

/**
 * How long the record of a change (`memory_changes`) is kept once it is over: for the owner's undo and the chip that shows it.
 * Longer than that nobody undoes it (and an undo of one that is gone is a 404, as for any change that is not theirs).
 */
export const CHANGE_KEEP_DAYS = 30;

/**
 * The periodic clean-up of `memory_changes` (app.ts runs it with the attachment sweep): a pending change older than
 * `CHANGE_KEEP_DAYS` days is discarded — nobody is going to answer it — and a change that is over (applied, undone, discarded) is
 * deleted once it is that old, counted from when it was resolved (from when it was made, for one applied at once). `now` is the
 * clock. Never reads or logs a note.
 */
export async function sweepMemoryChanges(q: Queryable, now: Date = new Date()): Promise<{ discarded: number; deleted: number }> {
  const stale = await q.query(
    `update memory_changes set status = 'discarded', resolved_at = $1::timestamptz
      where status = 'pending' and created_at < $1::timestamptz - $2::int * interval '1 day'`,
    [now, CHANGE_KEEP_DAYS],
  );
  const gone = await q.query(
    `delete from memory_changes
      where status in ('applied', 'undone', 'discarded') and coalesce(resolved_at, created_at) < $1::timestamptz - $2::int * interval '1 day'`,
    [now, CHANGE_KEEP_DAYS],
  );
  return { discarded: stale.rowCount ?? 0, deleted: gone.rowCount ?? 0 };
}
