// The client's copy of what the service said, as pure functions of (state, input) → state.
// Ids are the service's real ids (no "me" alias here; see viewmodel.js). Contract: app/service/README.md.
//
// Per conversation, `position` is the last seq applied by the seq rule (sync, catch-up, pushes): every
// visible message up to it is held. `messages[id]` is sorted by seq without duplicates; it may also hold
// my own sent messages beyond the position (an HTTP answer that overtook the pushes before it).
// `readSeq` is the read marker shown; `serverReadSeq` the one the service confirmed; `readsInFlight` the
// read requests not answered yet (only while there are some may `readSeq` run ahead of the service).
// `stays[id]` counts my departures from a conversation: an answer to a request made in an earlier stay
// must not reach the current one.

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
    /** conversation id → how many times I left it (see `stayOf`). */
    stays: {},
  };
}

/** Which of my stays in a conversation this is; changes whenever I leave it (or am found to have left). */
export const stayOf = (state, conversationId) => state.stays[conversationId] ?? 0;

const bumpStays = (stays, ids) => {
  if (ids.length === 0) return stays;
  const next = { ...stays };
  for (const id of ids) next[id] = (next[id] ?? 0) + 1;
  return next;
};

/**
 * A new stay in a conversation that is kept (re-added while away). Answers to requests of the earlier stay
 * are dropped (see `stayOf`), so nothing may wait for them: read requests stop counting and the marker
 * falls back to the confirmed one; unsent messages still sending become failed, keeping their clientTxn.
 * (Where the conversation itself is dropped — gone, sync, 404 — its counters and unsent messages go with it.)
 */
function startNewStay(state, conversationId) {
  let next = { ...state, stays: bumpStays(state.stays, [conversationId]) };
  const conv = next.conversations[conversationId];
  if (conv) next = putConversation(next, backToConfirmedRead({ ...conv, readsInFlight: 0 }, next.messages[conversationId] ?? [], next.me?.id));
  const sending = Object.values(next.pending).filter((p) => p.conversationId === conversationId && p.status === "sending");
  if (sending.length === 0) return next;
  const pending = { ...next.pending };
  for (const p of sending) pending[p.clientTxn] = { ...p, status: "failed", error: { code: "stale", reason: null } };
  return { ...next, pending };
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

    const position = advance(list, joins || complete ? Math.max(prev?.position ?? 0, entry.lastSeq) : entry.lastSeq);
    const readsInFlight = prev?.readsInFlight ?? 0;
    const conv = {
      ...metadata(entry),
      lastSeq: entry.lastSeq,
      readSeq: entry.readSeq,
      serverReadSeq: entry.readSeq,
      readsInFlight,
      unread: entry.unread,
      peerReadSeq: entry.peerReadSeq ?? null,
      position,
      hasOlder,
      syncIndex: index,
    };
    if (readsInFlight > 0 && prev.readSeq > entry.readSeq) {
      // My read request is not answered yet: keep showing its marker until it is (markReadDone).
      conv.readSeq = prev.readSeq;
      conv.unread = unreadAfterReading(conv, list, meId, entry.readSeq, prev.readSeq);
    }
    if (prev?.peerReadSeq != null && (conv.peerReadSeq === null || prev.peerReadSeq > conv.peerReadSeq)) conv.peerReadSeq = prev.peerReadSeq;
    conversations[entry.id] = conv;
    messages[entry.id] = list;
  });

  const principals = { ...state.principals };
  for (const p of sync.principals) principals[p.id] = p;

  const dropped = Object.keys(state.conversations).filter((id) => !(id in conversations));
  const pending = sameOwner ? filterValues(state.pending, (p) => p.conversationId in conversations) : {};
  const drafts = sameOwner ? filterValues(state.drafts, (_text, id) => id in conversations) : {};
  return { ...state, me: sync.me, owner: meId, synced: true, principals, conversations, messages, pending, drafts, stays: bumpStays(state.stays, dropped) };
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
      next = startNewStay(putConversation(next, { ...conv, position: wire.seq - 1, hasOlder: false }, later), conv.id);
    }
    next = applyMessage(next, wire).state;
  }
  return { state: next };
}

/** "Not a member now": the conversation, its messages, unsent messages and draft go; a new stay starts. Idempotent. */
export function applyGone(state, conversationId) {
  if (!(conversationId in state.conversations)) return state;
  return {
    ...state,
    conversations: without(state.conversations, conversationId),
    messages: without(state.messages, conversationId),
    pending: filterValues(state.pending, (p) => p.conversationId !== conversationId),
    drafts: without(state.drafts, conversationId),
    stays: bumpStays(state.stays, [conversationId]),
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
    serverReadSeq: Math.max(prev.serverReadSeq, entry.readSeq ?? 0),
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

/** Moves the shown marker forward to `seq` (never back) and recomputes unread. */
function showRead(state, conv, seq, fields = {}) {
  const forward = seq > conv.readSeq;
  const unread = forward ? unreadAfterReading(conv, state.messages[conv.id] ?? [], state.me?.id, conv.readSeq, seq) : conv.unread;
  return putConversation(state, { ...conv, ...fields, readSeq: forward ? seq : conv.readSeq, unread });
}

/** My read marker as the service confirmed it (a `read` push or the answer to my request): only forward. */
export function setRead(state, conversationId, seq) {
  const conv = state.conversations[conversationId];
  if (!conv || (seq <= conv.readSeq && seq <= conv.serverReadSeq)) return state;
  return showRead(state, conv, seq, { serverReadSeq: Math.max(conv.serverReadSeq, seq) });
}

/** A read request was sent: its marker shows at once, and stays while the request is unanswered. */
export function markReading(state, conversationId, seq) {
  const conv = state.conversations[conversationId];
  if (!conv) return state;
  return showRead(state, conv, seq, { readsInFlight: conv.readsInFlight + 1 });
}

/**
 * A read request was answered: `confirmed` is the service's marker, or null when it failed. Once no
 * request is left unanswered, the marker shown falls back to the confirmed one (unread comes back).
 */
export function markReadDone(state, conversationId, confirmed) {
  const conv = state.conversations[conversationId];
  if (!conv) return state;
  const readsInFlight = Math.max(0, conv.readsInFlight - 1);
  if (Number.isSafeInteger(confirmed)) {
    return showRead(state, conv, confirmed, { readsInFlight, serverReadSeq: Math.max(conv.serverReadSeq, confirmed) });
  }
  if (readsInFlight > 0) return putConversation(state, { ...conv, readsInFlight });
  return putConversation(state, backToConfirmedRead({ ...conv, readsInFlight }, state.messages[conversationId] ?? [], state.me?.id));
}

/** The shown read marker falls back to the one the service confirmed; what it covered counts as unread again. */
function backToConfirmedRead(conv, list, meId) {
  if (conv.readSeq <= conv.serverReadSeq) return conv;
  const unreadAgain = list.filter((m) => m.seq > conv.serverReadSeq && m.seq <= conv.readSeq && countsAsUnread(m, meId)).length;
  return { ...conv, readSeq: conv.serverReadSeq, unread: conv.unread + unreadAgain };
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
