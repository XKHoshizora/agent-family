import type { FastifyBaseLogger } from "fastify";
import { listenersFor } from "../agents/proactive/listeners.ts";
import { lockAgent, readOwnedAgent, type AgentRow } from "../agents/store.ts";
import type { Config } from "../config.ts";
import type { ConversationEvents } from "../conversations/events.ts";
import { appendSystem } from "../conversations/system.ts";
import type { Db, Queryable, Tx } from "../db.ts";
import type { Judge } from "../judge/client.ts";
import type { StoredMessage } from "../messages/model.ts";
import type { ModelGateway } from "../models/gateway.ts";
import { applyDream, applyOps, proposeUnlocks, vaultKey, type AppliedOp, type DreamOp, type StoredOp } from "./apply.ts";
import { memoryCall, type MemoryCallReport } from "./call.ts";
import { modelNote } from "./clean.ts";
import { lookedAt, parseAnswer, parseOps, refusedInPlace, sameKey, type Op } from "./ops.ts";
import { linesOf, readReview, type RefNote, type ReviewInput } from "./review.ts";
import { addsNothing, duplicateOf, ownerAsked, sortNote, type KnownNote, type SortDeps } from "./sort.ts";
import { count, countNoteOps } from "./stats.ts";
import { getNewNotes, listAgentNotes, listOwnerNotes, roomOf, type NoteKind } from "./store.ts";
import { bumpNotes, stampsOf } from "./write.ts";

/**
 * One review, start to finish (the scheduler, reviewer.ts, decides when): the input (`reviewInput`), one metered call
 * (`memoryCall`), the answer as safe operations (`parseOps`), the duplicate test and the vault sorting for what they add
 * (outside any transaction), then one transaction that applies them (`applyOps`), moves `reviewed_seq` and writes the
 * owner's notice, and the notice's announcement after commit.
 *
 * Fail closed: a call that could not be made, failed or was abandoned changes nothing and leaves `reviewed_seq`; an answer
 * that cannot be used (garbage, cut, empty) changes nothing but is reviewed (`reviewed_seq` moves, as it does when there
 * was no owner message to look at). In a group only additions are applied: forgetting and locking by speech are the
 * owner's, in their own conversation. What this owner has pending already counts as known. In the owner's own conversation memory asks
 * as little as it can (`runReview`): a lock and a faithful merge apply at once, a remove only when the owner asked for it.
 */

export interface PipelineDeps {
  db: Db;
  config: Config;
  models: Pick<ModelGateway, "stream">;
  judge: Judge | null;
  log: Pick<FastifyBaseLogger, "error" | "warn" | "info" | "debug">;
  /** The memory calls this process is working on, by run id (the stale-run sweep leaves them alone). */
  inFlight: Set<string>;
  conversations: Pick<ConversationEvents, "publish">;
  now: () => number;
}

export interface ReviewJob {
  kind: "review";
  agentId: string;
  conversationId: string;
  /** The one retry of a review whose call met the owner's cap of calls running (`ReviewContext.retry`): not retried again. */
  retried?: boolean;
}

export interface ReviewContext {
  /** The service is stopping: a call under way is abandoned, and nothing is applied. */
  closing: AbortSignal;
  /** Called with the newest seq a review looked at, as soon as it is known (before its call). */
  attempted(seq: number): void;
  /** After commit: a change was applied to the notes of this Agent's owner; the scheduler may nap the rooms it left nearly full. */
  changed?(agentId: string): void;
  /** After commit: the review left owner lines of a later topic for the next review (`ReviewInput.more`); the scheduler runs it after this one. */
  more?(): void;
  /** The review's call could not start because the owner had as many calls running as they may: the scheduler runs it once more a minute later. */
  retry?(): void;
}

/** What may be logged of an error: never its message or detail, which can carry the text of a note. */
export const errInfo = (err: unknown): { code?: string; name?: string } => ({
  ...(typeof (err as { code?: unknown })?.code === "string" ? { code: (err as { code: string }).code } : {}),
  ...(err instanceof Error ? { name: err.name } : {}),
});

/** The Agent when it keeps notes and may be reviewed for (memory on, not paused, not deleted); else null. */
export async function reviewableAgent(db: Db, agentId: string): Promise<AgentRow | null> {
  const owner = await db.query<{ owner_id: string }>("select owner_id from principals where id = $1", [agentId]);
  if (!owner.rows[0]) return null;
  const agent = await readOwnedAgent(db, owner.rows[0].owner_id, agentId);
  return agent && agent.memory && !agent.paused && !agent.deleted ? agent : null;
}

export async function reviewedSeq(db: Db, agentId: string, conversationId: string): Promise<number> {
  const { rows } = await db.query<{ s: string }>("select reviewed_seq::text as s from memory_review_state where agent_id = $1 and conversation_id = $2", [agentId, conversationId]);
  return Number(rows[0]?.s ?? 0);
}

const moveReviewed = `insert into memory_review_state (agent_id, conversation_id, reviewed_seq) values ($1, $2, $3)
  on conflict (agent_id, conversation_id) do update set reviewed_seq = greatest(memory_review_state.reviewed_seq, excluded.reviewed_seq)`;

/** Moves `reviewed_seq` (never back), and with it deletes the owner's-own-remark flags it has now passed. */
async function markReviewed(q: Queryable, agentId: string, conversationId: string, seq: number): Promise<void> {
  await q.query(moveReviewed, [agentId, conversationId, seq]);
  await q.query(
    `delete from memory_flags where agent_id = $1 and conversation_id = $2 and kind = 'own'
        and seq <= (select reviewed_seq from memory_review_state where agent_id = $1 and conversation_id = $2)`,
    [agentId, conversationId],
  );
}

/**
 * The transaction prologue of everything that writes an Agent's memory: the Agent's conversation and row locked (the order
 * every writer uses), then `work` — unless the Agent was deleted, paused or turned memory off meanwhile: then nothing
 * happens and null comes back.
 */
export async function inLockedAgent<T>(db: Db, agentId: string, work: (t: Tx, locked: AgentRow) => Promise<T>): Promise<T | null> {
  return db.tx(async (t) => {
    const locked = await lockAgent(t, agentId);
    if (locked.deleted || locked.paused || !locked.memory) return null;
    return work(t, locked);
  });
}

/** After commit: the notices go out to the owner (never to anyone else). A failure to announce is logged (ids, no text): they are stored. */
export function announce(deps: Pick<PipelineDeps, "conversations" | "log">, notices: readonly StoredMessage[] | null, agentId: string): void {
  if (notices === null || notices.length === 0) return;
  try {
    deps.conversations.publish({ messages: [...notices], conversations: [] }, deps.log);
  } catch (err) {
    deps.log.error({ ...errInfo(err), agentId }, "a memory notice could not be announced after it was stored; it is there when the owner next opens the conversation");
  }
}

/**
 * What this owner has waiting for their yes: texts of added, replaced, merged or split entries, the notes asked to be unlocked, and
 * every note a pending change touches (whatever it does to it), by `noteKey`.
 */
async function pendingOf(db: Db, agent: AgentRow): Promise<{ texts: Array<{ kind: NoteKind; text: string }>; unlocks: Set<string>; touched: Set<string> }> {
  const { rows } = await db.query<{ agent_id: string; ops: StoredOp[] }>("select agent_id, ops from memory_changes where owner_id = $1 and status = 'pending'", [agent.ownerId]);
  const texts: Array<{ kind: NoteKind; text: string }> = [];
  const unlocks = new Set<string>();
  const touched = new Set<string>();
  for (const row of rows) {
    for (const s of row.ops) {
      if (s.noteId) touched.add(noteKey(s.kind, s.noteId));
      for (const r of s.removed ?? []) if (r.noteId) touched.add(noteKey(s.kind, r.noteId));
      // The owner's room is shared by all their Agents; an Agent's own room is its own.
      if (s.kind === "self" && row.agent_id !== agent.id) continue;
      if ((s.op === "add" || s.op === "replace" || s.op === "merge") && s.after) texts.push({ kind: s.kind, text: s.after });
      if (s.op === "split") for (const part of s.parts ?? []) texts.push({ kind: s.kind, text: part.text });
      if (s.op === "unlock" && s.noteId) unlocks.add(s.noteId);
    }
  }
  return { texts, unlocks, touched };
}

/** A note, as `pendingOf` keeps the notes pending changes touch. */
const noteKey = (kind: NoteKind, noteId: string): string => `${kind}|${noteId}`;

/** An op that changes a note in place: what depends on the other such ops of its answer, and what a pending change may already ask about. */
const inPlace = (op: Op): op is Extract<Op, { op: "replace" | "remove" | "lock" }> => op.op === "replace" || op.op === "remove" || op.op === "lock";

/** The kinds a review of `conversationId` may change; in a group the owner's room only for the owner's reviewing Agent there. */
export async function kindsFor(db: Db, agent: AgentRow, conversationId: string, group: boolean): Promise<ReadonlySet<NoteKind>> {
  if (!agent.sharedNotes) return new Set<NoteKind>(["self"]);
  if (!group) return new Set<NoteKind>(["owner", "self"]);
  const seq = await db.query<{ seq: string }>("select seq::text from conversations where id = $1", [conversationId]);
  const listeners = await listenersFor(db, conversationId, Number(seq.rows[0]?.seq ?? 0) + 1);
  const mine = listeners.find((l) => l.ownerId === agent.ownerId);
  return new Set<NoteKind>(mine?.reviewerId === agent.id ? ["owner", "self"] : ["self"]);
}

/**
 * The notice of a change, in the Agent's own conversation with its owner (the Agent is locked, in the transaction): the lines
 * `linesOf` makes of what the change recorded, its status and fullness as stored. A room too full to take anything is only told,
 * never asked about: a pending change with no ops is applied, no card with no lines.
 */
export async function memoryNotice(
  t: Tx,
  locked: AgentRow,
  changeId: string,
  how: { unlock: boolean; phase: "rest" | "dream"; linesOf: (ops: StoredOp[], pending: boolean) => { lines: string[]; vaultLines: boolean[] } },
): Promise<StoredMessage> {
  const row = (await t.query<{ ops: StoredOp[]; full: boolean; status: "applied" | "pending" }>(`select ops, "full", status from memory_changes where id = $1`, [changeId])).rows[0]!;
  let status = row.status;
  if (status === "pending" && row.ops.length === 0) {
    await t.query("update memory_changes set status = 'applied', resolved_at = now() where id = $1", [changeId]);
    status = "applied";
  }
  const { lines, vaultLines } = how.linesOf(row.ops, status === "pending");
  return appendSystem(t, locked.conversationId, {
    event: "memory_changed",
    actorId: locked.id,
    changeId,
    lines,
    vaultLines,
    pending: status === "pending",
    unlock: how.unlock,
    full: row.full,
    status,
    phase: how.phase,
    count: lines.length,
  });
}

/**
 * A review; "refused" when its call was not made because the owner's memory allowance is spent (no failure: it waits for the next site day).
 *
 * What of an answer applies at once, in the owner's own conversation without 先问我再记: its adds; its locks (a lock only makes a note more
 * private, and is undone in one tap: never asked about); a merge — a room's one replace and its removes (`mergesOf`) — that the judgement
 * finds faithful, the dream's way (`faithfulOf`), applied as a dream's merge, ONE change of its own; and the replaces and removes left only
 * when none of them needs the owner's word (`needsWords`: a remove needs the owner to have asked, `askedFor`), else they wait together in
 * ONE card. The ops that change a note in place stand or fall together — save the faithful merge, the one deliberate exception: it is
 * judged and applied apart from the answer's other replaces and removes. With 先问我再记 everything waits as one card; a group only adds.
 */
export async function runReview(deps: PipelineDeps, job: ReviewJob, ctx: ReviewContext): Promise<"refused" | undefined> {
  const { db, config, log } = deps;
  const { agentId, conversationId } = job;
  const agent = await reviewableAgent(db, agentId);
  if (agent === null || ctx.closing.aborted) return;
  const group = conversationId !== agent.conversationId;
  const kinds = await kindsFor(db, agent, conversationId, group);
  const { input, seen } = await readReview(db, agent, conversationId, await reviewedSeq(db, agentId, conversationId), { kinds, config, now: new Date(deps.now()) });
  if (input === null) {
    count(db, "review_skipped_no_owner_words");
    // Nothing the owner said to look at: what the read saw is not looked at again, and nothing newer than what it saw is
    // marked (an owner message committed after the read is still to be reviewed).
    if (seen !== null) await markReviewed(db, agentId, conversationId, seen);
    return;
  }
  ctx.attempted(input.upToSeq);
  const pending = await pendingOf(db, agent);

  const report: MemoryCallReport = { answered: false };
  count(db, "review_run");
  let answer = await memoryCall(
    { db, models: deps.models, config, log, inFlight: deps.inFlight },
    agent.ownerId,
    { system: input.system, user: input.user, maxOutputTokens: config.memory.reviewMaxOutputTokens },
    ctx.closing,
    report,
  );
  // Charged for an answer that cannot be used: reviewed all the same (nothing is asked again for the same words).
  if (answer === null && report.answered) answer = "";
  // No answer at all: no model or allowance to call on, the call failed, or the service is stopping (that one is no failure).
  if (answer === null && !ctx.closing.aborted && report.refused !== true) count(db, "review_failed");
  // The owner's calls running were at their cap: a moment later there is room again (once; then it waits for their next words).
  if (answer === null && !ctx.closing.aborted && report.capped === true) ctx.retry?.();
  if (answer === null && !ctx.closing.aborted && report.refused === true) return "refused";
  if (answer === null || ctx.closing.aborted) return;

  const answered = parseOps(answer, new Set(input.refs.keys()), [...input.existing, ...pending.texts.map((p) => p.text)]).filter((op) => allowed(op, kinds, group, input.refs));
  // The ops that change a note in place depend on one another (a merge is a replace plus a remove), so they are decided as one group,
  // before anything else: when any of them names a note a pending change of this owner already touches (the waiting card already asks
  // about it), or the cleaning refused the text or the shape of one of them (it is gone from `answered`: the others would be half of it), ALL of them
  // are dropped (adds and `seen` still go on). One whose note changed since it was read drops them all too, decided where they are
  // applied (apply.ts `plan`).
  const waits =
    refusedInPlace(answer, new Set(input.refs.keys())) ||
    answered.some((op) => {
      const note = inPlace(op) ? input.refs.get(op.ref) : undefined;
      return note !== undefined && pending.touched.has(noteKey(note.kind, note.id));
    });
  const ops = waits ? answered.filter((op) => !inPlace(op)) : answered;
  const sorted = await sortOps(deps, agent, ops, input.refs, group ? [] : pending.texts, ctx.closing);
  if (ctx.closing.aborted) return;
  // What the owner said again: the notes the answer's adds repeat, by the judgement or word for word, are one stronger (below).
  const mentioned = ops.flatMap((o) => {
    const n = o.op === "seen" ? input.refs.get(o.ref) : undefined;
    return n ? [{ kind: n.kind, id: n.id }] : [];
  });
  const repeats = [...sorted.repeats, ...mentioned, ...(await exactRepeats(deps, agent, kinds, answer, ops))];
  // A `seen` only says the owner mentioned a note again (above): there is nothing in it to apply, record or tell.
  const changing = ops.filter((o) => o.op !== "seen");
  // Judged outside any transaction: which of the answer's merges are faithful (one request each), then, for the replaces and removes
  // left, whether the owner asked to forget (one request for the answer, when it can matter). A lock needs neither.
  const merges = mergesOf(changing.filter(inPlace), input.refs);
  const faithful = await faithfulOf(deps, agent, merges, input.refs, group, ctx.closing);
  if (ctx.closing.aborted) return;
  const asked = await askedFor(deps, agent, inPlaceLeft(changing, faithful, true), input, group, ctx.closing);
  if (ctx.closing.aborted) return;

  // What took effect, counted once the transaction has committed (`stats.ts`).
  const made: AppliedOp[] = [];
  let strengthened = 0;
  let mergedNow = 0;
  const shown: CardReason[] = [];
  const notices = await inLockedAgent(db, agentId, async (t, locked): Promise<StoredMessage[]> => {
    const ids = { ownerId: locked.ownerId, agentId };
    // Why each change, if it is a card (pending), waits for the owner (`card_shown_<reason>`); null: never a card.
    const written: Array<{ changeId: string; unlock: boolean; reason: CardReason | null }> = [];
    // Strength is no change anybody is told of: no change row, no notice, `updated_at` untouched (so no undo goes stale).
    const bumped = new Set<string>();
    for (const kind of ["owner", "self"] as const) {
      const ids = [...new Set(repeats.filter((r) => r.kind === kind).map((r) => r.id))].filter((id) => !bumped.has(id));
      for (const id of ids) bumped.add(id);
      await bumpNotes(t, kind === "owner" ? { kind, ownerId: locked.ownerId } : { kind, agentId }, ids);
    }
    strengthened = bumped.size;
    // In the owner's own conversation, without 先问我再记 (`auto`), memory asks as little as it can. A lock is applied at once. So is a
    // merge the judgement found faithful (`faithful`), as a dream's merge, one change of its own, judged and applied apart from the other
    // ops in place: the one exception to their standing or falling together. The replaces and removes left need the owner's words
    // (`needsWords`, `asked`), and they depend on one another (the room check of the one counts on the space the other frees): when ANY of
    // them is held ALL of them are, together in one pending change, the card 先问我再记 produces. Adds apply at once. With 先问我再记 on
    // everything waits as one change anyway; a group review has nothing but adds.
    const auto = !group && !locked.memoryAsk;
    const merged = auto ? faithful : [];
    const inMerge = opsOf(merged);
    const left = inPlaceLeft(changing, merged, auto);
    const held: Op[] = auto && left.some((op) => needsWords(op, input, asked)) ? left : [];
    const direct = changing.filter((op) => !held.includes(op) && !inMerge.has(op));
    if (merged.length > 0) {
      // First: what it frees in a room is there for the adds below.
      const notes = merged.flatMap((m) => [m.replace, ...m.removes]).map((op) => input.refs.get(op.ref)!);
      const result = await applyDream(t, { ...ids, sharedNotes: locked.sharedNotes, kinds }, merged.map(dreamMerge), refsOf(input.refs), {
        conversationId: locked.conversationId,
        status: "applied",
        phase: "rest",
        vaults: sorted.vaults,
        checked: new Set(merged.keys()),
        read: await asReviewed(t, ids, notes),
        resorted: new Map(),
        rooms: roomOf(config),
      });
      if (result?.changeId) {
        mergedNow = result.applied.filter((o) => o.op === "merge").length;
        written.push({ changeId: result.changeId, unlock: false, reason: null });
      }
    }
    const apply = (list: Op[], status: "applied" | "pending") =>
      applyOps(t, { ...ids, sharedNotes: locked.sharedNotes, kinds }, list, input.refs, {
        conversationId: locked.conversationId,
        originConversationId: conversationId,
        status,
        vaults: sorted.vaults,
        duplicates: sorted.duplicates,
        rooms: roomOf(config),
      });
    if (direct.length > 0) {
      const result = await apply(direct, locked.memoryAsk ? "pending" : "applied");
      if (result && !locked.memoryAsk) made.push(...result.applied);
      if (result?.changeId) written.push({ changeId: result.changeId, unlock: false, reason: locked.memoryAsk ? "ask_first" : null });
      if (result && result.unlocks.length > 0) {
        const targets = result.unlocks.flatMap((ref) => {
          const n = input.refs.get(ref);
          return n && !pending.unlocks.has(n.id) ? [{ kind: n.kind, id: n.id }] : [];
        });
        const unlockId = targets.length > 0 ? await proposeUnlocks(t, ids, locked.conversationId, targets) : null;
        if (unlockId) written.push({ changeId: unlockId, unlock: true, reason: "other" });
      }
    }
    if (held.length > 0) {
      const result = await apply(held, "pending");
      if (result?.changeId) written.push({ changeId: result.changeId, unlock: false, reason: heldFor(held, merges) });
    }
    await markReviewed(t, agentId, conversationId, input.upToSeq);
    const stored: StoredMessage[] = [];
    for (const w of written) {
      const notice = await memoryNotice(t, locked, w.changeId, { unlock: w.unlock, phase: "rest", linesOf });
      if (notice.body.pending === true && w.reason !== null) shown.push(w.reason);
      stored.push(notice);
    }
    return stored;
  });
  announce(deps, notices, agentId);
  if (notices !== null) {
    countNoteOps(db, made);
    count(db, "strength_bump", strengthened);
    // Every lock a review applies is one nobody was asked about.
    count(db, "lock_auto", made.filter((o) => o.op === "lock").length);
    count(db, "merge_auto", mergedNow);
    for (const reason of shown) count(db, `card_shown_${reason}`);
  }
  // A change that was applied may have left a room nearly full: that room is tidied now rather than at night.
  if (notices?.some((n) => n.body.status === "applied" && n.body.unlock !== true && Array.isArray(n.body.lines) && n.body.lines.length > 0)) ctx.changed?.(agentId);
  // A new topic's words were left for a review of their own: it follows this one.
  if (notices !== null && input.more) ctx.more?.();
  log.info({ metric: "memory_review", agentId, conversationId, ops: ops.length, notices: notices?.length ?? 0 }, "a memory review ended");
}

/**
 * Whether a replace or remove of the owner's own conversation lacks the owner's word and so waits for their yes: a `remove` unless the
 * owner asked, in the review's window, to forget or delete something (`asked`, the judgement's answer); a `replace` unless the window
 * holds an owner line at all and one of them came after the note was last changed. An `add`, a `lock` (always applied at once) or an
 * `unlock` (which is only ever a request) never waits for it.
 */
function needsWords(op: Op, input: Pick<ReviewInput, "ownerAt" | "refs">, asked: boolean): boolean {
  if (op.op === "remove") return !asked;
  if (op.op !== "replace") return false;
  const note = input.refs.get(op.ref);
  return note === undefined || input.ownerAt.length === 0 || !input.ownerAt.some((at) => at > note.updatedAt);
}

/**
 * Whether the owner asked to forget, for the removes among `left` (the answer's replaces and removes once its faithful merges are taken
 * out): the judgement's answer (`ownerAsked`), ONE request for the whole answer, made whatever words the owner used, but only when it can
 * change what is applied at once — in the owner's own conversation (a group review only adds), without 先问我再记 (everything waits then),
 * when `left` holds a remove, not when a replace of `left` waits whatever the answer (no owner line after its note's last change: the ops
 * left stand or fall together), and not once the service is closing (a request under way ends with it). Otherwise nothing is asked: not
 * asked for.
 */
async function askedFor(deps: PipelineDeps, agent: AgentRow, left: Op[], input: ReviewInput, group: boolean, closing: AbortSignal): Promise<boolean> {
  if (group || agent.memoryAsk || closing.aborted || !left.some((op) => op.op === "remove")) return false;
  if (left.some((op) => op.op === "replace" && needsWords(op, input, false))) return false;
  return ownerAsked({ db: deps.db, judge: deps.judge, ownerId: agent.ownerId, config: deps.config, log: deps.log }, input.said, closing);
}

/** Why a card waits for the owner (`card_shown_<reason>`): a remove not asked for, a merge not found faithful, 先问我再记, or anything else (a replace before the owner's word, a request to unlock). */
type CardReason = "remove" | "unfaithful_merge" | "ask_first" | "other";

/** Why the replaces and removes `held` wait: one of them is of a merge the judgement did not find faithful, else one is a remove the owner did not ask for, else a replace waits for the owner's word. */
const heldFor = (held: readonly Op[], merges: readonly Merge[]): CardReason =>
  merges.some((m) => held.includes(m.replace)) ? "unfaithful_merge" : held.some((op) => op.op === "remove") ? "remove" : "other";

/** A merge in a review's answer: the replace of a note, whose new text is meant to carry what the notes the removes name said. */
interface Merge {
  replace: Extract<Op, { op: "replace" }>;
  removes: Array<Extract<Op, { op: "remove" }>>;
}

/**
 * The merges among an answer's ops in place, found by their shape alone: in a room, its one `replace` (of note X) and every `remove` of
 * that room, one at least. Whether the new text of X carries what the removed notes said is the judgement's question (`faithfulOf`). No
 * merge in a room with two replaces or more (which one carries the removed notes is not known), nor when a note of it is named by another
 * op in place of the answer (X among the removes, a lock of X, a note removed twice): those follow the rule of before.
 */
function mergesOf(inPlaceOps: ReadonlyArray<Op>, refs: ReadonlyMap<string, RefNote>): Merge[] {
  const noteOf = (op: Op): RefNote | undefined => (inPlace(op) ? refs.get(op.ref) : undefined);
  const named = new Map<string, number>();
  for (const op of inPlaceOps) {
    const n = noteOf(op);
    if (n) named.set(noteKey(n.kind, n.id), (named.get(noteKey(n.kind, n.id)) ?? 0) + 1);
  }
  const once = (op: Op): boolean => {
    const n = noteOf(op);
    return n !== undefined && named.get(noteKey(n.kind, n.id)) === 1;
  };
  const merges: Merge[] = [];
  for (const kind of ["owner", "self"] as const) {
    const mine = inPlaceOps.filter((op) => noteOf(op)?.kind === kind);
    const replaces = mine.filter((op): op is Merge["replace"] => op.op === "replace");
    const removes = mine.filter((op): op is Merge["removes"][number] => op.op === "remove");
    if (replaces.length === 1 && removes.length > 0 && [replaces[0]!, ...removes].every(once)) merges.push({ replace: replaces[0]!, removes });
  }
  return merges;
}

/**
 * The merges of `merges` the judgement finds faithful, asked exactly as a dream's merge is (sort.ts `addsNothing`: the old texts of the
 * replaced note and of the removed ones as the sources, the new text as the result, `faithfulAt`), one request each, outside any
 * transaction; only where a merge may apply at once — in the owner's own conversation (a group review only adds), without 先问我再记
 * (everything waits then) — and not once the service is closing. No answer is not faithful: such a merge follows the rule of before.
 */
async function faithfulOf(deps: PipelineDeps, agent: AgentRow, merges: readonly Merge[], refs: ReadonlyMap<string, RefNote>, group: boolean, closing: AbortSignal): Promise<Merge[]> {
  if (group || agent.memoryAsk) return [];
  const sortDeps: SortDeps = { db: deps.db, judge: deps.judge, ownerId: agent.ownerId, config: deps.config, log: deps.log };
  const found: Merge[] = [];
  for (const m of merges) {
    if (closing.aborted) break;
    const sources = [m.replace, ...m.removes].map((op) => refs.get(op.ref)!.text);
    if (await addsNothing(sortDeps, { kind: "merge", sources, result: m.replace.text })) found.push(m);
  }
  return found;
}

/** The ops of `merged`. */
const opsOf = (merged: readonly Merge[]): Set<Op> => new Set(merged.flatMap((m) => [m.replace, ...m.removes]));

/** An answer's ops in place that are left to the hold rule: not in one of `merged`, and not a lock when locks apply at once (`auto`). */
function inPlaceLeft(changing: readonly Op[], merged: readonly Merge[], auto: boolean): Op[] {
  const inMerge = opsOf(merged);
  return changing.filter((op) => inPlace(op) && !inMerge.has(op) && !(auto && op.op === "lock"));
}

/** A faithful merge as the dream's op that applies it (apply.ts `applyDream`). */
const dreamMerge = (m: Merge): DreamOp => ({ op: "merge", into: m.replace.ref, from: m.removes.map((r) => r.ref), text: m.replace.text });

/** The notes a review's refs name, as `applyDream` takes them. */
const refsOf = (refs: ReadonlyMap<string, RefNote>): Map<string, { kind: NoteKind; id: string }> => new Map([...refs].map(([ref, n]) => [ref, { kind: n.kind, id: n.id }]));

/**
 * The exact `updated_at` (write.ts `exactTs`) of each of `notes` now, kept only while it is still the one the review read (`RefNote`'s, to
 * the millisecond a date holds): what a merge's notes are checked against where it is applied (apply.ts `planDream`'s `read`), so that a
 * note changed or gone since the review read it drops the merge, as it drops any op in place (apply.ts `plan`).
 */
async function asReviewed(q: Queryable, ids: { ownerId: string; agentId: string }, notes: ReadonlyArray<RefNote>): Promise<Map<string, string>> {
  const read = new Map<string, string>();
  for (const kind of ["owner", "self"] as const) {
    const mine = notes.filter((n) => n.kind === kind);
    const now = await stampsOf(q, kind === "owner" ? { kind, ownerId: ids.ownerId } : { kind, agentId: ids.agentId }, mine.map((n) => n.id));
    for (const n of mine) {
      const at = now.get(n.id)?.updatedAt;
      if (at !== undefined && Date.parse(at) === n.updatedAt.getTime()) read.set(n.id, at);
    }
  }
  return read;
}

/** Whether an op may be applied here: in a group only an addition (or a note's `seen`); only to a room this review may change. */
function allowed(op: Op, kinds: ReadonlySet<NoteKind>, group: boolean, refs: Map<string, RefNote>): boolean {
  if (op.op === "add") return kinds.has(op.kind);
  // That the owner mentioned a note again is no change to it: also in a group.
  if (group && op.op !== "seen") return false;
  const target = refs.get(op.ref);
  return target !== undefined && kinds.has(target.kind);
}

/** The duplicate test and the vault sorting for what the ops add or replace, outside any transaction. */
async function sortOps(
  deps: PipelineDeps,
  agent: AgentRow,
  ops: Op[],
  refs: Map<string, RefNote>,
  pending: ReadonlyArray<{ kind: NoteKind; text: string }>,
  closing: AbortSignal,
): Promise<{ vaults: Map<string, { vault: boolean; unsure: boolean }>; duplicates: Set<string>; repeats: Array<{ kind: NoteKind; id: string }> }> {
  const vaults = new Map<string, { vault: boolean; unsure: boolean }>();
  const duplicates = new Set<string>();
  const repeats: Array<{ kind: NoteKind; id: string }> = [];
  if (ops.every((o) => o.op !== "add" && o.op !== "replace")) return { vaults, duplicates, repeats };
  const { db, config, log } = deps;
  const sortDeps: SortDeps = { db, judge: deps.judge, ownerId: agent.ownerId, config, log };
  const setting = await getNewNotes(db, agent.ownerId);
  // Newest first: what a new note most likely repeats; what waits for the owner's yes counts as known.
  const known = (kind: NoteKind): KnownNote[] => [
    ...pending.flatMap((p, i) => (p.kind === kind ? [{ id: `pending-${i}`, text: p.text }] : [])).reverse(),
    ...[...refs.values()].filter((n) => n.kind === kind).reverse(),
  ];
  for (const op of ops) {
    if (closing.aborted) break;
    if (op.op === "add") {
      const same = await duplicateOf(sortDeps, op.text, known(op.kind));
      if (same !== null) {
        duplicates.add(op.text);
        // A repeat of a note (not of what only waits for the owner's yes) makes that note stronger.
        const note = [...refs.values()].find((n) => n.id === same);
        if (note) repeats.push({ kind: note.kind, id: note.id });
      } else vaults.set(vaultKey(op.kind, op.text), await sortNote(sortDeps, op.text, op.kind, setting));
    } else if (op.op === "replace") {
      const target = refs.get(op.ref);
      // A note inside the vault stays inside whatever the new text says: nothing to ask.
      if (target && !target.vault) vaults.set(vaultKey(target.kind, op.text), await sortNote(sortDeps, op.text, target.kind, setting));
    }
  }
  return { vaults, duplicates, repeats };
}

/**
 * The notes the answer's `add`s repeat word for word (case, whitespace and punctuation aside): `parseOps` drops such an add
 * (it is not new), and what the owner said again is what makes the note stronger. Only notes of the rooms this review may
 * change, whether or not it was shown them (in a group the vault is not shown, but is repeated all the same).
 */
async function exactRepeats(deps: PipelineDeps, agent: AgentRow, kinds: ReadonlySet<NoteKind>, answer: string, kept: Op[]): Promise<Array<{ kind: NoteKind; id: string }>> {
  const parsed = parseAnswer(answer);
  const list = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as { ops?: unknown }).ops : undefined;
  if (!Array.isArray(list)) return [];
  const keptKeys = new Set(kept.flatMap((o) => (o.op === "add" ? [sameKey(o.text)] : [])));
  const said = new Set<string>();
  for (const raw of lookedAt(list)) {
    if (typeof raw !== "object" || raw === null) continue;
    const { op, kind, text } = raw as { op?: unknown; kind?: unknown; text?: unknown };
    if (op !== "add" || (kind !== "owner" && kind !== "self") || !kinds.has(kind) || typeof text !== "string") continue;
    const clean = modelNote(text);
    if (clean !== null && !keptKeys.has(sameKey(clean))) said.add(sameKey(clean));
  }
  if (said.size === 0) return [];
  const rooms: Array<[NoteKind, Array<{ id: string; text: string }>]> = [
    ["owner", kinds.has("owner") && agent.sharedNotes ? await listOwnerNotes(deps.db, agent.ownerId) : []],
    ["self", kinds.has("self") ? await listAgentNotes(deps.db, agent.id) : []],
  ];
  return rooms.flatMap(([kind, notes]) => notes.filter((n) => said.has(sameKey(n.text))).map((n) => ({ kind, id: n.id })));
}
