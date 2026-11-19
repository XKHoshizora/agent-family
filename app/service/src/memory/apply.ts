import { lockAccount } from "../accounts/store.ts";
import type { Tx } from "../db.ts";
import { modelNote } from "./clean.ts";
import type { Op } from "./ops.ts";
import { codePoints, used, type Note, type NoteKind, type Rooms } from "./store.ts";
import { deleteNote, fits, insertNote, listRoomExact, lockRoom, restoreNote, roomLimit, updatedAtOf, updateNote, type ExactNote, type Room } from "./write.ts";

/**
 * Applying what a review may change, the one audited path: every change is recorded in `memory_changes` (so the owner
 * can undo it, or confirm it when it was held back) and happens under the owner's account lock, then the two rooms'
 * locks (the owner's shared room, the Agent's own), always in that order.
 *
 * The vault only fills by itself. `applyOps` never takes a note out of it (an `unlock` is only handed back, for the
 * caller to ask the owner about with `proposeUnlocks`), and `undoChange` never opens a note that was inside before the
 * change; the one code that opens a note the change did not find open is `confirmChange`, on a pending change for its
 * owner. (An undo may put a note back outside the vault only when it was outside before the change and nothing has
 * touched it since: the stale check proves that.)
 *
 * `memory_changes.ops` holds a JSON array of `StoredOp`: the `AppliedOp` fields plus what undo and confirm need to
 * restore or to check that nothing changed since. A pending change's `add` has `noteId: null` until it is confirmed.
 */

export interface AppliedOp {
  op: Op["op"];
  kind: NoteKind;
  /** The note changed; null only for an `add` of a pending change, which has no note yet. */
  noteId: string | null;
  before: string | null;
  after: string | null;
  vaultBefore: boolean | null;
  vaultAfter: boolean | null;
}

/** What a change stores of each operation (the `memory_changes.ops` array). */
export interface StoredOp extends AppliedOp {
  vaultByBefore: "auto" | "owner" | null;
  vaultByAfter: "auto" | "owner" | null;
  unsureBefore: boolean | null;
  unsureAfter: boolean | null;
  /** An `add`: where it was learned. A `remove`: where the note it deleted had been. */
  originConversationId: string | null;
  /** A `remove` keeps the deleted note's origin and creation time, so undo restores it whole. */
  origin: Note["origin"] | null;
  createdAt: string | null;
  /** The exact `updated_at` of the note before the change (what it was found as) and after it (what the change left): undo and confirm are stale unless the note still has it. */
  updatedAtBefore: string | null;
  updatedAtAfter: string | null;
}

export interface Who {
  ownerId: string;
  agentId: string;
  /** The Agent uses the owner's shared notes: without it, no op on a note about the owner is applied. */
  sharedNotes: boolean;
  /** The kinds of note this review may change. */
  kinds: ReadonlySet<NoteKind>;
}

export interface ApplyOpts {
  conversationId: string;
  /** Where the notes it adds began (the conversation, or null). */
  originConversationId: string | null;
  /** `pending`: the change is only recorded, to be confirmed by the owner. */
  status: "applied" | "pending";
  /** The sorting verdict by `vaultKey(kind, text)` of an `add` or `replace` (a replace's kind is the replaced note's); a text with none goes into the vault, unsure. */
  vaults: Map<string, { vault: boolean; unsure: boolean }>;
  /** Texts the duplicate test found already known: an `add` of one is dropped. */
  duplicates: ReadonlySet<string>;
  /** What each room holds at most (`roomOf(config)`). */
  rooms: Rooms;
}

export interface ApplyResult {
  /** The change row; null when nothing was recorded (no op was left, or only unlocks remain). */
  changeId: string | null;
  applied: AppliedOp[];
  /** An `add` or `replace` was dropped because the room is full. */
  full: boolean;
  /** Refs of `unlock` ops naming notes in the vault: never applied here. */
  unlocks: string[];
}

/** The key of a sorting verdict in `ApplyOpts.vaults`: the kind of the note and its text (the sorter's answer depends on the kind). */
export const vaultKey = (kind: NoteKind, text: string): string => `${kind}:${text}`;

type State = { owner: Map<string, Note>; self: Map<string, Note>; exact: Map<string, { createdAt: string; updatedAt: string }> };
type Ids = { ownerId: string; agentId: string };

const roomFor = (kind: NoteKind, w: Ids): Room => (kind === "owner" ? { kind, ownerId: w.ownerId } : { kind, agentId: w.agentId });
const plain = (s: StoredOp): AppliedOp => ({ op: s.op, kind: s.kind, noteId: s.noteId, before: s.before, after: s.after, vaultBefore: s.vaultBefore, vaultAfter: s.vaultAfter });

/** Whether the Agent is the owner's (a deleted one still is). */
async function ownsAgent(t: Tx, w: Ids): Promise<boolean> {
  const { rowCount } = await t.query("select 1 from agents a join principals p on p.id = a.principal_id where a.principal_id = $2 and p.owner_id = $1", [w.ownerId, w.agentId]);
  return rowCount === 1;
}

/** Locks both rooms (always in this order, after the account) and reads them. */
async function loadState(t: Tx, w: Ids): Promise<State> {
  const owner = roomFor("owner", w);
  const self = roomFor("self", w);
  await lockRoom(t, owner);
  await lockRoom(t, self);
  const [o, s] = [await listRoomExact(t, owner), await listRoomExact(t, self)];
  const byId = (list: ExactNote[]) => new Map(list.map((e) => [e.note.id, e.note]));
  const exact = new Map([...o, ...s].map((e) => [e.note.id, { createdAt: e.createdAt, updatedAt: e.updatedAt }]));
  return { owner: byId(o), self: byId(s), exact };
}

const usedIn = (state: State): { owner: number; self: number } => ({ owner: used([...state.owner.values()]), self: used([...state.self.values()]) });

const base = (op: Op["op"], kind: NoteKind, noteId: string | null): StoredOp => ({
  op,
  kind,
  noteId,
  before: null,
  after: null,
  vaultBefore: null,
  vaultAfter: null,
  vaultByBefore: null,
  vaultByAfter: null,
  unsureBefore: null,
  unsureAfter: null,
  originConversationId: null,
  origin: null,
  createdAt: null,
  updatedAtBefore: null,
  updatedAtAfter: null,
});

const snapshot = (s: StoredOp, n: Note, state: State): StoredOp => ({
  ...s,
  updatedAtBefore: state.exact.get(n.id)!.updatedAt,
  before: n.text,
  vaultBefore: n.vault,
  vaultByBefore: n.vaultBy,
  unsureBefore: n.unsure,
});

type Candidate = { index: number; op: "remove" | "lock" | "replace"; note: Note; text: string; growth: number };
type AddStep = { index: number; op: Extract<Op, { op: "add" }>; text: string };

/**
 * What the operations would do to the rooms as they stand. A change is judged by its net effect: every remove and every
 * shrinking replace is counted first (they free room), then every growth (a growing replace or an add) in the order the
 * ops came, each dropped (and `full` set) when its room would pass its limit. A note is touched by at most one op (the
 * first). The result lists removes, replaces and locks first, then the adds, so the notes added list in op order.
 * Nothing is written.
 */
function plan(state: State, who: Who, ops: Op[], refs: Map<string, { kind: NoteKind; id: string }>, opts: ApplyOpts): { stored: StoredOp[]; full: boolean; unlocks: string[] } {
  const allowed = (kind: NoteKind): boolean => who.kinds.has(kind) && (kind === "self" || who.sharedNotes);
  const room = usedIn(state);
  const touched = new Set<string>();
  const candidates: Candidate[] = [];
  const adds: AddStep[] = [];
  const unlocks: string[] = [];

  ops.forEach((op, index) => {
    if (op.op === "add") {
      if (!allowed(op.kind)) return;
      const text = modelNote(op.text);
      if (text !== null && !opts.duplicates.has(text) && !opts.duplicates.has(op.text)) adds.push({ index, op, text });
      return;
    }
    const target = refs.get(op.ref);
    if (!target || !allowed(target.kind)) return;
    const note = state[target.kind].get(target.id);
    if (!note) return;
    if (op.op === "unlock") {
      if (note.vault && !unlocks.includes(op.ref)) unlocks.push(op.ref);
      return;
    }
    if (touched.has(note.id)) return;
    if (op.op === "lock") {
      if (note.vault && note.vaultBy === "owner") return;
      touched.add(note.id);
      candidates.push({ index, op: "lock", note, text: note.text, growth: 0 });
    } else if (op.op === "remove") {
      touched.add(note.id);
      room[note.kind] -= codePoints(note.text);
      candidates.push({ index, op: "remove", note, text: note.text, growth: 0 });
    } else {
      const text = modelNote(op.text);
      if (text === null || text === note.text) return;
      touched.add(note.id);
      const growth = codePoints(text) - codePoints(note.text);
      if (growth < 0) room[note.kind] += growth;
      candidates.push({ index, op: "replace", note, text, growth });
    }
  });

  // Growth, in op order across replaces and adds together.
  const rejected = new Set<number>();
  let full = false;
  const growing = [
    ...candidates.filter((c) => c.op === "replace" && c.growth > 0).map((c) => ({ index: c.index, kind: c.note.kind, growth: c.growth })),
    ...adds.map((a) => ({ index: a.index, kind: a.op.kind, growth: codePoints(a.text) })),
  ].sort((x, y) => x.index - y.index);
  for (const g of growing) {
    if (fits(room[g.kind], g.growth, roomLimit(opts.rooms, g.kind))) room[g.kind] += g.growth;
    else {
      rejected.add(g.index);
      full = true;
    }
  }

  const stored: StoredOp[] = [];
  for (const { index, op, note, text } of candidates) {
    if (rejected.has(index)) continue;
    const s = snapshot(base(op, note.kind, note.id), note, state);
    if (op === "remove") {
      stored.push({ ...s, originConversationId: note.originConversationId, origin: note.origin, createdAt: state.exact.get(note.id)!.createdAt });
    } else if (op === "lock") {
      stored.push({ ...s, after: note.text, vaultAfter: true, vaultByAfter: "owner", unsureAfter: note.unsure });
    } else {
      // Into the vault only: a note inside stays (one the owner locked too, whatever the text). One outside, whoever put
      // it there, is new text the owner never approved for groups: it goes in unless the sorting says it is fine (a
      // text with no verdict is not known to be).
      let vault = { vault: note.vault, by: note.vaultBy, unsure: note.unsure };
      if (!note.vault) {
        const verdict = opts.vaults.get(vaultKey(note.kind, text)) ?? { vault: true, unsure: true };
        if (verdict.vault) vault = { vault: true, by: "auto", unsure: verdict.unsure };
      }
      stored.push({ ...s, after: text, vaultAfter: vault.vault, vaultByAfter: vault.by, unsureAfter: vault.unsure });
    }
  }
  for (const { index, op, text } of adds) {
    if (rejected.has(index)) continue;
    const verdict = opts.vaults.get(vaultKey(op.kind, text)) ?? opts.vaults.get(vaultKey(op.kind, op.text)) ?? { vault: true, unsure: true };
    stored.push({
      ...base("add", op.kind, null),
      after: text,
      vaultAfter: verdict.vault,
      vaultByAfter: "auto",
      unsureAfter: verdict.unsure,
      originConversationId: opts.originConversationId,
      origin: "review",
    });
  }
  return { stored, full, unlocks };
}

/**
 * Writes the operations, in order, with the room's own functions (the caller holds the locks), and returns those that
 * took effect (a note that vanished meanwhile is not reported as changed). Never an `unlock`; a note is only ever put
 * into the vault here (a replace moving an open note in, a lock), never out.
 */
async function execute(t: Tx, w: Ids, stored: StoredOp[]): Promise<StoredOp[]> {
  const done: StoredOp[] = [];
  for (const s of stored) {
    const room = roomFor(s.kind, w);
    let took = true;
    if (s.op === "add") {
      s.noteId = await insertNote(t, room, {
        text: s.after!,
        vault: s.vaultAfter!,
        vaultBy: "auto",
        unsure: s.unsureAfter!,
        origin: "review",
        originConversationId: s.originConversationId,
      });
    } else if (s.op === "replace") {
      const movedIn = s.vaultBefore === false && s.vaultAfter === true;
      took = await updateNote(t, room, s.noteId!, movedIn ? { text: s.after!, vault: true, vaultBy: s.vaultByAfter!, unsure: s.unsureAfter! } : { text: s.after! });
    } else if (s.op === "remove") {
      took = await deleteNote(t, room, s.noteId!);
    } else if (s.op === "lock") {
      took = await updateNote(t, room, s.noteId!, { vault: true, vaultBy: "owner" });
    } else {
      throw new Error("an unlock is only ever applied by confirmChange");
    }
    if (took) done.push(s);
  }
  return done;
}

/** Records, on every op that wrote a note, the exact `updated_at` the write left (read back in the same transaction). */
async function stamp(t: Tx, w: Ids, ops: StoredOp[]): Promise<void> {
  for (const kind of ["owner", "self"] as const) {
    const touched = ops.filter((s) => s.kind === kind && s.noteId !== null && s.op !== "remove");
    const at = await updatedAtOf(t, roomFor(kind, w), touched.map((s) => s.noteId!));
    for (const s of touched) s.updatedAtAfter = at.get(s.noteId!) ?? null;
  }
}

async function writeChange(t: Tx, w: Ids, conversationId: string, status: "applied" | "pending", stored: StoredOp[], full: boolean): Promise<string> {
  const { rows } = await t.query<{ id: string }>(
    `insert into memory_changes (owner_id, agent_id, conversation_id, status, ops, "full") values ($1, $2, $3, $4, $5::jsonb, $6) returning id`,
    [w.ownerId, w.agentId, conversationId, status, JSON.stringify(stored), full],
  );
  return rows[0]!.id;
}

/**
 * Applies a review's operations (or, with status `pending`, only records them for the owner to confirm), in the
 * caller's transaction, under the account lock. `refs` maps the numbers the model saw to notes. The change is judged by its
 * net effect on each room: every remove and shrinking replace is counted first, then every growth (a growing replace or
 * an add) in the order the ops came; one that would pass its room's limit is dropped and sets `full`. The result lists
 * removes, replaces and locks, then adds. An `unlock` is never applied (its refs come back in `unlocks`). Null when there is
 * nothing to report: no op left, no unlock, not full; also when the Agent is not the owner's. A change that only found
 * the room full is still recorded (`ops: []`, `full`).
 */
export async function applyOps(
  t: Tx,
  who: Who,
  ops: Op[],
  refs: Map<string, { kind: NoteKind; id: string }>,
  opts: ApplyOpts,
): Promise<ApplyResult | null> {
  await lockAccount(t, who.ownerId);
  if (!(await ownsAgent(t, who))) return null;
  const state = await loadState(t, who);
  const planned = plan(state, who, ops, refs, opts);
  const { full, unlocks } = planned;
  const stored = opts.status === "applied" ? await execute(t, who, planned.stored) : planned.stored;
  if (opts.status === "applied") await stamp(t, who, stored);
  if (stored.length === 0 && !full && unlocks.length === 0) return null;
  const changeId = stored.length > 0 || full ? await writeChange(t, who, opts.conversationId, opts.status, stored, full) : null;
  return { changeId, applied: stored.map(plain), full, unlocks };
}

/**
 * Records, as one pending change, a request to take notes out of the vault: only those still in it. The owner confirms
 * (`confirmChange`) or declines (`discardChange`); nothing is opened here. Null when none is left in the vault, or the
 * Agent is not the owner's.
 */
export async function proposeUnlocks(t: Tx, who: Ids, conversationId: string, notes: ReadonlyArray<{ kind: NoteKind; id: string }>): Promise<string | null> {
  await lockAccount(t, who.ownerId);
  if (!(await ownsAgent(t, who))) return null;
  const state = await loadState(t, who);
  const stored: StoredOp[] = [];
  const seen = new Set<string>();
  for (const target of notes) {
    const note = state[target.kind].get(target.id);
    if (!note || !note.vault || seen.has(note.id)) continue;
    seen.add(note.id);
    stored.push({ ...snapshot(base("unlock", target.kind, note.id), note, state), after: note.text, vaultAfter: false, vaultByAfter: "owner", unsureAfter: false });
  }
  return stored.length === 0 ? null : writeChange(t, who, conversationId, "pending", stored, false);
}

interface ChangeRow {
  agentId: string;
  status: "applied" | "undone" | "pending" | "discarded";
  ops: StoredOp[];
  full: boolean;
}

/** The owner's own change, locked for this transaction; null when it is nobody's of theirs. */
async function readChange(t: Tx, ownerId: string, changeId: string): Promise<ChangeRow | null> {
  const { rows } = await t.query<{ agent_id: string; status: ChangeRow["status"]; ops: StoredOp[]; full: boolean }>(
    `select agent_id, status, ops, "full" from memory_changes where id = $1 and owner_id = $2 for update`,
    [changeId, ownerId],
  );
  const r = rows[0];
  return r ? { agentId: r.agent_id, status: r.status, ops: r.ops, full: r.full } : null;
}

const resolve = (t: Tx, changeId: string, status: "undone" | "discarded" | "applied", extra?: { ops: StoredOp[]; full: boolean }) =>
  extra
    ? t.query(`update memory_changes set status = $2, ops = $3::jsonb, "full" = $4, resolved_at = now() where id = $1`, [changeId, status, JSON.stringify(extra.ops), extra.full])
    : t.query("update memory_changes set status = $2, resolved_at = now() where id = $1", [changeId, status]);

/**
 * The note a stored op names is exactly as the change left it (`side` after) or found it (before): its text, vault state,
 * `vault_by`, `unsure` and its exact `updated_at`. The last is what catches an owner's write that changed no value (their
 * own lock of a note the model locked): every write bumps it.
 */
const stands = (state: State, s: StoredOp, side: "before" | "after"): boolean => {
  const n = s.noteId === null ? undefined : state[s.kind].get(s.noteId);
  const a = side === "after" ? { text: s.after, vault: s.vaultAfter, by: s.vaultByAfter, unsure: s.unsureAfter, at: s.updatedAtAfter } : { text: s.before, vault: s.vaultBefore, by: s.vaultByBefore, unsure: s.unsureBefore, at: s.updatedAtBefore };
  return n !== undefined && n.text === a.text && n.vault === a.vault && n.vaultBy === a.by && n.unsure === a.unsure && a.at !== null && state.exact.get(n.id)?.updatedAt === a.at;
};

/** How many code points a stored op adds to its room when undone (negative: frees). */
const undoGrowth = (s: StoredOp): number =>
  s.op === "add" ? -codePoints(s.after!) : s.op === "remove" ? codePoints(s.before!) : s.op === "replace" ? codePoints(s.before!) - codePoints(s.after!) : 0;

/**
 * Undoes an applied change of the owner's: every note it touched is put back exactly as it was (text, vault state,
 * `vault_by`, `unsure`), an added note goes, a removed one returns (same id). Refused as `stale` (nothing changed) when
 * any touched note is not as the change left it, and as `full` (nothing changed) when restoring would put a room over
 * its limit. A note that was in the vault before the change is in it after; one the change moved in from outside goes
 * back outside (the stale check proves nothing touched it since). A note is put back with the `updated_at` it had before the
 * change, so changes to one note undo newest first. Null when the change is not the owner's or not applied.
 */
export async function undoChange(t: Tx, ownerId: string, changeId: string, rooms: Rooms): Promise<"undone" | "stale" | "full" | null> {
  await lockAccount(t, ownerId);
  const change = await readChange(t, ownerId, changeId);
  if (!change || change.status !== "applied") return null;
  const w = { ownerId, agentId: change.agentId };
  const state = await loadState(t, w);
  for (const s of change.ops) {
    const ok = s.op === "remove" ? !state[s.kind].has(s.noteId!) : stands(state, s, "after");
    if (!ok) return "stale";
  }
  const room = usedIn(state);
  const growth = { owner: 0, self: 0 };
  for (const s of change.ops) growth[s.kind] += undoGrowth(s);
  for (const kind of ["owner", "self"] as const) if (!fits(room[kind], growth[kind], roomLimit(rooms, kind))) return "full";

  for (const s of [...change.ops].reverse()) {
    const at = roomFor(s.kind, w);
    if (s.op === "add") {
      await deleteNote(t, at, s.noteId!);
    } else if (s.op === "remove") {
      await restoreNote(t, at, {
        id: s.noteId!,
        text: s.before!,
        vault: s.vaultBefore!,
        vaultBy: s.vaultByBefore!,
        unsure: s.unsureBefore!,
        origin: s.origin!,
        originConversationId: s.originConversationId,
        createdAt: s.createdAt!,
        updatedAt: s.updatedAtBefore!,
      });
    } else {
      await updateNote(t, at, s.noteId!, { text: s.before!, vault: s.vaultBefore!, vaultBy: s.vaultByBefore!, unsure: s.unsureBefore!, updatedAt: s.updatedAtBefore! });
    }
  }
  await resolve(t, changeId, "undone");
  return "undone";
}

/**
 * Confirms a pending change of the owner's: applies what it recorded, if every note it names is still as it was
 * (`stale` otherwise: the change is discarded and nothing is written). The one code that opens a note nobody else has
 * opened: an `unlock` takes it out of the vault, `vault_by` the owner. When the whole change would put a room over its limit
 * it answers `full` and writes nothing (the change stays pending). Null when the change is not the owner's or not pending.
 */
export async function confirmChange(t: Tx, ownerId: string, changeId: string, rooms: Rooms): Promise<AppliedOp[] | "stale" | "full" | null> {
  await lockAccount(t, ownerId);
  const change = await readChange(t, ownerId, changeId);
  if (!change || change.status !== "pending") return null;
  const w = { ownerId, agentId: change.agentId };
  const state = await loadState(t, w);
  for (const s of change.ops) {
    if (s.op === "add") continue;
    if (!stands(state, s, "before")) {
      await resolve(t, changeId, "discarded");
      return "stale";
    }
  }

  // All or nothing, judged by the net effect of the whole change per room (shrinks count before growth): when a room would
  // end over its limit nothing is written and the change stays pending, for the owner to make room and confirm again.
  const room = usedIn(state);
  const growth = { owner: 0, self: 0 };
  for (const s of change.ops) growth[s.kind] -= undoGrowth(s);
  for (const kind of ["owner", "self"] as const) if (!fits(room[kind], growth[kind], roomLimit(rooms, kind))) return "full";
  const done = await execute(t, w, change.ops.filter((s) => s.op !== "unlock"));
  for (const s of change.ops) {
    // Here and nowhere else a note leaves the vault by a decision that was not its own owner's earlier choice.
    if (s.op === "unlock" && (await updateNote(t, roomFor(s.kind, w), s.noteId!, { vault: false, vaultBy: "owner", unsure: false }))) done.push(s);
  }
  const kept = change.ops.filter((s) => done.includes(s));
  await stamp(t, w, kept);
  await resolve(t, changeId, "applied", { ops: kept, full: change.full });
  return kept.map(plain);
}

/** Declines a pending change of the owner's; nothing is written. Null when it is not theirs or not pending. */
export async function discardChange(t: Tx, ownerId: string, changeId: string): Promise<"discarded" | null> {
  await lockAccount(t, ownerId);
  const change = await readChange(t, ownerId, changeId);
  if (!change || change.status !== "pending") return null;
  await resolve(t, changeId, "discarded");
  return "discarded";
}
