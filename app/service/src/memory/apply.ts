import { lockAccount } from "../accounts/store.ts";
import type { Tx } from "../db.ts";
import { modelNote } from "./clean.ts";
import type { Op } from "./ops.ts";
import { keptOrigin } from "./origin.ts";
import { hearsayCost, hearsayUsed, type Note, type NoteKind, type Rooms } from "./store.ts";
import { weight, weightOf } from "./weight.ts";
import {
  deleteHearsay,
  deleteNote,
  fits,
  insertHearsay,
  insertNote,
  listHearsayExact,
  listRoomExact,
  lockHearsay,
  lockRoom,
  restoreHearsay,
  restoreNote,
  roomLimit,
  stampsOf,
  updateNote,
  type ExactNote,
  type HearsayExact,
  type Room,
} from "./write.ts";

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
 *
 * A dream (`applyDream`, dream.ts) goes through the same path: its `merge`, `split`, `rewrite` (stored as a `replace`) and `lock`
 * are stored ops too, undone and confirmed here. A merge keeps, on the note it is written into, what undo needs of the notes it
 * removed (`removed`); a split keeps the parts it made (`parts`) and records the source (the op's own fields). Undo of either
 * puts every note back as it was, ids and stamps, `strength` and `seen_at` included.
 *
 * A change of the other kind records hearsay (`applyHearsay`): its ops are `StoredHearsayOp`s only, and it is never
 * pending (hearsay is a list of clues, not a note, so even an Agent that asks first writes it at once). Undo deletes the
 * entries it inserted and puts back those it dropped; it is stale unless every inserted one is still there and no dropped
 * one is.
 */

export interface AppliedOp {
  op: Op["op"] | "merge" | "split";
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
  /** The exact `seen_at` of the note before the change (a replace sets it to now; undo puts it back). Absent in changes made before strength existed. */
  seenAtBefore?: string | null;
  /** A `remove` also keeps the deleted note's strength, so undo restores it whole. */
  strengthBefore?: number | null;
  /** A `merge`: what the note it is written into holds afterwards. */
  strengthAfter?: number | null;
  seenAtAfter?: string | null;
  /** A `replace` or `merge`: the note's origin conversation before the change and after it (origin.ts decides; undo puts `originBefore` back). Absent in changes made before: those leave the origin alone. */
  originBefore?: string | null;
  originAfter?: string | null;
  /** A dream's `replace` is no mention of the owner's: it leaves `seen_at` alone. */
  keepSeen?: boolean;
  /** A `merge`: the notes it removed, whole. */
  removed?: StoredNote[];
  /** A `split`: the notes it made from the source (the op's own fields are the source); `noteId` and `updatedAt` are null until they are written. */
  parts?: StoredNote[];
}

/** A note a merge removed or a split made, as a stored op keeps it. */
export interface StoredNote {
  noteId: string | null;
  text: string;
  vault: boolean;
  vaultBy: "auto" | "owner";
  unsure: boolean;
  origin: Note["origin"];
  originConversationId: string | null;
  createdAt: string | null;
  /** A removed note: its exact `updated_at` when read. A part: the one the write left (null before). */
  updatedAt: string | null;
  strength: number;
  seenAt: string;
}

/** What a dream may ask for (dream.ts `parseDreamOps` makes them from the model's answer, refs being the numbers it was shown). */
export type DreamOp =
  | { op: "merge"; into: string; from: string[]; text: string }
  | { op: "rewrite"; ref: string; text: string }
  | { op: "split"; ref: string; texts: string[] }
  | { op: "lock"; ref: string };

/**
 * What a hearsay change stores of each entry it touched: `hearsay_add` an entry it inserted (`createdAt` null: undo only
 * deletes it), `hearsay_drop` one it deleted — superseded by the new ones, or trimmed to fit the room — with the exact
 * times it had, so undo puts it back whole.
 */
export interface StoredHearsayOp {
  op: "hearsay_add" | "hearsay_drop";
  hearsayId: string;
  conversationId: string;
  speakerId: string | null;
  speakerName: string;
  text: string;
  saidAt: string;
  createdAt: string | null;
}

const isHearsayOp = (s: StoredOp | StoredHearsayOp): s is StoredHearsayOp => s.op === "hearsay_add" || s.op === "hearsay_drop";

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
  /** A dream: how many of its ops were left out because the room could not hold what they wrote (the size rule). */
  noRoom?: number;
  applied: AppliedOp[];
  /** An `add` or `replace` was dropped because the room is full. */
  full: boolean;
  /** Refs of `unlock` ops naming notes in the vault: never applied here. */
  unlocks: string[];
}

/** The key of a sorting verdict in `ApplyOpts.vaults`: the kind of the note and its text (the sorter's answer depends on the kind). */
export const vaultKey = (kind: NoteKind, text: string): string => `${kind}:${text}`;

type State = { owner: Map<string, Note>; self: Map<string, Note>; exact: Map<string, { createdAt: string; updatedAt: string; seenAt: string }> };
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
  const exact = new Map([...o, ...s].map((e) => [e.note.id, { createdAt: e.createdAt, updatedAt: e.updatedAt, seenAt: e.seenAt }]));
  return { owner: byId(o), self: byId(s), exact };
}

const usedIn = (state: State): { owner: number; self: number } => ({ owner: weightOf([...state.owner.values()]), self: weightOf([...state.self.values()]) });

const base = (op: AppliedOp["op"], kind: NoteKind, noteId: string | null): StoredOp => ({
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
  seenAtBefore: state.exact.get(n.id)!.seenAt,
  strengthBefore: n.strength,
  before: n.text,
  vaultBefore: n.vault,
  vaultByBefore: n.vaultBy,
  unsureBefore: n.unsure,
});

/**
 * The net rule of a room's limit, judged once for a whole change: every step that shrinks a room is counted first (it frees
 * room), then every step that grows one, in the order the ops came, each dropped (and `full` set) when its room would pass its
 * limit. `room` is what each holds now; a step is one op's net growth in weight.
 */
function netRule(room: { owner: number; self: number }, steps: ReadonlyArray<{ index: number; kind: NoteKind; growth: number }>, limits: Rooms): { rejected: Set<number>; full: boolean } {
  const left = { ...room };
  for (const s of steps) if (s.growth < 0) left[s.kind] += s.growth;
  const rejected = new Set<number>();
  let full = false;
  for (const s of steps.filter((x) => x.growth > 0).sort((a, b) => a.index - b.index)) {
    if (fits(left[s.kind], s.growth, roomLimit(limits, s.kind))) left[s.kind] += s.growth;
    else {
      rejected.add(s.index);
      full = true;
    }
  }
  return { rejected, full };
}

/**
 * The vault state of a note after its text changed to a new one with `verdict` (null: no verdict, which is not "harmless"): the
 * vault only fills here. A note inside stays (one the owner locked too, whatever the text). One outside, whoever put it there,
 * is new text the owner never approved for groups: it goes in unless the verdict says it is fine.
 */
function intoVaultOnly(note: Note, verdict: { vault: boolean; unsure: boolean } | null | undefined): { vault: boolean; by: "auto" | "owner"; unsure: boolean } {
  if (note.vault) return { vault: true, by: note.vaultBy, unsure: note.unsure };
  const v = verdict ?? { vault: true, unsure: true };
  return v.vault ? { vault: true, by: "auto", unsure: v.unsure } : { vault: false, by: note.vaultBy, unsure: note.unsure };
}

/** How many notes a room may hold (`Rooms.notes`; none given: no count limit). */
const noteCap = (rooms: Rooms): number => rooms.notes ?? Number.POSITIVE_INFINITY;

/** How many more notes a stored op leaves its room holding once applied (negative: fewer). */
const countGrowth = (s: StoredOp): number => (s.op === "add" ? 1 : s.op === "remove" ? -1 : s.op === "merge" ? -s.removed!.length : s.op === "split" ? s.parts!.length - 1 : 0);

/** Whether a room of `size` notes may grow by `growth` notes under `cap` (a change that does not grow it always fits). */
const fitsCount = (size: number, growth: number, cap: number): boolean => growth <= 0 || size + growth <= cap;

/**
 * The count rule of a change, after the size rule: what shrinks a room is counted first, then each step that grows one, in the
 * order the steps came, is dropped (it is `full`) when its room would hold more than `cap` notes. `steps` are only those the size
 * rule kept. Returns the indexes dropped.
 */
function countRule(size: { owner: number; self: number }, steps: ReadonlyArray<{ index: number; kind: NoteKind; count: number }>, cap: number): Set<number> {
  const left = { ...size };
  for (const s of steps) if (s.count < 0) left[s.kind] += s.count;
  const rejected = new Set<number>();
  for (const s of [...steps].filter((x) => x.count > 0).sort((a, b) => a.index - b.index)) {
    if (fitsCount(left[s.kind], s.count, cap)) left[s.kind] += s.count;
    else rejected.add(s.index);
  }
  return rejected;
}

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
  const touched = new Set<string>();
  const candidates: Candidate[] = [];
  const adds: AddStep[] = [];
  const unlocks: string[] = [];

  ops.forEach((op, index) => {
    // The owner mentioning a note again is no change (the review counts it, pipeline.ts).
    if (op.op === "seen") return;
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
      candidates.push({ index, op: "remove", note, text: note.text, growth: -weight(note.text) });
    } else {
      const text = modelNote(op.text);
      if (text === null || text === note.text) return;
      touched.add(note.id);
      candidates.push({ index, op: "replace", note, text, growth: weight(text) - weight(note.text) });
    }
  });

  const sized = netRule(
    usedIn(state),
    [
      ...candidates.map((c) => ({ index: c.index, kind: c.note.kind, growth: c.growth })),
      ...adds.map((a) => ({ index: a.index, kind: a.op.kind, growth: weight(a.text) })),
    ],
    opts.rooms,
  );
  // A room holds at most so many notes besides its size: an add beyond it is dropped as a full room.
  const tooMany = countRule(
    { owner: state.owner.size, self: state.self.size },
    [
      ...candidates.filter((c) => c.op === "remove" && !sized.rejected.has(c.index)).map((c) => ({ index: c.index, kind: c.note.kind, count: -1 })),
      ...adds.filter((a) => !sized.rejected.has(a.index)).map((a) => ({ index: a.index, kind: a.op.kind, count: 1 })),
    ],
    noteCap(opts.rooms),
  );
  const rejected = new Set([...sized.rejected, ...tooMany]);
  const full = sized.full || tooMany.size > 0;

  const stored: StoredOp[] = [];
  for (const { index, op, note, text } of candidates) {
    if (rejected.has(index)) continue;
    const s = snapshot(base(op, note.kind, note.id), note, state);
    if (op === "remove") {
      stored.push({ ...s, originConversationId: note.originConversationId, origin: note.origin, createdAt: state.exact.get(note.id)!.createdAt });
    } else if (op === "lock") {
      stored.push({ ...s, after: note.text, vaultAfter: true, vaultByAfter: "owner", unsureAfter: note.unsure });
    } else {
      const vault = intoVaultOnly(note, opts.vaults.get(vaultKey(note.kind, text)));
      const originAfter = keptOrigin(note.originConversationId, { from: "conversation", id: opts.originConversationId });
      stored.push({ ...s, after: text, vaultAfter: vault.vault, vaultByAfter: vault.by, unsureAfter: vault.unsure, originBefore: note.originConversationId, originAfter });
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
      // A note a review rewrote is seen now (a dream's rewrite is no mention of the owner's).
      took = await updateNote(t, room, s.noteId!, {
        ...(movedIn ? { text: s.after!, vault: true, vaultBy: s.vaultByAfter!, unsure: s.unsureAfter! } : { text: s.after! }),
        ...(s.keepSeen ? {} : { seenAt: "now" as const }),
        ...(s.originAfter !== undefined ? { originConversationId: s.originAfter } : {}),
      });
    } else if (s.op === "remove") {
      took = await deleteNote(t, room, s.noteId!);
    } else if (s.op === "lock") {
      took = await updateNote(t, room, s.noteId!, { vault: true, vaultBy: s.vaultByAfter!, unsure: s.unsureAfter! });
    } else if (s.op === "merge") {
      took = await updateNote(t, room, s.noteId!, {
        text: s.after!,
        vault: s.vaultAfter!,
        vaultBy: s.vaultByAfter!,
        unsure: s.unsureAfter!,
        strength: s.strengthAfter!,
        seenAt: s.seenAtAfter!,
        ...(s.originAfter !== undefined ? { originConversationId: s.originAfter } : {}),
      });
      if (took) for (const r of s.removed!) await deleteNote(t, room, r.noteId!);
    } else if (s.op === "split") {
      // The parts keep the source's origin, strength and last-mentioned time, and list in order from its creation time.
      for (const [i, p] of s.parts!.entries()) {
        p.noteId = await insertNote(t, room, {
          text: p.text,
          vault: p.vault,
          vaultBy: p.vaultBy,
          unsure: p.unsure,
          origin: p.origin,
          originConversationId: p.originConversationId,
          strength: p.strength,
          seenAt: p.seenAt,
          createdAt: s.createdAt!,
          createdOffsetUs: i,
        });
      }
      took = await deleteNote(t, room, s.noteId!);
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
    const touched = ops.filter((s) => s.kind === kind && s.noteId !== null && s.op !== "remove" && s.op !== "split");
    const at = await stampsOf(t, roomFor(kind, w), touched.map((s) => s.noteId!));
    for (const s of touched) {
      const now = at.get(s.noteId!);
      s.updatedAtAfter = now?.updatedAt ?? null;
      // What the write left, for an undo that must not erase what the owner mentions after it.
      if (now && s.op !== "lock" && s.op !== "unlock") {
        s.seenAtAfter = now.seenAt;
        s.strengthAfter = now.strength;
      }
    }
    // The parts a split made are stamped the same way.
    const parts = ops.filter((s) => s.kind === kind && s.op === "split").flatMap((s) => s.parts!.filter((p) => p.noteId !== null));
    const partAt = await stampsOf(t, roomFor(kind, w), parts.map((p) => p.noteId!));
    for (const p of parts) p.updatedAt = partAt.get(p.noteId!)?.updatedAt ?? null;
  }
}

async function writeChange(t: Tx, w: Ids, conversationId: string, status: "applied" | "pending", stored: ReadonlyArray<StoredOp | StoredHearsayOp>, full: boolean, phase: "rest" | "dream" = "rest"): Promise<string> {
  const { rows } = await t.query<{ id: string }>(
    `insert into memory_changes (owner_id, agent_id, conversation_id, status, ops, "full", phase) values ($1, $2, $3, $4, $5::jsonb, $6, $7) returning id`,
    [w.ownerId, w.agentId, conversationId, status, JSON.stringify(stored), full, phase],
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

export interface DreamApplyOpts {
  conversationId: string;
  /** `pending`: the whole dream is only recorded, to be confirmed by the owner as one change. */
  status: "applied" | "pending";
  /** The sorting verdict by `vaultKey(kind, text)` of a text a merge, rewrite or split makes, or of an open note that is new; a text with none goes into the vault, unsure. */
  vaults: Map<string, { vault: boolean; unsure: boolean }>;
  /** The indexes (in the `ops` given) of the merges, rewrites and splits the judgement found to add nothing and lose nothing (sort.ts `addsNothing`): any other is dropped. */
  checked: ReadonlySet<number>;
  /** Every note the dream was shown: its id and exact `updated_at` as it was read. An op naming a note that has changed (or is gone) since is dropped. */
  read: ReadonlyMap<string, string>;
  /** The sorting verdict (sort.ts `resortNote`) of each open note that is new since the last dream: one that no op touched, that is not the owner's choice and has not changed since it was read is locked when its verdict says so. A note with no entry has no verdict and stays. */
  resorted: ReadonlyMap<string, { vault: boolean; unsure: boolean }>;
  rooms: Rooms;
  /**
   * A language conversion: a rewrite keeps the note's vault state (`vault`, `vault_by`, `unsure`) exactly as it is, whatever `vaults` says
   * (a faithful restatement has the same meaning). It is held to the same limit of a model's entry as any other rewrite (weight follows
   * tokens, so a restatement in another script weighs about what the original did).
   */
  conversion?: boolean;
}

/**
 * What a dream's operations would do to the rooms as they stand, judged by the net effect (the shrinking ones first, then the
 * growing ones in op order, each dropped when its room would pass its limit). An op names notes by the refs the model was
 * shown; one that names a note that changed since it was read, that is not of a room this dream may change, that another op
 * took, or whose notes are not all of one room, is dropped. The vault only fills here: a merge with a note in the vault, and
 * every part of a split vault note, is in the vault; no op takes a note out of it. Nothing is written.
 */
function planDream(state: State, who: Who, ops: DreamOp[], refs: Map<string, { kind: NoteKind; id: string }>, opts: DreamApplyOpts): { stored: StoredOp[]; full: boolean; noRoom: number } {
  const allowed = (kind: NoteKind): boolean => who.kinds.has(kind) && (kind === "self" || who.sharedNotes);
  const touched = new Set<string>();
  const noteOf = (ref: string): Note | null => {
    const target = refs.get(ref);
    if (!target || !allowed(target.kind)) return null;
    const note = state[target.kind].get(target.id);
    if (!note || touched.has(note.id) || state.exact.get(note.id)?.updatedAt !== opts.read.get(note.id)) return null;
    return note;
  };
  const verdictOf = (kind: NoteKind, text: string) => opts.vaults.get(vaultKey(kind, text));
  const keep = (n: Note, text: string) => intoVaultOnly(n, verdictOf(n.kind, text));
  const whole = (n: Note): StoredNote => {
    const at = state.exact.get(n.id)!;
    return { noteId: n.id, text: n.text, vault: n.vault, vaultBy: n.vaultBy, unsure: n.unsure, origin: n.origin, originConversationId: n.originConversationId, createdAt: at.createdAt, updatedAt: at.updatedAt, strength: n.strength, seenAt: at.seenAt };
  };

  const steps: Array<{ index: number; kind: NoteKind; growth: number; stored: StoredOp }> = [];
  ops.forEach((op, index) => {
    if (op.op === "merge") {
      if (!opts.checked.has(index)) return;
      const into = noteOf(op.into);
      const from = op.from.map(noteOf);
      if (!into || from.some((n) => n === null)) return;
      const sources = [into, ...(from as Note[])];
      if (new Set(sources.map((n) => n.id)).size !== sources.length || sources.some((n) => n.kind !== into.kind)) return;
      const text = modelNote(op.text);
      if (text === null) return;
      sources.forEach((n) => touched.add(n.id));
      // Any source in the vault puts the result there (the owner's only when every source was); else it is sorted afresh.
      const vault = sources.some((n) => n.vault)
        ? { vault: true, by: sources.every((n) => n.vault && n.vaultBy === "owner") ? ("owner" as const) : ("auto" as const), unsure: sources.some((n) => n.vault && n.unsure) }
        : keep(into, text);
      steps.push({
        index,
        kind: into.kind,
        growth: weight(text) - weightOf(sources),
        stored: {
          ...snapshot(base("merge", into.kind, into.id), into, state),
          after: text,
          vaultAfter: vault.vault,
          vaultByAfter: vault.by,
          unsureAfter: vault.unsure,
          originBefore: into.originConversationId,
          originAfter: keptOrigin(into.originConversationId, { from: "notes", origins: sources.map((n) => n.originConversationId) }),
          strengthAfter: sources.reduce((sum, n) => sum + n.strength, 0),
          seenAtAfter: sources.map((n) => state.exact.get(n.id)!.seenAt).sort().at(-1)!,
          removed: (from as Note[]).map(whole),
        },
      });
    } else if (op.op === "rewrite") {
      const note = opts.checked.has(index) ? noteOf(op.ref) : null;
      const text = note ? modelNote(op.text) : null;
      if (!note || text === null || text === note.text) return;
      touched.add(note.id);
      const vault = opts.conversion ? { vault: note.vault, by: note.vaultBy, unsure: note.unsure } : keep(note, text);
      steps.push({
        index,
        kind: note.kind,
        growth: weight(text) - weight(note.text),
        stored: { ...snapshot(base("replace", note.kind, note.id), note, state), after: text, vaultAfter: vault.vault, vaultByAfter: vault.by, unsureAfter: vault.unsure, keepSeen: true, originBefore: note.originConversationId, originAfter: keptOrigin(note.originConversationId, { from: "nothing-new" }) },
      });
    } else if (op.op === "split") {
      const note = opts.checked.has(index) ? noteOf(op.ref) : null;
      const texts = op.texts.map((t) => modelNote(t));
      if (!note || texts.length < 2 || texts.length > 4 || texts.some((t) => t === null)) return;
      touched.add(note.id);
      const at = state.exact.get(note.id)!;
      const parts = (texts as string[]).map((text): StoredNote => {
        const vault = note.vault ? { vault: true, by: note.vaultBy, unsure: note.unsure } : keep(note, text);
        return { noteId: null, text, vault: vault.vault, vaultBy: vault.vault && !note.vault ? "auto" : note.vaultBy, unsure: vault.unsure, origin: note.origin, originConversationId: keptOrigin(note.originConversationId, { from: "nothing-new" }), createdAt: at.createdAt, updatedAt: null, strength: note.strength, seenAt: at.seenAt };
      });
      steps.push({
        index,
        kind: note.kind,
        growth: weightOf(parts) - weight(note.text),
        stored: { ...snapshot(base("split", note.kind, note.id), note, state), after: parts.map((p) => p.text).join("；"), originConversationId: note.originConversationId, origin: note.origin, createdAt: at.createdAt, parts },
      });
    } else {
      const note = noteOf(op.ref);
      // One the owner took out of the vault (`vault_by` the owner) is not put back by the model.
      if (!note || note.vault || note.vaultBy === "owner") return;
      touched.add(note.id);
      steps.push({ index, kind: note.kind, growth: 0, stored: { ...snapshot(base("lock", note.kind, note.id), note, state), after: note.text, vaultAfter: true, vaultByAfter: "auto", unsureAfter: false } });
    }
  });

  const sized = netRule(usedIn(state), steps, opts.rooms);
  const tooMany = countRule(
    { owner: state.owner.size, self: state.self.size },
    steps.filter((s) => !sized.rejected.has(s.index)).map((s) => ({ index: s.index, kind: s.kind, count: countGrowth(s.stored) })),
    noteCap(opts.rooms),
  );
  const rejected = new Set([...sized.rejected, ...tooMany]);
  const full = sized.full || tooMany.size > 0;
  const stored = steps.filter((s) => !rejected.has(s.index)).map((s) => s.stored);
  const noRoom = rejected.size;

  // An open note that is new since the last dream and that no op touched is locked on a vault verdict; the owner's own choice is final.
  for (const kind of ["owner", "self"] as const) {
    if (!allowed(kind)) continue;
    for (const note of state[kind].values()) {
      const verdict = opts.resorted.get(note.id);
      if (!verdict?.vault || touched.has(note.id) || note.vault || note.vaultBy === "owner" || state.exact.get(note.id)?.updatedAt !== opts.read.get(note.id)) continue;
      stored.push({ ...snapshot(base("lock", kind, note.id), note, state), after: note.text, vaultAfter: true, vaultByAfter: "auto", unsureAfter: verdict.unsure });
    }
  }
  return { stored, full, noRoom };
}

/**
 * Applies a dream's operations (or, with status `pending`, only records them as one change for the owner to confirm), in the
 * caller's transaction, under the account lock. `who.agentId` is the Agent carrying the dream out, `who.kinds` the room it
 * consolidates. The change is judged by its net effect on the room (`planDream`). Null when no op took effect; also when the
 * Agent is not the owner's.
 */
export async function applyDream(t: Tx, who: Who, ops: DreamOp[], refs: Map<string, { kind: NoteKind; id: string }>, opts: DreamApplyOpts): Promise<ApplyResult | null> {
  await lockAccount(t, who.ownerId);
  if (!(await ownsAgent(t, who))) return null;
  const state = await loadState(t, who);
  const planned = planDream(state, who, ops, refs, opts);
  const stored = opts.status === "applied" ? await execute(t, who, planned.stored) : planned.stored;
  if (opts.status === "applied") await stamp(t, who, stored);
  // A room too full to take a longer text is nothing a dream has to say (a conversion is told how many it left for that: `noRoom`).
  if (stored.length === 0) return planned.noRoom > 0 ? { changeId: null, applied: [], full: planned.full, unlocks: [], noRoom: planned.noRoom } : null;
  const changeId = await writeChange(t, who, opts.conversationId, opts.status, stored, planned.full, "dream");
  return { changeId, applied: stored.map(plain), full: planned.full, unlocks: [], noRoom: planned.noRoom };
}

/** An entry to write into an Agent's hearsay: who said it (a flagged message's own sender), where and when. */
export interface NewHearsay {
  conversationId: string;
  speakerId: string;
  speakerName: string;
  text: string;
  saidAt: Date;
}

/**
 * Writes hearsay entries, in the caller's transaction (which holds the Agent's row), under the account lock and the
 * Agent's hearsay lock: deletes the entries of `drop` (ids of this Agent's), inserts `entries` in order, then deletes the
 * oldest entries — of any group, the new ones last — until the room holds at most `room` weight, and records it all
 * as one applied change. Nothing is written, and null comes back, when no entry is left to insert (none given, or the
 * room cannot hold any) or the Agent is not the owner's: a drop alone is never applied. `added` lists what was inserted.
 */
export async function applyHearsay(
  t: Tx,
  w: Ids,
  opts: { conversationId: string; entries: ReadonlyArray<NewHearsay>; drop: ReadonlySet<string>; room: number },
): Promise<{ changeId: string; added: StoredHearsayOp[] } | null> {
  if (opts.entries.length === 0) return null;
  await lockAccount(t, w.ownerId);
  if (!(await ownsAgent(t, w))) return null;
  await lockHearsay(t, w.agentId);
  const existing = await listHearsayExact(t, w.agentId);
  const dropped = existing.filter((e) => opts.drop.has(e.id));
  // In the order a room trims: what is kept, oldest first, then what comes in.
  const line: Array<{ old: HearsayExact } | { entry: NewHearsay }> = [
    ...existing.filter((e) => !opts.drop.has(e.id)).map((old) => ({ old })),
    ...opts.entries.map((entry) => ({ entry })),
  ];
  const pointsOf = (l: (typeof line)[number]): number => hearsayCost("old" in l ? l.old : l.entry);
  let usedNow = line.reduce((sum, l) => sum + pointsOf(l), 0);
  const trimmed: HearsayExact[] = [];
  const arriving: NewHearsay[] = [];
  for (const l of line) {
    if (usedNow > opts.room) {
      usedNow -= pointsOf(l);
      if ("old" in l) trimmed.push(l.old);
    } else if ("entry" in l) {
      arriving.push(l.entry);
    }
  }
  if (arriving.length === 0) return null;

  // Only what the delete really removed is recorded as dropped: an undo must never put back what was not taken.
  const deleted = new Set(await deleteHearsay(t, w.agentId, [...dropped, ...trimmed].map((g) => g.id)));
  const gone = [...dropped, ...trimmed].filter((g) => deleted.has(g.id));
  const added: StoredHearsayOp[] = [];
  for (const entry of arriving) {
    const hearsayId = await insertHearsay(t, w.agentId, entry);
    added.push({ op: "hearsay_add", hearsayId, conversationId: entry.conversationId, speakerId: entry.speakerId, speakerName: entry.speakerName, text: entry.text, saidAt: entry.saidAt.toISOString(), createdAt: null });
  }
  const removed = gone.map(
    (g): StoredHearsayOp => ({ op: "hearsay_drop", hearsayId: g.id, conversationId: g.conversationId, speakerId: g.speakerId, speakerName: g.speakerName, text: g.text, saidAt: g.saidAt, createdAt: g.createdAt }),
  );
  const changeId = await writeChange(t, w, opts.conversationId, "applied", [...removed, ...added], false);
  return { changeId, added };
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
  /** The change's operations on notes, or (a hearsay change) its operations on hearsay: a change holds only one kind. */
  ops: StoredOp[];
  hearsay: StoredHearsayOp[];
  full: boolean;
}

/** The owner's own change, locked for this transaction; null when it is nobody's of theirs. */
async function readChange(t: Tx, ownerId: string, changeId: string): Promise<ChangeRow | null> {
  const { rows } = await t.query<{ agent_id: string; status: ChangeRow["status"]; ops: Array<StoredOp | StoredHearsayOp>; full: boolean }>(
    `select agent_id, status, ops, "full" from memory_changes where id = $1 and owner_id = $2 for update`,
    [changeId, ownerId],
  );
  const r = rows[0];
  return r ? { agentId: r.agent_id, status: r.status, ops: r.ops.filter((s): s is StoredOp => !isHearsayOp(s)), hearsay: r.ops.filter(isHearsayOp), full: r.full } : null;
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

/** Whether a note a merge removed or a split made is exactly as the change found it (`before`: a removed note) or left it (`after`: a part). */
const partStands = (state: State, kind: NoteKind, p: StoredNote): boolean => {
  const n = p.noteId === null ? undefined : state[kind].get(p.noteId);
  return n !== undefined && n.text === p.text && n.vault === p.vault && n.vaultBy === p.vaultBy && n.unsure === p.unsure && p.updatedAt !== null && state.exact.get(n.id)?.updatedAt === p.updatedAt;
};

/**
 * `stands` for any stored op, a merge and a split included. A merge before: its note and every note it removes are as found;
 * after: its note as left and the removed ones gone. A split before: its source as found; after: the source gone and every
 * part as left.
 */
const operationStands = (state: State, s: StoredOp, side: "before" | "after"): boolean => {
  if (s.op === "split") return side === "before" ? stands(state, s, "before") : !state[s.kind].has(s.noteId!) && s.parts!.every((p) => partStands(state, s.kind, p));
  if (s.op === "merge") {
    return stands(state, s, side) && s.removed!.every((r) => (side === "before" ? partStands(state, s.kind, r) : !state[s.kind].has(r.noteId!)));
  }
  return stands(state, s, side);
};


/** How much weight a stored op adds to its room when undone (negative: frees). */
const undoGrowth = (s: StoredOp): number =>
  s.op === "add"
    ? -weight(s.after!)
    : s.op === "remove"
      ? weight(s.before!)
      : s.op === "replace"
        ? weight(s.before!) - weight(s.after!)
        : s.op === "merge"
          ? weight(s.before!) - weight(s.after!) + weightOf(s.removed!)
          : s.op === "split"
            ? weight(s.before!) - weightOf(s.parts!)
            : 0;

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
  if (change.hearsay.length > 0) return undoHearsay(t, changeId, change.agentId, change.hearsay, rooms);
  const w = { ownerId, agentId: change.agentId };
  const state = await loadState(t, w);
  for (const s of change.ops) {
    const ok = s.op === "remove" ? !state[s.kind].has(s.noteId!) : operationStands(state, s, "after");
    if (!ok) return "stale";
  }
  const room = usedIn(state);
  const growth = { owner: 0, self: 0 };
  const count = { owner: 0, self: 0 };
  for (const s of change.ops) {
    growth[s.kind] += undoGrowth(s);
    count[s.kind] -= countGrowth(s);
  }
  for (const kind of ["owner", "self"] as const) {
    if (!fits(room[kind], growth[kind], roomLimit(rooms, kind)) || !fitsCount(state[kind].size, count[kind], noteCap(rooms))) return "full";
  }

  for (const s of [...change.ops].reverse()) {
    const at = roomFor(s.kind, w);
    if (s.op === "add") {
      await deleteNote(t, at, s.noteId!);
    } else if (s.op === "split") {
      // What the owner mentioned about the parts since is not lost: the source comes back with the strength they gained and the
      // latest time any was seen (read now, before they go).
      const gained = s.parts!.reduce((sum, p) => sum + Math.max(0, (state[s.kind].get(p.noteId!)?.strength ?? p.strength) - p.strength), 0);
      const seen = [s.seenAtBefore, ...s.parts!.map((p) => state.exact.get(p.noteId!)?.seenAt ?? p.seenAt)].filter((x): x is string => x != null).sort().at(-1)!;
      for (const p of s.parts!) await deleteNote(t, at, p.noteId!);
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
        ...(s.strengthBefore != null ? { strength: s.strengthBefore + gained } : {}),
        seenAt: seen,
      });
    } else if (s.op === "merge") {
      for (const r of s.removed!) {
        await restoreNote(t, at, { id: r.noteId!, text: r.text, vault: r.vault, vaultBy: r.vaultBy, unsure: r.unsure, origin: r.origin, originConversationId: r.originConversationId, createdAt: r.createdAt!, updatedAt: r.updatedAt!, strength: r.strength, seenAt: r.seenAt });
      }
      await updateNote(t, at, s.noteId!, {
        text: s.before!,
        vault: s.vaultBefore!,
        vaultBy: s.vaultByBefore!,
        unsure: s.unsureBefore!,
        updatedAt: s.updatedAtBefore!,
        // What the owner has mentioned since stays on top of what was recorded.
        strengthBack: { before: s.strengthBefore!, after: s.strengthAfter! },
        seenBack: { before: s.seenAtBefore!, after: s.seenAtAfter! },
        ...(s.originBefore !== undefined ? { originConversationId: s.originBefore } : {}),
      });
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
        ...(s.strengthBefore != null ? { strength: s.strengthBefore } : {}),
        ...(s.seenAtBefore != null ? { seenAt: s.seenAtBefore } : {}),
      });
    } else {
      await updateNote(t, at, s.noteId!, {
        text: s.before!,
        vault: s.vaultBefore!,
        vaultBy: s.vaultByBefore!,
        unsure: s.unsureBefore!,
        updatedAt: s.updatedAtBefore!,
        ...(s.op === "replace" && s.seenAtBefore != null && s.seenAtAfter != null ? { seenBack: { before: s.seenAtBefore, after: s.seenAtAfter } } : {}),
        ...(s.op === "replace" && s.originBefore !== undefined ? { originConversationId: s.originBefore } : {}),
      });
    }
  }
  await resolve(t, changeId, "undone");
  return "undone";
}

/**
 * Undoes a hearsay change (the account is locked): stale unless every entry it inserted is still there and none it dropped
 * is (presence only: entries are never edited); full when putting the dropped ones back would pass the room. The entries
 * it inserted go, those it dropped return with their ids and times (one whose group is gone stays gone).
 */
async function undoHearsay(t: Tx, changeId: string, agentId: string, ops: StoredHearsayOp[], rooms: Rooms): Promise<"undone" | "stale" | "full"> {
  await lockHearsay(t, agentId);
  const existing = await listHearsayExact(t, agentId);
  const present = new Set(existing.map((e) => e.id));
  for (const s of ops) if ((s.op === "hearsay_add") !== present.has(s.hearsayId)) return "stale";
  // An entry whose group is gone cannot come back (restoreHearsay), so it takes no room.
  const alive = new Set((await t.query<{ id: string }>("select id from conversations where id = any($1::uuid[])", [ops.map((s) => s.conversationId)])).rows.map((r) => r.id));
  const growth = ops.reduce((sum, s) => sum + (s.op === "hearsay_add" ? -hearsayCost(s) : alive.has(s.conversationId) ? hearsayCost(s) : 0), 0);
  if (!fits(hearsayUsed(existing), growth, rooms.hearsay)) return "full";
  await deleteHearsay(t, agentId, ops.filter((s) => s.op === "hearsay_add").map((s) => s.hearsayId));
  for (const s of ops) {
    if (s.op === "hearsay_drop") await restoreHearsay(t, agentId, { id: s.hearsayId, conversationId: s.conversationId, speakerId: s.speakerId, speakerName: s.speakerName, text: s.text, saidAt: s.saidAt, createdAt: s.createdAt! });
  }
  await resolve(t, changeId, "undone");
  return "undone";
}

/**
 * What a pending change recorded of strength, seen time and origin, brought up to the notes as they are now (they are what the
 * change is applied to): a remove's or a replace's note keeps what it has now, a merge's note is the sum of its sources' strengths and the latest time any was seen, a split's parts take
 * the source's, and a change written before the origin rule (no `originAfter`) clears the origin, as that rule does for any text
 * that is not the note's own. What undo puts back is refreshed the same way (the merged-away notes, the source).
 */
function refreshPending(state: State, ops: StoredOp[]): void {
  const seenOf = (kind: NoteKind, id: string, fallback: string): string => state.exact.get(id)?.seenAt ?? fallback;
  for (const s of ops) {
    if (s.op === "replace" || s.op === "merge") {
      // Written before the origin rule: its origin is cleared, as the rule would have.
      if (s.originAfter === undefined) s.originAfter = null;
    }
    const source = s.noteId === null ? undefined : state[s.kind].get(s.noteId);
    if ((s.op === "remove" || s.op === "replace") && source) {
      // What the owner mentioned of the note while the card waited (no stale change: strength and seen time leave `updated_at` alone):
      // undo puts back what the note is now, not what it was when the card was made.
      s.strengthBefore = source.strength;
      s.seenAtBefore = seenOf(s.kind, source.id, s.seenAtBefore ?? "");
    } else if (s.op === "merge" && source) {
      const members = [source, ...s.removed!.map((r) => state[s.kind].get(r.noteId!)).filter((n): n is Note => n !== undefined)];
      s.strengthBefore = source.strength;
      s.seenAtBefore = seenOf(s.kind, source.id, s.seenAtBefore ?? "");
      s.strengthAfter = members.reduce((sum, n) => sum + n.strength, 0);
      s.seenAtAfter = members.map((n) => seenOf(s.kind, n.id, "")).sort().at(-1)!;
      for (const r of s.removed!) {
        const n = state[s.kind].get(r.noteId!);
        if (n) {
          r.strength = n.strength;
          r.seenAt = seenOf(s.kind, n.id, r.seenAt);
        }
      }
    } else if (s.op === "split" && source) {
      s.strengthBefore = source.strength;
      s.seenAtBefore = seenOf(s.kind, source.id, s.seenAtBefore ?? "");
      for (const p of s.parts!) {
        p.strength = source.strength;
        p.seenAt = s.seenAtBefore;
      }
    }
  }
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
    if (!operationStands(state, s, "before")) {
      await resolve(t, changeId, "discarded");
      return "stale";
    }
  }

  // All or nothing, judged by the net effect of the whole change per room (shrinks count before growth): when a room would
  // end over its limit nothing is written and the change stays pending, for the owner to make room and confirm again.
  refreshPending(state, change.ops);
  const room = usedIn(state);
  const growth = { owner: 0, self: 0 };
  const count = { owner: 0, self: 0 };
  for (const s of change.ops) {
    growth[s.kind] -= undoGrowth(s);
    if (s.op !== "unlock") count[s.kind] += countGrowth(s);
  }
  for (const kind of ["owner", "self"] as const) {
    if (!fits(room[kind], growth[kind], roomLimit(rooms, kind)) || !fitsCount(state[kind].size, count[kind], noteCap(rooms))) return "full";
  }
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
