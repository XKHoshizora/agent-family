import { lockAccount } from "../accounts/store.ts";
import type { Tx } from "../db.ts";
import { modelNote } from "./clean.ts";
import type { Op } from "./ops.ts";
import type { Note, NoteKind, Rooms } from "./store.ts";
import { deleteNote, insertNote, listRoom, lockRoom, updateNote, type Room } from "./write.ts";

/**
 * Applying what a review may change, the one audited path: every change is recorded in `memory_changes` (so the owner
 * can undo it, or confirm it when it was held back) and happens under the owner's account lock, then the two rooms'
 * locks (the owner's shared room, the Agent's own), always in that order.
 *
 * The vault only fills by itself. `applyOps` never takes a note out of it (an `unlock` is only handed back, for the
 * caller to ask the owner about with `proposeUnlocks`), and neither does `undoChange`; the one code that writes
 * `vault = false` on a note is `confirmChange`, acting on a pending change for its owner.
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
  /** The sorting verdict by the text of an `add` or `replace`; a text with none goes into the vault, unsure. */
  vaults: Map<string, { vault: boolean; unsure: boolean }>;
  /** Texts the duplicate test found already known: an `add` of one is dropped. */
  duplicates: ReadonlySet<string>;
  /** What each room holds at most (`roomOf(config)`). */
  rooms: Rooms;
}

export interface ApplyResult {
  /** The change row; null when nothing was recorded (no op was left, or only fullness or unlocks remain). */
  changeId: string | null;
  applied: AppliedOp[];
  /** An `add` or `replace` was dropped because the room is full. */
  full: boolean;
  /** Refs of `unlock` ops naming notes in the vault: never applied here. */
  unlocks: string[];
}

type State = { owner: Map<string, Note>; self: Map<string, Note> };
type Ids = { ownerId: string; agentId: string };

const len = (s: string): number => [...s].length;
const roomFor = (kind: NoteKind, w: Ids): Room => (kind === "owner" ? { kind, ownerId: w.ownerId } : { kind, agentId: w.agentId });
const limitOf = (rooms: Rooms, kind: NoteKind): number => (kind === "owner" ? rooms.owner : rooms.self);
const plain = (s: StoredOp): AppliedOp => ({ op: s.op, kind: s.kind, noteId: s.noteId, before: s.before, after: s.after, vaultBefore: s.vaultBefore, vaultAfter: s.vaultAfter });
const usedOf = (notes: Map<string, Note>): number => [...notes.values()].reduce((sum, n) => sum + len(n.text), 0);

/** Locks both rooms (always in this order, after the account) and reads them. */
async function loadState(t: Tx, w: Ids): Promise<State> {
  const owner = roomFor("owner", w);
  const self = roomFor("self", w);
  await lockRoom(t, owner);
  await lockRoom(t, self);
  const [o, s] = [await listRoom(t, owner), await listRoom(t, self)];
  return { owner: new Map(o.map((n) => [n.id, n])), self: new Map(s.map((n) => [n.id, n])) };
}

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
});

const snapshot = (s: StoredOp, n: Note): StoredOp => ({
  ...s,
  before: n.text,
  vaultBefore: n.vault,
  vaultByBefore: n.vaultBy,
  unsureBefore: n.unsure,
});

/**
 * What the operations would do to the rooms as they stand: removes, replaces and locks first (in the order given), then
 * adds, so a merge frees room for its add. A note is touched by at most one op (the first). Nothing is written.
 */
function plan(state: State, who: Who, ops: Op[], refs: Map<string, { kind: NoteKind; id: string }>, opts: ApplyOpts): { stored: StoredOp[]; full: boolean; unlocks: string[] } {
  const allowed = (kind: NoteKind): boolean => who.kinds.has(kind) && (kind === "self" || who.sharedNotes);
  const used = { owner: usedOf(state.owner), self: usedOf(state.self) };
  const touched = new Set<string>();
  const stored: StoredOp[] = [];
  const unlocks: string[] = [];
  let full = false;

  for (const op of ops) {
    if (op.op === "add") continue;
    const target = refs.get(op.ref);
    if (!target || !allowed(target.kind)) continue;
    const note = state[target.kind].get(target.id);
    if (!note) continue;
    if (op.op === "unlock") {
      if (note.vault && !unlocks.includes(op.ref)) unlocks.push(op.ref);
      continue;
    }
    if (touched.has(note.id)) continue;
    const s = snapshot(base(op.op, target.kind, note.id), note);
    if (op.op === "remove") {
      touched.add(note.id);
      used[note.kind] -= len(note.text);
      stored.push({ ...s, originConversationId: note.originConversationId, origin: note.origin, createdAt: note.createdAt.toISOString() });
    } else if (op.op === "lock") {
      if (note.vault && note.vaultBy === "owner") continue;
      touched.add(note.id);
      stored.push({ ...s, after: note.text, vaultAfter: true, vaultByAfter: "owner", unsureAfter: note.unsure });
    } else {
      const text = modelNote(op.text);
      if (text === null || text === note.text) continue;
      const growth = len(text) - len(note.text);
      if (growth > 0 && used[note.kind] + growth > limitOf(opts.rooms, note.kind)) {
        full = true;
        continue;
      }
      // Into the vault only: a vault note stays, a note the owner chose is left alone, an open one goes in unless
      // the sorting says it is fine (a text with no verdict is not known to be).
      let vault = { vault: note.vault, by: note.vaultBy, unsure: note.unsure };
      if (!note.vault && note.vaultBy !== "owner") {
        const verdict = opts.vaults.get(text) ?? { vault: true, unsure: true };
        if (verdict.vault) vault = { vault: true, by: "auto", unsure: verdict.unsure };
      }
      touched.add(note.id);
      used[note.kind] += growth;
      stored.push({ ...s, after: text, vaultAfter: vault.vault, vaultByAfter: vault.by, unsureAfter: vault.unsure });
    }
  }

  for (const op of ops) {
    if (op.op !== "add" || !allowed(op.kind)) continue;
    const text = modelNote(op.text);
    if (text === null || opts.duplicates.has(text) || opts.duplicates.has(op.text)) continue;
    if (used[op.kind] + len(text) > limitOf(opts.rooms, op.kind)) {
      full = true;
      continue;
    }
    used[op.kind] += len(text);
    const verdict = opts.vaults.get(text) ?? opts.vaults.get(op.text) ?? { vault: true, unsure: true };
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
 * Writes the operations, in order, with the room's own functions (the caller holds the locks). Never an `unlock`; and
 * a note is only ever put into the vault here (a replace moving an open note in, a lock), never out.
 */
async function execute(t: Tx, w: Ids, stored: StoredOp[]): Promise<void> {
  for (const s of stored) {
    const room = roomFor(s.kind, w);
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
      await updateNote(t, room, s.noteId!, movedIn ? { text: s.after!, vault: true, vaultBy: s.vaultByAfter!, unsure: s.unsureAfter! } : { text: s.after! });
    } else if (s.op === "remove") {
      await deleteNote(t, room, s.noteId!);
    } else if (s.op === "lock") {
      await updateNote(t, room, s.noteId!, { vault: true, vaultBy: "owner" });
    } else {
      throw new Error("an unlock is only ever applied by confirmChange");
    }
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
 * caller's transaction, under the account lock. `refs` maps the numbers the model saw to notes. Removes, replaces and
 * locks go first, then adds: an add that would pass its room is dropped and sets `full`; an `unlock` is never applied
 * (its refs come back in `unlocks`). Null when there is nothing to report: no op left, no unlock, not full.
 */
export async function applyOps(
  t: Tx,
  who: Who,
  ops: Op[],
  refs: Map<string, { kind: NoteKind; id: string }>,
  opts: ApplyOpts,
): Promise<ApplyResult | null> {
  await lockAccount(t, who.ownerId);
  const state = await loadState(t, who);
  const { stored, full, unlocks } = plan(state, who, ops, refs, opts);
  if (stored.length === 0 && !full && unlocks.length === 0) return null;
  if (stored.length > 0 && opts.status === "applied") await execute(t, who, stored);
  const changeId = stored.length > 0 || full ? await writeChange(t, who, opts.conversationId, opts.status, stored, full) : null;
  return { changeId, applied: stored.map(plain), full, unlocks };
}

/**
 * Records, as one pending change, a request to take notes out of the vault: only those still in it. The owner confirms
 * (`confirmChange`) or declines (`discardChange`); nothing is opened here. Null when none is left in the vault.
 */
export async function proposeUnlocks(t: Tx, who: Ids, conversationId: string, notes: ReadonlyArray<{ kind: NoteKind; id: string }>): Promise<string | null> {
  await lockAccount(t, who.ownerId);
  const state = await loadState(t, who);
  const stored: StoredOp[] = [];
  const seen = new Set<string>();
  for (const target of notes) {
    const note = state[target.kind].get(target.id);
    if (!note || !note.vault || seen.has(note.id)) continue;
    seen.add(note.id);
    stored.push({ ...snapshot(base("unlock", target.kind, note.id), note), after: note.text, vaultAfter: false, vaultByAfter: "owner", unsureAfter: false });
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

/** The note a stored op names stands as the change left it (or, before a pending change is applied, as it found it). */
const stands = (n: Note | undefined, text: string | null, vault: boolean | null, by: "auto" | "owner" | null): boolean =>
  n !== undefined && n.text === text && n.vault === vault && n.vaultBy === by;

/**
 * Undoes an applied change of the owner's: every note it touched gets its previous text back, an added note goes, a
 * removed one returns (same id). Refused as `stale` (nothing changed) when any touched note is not as the change left
 * it. A note that was in the vault before is in it after; one the change moved into the vault stays there, because
 * undoing never takes a note out. Null when the change is not the owner's or not applied.
 */
export async function undoChange(t: Tx, ownerId: string, changeId: string): Promise<"undone" | "stale" | null> {
  await lockAccount(t, ownerId);
  const change = await readChange(t, ownerId, changeId);
  if (!change || change.status !== "applied") return null;
  const w = { ownerId, agentId: change.agentId };
  const state = await loadState(t, w);
  for (const s of change.ops) {
    const note = s.noteId === null ? undefined : state[s.kind].get(s.noteId);
    const ok = s.op === "remove" ? note === undefined : stands(note, s.after, s.vaultAfter, s.vaultByAfter);
    if (!ok) return "stale";
  }
  for (const s of [...change.ops].reverse()) {
    const room = roomFor(s.kind, w);
    if (s.op === "add") {
      await deleteNote(t, room, s.noteId!);
    } else if (s.op === "remove") {
      // The conversation it began in may be gone by now (the column then goes null, as it would have).
      const [table, column] = s.kind === "owner" ? ["owner_notes", "owner_id"] : ["agent_notes", "agent_id"];
      await t.query(
        `insert into ${table} (${column}, id, text, vault, vault_by, unsure, origin, origin_conversation_id, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, (select id from conversations where id = $8), $9)`,
        [s.kind === "owner" ? ownerId : change.agentId, s.noteId, s.before, s.vaultBefore, s.vaultByBefore, s.unsureBefore, s.origin, s.originConversationId, s.createdAt],
      );
    } else if (s.vaultBefore === true && s.vaultAfter === false) {
      // An unlocked note goes back in: into the vault is always allowed.
      await updateNote(t, room, s.noteId!, { text: s.before!, vault: true, vaultBy: s.vaultByBefore!, unsure: s.unsureBefore! });
    } else if (s.vaultBefore === s.vaultAfter) {
      await updateNote(t, room, s.noteId!, { text: s.before!, vaultBy: s.vaultByBefore!, unsure: s.unsureBefore! });
    } else {
      // Moved into the vault (a replace, a lock): the text goes back, the note stays in.
      await updateNote(t, room, s.noteId!, { text: s.before! });
    }
  }
  await resolve(t, changeId, "undone");
  return "undone";
}

/**
 * Confirms a pending change of the owner's: applies what it recorded, if every note it names is still as it was
 * (`stale` otherwise: the change is discarded and nothing is written). The one code that takes a note out of the
 * vault: an `unlock` opens it, `vault_by` the owner. An add or replace that no longer fits its room is dropped and
 * sets the change's `full`. Null when the change is not the owner's or not pending.
 */
export async function confirmChange(t: Tx, ownerId: string, changeId: string, rooms: Rooms): Promise<AppliedOp[] | "stale" | null> {
  await lockAccount(t, ownerId);
  const change = await readChange(t, ownerId, changeId);
  if (!change || change.status !== "pending") return null;
  const w = { ownerId, agentId: change.agentId };
  const state = await loadState(t, w);
  for (const s of change.ops) {
    if (s.op === "add") continue;
    if (!stands(state[s.kind].get(s.noteId!), s.before, s.vaultBefore, s.vaultByBefore)) {
      await resolve(t, changeId, "discarded");
      return "stale";
    }
  }

  const used = { owner: usedOf(state.owner), self: usedOf(state.self) };
  const kept: StoredOp[] = [];
  let full = change.full;
  for (const s of change.ops) {
    const growth = s.op === "add" ? len(s.after!) : s.op === "replace" ? len(s.after!) - len(s.before!) : s.op === "remove" ? -len(s.before!) : 0;
    if (growth > 0 && used[s.kind] + growth > limitOf(rooms, s.kind)) {
      full = true;
      continue;
    }
    used[s.kind] += growth;
    kept.push(s);
  }
  await execute(t, w, kept.filter((s) => s.op !== "unlock"));
  for (const s of kept) {
    // Here and nowhere else a note leaves the vault.
    if (s.op === "unlock") await updateNote(t, roomFor(s.kind, w), s.noteId!, { vault: false, vaultBy: "owner", unsure: false });
  }
  await resolve(t, changeId, "applied", { ops: kept, full });
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
