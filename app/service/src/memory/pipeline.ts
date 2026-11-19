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
import { applyOps, proposeUnlocks, vaultKey, type StoredOp } from "./apply.ts";
import { memoryCall, type MemoryCallReport } from "./call.ts";
import { modelNote } from "./clean.ts";
import { MAX_OPS, parseAnswer, parseOps, sameKey, type Op } from "./ops.ts";
import { linesOf, readReview, type RefNote } from "./review.ts";
import { duplicateOf, sortNote, type SortDeps } from "./sort.ts";
import { getNewNotes, listAgentNotes, listOwnerNotes, roomOf, type NoteKind } from "./store.ts";
import { bumpNotes } from "./write.ts";

/**
 * One review, start to finish (the scheduler, reviewer.ts, decides when): the input (`reviewInput`), one metered call
 * (`memoryCall`), the answer as safe operations (`parseOps`), the duplicate test and the vault sorting for what they add
 * (outside any transaction), then one transaction that applies them (`applyOps`), moves `reviewed_seq` and writes the
 * owner's notice, and the notice's announcement after commit.
 *
 * Fail closed: a call that could not be made, failed or was abandoned changes nothing and leaves `reviewed_seq`; an answer
 * that cannot be used (garbage, cut, empty) changes nothing but is reviewed (`reviewed_seq` moves, as it does when there
 * was no owner message to look at). In a group only additions are applied: forgetting and locking by speech are the
 * owner's, in their own conversation. What this owner has pending already counts as known.
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
}

export interface ReviewContext {
  /** The service is stopping: a call under way is abandoned, and nothing is applied. */
  closing: AbortSignal;
  /** Called with the newest seq a review looked at, as soon as it is known (before its call). */
  attempted(seq: number): void;
  /** After commit: a change was applied to the notes of this Agent's owner; the scheduler may nap the rooms it left nearly full. */
  changed?(agentId: string): void;
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

/** What this owner has waiting for their yes: texts of added, replaced, merged or split entries, and the notes asked to be unlocked. */
async function pendingOf(db: Db, agent: AgentRow): Promise<{ texts: Array<{ kind: NoteKind; text: string }>; unlocks: Set<string> }> {
  const { rows } = await db.query<{ agent_id: string; ops: StoredOp[] }>("select agent_id, ops from memory_changes where owner_id = $1 and status = 'pending'", [agent.ownerId]);
  const texts: Array<{ kind: NoteKind; text: string }> = [];
  const unlocks = new Set<string>();
  for (const row of rows) {
    for (const s of row.ops) {
      // The owner's room is shared by all their Agents; an Agent's own room is its own.
      if (s.kind === "self" && row.agent_id !== agent.id) continue;
      if ((s.op === "add" || s.op === "replace" || s.op === "merge") && s.after) texts.push({ kind: s.kind, text: s.after });
      if (s.op === "split") for (const part of s.parts ?? []) texts.push({ kind: s.kind, text: part.text });
      if (s.op === "unlock" && s.noteId) unlocks.add(s.noteId);
    }
  }
  return { texts, unlocks };
}

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
  how: { unlock: boolean; phase: "rest" | "dream"; linesOf: (ops: StoredOp[]) => { lines: string[]; vaultLines: boolean[] } },
): Promise<StoredMessage> {
  const row = (await t.query<{ ops: StoredOp[]; full: boolean; status: "applied" | "pending" }>(`select ops, "full", status from memory_changes where id = $1`, [changeId])).rows[0]!;
  let status = row.status;
  if (status === "pending" && row.ops.length === 0) {
    await t.query("update memory_changes set status = 'applied', resolved_at = now() where id = $1", [changeId]);
    status = "applied";
  }
  const { lines, vaultLines } = how.linesOf(row.ops);
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

export async function runReview(deps: PipelineDeps, job: ReviewJob, ctx: ReviewContext): Promise<void> {
  const { db, config, log } = deps;
  const { agentId, conversationId } = job;
  const agent = await reviewableAgent(db, agentId);
  if (agent === null || ctx.closing.aborted) return;
  const group = conversationId !== agent.conversationId;
  const kinds = await kindsFor(db, agent, conversationId, group);
  const { input, seen } = await readReview(db, agent, conversationId, await reviewedSeq(db, agentId, conversationId), { kinds, config, now: new Date(deps.now()) });
  if (input === null) {
    // Nothing the owner said to look at: what the read saw is not looked at again, and nothing newer than what it saw is
    // marked (an owner message committed after the read is still to be reviewed).
    if (seen !== null) await markReviewed(db, agentId, conversationId, seen);
    return;
  }
  ctx.attempted(input.upToSeq);
  const pending = await pendingOf(db, agent);

  const report: MemoryCallReport = { answered: false };
  let answer = await memoryCall(
    { db, models: deps.models, config, log, inFlight: deps.inFlight },
    agent.ownerId,
    { system: input.system, user: input.user, maxOutputTokens: config.memory.reviewMaxOutputTokens },
    ctx.closing,
    report,
  );
  // Charged for an answer that cannot be used: reviewed all the same (nothing is asked again for the same words).
  if (answer === null && report.answered) answer = "";
  if (answer === null || ctx.closing.aborted) return;

  const ops = parseOps(answer, new Set(input.refs.keys()), [...input.existing, ...pending.texts.map((p) => p.text)]).filter((op) => allowed(op, kinds, group, input.refs));
  const sorted = await sortOps(deps, agent, ops, input.refs, group ? [] : pending.texts, ctx.closing);
  if (ctx.closing.aborted) return;
  // What the owner said again: the notes the answer's adds repeat, by the judgement or word for word, are one stronger (below).
  const repeats = [...sorted.repeats, ...(await exactRepeats(deps, agent, kinds, answer, ops))];

  const notices = await inLockedAgent(db, agentId, async (t, locked): Promise<StoredMessage[]> => {
    const ids = { ownerId: locked.ownerId, agentId };
    const written: Array<{ changeId: string; unlock: boolean }> = [];
    // Strength is no change anybody is told of: no change row, no notice, `updated_at` untouched (so no undo goes stale).
    const bumped = new Set<string>();
    for (const kind of ["owner", "self"] as const) {
      const ids = [...new Set(repeats.filter((r) => r.kind === kind).map((r) => r.id))].filter((id) => !bumped.has(id));
      for (const id of ids) bumped.add(id);
      await bumpNotes(t, kind === "owner" ? { kind, ownerId: locked.ownerId } : { kind, agentId }, ids);
    }
    if (ops.length > 0) {
      const result = await applyOps(t, { ...ids, sharedNotes: locked.sharedNotes, kinds }, ops, input.refs, {
        conversationId: locked.conversationId,
        originConversationId: conversationId,
        status: locked.memoryAsk ? "pending" : "applied",
        vaults: sorted.vaults,
        duplicates: sorted.duplicates,
        rooms: roomOf(config),
      });
      if (result?.changeId) written.push({ changeId: result.changeId, unlock: false });
      if (result && result.unlocks.length > 0) {
        const targets = result.unlocks.flatMap((ref) => {
          const n = input.refs.get(ref);
          return n && !pending.unlocks.has(n.id) ? [{ kind: n.kind, id: n.id }] : [];
        });
        const unlockId = targets.length > 0 ? await proposeUnlocks(t, ids, locked.conversationId, targets) : null;
        if (unlockId) written.push({ changeId: unlockId, unlock: true });
      }
    }
    await markReviewed(t, agentId, conversationId, input.upToSeq);
    const stored: StoredMessage[] = [];
    for (const w of written) stored.push(await memoryNotice(t, locked, w.changeId, { unlock: w.unlock, phase: "rest", linesOf }));
    return stored;
  });
  announce(deps, notices, agentId);
  // A change that was applied may have left a room nearly full: that room is tidied now rather than at night.
  if (notices?.some((n) => n.body.status === "applied" && n.body.unlock !== true && Array.isArray(n.body.lines) && n.body.lines.length > 0)) ctx.changed?.(agentId);
  log.info({ metric: "memory_review", agentId, conversationId, ops: ops.length, notices: notices?.length ?? 0 }, "a memory review ended");
}

/** Whether an op may be applied here: in a group only an addition; only to a room this review may change. */
function allowed(op: Op, kinds: ReadonlySet<NoteKind>, group: boolean, refs: Map<string, RefNote>): boolean {
  if (op.op === "add") return kinds.has(op.kind);
  if (group) return false;
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
  const sortDeps: SortDeps = { db, judge: deps.judge, config, log };
  const setting = await getNewNotes(db, agent.ownerId);
  // Newest first: what a new note most likely repeats; what waits for the owner's yes counts as known.
  const known = (kind: NoteKind) => [
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
  for (const raw of list.slice(0, MAX_OPS)) {
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
