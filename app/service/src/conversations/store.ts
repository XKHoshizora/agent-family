import type { Queryable, Tx } from "../db.ts";
import { AppError, notFound } from "../errors.ts";
import type { PairEvent, StoredMessage } from "../messages/model.ts";
import { lockPair, orderedPair } from "../social/pair.ts";
import { canDirectSend } from "../social/relations.ts";
import { appendSystem } from "./system.ts";

/**
 * THE visibility rule, and the only place it is written down. Join it onto `messages m`. A message is
 * visible iff the reader has a CURRENT membership (`left_seq is null`) in its conversation that began
 * before it (`joined_seq < seq`). Nothing else grants read access: not an earlier stay, not having sent
 * the message, not quoting it.
 *
 * `reader` is the SQL expression holding the reader's principal id — a parameter or a column such as
 * `r.reader_id` for many readers at once. It is spliced into SQL: only ever pass a literal written in code.
 */
export function visibleJoin(reader: string): string {
  return `join memberships vis on vis.conversation_id = m.conversation_id and vis.principal_id = ${reader} and vis.left_seq is null and vis.joined_seq < m.seq`;
}

/**
 * `visibleJoin` for one reader passed as `$1`:
 *
 *   select ... from messages m ${VISIBLE_JOIN} where m.conversation_id = $2 ...
 */
export const VISIBLE_JOIN = visibleJoin("$1");

export const MAX_GROUP_MEMBERS = 500;

export interface ConversationRow {
  id: string;
  type: "direct" | "group";
  title: string | null;
  creatorId: string;
  /** The last assigned message seq. */
  seq: number;
  closedAt: Date | null;
}

export interface Membership {
  id: string;
  conversationId: string;
  principalId: string;
  role: "speaker" | "observer";
  joinedSeq: number;
  leftSeq: number | null;
  readSeq: number;
}

interface ConversationDbRow {
  id: string;
  type: "direct" | "group";
  title: string | null;
  creator_id: string;
  seq: string;
  closed_at: Date | null;
}

interface MembershipDbRow {
  id: string;
  conversation_id: string;
  principal_id: string;
  role: "speaker" | "observer";
  joined_seq: string;
  left_seq: string | null;
  read_seq: string;
}

const toConversation = (r: ConversationDbRow): ConversationRow => ({
  id: r.id,
  type: r.type,
  title: r.title,
  creatorId: r.creator_id,
  seq: Number(r.seq),
  closedAt: r.closed_at,
});

const toMembership = (r: MembershipDbRow): Membership => ({
  id: r.id,
  conversationId: r.conversation_id,
  principalId: r.principal_id,
  role: r.role,
  joinedSeq: Number(r.joined_seq),
  leftSeq: r.left_seq === null ? null : Number(r.left_seq),
  readSeq: Number(r.read_seq),
});

/** Locks the conversation row (`select … for update`) for the rest of the transaction. */
export async function lockConversation(t: Tx, conversationId: string): Promise<ConversationRow | null> {
  const { rows } = await t.query<ConversationDbRow>(
    "select id, type, title, creator_id, seq, closed_at from conversations where id = $1 for update",
    [conversationId],
  );
  return rows[0] ? toConversation(rows[0]) : null;
}

/** The principal's current membership (`left_seq is null`), or null. */
export async function currentMembership(q: Queryable, conversationId: string, principalId: string): Promise<Membership | null> {
  const { rows } = await q.query<MembershipDbRow>(
    `select id, conversation_id, principal_id, role, joined_seq, left_seq, read_seq
       from memberships where conversation_id = $1 and principal_id = $2 and left_seq is null`,
    [conversationId, principalId],
  );
  return rows[0] ? toMembership(rows[0]) : null;
}

export async function currentMemberIds(q: Queryable, conversationId: string): Promise<string[]> {
  const { rows } = await q.query<{ principal_id: string }>(
    "select principal_id from memberships where conversation_id = $1 and left_seq is null order by joined_seq, id",
    [conversationId],
  );
  return rows.map((r) => r.principal_id);
}

/** Type and (for direct chats) the pair, without locking: neither ever changes after creation. */
export async function peekConversation(
  q: Queryable,
  conversationId: string,
): Promise<{ type: "direct" | "group"; pair: [string, string] | null } | null> {
  const { rows } = await q.query<{ type: "direct" | "group"; a_id: string | null; b_id: string | null }>(
    `select c.type, d.a_id, d.b_id from conversations c left join direct_pairs d on d.conversation_id = c.id
      where c.id = $1`,
    [conversationId],
  );
  const r = rows[0];
  if (!r) return null;
  return { type: r.type, pair: r.a_id && r.b_id ? [r.a_id, r.b_id] : null };
}

export interface WriteLock {
  conversation: ConversationRow;
  membership: Membership;
  /** The other party of a direct conversation; null in groups. */
  peerId: string | null;
}

/**
 * Takes the locks for a write by `principalId` in the global order — the pair lock first for a direct
 * conversation, then the conversation row — and returns the locked state. 404 `not_found` unless
 * `principalId` is a current member of the open conversation (the same answer as for a missing one).
 */
export async function lockForWrite(t: Tx, conversationId: string, principalId: string): Promise<WriteLock> {
  const peek = await peekConversation(t, conversationId);
  if (!peek) throw notFound();
  let peerId: string | null = null;
  if (peek.type === "direct") {
    if (!peek.pair) throw notFound();
    const [a, b] = peek.pair;
    if (principalId !== a && principalId !== b) throw notFound();
    peerId = principalId === a ? b : a;
    await lockPair(t, a, b);
  }
  const conversation = await lockConversation(t, conversationId);
  if (!conversation || conversation.closedAt) throw notFound();
  const membership = await currentMembership(t, conversationId, principalId);
  if (!membership) throw notFound();
  return { conversation, membership, peerId };
}

export type CanSend = { ok: true } | { ok: false; reason: "blocked" | "not_friends" };

async function permission(q: Queryable, type: "direct" | "group", principalId: string, peerId: string | null): Promise<CanSend> {
  if (type === "group") return { ok: true };
  const reason = await canDirectSend(q, principalId, peerId!);
  return reason ? { ok: false, reason } : { ok: true };
}

/**
 * Whether `principalId` may send in the conversation right now: direct chats follow the pair's
 * friendship and blocks, groups let every current member send. Null when not a current member of an
 * open conversation. Advisory outside a transaction (sync uses it to show state); sends re-check under locks.
 */
export async function canSend(q: Queryable, conversationId: string, principalId: string): Promise<CanSend | null> {
  const { rows } = await q.query<{ type: "direct" | "group"; a_id: string | null; b_id: string | null }>(
    `select c.type, d.a_id, d.b_id
       from conversations c
       join memberships ms on ms.conversation_id = c.id and ms.principal_id = $2 and ms.left_seq is null
       left join direct_pairs d on d.conversation_id = c.id
      where c.id = $1 and c.closed_at is null`,
    [conversationId, principalId],
  );
  const r = rows[0];
  if (!r) return null;
  const peerId = r.type === "direct" ? (r.a_id === principalId ? r.b_id : r.a_id) : null;
  return permission(q, r.type, principalId, peerId);
}

/** Inside a write holding `lockForWrite`: 403 `cannot_send` with the reason, the same refusal a send gets. */
export async function assertCanSend(t: Tx, lock: WriteLock): Promise<void> {
  const verdict = await permission(t, lock.conversation.type, lock.membership.principalId, lock.peerId);
  if (!verdict.ok) throw new AppError(403, "cannot_send", { reason: verdict.reason });
}

export async function findDirect(q: Queryable, a: string, b: string): Promise<string | null> {
  const [lo, hi] = orderedPair(a, b);
  const { rows } = await q.query<{ conversation_id: string }>(
    "select conversation_id from direct_pairs where a_id = $1 and b_id = $2",
    [lo, hi],
  );
  return rows[0]?.conversation_id ?? null;
}

/**
 * The direct conversation for the unordered pair, created on first use. Idempotent and race-safe
 * (serialised on the pair lock). `creatorId` (the accepter, when called from accept) is recorded as
 * creator. Both parties are speakers from seq 0 and stay members for good, so re-befriending after
 * unfriending reuses the same conversation.
 */
export async function ensureDirect(t: Tx, a: string, b: string, creatorId: string = b): Promise<string> {
  await lockPair(t, a, b);
  const existing = await findDirect(t, a, b);
  if (existing) return existing;

  const [lo, hi] = orderedPair(a, b);
  const created = await t.query<{ id: string }>(
    "insert into conversations (type, creator_id) values ('direct', $1) returning id",
    [creatorId],
  );
  const id = created.rows[0]!.id;
  await t.query("insert into direct_pairs (conversation_id, a_id, b_id) values ($1, $2, $3)", [id, lo, hi]);
  await t.query(
    `insert into memberships (conversation_id, principal_id, role, joined_seq)
     values ($1, $2, 'speaker', 0), ($1, $3, 'speaker', 0)`,
    [id, lo, hi],
  );
  return id;
}

/**
 * Appends a relationship notice to the pair's direct conversation, if they have one, in the caller's
 * transaction (which already holds the pair lock; taking it again is a no-op that pins the lock order).
 */
export async function appendDirectNotice(t: Tx, e: PairEvent): Promise<StoredMessage | null> {
  await lockPair(t, e.actorId, e.principalId);
  const id = await findDirect(t, e.actorId, e.principalId);
  if (!id) return null;
  await lockConversation(t, id);
  return appendSystem(t, id, e);
}

export interface MemberView {
  id: string;
  handle: string;
  displayName: string;
  kind: "human" | "agent";
  role: "speaker" | "observer";
  /** Only ever true in groups. */
  isCreator: boolean;
}

/**
 * The current members, as `readerId` may see them: null unless the reader is a current member. One
 * statement, so the membership check and the list come from the same snapshot (a member removed
 * concurrently never receives the list as it is after their removal).
 */
export async function listMembers(q: Queryable, readerId: string, conversationId: string): Promise<MemberView[] | null> {
  const { rows } = await q.query<{
    id: string;
    handle: string;
    display_name: string;
    kind: "human" | "agent";
    role: "speaker" | "observer";
    is_creator: boolean;
  }>(
    `select p.id, p.handle::text as handle, p.display_name, p.kind, ms.role,
            (c.type = 'group' and c.creator_id = p.id) as is_creator
       from memberships me
       join conversations c on c.id = me.conversation_id
       join memberships ms on ms.conversation_id = me.conversation_id and ms.left_seq is null
       join principals p on p.id = ms.principal_id
      where me.conversation_id = $1 and me.principal_id = $2 and me.left_seq is null
      order by ms.joined_seq, ms.id`,
    [conversationId, readerId],
  );
  // A current member always sees at least themselves, so no rows means "not a member".
  if (rows.length === 0) return null;
  return rows.map((r) => ({
    id: r.id,
    handle: r.handle,
    displayName: r.display_name,
    kind: r.kind,
    role: r.role,
    isCreator: r.is_creator,
  }));
}
