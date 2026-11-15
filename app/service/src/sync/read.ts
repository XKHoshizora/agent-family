import { VISIBLE_JOIN } from "../conversations/store.ts";
import type { Db, Tx } from "../db.ts";
import { MESSAGE_COLUMNS, toStored, type MessageRow, type StoredMessage, type WireMessage } from "../messages/model.ts";
import { toWireFor } from "../messages/read.ts";
import { canDirectSendMany, type DirectRefusal } from "../social/relations.ts";

/** How many of the newest visible messages per conversation `GET /api/sync` returns. */
export const SYNC_MESSAGES_PER_CONVERSATION = 30;
/** At most this many messages per catch-up response. */
export const CATCHUP_MAX_MESSAGES = 500;
/** At most this many conversations per catch-up request. */
export const CATCHUP_MAX_POSITIONS = 500;

type Role = "speaker" | "observer";

export interface SyncConversation {
  id: string;
  type: "direct" | "group";
  title: string | null;
  /** Groups only: a direct chat has no creator role (and `isCreator` is false for both of its members). */
  creatorId?: string;
  myRole: Role;
  closed: boolean;
  /** When the conversation was created (ISO 8601): `/api/sync`'s order, and a place for one without messages. */
  createdAt: string;
  /** Direct chats only: the other party, from the pair the conversation belongs to (as the send path). */
  peerId?: string;
  canSend: { ok: true } | { ok: false; reason: "blocked" | "not_friends" | "closed" };
  members: Array<{ id: string; role: Role; isCreator: boolean }>;
  /** The conversation's last assigned seq (it reveals how much was said, also before the caller joined). */
  lastSeq: number;
  readSeq: number;
  /** Visible messages from others, not system notices, after `readSeq`. */
  unread: number;
  /** Direct chats only: how far the other party has read. */
  peerReadSeq?: number;
}

export interface SyncPrincipal {
  id: string;
  handle: string;
  displayName: string;
  kind: "human" | "agent";
}

export interface SyncView {
  conversations: SyncConversation[];
  /** Every principal the response mentions: members, the caller, and anyone named in a visible message. */
  principals: SyncPrincipal[];
  /** Per conversation (in `conversations` order) its newest visible messages, ascending by seq. */
  messages: WireMessage[];
}

export interface CatchUp {
  /** Per conversation (in request order) the next visible messages after the position, ascending by seq. */
  messages: WireMessage[];
  /** Requested ids the caller is not a current member of — left, removed, never a member or unknown alike. */
  gone: string[];
  /** The 500-message cap cut the response short: ask again with the advanced positions. */
  more: boolean;
}

/**
 * Runs `fn` in a read-only transaction on one snapshot, so every part of a response describes the same
 * moment: the membership that admits a message is the one that was current when it was read.
 */
function onSnapshot<T>(db: Db, fn: (t: Tx) => Promise<T>): Promise<T> {
  return db.tx(async (t) => {
    await t.query("set transaction isolation level repeatable read, read only");
    return fn(t);
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Principal ids a rendered message names: its sender, a visible quote's sender, a notice's participants. */
function mentionedIn(m: WireMessage): string[] {
  const ids: unknown[] = [m.senderId];
  if (m.replyTo?.visible) ids.push(m.replyTo.senderId);
  if (m.system) {
    const { actorId, principalId, newCreatorId, memberIds } = m.system as Record<string, unknown>;
    ids.push(actorId, principalId, newCreatorId, ...(Array.isArray(memberIds) ? memberIds : []));
  }
  return ids.filter((id): id is string => typeof id === "string" && UUID.test(id)).map((id) => id.toLowerCase());
}

/**
 * The caller's entries for the conversations they are currently in (all of them, or only `onlyId`), in
 * `/api/sync` order: what both `GET /api/sync` and `GET /api/conversations/:id` answer.
 */
async function conversationEntries(t: Tx, me: string, onlyId: string | null = null): Promise<SyncConversation[]> {
  const conversations = await t.query<{
    id: string;
    type: "direct" | "group";
    title: string | null;
    creator_id: string;
    seq: string;
    closed: boolean;
    created_at: Date;
    role: Role;
    read_seq: string;
    peer_id: string | null;
    peer_read_seq: string | null;
    unread: string;
  }>(
    // A direct chat's other party comes from its pair (direct_pairs), the one source the send path uses;
    // only the peer's read marker is read from their membership.
    `select c.id, c.type, c.title, c.creator_id, c.seq, c.closed_at is not null as closed, c.created_at, me.role, me.read_seq,
            pair.peer_id, peer.read_seq as peer_read_seq,
            (select count(*) from messages m ${VISIBLE_JOIN}
              where m.conversation_id = c.id and m.seq > me.read_seq and m.kind <> 'system' and m.sender_id <> $1) as unread
       from memberships me
       join conversations c on c.id = me.conversation_id
       left join lateral (
         select case when d.a_id = $1 then d.b_id else d.a_id end as peer_id
           from direct_pairs d where d.conversation_id = c.id
       ) pair on true
       left join memberships peer
         on peer.conversation_id = c.id and peer.principal_id = pair.peer_id and peer.left_seq is null
      where me.principal_id = $1 and me.left_seq is null and ($2::uuid is null or me.conversation_id = $2::uuid)
      order by c.created_at, c.id`,
    [me, onlyId],
  );
  if (conversations.rows.length === 0) return [];

  const members = await t.query<{ conversation_id: string; principal_id: string; role: Role; is_creator: boolean }>(
    `select ms.conversation_id, ms.principal_id, ms.role, (c.type = 'group' and c.creator_id = ms.principal_id) as is_creator
       from memberships me
       join conversations c on c.id = me.conversation_id
       join memberships ms on ms.conversation_id = me.conversation_id and ms.left_seq is null
      where me.principal_id = $1 and me.left_seq is null and ($2::uuid is null or me.conversation_id = $2::uuid)
      order by ms.joined_seq, ms.id`,
    [me, onlyId],
  );
  const membersOf = new Map<string, SyncConversation["members"]>();
  for (const r of members.rows) {
    const list = membersOf.get(r.conversation_id) ?? [];
    list.push({ id: r.principal_id, role: r.role, isCreator: r.is_creator });
    membersOf.set(r.conversation_id, list);
  }

  const verdicts = await canDirectSendMany(
    t,
    me,
    conversations.rows.flatMap((c) => (c.peer_id ? [c.peer_id] : [])),
  );
  /** A direct chat without a verdict (cannot happen) shows as refused, never as allowed. */
  const directVerdict = (peerId: string | null): DirectRefusal | null => {
    const verdict = peerId ? verdicts.get(peerId) : undefined;
    return verdict === undefined ? "not_friends" : verdict;
  };
  return conversations.rows.map((c) => {
    const verdict = c.type === "direct" ? directVerdict(c.peer_id) : null;
    return {
      id: c.id,
      type: c.type,
      title: c.title,
      ...(c.type === "group" ? { creatorId: c.creator_id } : {}),
      myRole: c.role,
      closed: c.closed,
      createdAt: c.created_at.toISOString(),
      ...(c.type === "direct" && c.peer_id ? { peerId: c.peer_id } : {}),
      canSend: c.closed ? { ok: false, reason: "closed" } : verdict ? { ok: false, reason: verdict } : { ok: true },
      members: membersOf.get(c.id) ?? [],
      lastSeq: Number(c.seq),
      readSeq: Number(c.read_seq),
      unread: Number(c.unread),
      ...(c.type === "direct" && c.peer_read_seq !== null ? { peerReadSeq: Number(c.peer_read_seq) } : {}),
    };
  });
}

/**
 * One conversation as the caller's `/api/sync` shows it, or null unless they are a current member (never,
 * left, removed, unknown alike).
 */
export async function syncConversation(db: Db, me: string, conversationId: string): Promise<SyncConversation | null> {
  return onSnapshot(db, async (t) => (await conversationEntries(t, me, conversationId))[0] ?? null);
}

/** Everything the web client loads at start: the caller's current conversations and what they may read of them. */
export async function syncView(db: Db, me: string): Promise<SyncView> {
  return onSnapshot(db, async (t) => {
    const out = await conversationEntries(t, me);

    const recent = await t.query<MessageRow>(
      `select ${MESSAGE_COLUMNS}
         from memberships me
         cross join lateral (
           select m.* from messages m ${VISIBLE_JOIN}
            where m.conversation_id = me.conversation_id
            order by m.seq desc limit ${SYNC_MESSAGES_PER_CONVERSATION}
         ) m
        where me.principal_id = $1 and me.left_seq is null`,
      [me],
    );
    const recentOf = new Map<string, StoredMessage[]>();
    for (const m of recent.rows.map(toStored)) {
      const list = recentOf.get(m.conversationId) ?? [];
      list.push(m);
      recentOf.set(m.conversationId, list);
    }
    const ordered = out.flatMap((c) => (recentOf.get(c.id) ?? []).sort((x, y) => x.seq - y.seq));
    const messages = await toWireFor(t, me, ordered);

    const mentioned = new Set<string>([me.toLowerCase()]);
    for (const c of out) for (const m of c.members) mentioned.add(m.id);
    for (const m of messages) for (const id of mentionedIn(m)) mentioned.add(id);
    const principals = await t.query<{ id: string; handle: string; display_name: string; kind: "human" | "agent" }>(
      "select id, handle::text as handle, display_name, kind from principals where id = any($1::uuid[]) order by handle",
      [[...mentioned]],
    );

    return {
      conversations: out,
      principals: principals.rows.map((p) => ({ id: p.id, handle: p.handle, displayName: p.display_name, kind: p.kind })),
      messages,
    };
  });
}

/**
 * Splits `budget` over the backlogs as evenly as they allow (a conversation with little to send leaves its
 * share to the others), so one busy conversation cannot starve the rest across repeated calls.
 */
function allot(backlogs: Array<{ id: string; missed: number }>, budget: number): Map<string, number> {
  const take = new Map(backlogs.map((b) => [b.id, 0]));
  let active = backlogs.filter((b) => b.missed > 0);
  while (budget > 0 && active.length > 0) {
    const share = Math.max(1, Math.floor(budget / active.length));
    for (const b of active) {
      const n = Math.min(share, b.missed - take.get(b.id)!, budget);
      take.set(b.id, take.get(b.id)! + n);
      budget -= n;
      if (budget === 0) break;
    }
    active = active.filter((b) => take.get(b.id)! < b.missed);
  }
  return take;
}

/**
 * The visible messages after each given position (conversation id, lower-case → last seq the client has),
 * at most 500 in total, each conversation's share a gapless prefix of what it missed. Ids the caller is
 * not a current member of are only listed in `gone`, whatever the reason; conversations the caller is in
 * but sent no position for are not looked at.
 */
export async function catchUp(db: Db, me: string, positions: ReadonlyMap<string, number>): Promise<CatchUp> {
  if (positions.size === 0) return { messages: [], gone: [], more: false };
  const ids = [...positions.keys()];

  return onSnapshot(db, async (t) => {
    // First only which ids the caller is currently in (one index probe per id). Nothing more is looked
    // at for the others, so an id you are not in costs the same whether it exists, is busy, or not.
    const member = await t.query<{ id: string }>(
      `select p.id from unnest($2::uuid[]) as p (id)
         join memberships me on me.conversation_id = p.id and me.principal_id = $1 and me.left_seq is null`,
      [me, ids],
    );
    const memberOf = new Set(member.rows.map((r) => r.id));
    const gone = ids.filter((id) => !memberOf.has(id));
    const memberIds = ids.filter((id) => memberOf.has(id));
    if (memberIds.length === 0) return { messages: [], gone, more: false };

    // Per conversation the caller is in: how many visible messages follow the position (counted up to
    // one past the cap: enough to know whether more remain).
    const backlog = await t.query<{ id: string; missed: string }>(
      `select p.id,
              (select count(*) from (
                 select 1 from messages m ${VISIBLE_JOIN}
                  where m.conversation_id = p.id and m.seq > p.after
                  limit $4
              ) x) as missed
         from unnest($2::uuid[], $3::bigint[]) with ordinality as p (id, after, ord)
        order by p.ord`,
      [me, memberIds, memberIds.map((id) => positions.get(id)!), CATCHUP_MAX_MESSAGES + 1],
    );
    const mine = backlog.rows.map((r) => ({ id: r.id, missed: Number(r.missed) }));
    const take = allot(mine, CATCHUP_MAX_MESSAGES);
    const more = mine.some((b) => b.missed > take.get(b.id)!);
    const wanted = mine.filter((b) => take.get(b.id)! > 0);
    if (wanted.length === 0) return { messages: [], gone, more };

    const { rows } = await t.query<MessageRow>(
      `select ${MESSAGE_COLUMNS}
         from unnest($2::uuid[], $3::bigint[], $4::int[]) with ordinality as p (id, after, take, ord)
         cross join lateral (
           select m.* from messages m ${VISIBLE_JOIN}
            where m.conversation_id = p.id and m.seq > p.after
            order by m.seq limit p.take
         ) m
        order by p.ord, m.seq`,
      [me, wanted.map((b) => b.id), wanted.map((b) => positions.get(b.id)!), wanted.map((b) => take.get(b.id)!)],
    );
    return { messages: await toWireFor(t, me, rows.map(toStored)), gone, more };
  });
}
