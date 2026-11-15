// The client's copy of what the service said, as pure functions of (state, input) → state.
// Ids are the service's real ids (no "me" alias here; see viewmodel.js). Contract: app/service/README.md.
//
// Per conversation, `position` is the last seq applied by the seq rule (sync, catch-up, pushes): every
// visible message up to it is held. `messages[id]` is sorted by seq without duplicates; it may also hold
// my own sent messages beyond the position (an HTTP answer that overtook the pushes before it).

/** How many of its newest messages `GET /api/sync` returns per conversation (service: SYNC_MESSAGES_PER_CONVERSATION). */
export const SYNC_WINDOW = 30;

export function initial() {
  return {
    /** The signed-in principal from /api/sync: {id, handle, displayName, email}. */
    me: null,
    /** Whose drafts and unsent messages these are; survives `resetKeepingDrafts`. */
    owner: null,
    synced: false,
    /** id → {id, handle, displayName, kind}. */
    principals: {},
    conversations: {},
    /** conversation id → WireMessage[] (plus `clientTxn` on my messages confirmed over HTTP). */
    messages: {},
    /** clientTxn → unsent message: {clientTxn, conversationId, text, replyToSeq, attachment, at, afterSeq, status, error}. */
    pending: {},
    /** conversation id → composer text not sent yet. */
    drafts: {},
    /** The last /api/social answer. */
    social: null,
  };
}

// ───────── helpers

const without = (obj, key) => {
  if (!(key in obj)) return obj;
  const { [key]: _gone, ...rest } = obj;
  return rest;
};

function filterValues(obj, keep) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (keep(v, k)) out[k] = v;
  return out;
}

/** Merges ascending, seq-unique lists; on equal seqs the incoming copy wins but keeps a known clientTxn. */
function mergeBySeq(held, incoming) {
  if (incoming.length === 0) return held;
  if (held.length === 0) return [...incoming].sort((a, b) => a.seq - b.seq);
  const bySeq = new Map(held.map((m) => [m.seq, m]));
  for (const m of incoming) {
    const old = bySeq.get(m.seq);
    const clientTxn = m.clientTxn ?? old?.clientTxn;
    bySeq.set(m.seq, clientTxn ? { ...m, clientTxn } : m);
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/** The highest seq reachable from `seq` through consecutive held messages. */
function advance(list, seq) {
  let position = seq;
  const seqs = new Set(list.map((m) => m.seq));
  while (seqs.has(position + 1)) position += 1;
  return position;
}

/** Counts towards unread: a visible message from someone else that is not a system notice. */
const countsAsUnread = (m, meId) => m.kind !== "system" && m.senderId !== null && m.senderId !== meId;

function unreadAfterReading(conv, list, meId, oldRead, newRead) {
  if (newRead >= conv.position) return 0;
  const nowRead = list.filter((m) => m.seq > oldRead && m.seq <= newRead && countsAsUnread(m, meId)).length;
  return Math.max(0, conv.unread - nowRead);
}

function metadata(entry) {
  const isGroup = entry.type === "group";
  return {
    id: entry.id,
    type: entry.type,
    title: entry.title ?? null,
    // A direct chat has no creator role, whatever the entry says.
    creatorId: isGroup ? entry.creatorId ?? null : null,
    myRole: entry.myRole,
    closed: Boolean(entry.closed),
    peerId: isGroup ? null : entry.peerId ?? null,
    canSend: entry.canSend ?? { ok: false, reason: "closed" },
    members: entry.members ?? [],
    createdAt: entry.createdAt ?? null,
  };
}

function putConversation(state, conv, list) {
  return {
    ...state,
    conversations: { ...state.conversations, [conv.id]: conv },
    messages: list === undefined ? state.messages : { ...state.messages, [conv.id]: list },
  };
}

// ───────── sync, catch-up, pushes

/**
 * Applies `GET /api/sync`. Conversations it does not list are dropped. A window of fewer than
 * SYNC_WINDOW messages is everything visible, so it replaces what is held; a full window is merged when
 * it joins up with the held messages and otherwise replaces them (no hole is kept). My own messages
 * confirmed over HTTP after the snapshot are kept either way. Drafts and unsent messages of another
 * account are dropped.
 */
export function applySync(state, sync) {
  const meId = sync.me.id;
  const sameOwner = state.owner === null || state.owner === meId;
  const windows = new Map();
  for (const m of sync.messages) {
    const list = windows.get(m.conversationId) ?? [];
    list.push(m);
    windows.set(m.conversationId, list);
  }

  const conversations = {};
  const messages = {};
  sync.conversations.forEach((entry, index) => {
    const prev = state.conversations[entry.id];
    const held = prev ? state.messages[entry.id] ?? [] : [];
    const incoming = (windows.get(entry.id) ?? []).sort((a, b) => a.seq - b.seq);
    const inWindow = new Set(incoming.map((m) => m.seq));
    const complete = incoming.length < SYNC_WINDOW;
    const joins = Boolean(prev) && !complete && incoming[0].seq <= prev.position + 1;
    const kept = joins ? held : held.filter((m) => inWindow.has(m.seq) || m.seq > entry.lastSeq);
    const list = mergeBySeq(kept, incoming);
    let hasOlder;
    if (complete) hasOlder = false;
    else if (joins && held.length > 0 && held[0].seq < incoming[0].seq) hasOlder = prev.hasOlder;
    else hasOlder = list.length > 0 && list[0].seq > 1;

    let readSeq = entry.readSeq;
    let unread = entry.unread;
    const position = advance(list, joins || complete ? Math.max(prev?.position ?? 0, entry.lastSeq) : entry.lastSeq);
    const conv = { ...metadata(entry), lastSeq: entry.lastSeq, readSeq, unread, peerReadSeq: entry.peerReadSeq ?? null, position, hasOlder, syncIndex: index };
    if (prev && prev.readSeq > entry.readSeq) {
      // A read marker of ours that the service has not confirmed yet (request in flight).
      readSeq = prev.readSeq;
      unread = unreadAfterReading(conv, list, meId, entry.readSeq, readSeq);
    }
    conv.readSeq = readSeq;
    conv.unread = unread;
    if (prev?.peerReadSeq != null && (conv.peerReadSeq === null || prev.peerReadSeq > conv.peerReadSeq)) conv.peerReadSeq = prev.peerReadSeq;
    conversations[entry.id] = conv;
    messages[entry.id] = list;
  });

  const principals = { ...state.principals };
  for (const p of sync.principals) principals[p.id] = p;

  const pending = sameOwner ? filterValues(state.pending, (p) => p.conversationId in conversations) : {};
  const drafts = sameOwner ? filterValues(state.drafts, (_text, id) => id in conversations) : {};
  return { ...state, me: sync.me, owner: meId, synced: true, principals, conversations, messages, pending, drafts };
}

/**
 * Applies one pushed message by the seq rule: `seq <= position` is a duplicate; `position + 1` is
 * appended; beyond that is a gap to repair with catch-up from the position (nothing is appended).
 * @returns {{state, gap?: {conversationId: string, from: number}, unknown?: string}}
 */
export function applyMessage(state, wire) {
  const id = wire.conversationId;
  const conv = state.conversations[id];
  if (!conv) return { state, unknown: id };
  if (wire.seq <= conv.position) return { state };
  if (wire.seq > conv.position + 1) return { state, gap: { conversationId: id, from: conv.position } };
  const list = mergeBySeq(state.messages[id] ?? [], [wire]);
  const position = advance(list, wire.seq);
  const unread = conv.unread + (wire.seq > conv.readSeq && countsAsUnread(wire, state.me?.id) ? 1 : 0);
  return { state: putConversation(state, { ...conv, position, lastSeq: Math.max(conv.lastSeq, position), unread }, list) };
}

/**
 * Applies a `POST /api/sync/catchup` answer: drops the `gone` conversations and appends each
 * conversation's continuation, advancing the position message by message. Within one stay the
 * continuation starts at position + 1; a later start means I was removed and added again while away,
 * so what is held from before it belongs to the earlier stay and is dropped.
 */
export function applyCatchup(state, response) {
  let next = state;
  for (const id of response.gone ?? []) next = applyGone(next, id);
  for (const wire of response.messages ?? []) {
    const conv = next.conversations[wire.conversationId];
    if (!conv || wire.seq <= conv.position) continue;
    if (wire.seq > conv.position + 1) {
      const later = (next.messages[conv.id] ?? []).filter((m) => m.seq >= wire.seq);
      next = putConversation(next, { ...conv, position: wire.seq - 1, hasOlder: false }, later);
    }
    next = applyMessage(next, wire).state;
  }
  return { state: next };
}

/** "Not a member now": the conversation, its messages, unsent messages and draft go. Idempotent. */
export function applyGone(state, conversationId) {
  if (!(conversationId in state.conversations)) return state;
  return {
    ...state,
    conversations: without(state.conversations, conversationId),
    messages: without(state.messages, conversationId),
    pending: filterValues(state.pending, (p) => p.conversationId !== conversationId),
    drafts: without(state.drafts, conversationId),
  };
}

/**
 * Refreshes one held conversation's metadata (from `GET /api/conversations/:id`). Position, unread and
 * held messages stay: the pushes are the authority on those. Read markers only move forward.
 */
export function applyConversation(state, entry) {
  const prev = state.conversations[entry.id];
  if (!prev) return state;
  const readSeq = Math.max(prev.readSeq, entry.readSeq ?? 0);
  const list = state.messages[entry.id] ?? [];
  const peerReadSeq = entry.peerReadSeq == null ? prev.peerReadSeq : Math.max(prev.peerReadSeq ?? 0, entry.peerReadSeq);
  return putConversation(state, {
    ...prev,
    ...metadata(entry),
    createdAt: entry.createdAt ?? prev.createdAt,
    lastSeq: Math.max(prev.lastSeq, entry.lastSeq ?? 0),
    readSeq,
    unread: readSeq > prev.readSeq ? unreadAfterReading(prev, list, state.me?.id, prev.readSeq, readSeq) : prev.unread,
    peerReadSeq,
  });
}

/** Member ids of a held conversation that no principal entry names. */
export function unknownMembers(state, conversationId) {
  const conv = state.conversations[conversationId];
  return conv ? conv.members.map((m) => m.id).filter((id) => !(id in state.principals)) : [];
}

export function applySocial(state, social) {
  return { ...state, social };
}

/** Prepends an older page (`GET /api/conversations/:id/messages?before=`). */
export function applyOlder(state, conversationId, page) {
  const conv = state.conversations[conversationId];
  if (!conv) return state;
  const list = mergeBySeq(state.messages[conversationId] ?? [], page.messages ?? []);
  return putConversation(state, { ...conv, hasOlder: page.nextBefore !== null && page.nextBefore !== undefined }, list);
}

/** `{conversationId: position}` for the held ones among `ids`. */
export function positionsOf(state, ids) {
  const out = {};
  for (const id of ids) if (state.conversations[id]) out[id] = state.conversations[id].position;
  return out;
}

// ───────── optimistic sends, keyed by clientTxn

/** A new unsent message, or a retry of one (it keeps its clientTxn, time and place). */
export function markSending(state, { clientTxn, conversationId, text = "", replyToSeq = null, attachment = null, at }) {
  const conv = state.conversations[conversationId];
  const old = state.pending[clientTxn];
  const entry = old
    ? { ...old, status: "sending", error: null }
    : { clientTxn, conversationId, text, replyToSeq, attachment, at, afterSeq: conv ? conv.position : 0, status: "sending", error: null };
  return { ...state, pending: { ...state.pending, [clientTxn]: entry } };
}

/** The service stored it (`duplicate` or not): the unsent entry becomes the server's message. */
export function markSent(state, clientTxn, wire) {
  const next = { ...state, pending: without(state.pending, clientTxn) };
  const conv = next.conversations[wire.conversationId];
  if (!conv) return next;
  const list = mergeBySeq(next.messages[wire.conversationId] ?? [], [{ ...wire, clientTxn }]);
  const position = wire.seq === conv.position + 1 ? advance(list, wire.seq) : conv.position;
  return putConversation(next, { ...conv, position, lastSeq: Math.max(conv.lastSeq, wire.seq) }, list);
}

export function markFailed(state, clientTxn, error) {
  const p = state.pending[clientTxn];
  if (!p) return state;
  const failed = { ...p, status: "failed", error: { code: error?.code ?? "unknown", reason: error?.reason ?? null } };
  return { ...state, pending: { ...state.pending, [clientTxn]: failed } };
}

/** The service's verdict on sending here, e.g. from a `cannot_send` refusal. */
export function setCanSend(state, conversationId, canSend) {
  const conv = state.conversations[conversationId];
  return conv ? putConversation(state, { ...conv, canSend }) : state;
}

// ───────── read markers and drafts

/** My read marker: only forward; unread follows. */
export function setRead(state, conversationId, seq) {
  const conv = state.conversations[conversationId];
  if (!conv || seq <= conv.readSeq) return state;
  const unread = unreadAfterReading(conv, state.messages[conversationId] ?? [], state.me?.id, conv.readSeq, seq);
  return putConversation(state, { ...conv, readSeq: seq, unread });
}

/** The other side's read marker in a direct chat: max(current, seq). */
export function setPeerRead(state, conversationId, seq) {
  const conv = state.conversations[conversationId];
  if (!conv || (conv.peerReadSeq !== null && seq <= conv.peerReadSeq)) return state;
  return putConversation(state, { ...conv, peerReadSeq: seq });
}

export function setDraft(state, conversationId, text) {
  if ((state.drafts[conversationId] ?? "") === text) return state;
  return { ...state, drafts: text ? { ...state.drafts, [conversationId]: text } : without(state.drafts, conversationId) };
}

/**
 * Forgets everything the service said (on stop / sign-out) but keeps this account's drafts and unsent
 * messages; one still in flight becomes failed (a retry reuses its clientTxn, so it cannot double).
 */
export function resetKeepingDrafts(state) {
  const pending = {};
  for (const [k, p] of Object.entries(state.pending)) pending[k] = p.status === "sending" ? { ...p, status: "failed", error: { code: "network_error", reason: null } } : p;
  return { ...initial(), owner: state.owner, drafts: state.drafts, pending };
}
