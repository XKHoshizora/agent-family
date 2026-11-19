import type { Queryable } from "../db.ts";

/**
 * How long the record of a change (`memory_changes`) is kept once it is over: for the owner's undo and the chip that shows it.
 * Longer than that nobody undoes it (and an undo of one that is gone is a 404, as for any change that is not theirs); the notice in the
 * conversation stays, without actions (messages/read.ts: `status: "expired"`).
 */
export const CHANGE_KEEP_DAYS = 30;

/** A run works through at most `CHANGE_SWEEP_BATCHES` batches of `CHANGE_SWEEP_BATCH` rows for each of its two jobs; what is left waits for the next run. */
export const CHANGE_SWEEP_BATCH = 500;
export const CHANGE_SWEEP_BATCHES = 20;

/**
 * The periodic clean-up of `memory_changes` (app.ts runs it on its own timer, and `attachments:sweep` by hand): a pending change older than
 * `CHANGE_KEEP_DAYS` days is discarded — nobody is going to answer it — and a change that is over (applied, undone, discarded) is
 * deleted once it is that old, counted from when it was resolved (from when it was made, for one applied at once). Bounded work: in batches
 * (`limits`, by default `CHANGE_SWEEP_BATCH` rows, `CHANGE_SWEEP_BATCHES` times), the index `(status, resolved_at)` finds them. `now` is the
 * clock. Never reads or logs a note.
 */
export async function sweepMemoryChanges(
  q: Queryable,
  now: Date = new Date(),
  limits: { batch?: number; batches?: number } = {},
): Promise<{ discarded: number; deleted: number }> {
  const batch = limits.batch ?? CHANGE_SWEEP_BATCH;
  const batches = limits.batches ?? CHANGE_SWEEP_BATCHES;
  const total = { discarded: 0, deleted: 0 };
  for (let i = 0; i < batches; i++) {
    const stale = await q.query(
      `update memory_changes set status = 'discarded', resolved_at = $1::timestamptz
        where id in (select id from memory_changes where status = 'pending' and created_at < $1::timestamptz - $2::int * interval '1 day' limit $3)`,
      [now, CHANGE_KEEP_DAYS, batch],
    );
    total.discarded += stale.rowCount ?? 0;
    if ((stale.rowCount ?? 0) < batch) break;
  }
  for (let i = 0; i < batches; i++) {
    const gone = await q.query(
      `delete from memory_changes
        where id in (
          select id from memory_changes
           where status in ('applied', 'undone', 'discarded')
             and (resolved_at < $1::timestamptz - $2::int * interval '1 day'
                  or (resolved_at is null and created_at < $1::timestamptz - $2::int * interval '1 day'))
           limit $3)`,
      [now, CHANGE_KEEP_DAYS, batch],
    );
    total.deleted += gone.rowCount ?? 0;
    if ((gone.rowCount ?? 0) < batch) break;
  }
  return total;
}
