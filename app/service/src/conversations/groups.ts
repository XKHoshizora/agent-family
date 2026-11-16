import type { Tx } from "../db.ts";
import { AppError, notFound } from "../errors.ts";
import { lockPair, lockPairs } from "../social/pair.ts";
import { areFriends, blockBetween } from "../social/relations.ts";
import type { Change } from "./events.ts";
import {
  MAX_GROUP_MEMBERS,
  currentMemberIds,
  currentMembership,
  lockConversation,
  peekConversation,
  type ConversationRow,
  type Membership,
} from "./store.ts";
import { appendSystem } from "./system.ts";

const forbidden = () => new AppError(403, "forbidden");

/** Only friends without a block in either direction may put each other into a group. Caller holds the pair lock. */
async function mayAdd(t: Tx, actorId: string, targetId: string): Promise<boolean> {
  return (await areFriends(t, actorId, targetId)) && !(await blockBetween(t, actorId, targetId));
}

/** An Agent is never a group member: its id is refused like any other malformed request (400 `invalid_request`). */
async function refuseAgents(t: Tx, ids: string[]): Promise<void> {
  const { rowCount } = await t.query("select 1 from principals where id = any($1::uuid[]) and kind = 'agent' limit 1", [ids]);
  if (rowCount) throw new AppError(400, "invalid_request");
}

/**
 * Locks an open group for a change by `actorId`: the pair lock with `pairWith` first (when the change
 * checks their relationship), then the row. 404 for direct chats, closed or missing groups and non-members.
 */
async function lockGroup(
  t: Tx,
  conversationId: string,
  actorId: string,
  pairWith?: string,
): Promise<{ conversation: ConversationRow; membership: Membership }> {
  const peek = await peekConversation(t, conversationId);
  if (peek?.type !== "group") throw notFound();
  if (pairWith !== undefined && pairWith !== actorId) await lockPair(t, actorId, pairWith);
  const conversation = await lockConversation(t, conversationId);
  if (!conversation || conversation.closedAt) throw notFound();
  const membership = await currentMembership(t, conversationId, actorId);
  if (!membership) throw notFound();
  return { conversation, membership };
}

/**
 * A group of the creator and at least two of the creator's friends (distinct, not the creator), all
 * speakers from seq 0; nobody needs to confirm. 403 `forbidden` if any is not a friend, a block exists
 * either way, or the group would exceed 500.
 */
export async function createGroup(
  t: Tx,
  creatorId: string,
  title: string,
  memberIds: string[],
): Promise<{ conversationId: string; change: Change }> {
  if (new Set(memberIds).size !== memberIds.length || memberIds.length < 2 || memberIds.includes(creatorId)) {
    throw new AppError(400, "invalid_request");
  }
  if (memberIds.length + 1 > MAX_GROUP_MEMBERS) throw forbidden();
  await refuseAgents(t, memberIds);
  await lockPairs(t, memberIds.map((m) => [creatorId, m] as const));
  for (const m of memberIds) if (!(await mayAdd(t, creatorId, m))) throw forbidden();

  const { rows } = await t.query<{ id: string }>(
    "insert into conversations (type, title, creator_id) values ('group', $1, $2) returning id",
    [title, creatorId],
  );
  const id = rows[0]!.id;
  const everyone = [creatorId, ...memberIds];
  await t.query(
    `insert into memberships (conversation_id, principal_id, role, joined_seq)
     select $1, p, 'speaker', 0 from unnest($2::uuid[]) as p`,
    [id, everyone],
  );
  await lockConversation(t, id);
  const notice = await appendSystem(t, id, { event: "group_created", actorId: creatorId, title, memberIds });
  return {
    conversationId: id,
    change: { messages: [notice], conversations: [{ conversationId: id, principalIds: everyone }] },
  };
}

/**
 * Any current member adds one of their own friends. The newcomer's `joined_seq` is the seq at this
 * moment, so they see the "joined" notice and nothing before it. 409 `already_member`; 403 `forbidden`
 * for non-friends, blocks either way, or a 501st member.
 */
export async function addMember(t: Tx, conversationId: string, actorId: string, targetId: string): Promise<Change> {
  const { conversation } = await lockGroup(t, conversationId, actorId, targetId);
  await refuseAgents(t, [targetId]);
  if (await currentMembership(t, conversationId, targetId)) throw new AppError(409, "already_member");
  if (!(await mayAdd(t, actorId, targetId))) throw forbidden();
  const before = await currentMemberIds(t, conversationId);
  if (before.length + 1 > MAX_GROUP_MEMBERS) throw forbidden();

  await t.query(
    `insert into memberships (conversation_id, principal_id, role, joined_seq) values ($1, $2, 'speaker', $3)`,
    [conversationId, targetId, conversation.seq],
  );
  const notice = await appendSystem(t, conversationId, { event: "member_joined", actorId, principalId: targetId });
  return { messages: [notice], conversations: [{ conversationId, principalIds: [...before, targetId] }] };
}

/**
 * Leaving (target = actor; anyone) or removal (only the creator). `left_seq` is the seq of the notice, so
 * the person who left does not see it. When the creator leaves, the earliest current member (lowest
 * `joined_seq`, ties by membership id) becomes creator; when the last member leaves the group closes.
 */
export async function removeMember(t: Tx, conversationId: string, actorId: string, targetId: string): Promise<Change> {
  const { conversation, membership } = await lockGroup(t, conversationId, actorId);
  const leaving = targetId === actorId;
  if (!leaving && conversation.creatorId !== actorId) throw forbidden();
  const target = leaving ? membership : await currentMembership(t, conversationId, targetId);
  if (!target) throw notFound();

  const before = await currentMemberIds(t, conversationId);
  const remaining = before.filter((id) => id !== targetId);
  const newCreatorId = targetId === conversation.creatorId ? (remaining[0] ?? null) : null;
  const notice = await appendSystem(
    t,
    conversationId,
    leaving
      ? { event: "member_left", actorId, principalId: actorId, newCreatorId }
      : { event: "member_removed", actorId, principalId: targetId },
  );
  await t.query("update memberships set left_seq = $2 where id = $1", [target.id, notice.seq]);
  if (newCreatorId) await t.query("update conversations set creator_id = $2 where id = $1", [conversationId, newCreatorId]);
  if (remaining.length === 0) await t.query("update conversations set closed_at = now() where id = $1", [conversationId]);
  return { messages: [notice], conversations: [{ conversationId, principalIds: before }] };
}

/** Only the creator renames. Renaming to the current title changes nothing and announces nothing. */
export async function renameGroup(t: Tx, conversationId: string, actorId: string, title: string): Promise<Change> {
  const { conversation } = await lockGroup(t, conversationId, actorId);
  if (conversation.creatorId !== actorId) throw forbidden();
  if (conversation.title === title) return { messages: [], conversations: [] };
  await t.query("update conversations set title = $2 where id = $1", [conversationId, title]);
  const notice = await appendSystem(t, conversationId, { event: "group_renamed", actorId, title });
  const members = await currentMemberIds(t, conversationId);
  return { messages: [notice], conversations: [{ conversationId, principalIds: members }] };
}
