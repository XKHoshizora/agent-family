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
//
// `windows[id]` is a detached window: the messages around a search hit that lies outside what is held. The held
// list (`messages[id]`) keeps following the pushes untouched, so nothing arriving meanwhile is lost or misplaced;
// the window is only what the screen shows while it exists, and it never moves the position or the read marker.
// It is dropped when the person goes back to the newest messages, and absorbed into the held list as soon as it
// reaches it (see `settleWindow`).
//
// Agents (batch 2A). `runs[conversationId]` is the latest reply of the Agent of that conversation (the service's Run,
// plus `posted: true` once the reply's message is held). `streams[runId]` is the text and reasoning streamed so far
// (`delta` pushes) of a run that is running and not posted yet: transient, never a message, never in search, unread or
// the preview, and gone when the message, a terminal `run`, a `gone` or a reconnect arrives. `avatarVersions[id]` is
// the version put in a principal's avatar URL: set by /api/sync and `principal` pushes, raised by every other answer that
// names one, and for my own avatar also a newer cache-buster the moment I change it (`bumpAvatar`).

/** How many of its newest messages `GET /api/sync` returns per conversation (service: SYNC_MESSAGES_PER_CONVERSATION). */
export const SYNC_WINDOW = 30;

export function initial() {
  return {
    /** The signed-in principal from /api/sync: {id, handle, displayName, avatarVersion, email}. */
    me: null,
    /** Whose drafts and unsent messages these are; survives `resetKeepingDrafts`. */
    owner: null,
    synced: false,
    /** id → {id, handle, displayName, kind}. */
    principals: {},
    conversations: {},
    /** conversation id → WireMessage[] (plus `clientTxn` on my messages confirmed over HTTP). */
    messages: {},
    /** clientTxn → unsent message: {clientTxn, conversationId, text, replyToSeq, attachment, file, upload, at, afterSeq, status, error}. */
    pending: {},
    /** conversation id → composer text not sent yet. */
    drafts: {},
    /** The last /api/social answer. */
    social: null,
    /** conversation id → how many times I left it (see `stayOf`). */
    stays: {},
    /** conversation id → detached window {n, messages, hasOlder, focusSeq} (see the header). */
    windows: {},
    /** principal id → the version in its avatar URL (see the header). */
    avatarVersions: {},
    /** agent id → my Agent as the service answers it (deleted ones included). */
    agents: {},
    /** provider id → my model provider: {id, name, protocol, baseUrl, keyLast4, models}. Never an API key. */
    providers: {},
    /** The last `GET /api/usage` answer (points are decimal strings), or null before it. */
    usage: null,
    /** The site's models from `GET /api/models`: [{id, label, tier, vision, pdf, reasoning, contextTokens}]. */
    siteModels: [],
    /** What a provider model gets when its entry says nothing: {contextTokens, maxOutputTokens}, or null before it. */
    providerDefaults: null,
    /** conversation id → its latest run (see the header), or null when there is none to show. */
    runs: {},
    /** run id → {text, reasoning} streamed so far (see the header). */
    streams: {},
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
  let next = { ...state, stays: bumpStays(state.stays, [conversationId]), windows: without(state.windows, conversationId) };
  const conv = next.conversations[conversationId];
  if (conv) next = putConversation(next, backToConfirmedRead({ ...conv, readsInFlight: 0 }, next.messages[conversationId] ?? [], next.me?.id));
  const sending = Object.values(next.pending).filter((p) => p.conversationId === conversationId && p.status === "sending");
  if (sending.length === 0) return next;
  const pending = { ...next.pending };
  for (const p of sending) pending[p.clientTxn] = failedEntry(p, { code: "stale" });
  return { ...next, pending };
}

// ───────── helpers

/** An unsent entry that failed: no longer sending or uploading; its attachment (if the upload finished) stays. */
const failedEntry = (p, error) => ({
  ...p,
  status: "failed",
  upload: null,
  error: { code: error?.code ?? "unknown", reason: error?.reason ?? null },
});

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
  const isAgent = entry.type === "agent";
  return {
    id: entry.id,
    type: entry.type,
    title: entry.title ?? null,
    // A direct chat has no creator role, whatever the entry says.
    creatorId: isGroup ? entry.creatorId ?? null : null,
    myRole: entry.myRole,
    closed: Boolean(entry.closed),
    peerId: isGroup || isAgent ? null : entry.peerId ?? null,
    // An Agent's conversation: the Agent, and whether it is paused or deleted.
    agentId: isAgent ? entry.agentId ?? null : null,
    agent: isAgent ? { paused: Boolean(entry.agent?.paused), deleted: Boolean(entry.agent?.deleted) } : null,
    canSend: entry.canSend ?? { ok: false, reason: "closed" },
    members: entry.members ?? [],
    createdAt: entry.createdAt ?? null,
  };
}

// ───────── avatar versions

const isVersion = (v) => Number.isSafeInteger(v) && v >= 0;

/** Raises `id`'s version to `version` (never lowers it): an answer may be older than a push already applied. */
function raiseVersion(versions, id, version) {
  if (typeof id !== "string" || !isVersion(version) || (versions[id] ?? -1) >= version) return versions;
  return { ...versions, [id]: version };
}

function raiseVersionsOf(versions, principals) {
  let next = versions;
  for (const p of principals) if (p && typeof p.id === "string") next = raiseVersion(next, p.id, p.avatarVersion);
  return next;
}

/** A `principal` push: someone's avatar changed. The push is the latest word, so it sets the version. */
export function setAvatarVersion(state, principalId, version) {
  if (typeof principalId !== "string" || !isVersion(version) || state.avatarVersions[principalId] === version) return state;
  return { ...state, avatarVersions: { ...state.avatarVersions, [principalId]: version } };
}

// ───────── a reply in progress (runs and their streams)

/** Whether `m` is a message of the conversation's Agent (its reply), not a notice. */
const fromAgent = (conv, m) => conv.type === "agent" && Boolean(conv.agentId) && m.senderId === conv.agentId && m.kind !== "system";

/**
 * Messages of the Agent arrived while its run is running: that is the run's reply (one run at a time, and the service
 * posts it before the run ends). Its stream is dropped and the run is marked posted, so no later delta brings it back.
 */
function notePosted(state, conversationId, arrived) {
  const conv = state.conversations[conversationId];
  const run = state.runs[conversationId];
  if (!conv || !run || run.status !== "running" || run.posted || !arrived.some((m) => fromAgent(conv, m))) return state;
  return { ...state, runs: { ...state.runs, [conversationId]: { ...run, posted: true } }, streams: without(state.streams, run.id) };
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
  const avatarVersions = { ...state.avatarVersions };
  for (const p of sync.principals) {
    principals[p.id] = p;
    if (isVersion(p.avatarVersion)) avatarVersions[p.id] = p.avatarVersion;
  }
  if (isVersion(sync.me.avatarVersion)) avatarVersions[meId] = sync.me.avatarVersion;

  const dropped = Object.keys(state.conversations).filter((id) => !(id in conversations));
  const pending = sameOwner ? filterValues(state.pending, (p) => p.conversationId in conversations) : {};
  const drafts = sameOwner ? filterValues(state.drafts, (_text, id) => id in conversations) : {};
  const detached = filterValues(state.windows, (_w, id) => id in conversations);
  // A conversation that is gone takes its run and stream with it.
  const runs = filterValues(state.runs, (_run, id) => id in conversations);
  const runIds = new Set(Object.values(runs).map((r) => r?.id));
  const streams = filterValues(state.streams, (_s, runId) => runIds.has(runId));
  let next = {
    ...state,
    me: sync.me,
    owner: meId,
    synced: true,
    principals,
    avatarVersions,
    conversations,
    messages,
    pending,
    drafts,
    windows: detached,
    stays: bumpStays(state.stays, dropped),
    runs,
    streams,
  };
  // The Agent's reply may have come with this snapshot (its push then reads as a duplicate).
  for (const id of Object.keys(runs)) {
    const prev = state.conversations[id];
    if (prev) next = notePosted(next, id, (windows.get(id) ?? []).filter((m) => m.seq > prev.position));
  }
  return next;
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
  const next = putConversation(state, { ...conv, position, lastSeq: Math.max(conv.lastSeq, position), unread }, list);
  return { state: notePosted(next, id, [wire]) };
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

/**
 * "Not a member now": the conversation, its messages, unsent messages, draft, run and stream go; a new stay starts.
 * Idempotent.
 */
export function applyGone(state, conversationId) {
  if (!(conversationId in state.conversations)) return state;
  const run = state.runs[conversationId];
  return {
    ...state,
    conversations: without(state.conversations, conversationId),
    messages: without(state.messages, conversationId),
    pending: filterValues(state.pending, (p) => p.conversationId !== conversationId),
    drafts: without(state.drafts, conversationId),
    windows: without(state.windows, conversationId),
    stays: bumpStays(state.stays, [conversationId]),
    runs: without(state.runs, conversationId),
    streams: run ? without(state.streams, run.id) : state.streams,
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
  const named = social ? [...(social.friends ?? []), ...(social.blocked ?? []), ...(social.blockedBy ?? [])] : [];
  for (const r of [...(social?.incoming ?? []), ...(social?.outgoing ?? [])]) named.push(r?.principal);
  return { ...state, social, avatarVersions: raiseVersionsOf(state.avatarVersions, named) };
}

/**
 * Adds the people a message read names: the `principals` of history, single-message and search answers (a map
 * by id, the same public shape as in /api/sync; an array is accepted too). Absent or malformed: no change.
 */
export function applyPrincipals(state, principals) {
  const list = Array.isArray(principals) ? principals : principals && typeof principals === "object" ? Object.values(principals) : [];
  const valid = list.filter((p) => p && typeof p.id === "string" && typeof p.handle === "string" && typeof p.displayName === "string");
  if (valid.length === 0) return state;
  const next = { ...state.principals };
  for (const p of valid) next[p.id] = p;
  return { ...state, principals: next, avatarVersions: raiseVersionsOf(state.avatarVersions, valid) };
}

/** Prepends an older page (`GET /api/conversations/:id/messages?before=`) and the people it names. */
export function applyOlder(state, conversationId, page) {
  const conv = state.conversations[conversationId];
  if (!conv) return state;
  const list = mergeBySeq(state.messages[conversationId] ?? [], page.messages ?? []);
  const named = applyPrincipals(state, page.principals);
  return putConversation(named, { ...conv, hasOlder: page.nextBefore !== null && page.nextBefore !== undefined }, list);
}

// ───────── the detached window around a search hit

/** The window reaches the held messages (or, with none held, the position): nothing lies between them to load. */
function touchesHeld(state, conv, list) {
  if (list.length === 0) return false;
  const newest = list[list.length - 1].seq;
  const held = state.messages[conv.id] ?? [];
  return held.length > 0 ? newest + 1 >= held[0].seq : newest >= conv.position;
}

/** The window joins the held list: its messages are merged in and it is gone; the older edge is the window's. */
function attachWindow(state, conv, win) {
  const held = state.messages[conv.id] ?? [];
  const list = mergeBySeq(held, win.messages);
  const position = advance(list, conv.position);
  const reachesOlder = held.length === 0 || (win.messages[0] && win.messages[0].seq <= held[0].seq);
  const next = putConversation(
    state,
    { ...conv, position, lastSeq: Math.max(conv.lastSeq, position), hasOlder: reachesOlder ? win.hasOlder : conv.hasOlder },
    list,
  );
  return { ...next, windows: without(next.windows, conv.id) };
}

/** Keeps the window apart while it does not reach the held messages; absorbs it when it does. */
function settleWindow(state, conv, win) {
  if (touchesHeld(state, conv, win.messages)) return attachWindow(state, conv, win);
  return { ...state, windows: { ...state.windows, [conv.id]: win } };
}

/**
 * Shows the window around `focusSeq` (a `GET .../messages?before=` page): the people it names are added. `n` numbers
 * the window, so answers of an older one are told apart. A page that reaches the held messages joins them instead.
 */
export function openWindow(state, conversationId, page, { focusSeq, n }) {
  const conv = state.conversations[conversationId];
  if (!conv) return state;
  const named = applyPrincipals(state, page.principals);
  const messages = mergeBySeq([], page.messages ?? []);
  return settleWindow(named, conv, { n, messages, hasOlder: page.nextBefore !== null && page.nextBefore !== undefined, focusSeq });
}

/** An older page for window `n`: prepended to it. An answer for another window, or none, changes nothing. */
export function applyOlderInWindow(state, conversationId, page, n) {
  const win = state.windows[conversationId];
  if (!win || win.n !== n) return state;
  const named = applyPrincipals(state, page.principals);
  const messages = mergeBySeq(win.messages, page.messages ?? []);
  const hasOlder = page.nextBefore !== null && page.nextBefore !== undefined;
  return { ...named, windows: { ...named.windows, [conversationId]: { ...win, messages, hasOlder } } };
}

/**
 * A newer page for window `n` (the messages after its newest one). The window joins the held messages once it reaches
 * them, or when the page holds nothing new (what lies between is then not visible to me).
 */
export function applyNewerInWindow(state, conversationId, page, n) {
  const win = state.windows[conversationId];
  const conv = state.conversations[conversationId];
  if (!win || !conv || win.n !== n) return state;
  const named = applyPrincipals(state, page.principals);
  const messages = mergeBySeq(win.messages, page.messages ?? []);
  const next = { ...win, messages };
  return messages.length > win.messages.length ? settleWindow(named, conv, next) : attachWindow(named, conv, next);
}

/** Back to the newest messages: the window is dropped. */
export function closeWindow(state, conversationId) {
  return conversationId in state.windows ? { ...state, windows: without(state.windows, conversationId) } : state;
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
  return applyPosted({ ...state, pending: without(state.pending, clientTxn) }, { ...wire, clientTxn });
}

/**
 * A message of mine that an HTTP answer returned (a send, the new-topic notice): held at once, also beyond a gap (the
 * pushes before it follow); the position advances only when it is next.
 */
export function applyPosted(state, wire) {
  const conv = state.conversations[wire.conversationId];
  if (!conv) return state;
  const list = mergeBySeq(state.messages[wire.conversationId] ?? [], [wire]);
  const position = wire.seq === conv.position + 1 ? advance(list, wire.seq) : conv.position;
  return putConversation(state, { ...conv, position, lastSeq: Math.max(conv.lastSeq, wire.seq) }, list);
}

export function markFailed(state, clientTxn, error) {
  const p = state.pending[clientTxn];
  if (!p) return state;
  return { ...state, pending: { ...state.pending, [clientTxn]: failedEntry(p, error) } };
}

/**
 * A file picked for sending, not uploaded yet (or an upload being retried: the entry keeps its clientTxn, time and
 * place). `file` is {name, size}; `upload` is {phase: "queued" | "uploading", progress: 0..1} while the upload lasts.
 */
export function markUploading(state, { clientTxn, conversationId, text = "", replyToSeq = null, file, at }) {
  const conv = state.conversations[conversationId];
  const old = state.pending[clientTxn];
  const upload = { phase: "queued", progress: 0 };
  const entry = old
    ? { ...old, status: "sending", error: null, attachment: null, upload }
    : { clientTxn, conversationId, text, replyToSeq, attachment: null, file, at, afterSeq: conv ? conv.position : 0, status: "sending", error: null, upload };
  return { ...state, pending: { ...state.pending, [clientTxn]: entry } };
}

/** The upload started (progress omitted) or reached `progress` (0..1). */
export function setUploadProgress(state, clientTxn, progress) {
  const p = state.pending[clientTxn];
  if (!p?.upload) return state;
  const next = { phase: "uploading", progress: progress ?? p.upload.progress };
  if (next.phase === p.upload.phase && next.progress === p.upload.progress) return state;
  return { ...state, pending: { ...state.pending, [clientTxn]: { ...p, upload: next } } };
}

/** The upload finished: the entry now carries the attachment `{id, name, size, inline}` and is ready to be sent. */
export function setUploaded(state, clientTxn, attachment) {
  const p = state.pending[clientTxn];
  if (!p) return state;
  const { id, name, size, inline } = attachment;
  return { ...state, pending: { ...state.pending, [clientTxn]: { ...p, attachment: { id, name, size, inline: Boolean(inline) }, upload: null } } };
}

/** Removes an unsent entry (a cancelled upload). */
export function discardPending(state, clientTxn) {
  return clientTxn in state.pending ? { ...state, pending: without(state.pending, clientTxn) } : state;
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
  for (const [k, p] of Object.entries(state.pending)) pending[k] = p.status === "sending" ? failedEntry(p, { code: "network_error" }) : p;
  return { ...initial(), owner: state.owner, drafts: state.drafts, pending };
}

// ───────── my profile

/** `PATCH /api/me` answered: my name as stored, in `me` and in my principal entry (message senders read it). */
export function applyMyName(state, displayName) {
  if (!state.me) return state;
  const me = { ...state.me, displayName };
  const entry = state.principals[me.id];
  return { ...state, me, principals: entry ? { ...state.principals, [me.id]: { ...entry, displayName } } : state.principals };
}

/**
 * An avatar I just changed (mine by default, or one of my Agents'): every URL of it gets a new version at once, so the
 * browser fetches it again; `version` when it is newer than the one held, else the next one. The push that follows
 * sets the service's own number.
 */
export function bumpAvatar(state, version, principalId = state.me?.id) {
  if (typeof principalId !== "string") return state;
  const current = state.avatarVersions[principalId] ?? 0;
  return { ...state, avatarVersions: { ...state.avatarVersions, [principalId]: version > current ? version : current + 1 } };
}

// ───────── my Agents

const isAgentRecord = (a) => a && typeof a.id === "string" && typeof a.handle === "string" && typeof a.name === "string";

/** The Agent's principal entry follows the Agent (its name now, for notices and senders); its avatar version only rises. */
function nameAgent(state, agent) {
  const entry = { ...(state.principals[agent.id] ?? {}), id: agent.id, handle: agent.handle, displayName: agent.name, kind: "agent" };
  return {
    ...state,
    principals: { ...state.principals, [agent.id]: entry },
    avatarVersions: raiseVersion(state.avatarVersions, agent.id, agent.avatarVersion),
  };
}

/** `GET /api/agents`: the whole list (deleted ones included) replaces what is held. */
export function applyAgents(state, list) {
  const valid = (Array.isArray(list) ? list : []).filter(isAgentRecord);
  const agents = {};
  for (const a of valid) agents[a.id] = a;
  let next = { ...state, agents };
  for (const a of valid) next = nameAgent(next, a);
  return next;
}

/** One Agent as an answer (`GET`, create, edit, pause, resume, delete, confirm) returned it. */
export function applyAgent(state, agent) {
  if (!isAgentRecord(agent)) return state;
  return nameAgent({ ...state, agents: { ...state.agents, [agent.id]: agent } }, agent);
}

/** An Agent the service no longer knows as mine. */
export function dropAgent(state, agentId) {
  return agentId in state.agents ? { ...state, agents: without(state.agents, agentId) } : state;
}

// ───────── persona proposal cards

/** The conversation of `agentId` (held) and the seqs of its messages, held or in a window, whose proposal is still open. */
export function openProposals(state, agentId) {
  const conversationId =
    state.agents[agentId]?.conversationId ?? Object.values(state.conversations).find((c) => c.agentId === agentId)?.id ?? null;
  if (!conversationId || !state.conversations[conversationId]) return { conversationId: null, seqs: [] };
  const seqs = new Set();
  const shown = [...(state.messages[conversationId] ?? []), ...(state.windows[conversationId]?.messages ?? [])];
  for (const m of shown) if (m.proposal?.status === "open") seqs.add(m.seq);
  return { conversationId, seqs: [...seqs].sort((a, b) => a - b) };
}

/** Replaces `list`'s message with `wire`'s seq (keeping a known clientTxn); the same list when there is none. */
function replaceBySeq(list, wire) {
  const at = list.findIndex((m) => m.seq === wire.seq);
  if (at < 0) return list;
  const next = [...list];
  next[at] = list[at].clientTxn ? { ...wire, clientTxn: list[at].clientTxn } : wire;
  return next;
}

/**
 * A message fetched again (`GET /api/conversations/:id/messages/:seq`, a proposal card after an `agent` push): the copy
 * held, and the one in a detached window, are replaced. Nothing is added and no position moves.
 */
export function applyMessageUpdate(state, wire) {
  const id = wire?.conversationId;
  if (!state.conversations[id] || !Number.isSafeInteger(wire.seq)) return state;
  const held = state.messages[id] ?? [];
  const list = replaceBySeq(held, wire);
  const win = state.windows[id];
  const shown = win ? replaceBySeq(win.messages, wire) : null;
  let next = state;
  if (list !== held) next = { ...next, messages: { ...next.messages, [id]: list } };
  if (win && shown !== win.messages) next = { ...next, windows: { ...next.windows, [id]: { ...win, messages: shown } } };
  return next;
}

/** My confirmation or discard was answered: the card says so at once (the `agent` push refetches the others). */
export function setProposalStatus(state, conversationId, proposalId, status) {
  const mark = (list) => list.map((m) => (m.proposal?.id === proposalId ? { ...m, proposal: { ...m.proposal, status } } : m));
  if (!state.conversations[conversationId]) return state;
  const win = state.windows[conversationId];
  return {
    ...state,
    messages: { ...state.messages, [conversationId]: mark(state.messages[conversationId] ?? []) },
    windows: win ? { ...state.windows, [conversationId]: { ...win, messages: mark(win.messages) } } : state.windows,
  };
}

// ───────── runs and streams

const RUN_RANK = { queued: 0, running: 1 };
const runRank = (status) => RUN_RANK[status] ?? 2;

function wireRun(run) {
  const out = { id: run.id, status: run.status, retryable: Boolean(run.retryable) };
  if (typeof run.error === "string") out.error = run.error;
  if (typeof run.resetsAt === "string") out.resetsAt = run.resetsAt;
  return out;
}

/**
 * The latest run of a held conversation (a `run` push, `GET .../run`, a retry's answer), or null for none. The same
 * run's status only moves forward (an answer may overtake a push) and stays posted; a run that is not running has no
 * stream; a newer run ends the older one's stream.
 */
export function applyRun(state, conversationId, run) {
  if (!state.conversations[conversationId]) return state;
  if (run !== null && !(run && typeof run.id === "string" && typeof run.status === "string")) return state;
  const prev = state.runs[conversationId] ?? null;
  let next = run === null ? null : wireRun(run);
  if (next && prev && prev.id === next.id) {
    if (runRank(next.status) < runRank(prev.status)) return state;
    if (prev.posted) next = { ...next, posted: true };
  }
  let streams = state.streams;
  if (prev && prev.id !== next?.id) streams = without(streams, prev.id);
  if (next && next.status !== "running") streams = without(streams, next.id);
  return { ...state, runs: { ...state.runs, [conversationId]: next }, streams };
}

/**
 * A `delta` push: appended to the stream of the conversation's run only while that run is running and its message has
 * not arrived; anything else (an unknown or finished run, another conversation's) is ignored.
 */
export function applyDelta(state, { conversationId, runId, text, reasoning } = {}) {
  const run = state.runs[conversationId];
  if (!run || run.id !== runId || run.status !== "running" || run.posted) return state;
  const addText = typeof text === "string" ? text : "";
  const addReasoning = typeof reasoning === "string" ? reasoning : "";
  if (!addText && !addReasoning) return state;
  const prev = state.streams[runId] ?? { text: "", reasoning: "" };
  return { ...state, streams: { ...state.streams, [runId]: { text: prev.text + addText, reasoning: prev.reasoning + addReasoning } } };
}

/** A new connection: what was streamed before it is not sent again, so every stream goes. */
export function clearStreams(state) {
  return Object.keys(state.streams).length === 0 ? state : { ...state, streams: {} };
}

// ───────── providers, usage, the site's models

/** A provider's public fields, and nothing else: whatever an answer carries, no key is ever kept (or passed on). */
export function publicProvider(answer) {
  const p = answer ?? {};
  return {
    id: p.id,
    name: p.name,
    protocol: p.protocol,
    baseUrl: p.baseUrl,
    keyLast4: p.keyLast4,
    models: (Array.isArray(p.models) ? p.models : []).map((m) => ({
      name: m.name,
      vision: Boolean(m.vision),
      pdf: Boolean(m.pdf),
      reasoning: Boolean(m.reasoning),
      contextTokens: m.contextTokens,
    })),
  };
}

const isProvider = (p) => p && typeof p.id === "string";

/** `GET /api/providers`: the whole list replaces what is held (oldest first). */
export function applyProviders(state, list) {
  const providers = {};
  for (const p of (Array.isArray(list) ? list : []).filter(isProvider)) providers[p.id] = publicProvider(p);
  return { ...state, providers };
}

/** One provider as an answer returned it (create, edit, refresh). */
export function applyProvider(state, provider) {
  if (!isProvider(provider)) return state;
  return { ...state, providers: { ...state.providers, [provider.id]: publicProvider(provider) } };
}

export function removeProvider(state, providerId) {
  return providerId in state.providers ? { ...state, providers: without(state.providers, providerId) } : state;
}

/** `GET /api/usage` (points stay the service's decimal strings). */
export function applyUsage(state, usage) {
  return usage && typeof usage === "object" ? { ...state, usage } : state;
}

/** `GET /api/models`: the site's models and what a provider model gets by default. */
export function applyModels(state, answer) {
  if (!answer || !Array.isArray(answer.siteModels)) return state;
  const siteModels = answer.siteModels
    .filter((m) => m && typeof m.id === "string")
    .map((m) => ({
      id: m.id,
      label: m.label,
      tier: m.tier,
      vision: Boolean(m.vision),
      pdf: Boolean(m.pdf),
      reasoning: Array.isArray(m.reasoning) ? m.reasoning : [],
      contextTokens: m.contextTokens,
    }));
  const d = answer.providerDefaults;
  const providerDefaults = d && typeof d === "object" ? { contextTokens: d.contextTokens, maxOutputTokens: d.maxOutputTokens } : state.providerDefaults;
  return { ...state, siteModels, providerDefaults };
}
