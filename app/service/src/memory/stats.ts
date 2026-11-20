import type { FastifyBaseLogger } from "fastify";
import { siteDay } from "../accounts/store.ts";
import type { Queryable } from "../db.ts";

/**
 * Content-free counters of how the memory feature really behaves (README "Memory counters"): one row of `memory_stats` per
 * site day and name, counted where the behaviour is decided. A count carries no id, owner, conversation or text — only a name
 * from the list in the README and an amount — and is never any reason for what it counts to fail or wait: `count` returns at once,
 * and what goes wrong with it is swallowed.
 */

/** What `count` knows of the service, set once at start-up (`configureStats`): the day it counts on, and where its log lines go. */
let timezone = "UTC";
let sink: Pick<FastifyBaseLogger, "info"> | null = null;

export function configureStats(options: { siteTimezone: string; log: Pick<FastifyBaseLogger, "info"> | null }): void {
  timezone = options.siteTimezone;
  sink = options.log;
}

/** The counts under way: a test waits for them (`settled`). */
const pending = new Set<Promise<void>>();

/** Resolves once every count started so far has been written (or has failed): for tests; the service never waits for one. */
export async function settled(): Promise<void> {
  while (pending.size > 0) await Promise.allSettled([...pending]);
}

const UPSERT =
  "insert into memory_stats (day, name, n) values ($1::date, $2, $3) on conflict (day, name) do update set n = memory_stats.n + excluded.n";

/**
 * Adds `by` (a positive whole number; anything else counts nothing) to counter `name` of today's site day, and logs one
 * `metric` line (`memory_stat`, name and amount). Fire and forget: never throws, never waits for the database.
 */
export function count(db: Queryable, name: string, by = 1): void {
  try {
    if (!Number.isSafeInteger(by) || by <= 0) return;
    const day = siteDay(new Date(), timezone);
    sink?.info({ metric: "memory_stat", name, by }, "a memory counter");
    // `then` so that a `query` that throws is caught as one that rejects.
    const written = Promise.resolve()
      .then(() => db.query(UPSERT, [day, name, by]))
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => pending.delete(written));
    pending.add(written);
  } catch {
    // A counter is never worth a failure.
  }
}

const NOTE_COUNTER: Record<string, string> = { add: "note_added", replace: "note_replaced", remove: "note_removed", lock: "note_locked" };

/** The notes a review wrote: one `note_*` count for each op that was applied (`add`, `replace`, `remove`, `lock`; others count nothing). */
export function countNoteOps(db: Queryable, ops: ReadonlyArray<{ op: string }>): void {
  for (const op of ops) {
    const name = NOTE_COUNTER[op.op];
    if (name !== undefined) count(db, name);
  }
}

/** What a dream's change did, as it was applied: `locked` are the ids of the notes the model's own `lock` named (any other lock is the re-sort of a new open note). */
export function countDreamOps(db: Queryable, ops: ReadonlyArray<{ op: string; noteId: string | null }>, locked: ReadonlySet<string>): void {
  for (const o of ops) {
    if (o.op === "merge") count(db, "dream_merge");
    else if (o.op === "split") count(db, "dream_split");
    else if (o.op === "replace") count(db, "dream_rewrite");
    else if (o.op === "lock") count(db, o.noteId !== null && locked.has(o.noteId) ? "dream_lock" : "dream_resort_locked");
  }
}

/** Flags a delete removed (`returning (tries >= 2) as tries`): those tried twice, and those that were too old. */
export function countDroppedFlags(db: Queryable, dropped: ReadonlyArray<{ tries: boolean }>): void {
  const tried = dropped.filter((d) => d.tries).length;
  count(db, "flags_dropped_tries", tried);
  count(db, "flags_dropped_age", dropped.length - tried);
}

/** The owner's decision on a change, counted when it took effect: `kind` is `changeKind` of the change (read before the decision). A card shown is counted where it is made (`card_shown_<reason>`), one nobody answered where the sweep discards it (`card_expired`). */
export function countDecision(db: Queryable, verb: "undo" | "confirm" | "discard", kind: Awaited<ReturnType<typeof changeKind>> | null): void {
  if (verb === "undo") count(db, kind === "hearsay" ? "undo_hearsay" : kind === "dream" ? "undo_dream" : "undo_rest");
  else if (verb === "discard") count(db, "card_discarded");
  else {
    count(db, "card_confirmed");
    // Confirming a request to take notes out of the vault takes them out.
    if (kind === "unlock") count(db, "owner_unlocked");
  }
}

/** What kind of change this is, for counting the owner's decision on it (`undo_*`, `owner_unlocked`): its first op and phase say. Never throws. */
export async function changeKind(q: Queryable, changeId: string): Promise<"rest" | "dream" | "hearsay" | "unlock"> {
  try {
    const { rows } = await q.query<{ phase: string; first: string | null }>("select phase, ops -> 0 ->> 'op' as first from memory_changes where id = $1", [changeId]);
    const first = rows[0]?.first ?? "";
    if (first.startsWith("hearsay_")) return "hearsay";
    if (first === "unlock") return "unlock";
    return rows[0]?.phase === "dream" ? "dream" : "rest";
  } catch {
    // Only a count is lost.
    return "rest";
  }
}

export interface StatRow {
  day: string;
  name: string;
  n: number;
}

/** The counters of the `days` site days that end with the latest day that has any (all of them, oldest first); empty when none. */
export async function readStats(q: Queryable, days: number): Promise<StatRow[]> {
  const { rows } = await q.query<{ day: string; name: string; n: string }>(
    `select day::text as day, name, n::text as n from memory_stats
      where day > (select max(day) from memory_stats) - $1::int order by name, day`,
    [days],
  );
  return rows.map((r) => ({ day: r.day, name: r.name, n: Number(r.n) }));
}

/** The table `memory-stats` prints: days as columns (oldest first, `days` of them ending at the latest day with a count), names as rows. */
export function formatStats(rows: ReadonlyArray<StatRow>, days: number): string {
  if (rows.length === 0) return "no memory counters yet";
  const latest = rows.reduce((m, r) => (r.day > m ? r.day : m), rows[0]!.day);
  const columns = Array.from({ length: days }, (_, i) => new Date(Date.parse(latest) - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10));
  const names = [...new Set(rows.map((r) => r.name))].sort();
  const cell = new Map(rows.map((r) => [`${r.name}|${r.day}`, r.n]));
  const width = Math.max(...names.map((n) => n.length), 4);
  const head = ["name".padEnd(width), ...columns.map((d) => d.slice(5).padStart(7))].join(" ");
  const body = names.map((name) => [name.padEnd(width), ...columns.map((d) => String(cell.get(`${name}|${d}`) ?? "-").padStart(7))].join(" "));
  return [head, ...body].join("\n");
}
