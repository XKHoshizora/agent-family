// The async actions pages call. Sends are optimistic and keyed by clientTxn (reused on retry); the social
// and group wrappers call their route and then ask the sync engine for fresh state (pushes do the same).
// Principal ids may be given as the view model's "me" alias; they are mapped to the real id here.
import * as routes from "../api/routes.js";
import { ME } from "./identities.js";
import { applyGone, applyOlder, markFailed, markSending, markSent, setCanSend, setDraft, setRead } from "./model.js";

const errorOf = (err) => ({ code: err?.code ?? "unknown", reason: err?.reason ?? null, status: err?.status ?? 0 });
const refused = (code, clientTxn = null) => Promise.resolve({ ok: false, clientTxn, error: { code, reason: null, status: 0 } });

/**
 * @param {object} deps
 * @param {() => object} deps.getModel
 * @param {(model: object) => void} deps.setModel
 * @param {object} [deps.api] the routes module (or a fake with the same functions)
 * @param {() => string} deps.uuid clientTxn generator
 * @param {() => number} deps.now
 * @param {() => number} deps.epoch changes on every stop(); answers to older requests are dropped
 * @param {(needs: {sync?: boolean, social?: boolean, conversation?: string}) => void} deps.request
 * @param {() => void} deps.signedOut called on a 401
 */
export function createActions({ getModel, setModel, api = routes, uuid, now, epoch, request, signedOut }) {
  const realId = (id) => (id === ME ? getModel().me?.id ?? id : id);
  const peerConversation = (principalId) =>
    Object.values(getModel().conversations).find((c) => c.type === "direct" && c.peerId === principalId)?.id ?? null;

  async function deliver(clientTxn) {
    const p = getModel().pending[clientTxn];
    const token = epoch();
    const body = { clientTxn };
    if (p.attachment) body.attachmentId = p.attachment.id;
    if (p.text) body.text = p.text;
    if (p.replyToSeq !== null && p.replyToSeq !== undefined) body.replyToSeq = p.replyToSeq;
    try {
      const res = await api.sendMessage(p.conversationId, body);
      if (token !== epoch()) return { ok: false, clientTxn, error: { code: "stopped", reason: null, status: 0 } };
      setModel(markSent(getModel(), clientTxn, res.message));
      return { ok: true, clientTxn, duplicate: Boolean(res.duplicate) };
    } catch (err) {
      const error = errorOf(err);
      if (token !== epoch()) return { ok: false, clientTxn, error };
      setModel(markFailed(getModel(), clientTxn, error));
      if (error.status === 401) signedOut();
      else if (error.code === "cannot_send") {
        setModel(setCanSend(getModel(), p.conversationId, { ok: false, reason: error.reason ?? "not_friends" }));
        request({ social: true, conversation: p.conversationId });
      } else if (error.status === 404) request({ conversation: p.conversationId });
      return { ok: false, clientTxn, error };
    }
  }

  function send(conversationId, { text = "", replyToSeq = null, attachment = null }) {
    if (!getModel().conversations[conversationId]) return refused("not_found");
    const clientTxn = uuid();
    setModel(markSending(getModel(), { clientTxn, conversationId, text, replyToSeq, attachment, at: now() }));
    return deliver(clientTxn);
  }

  /** Sends text (trimmed; empty is refused without a request). Resolves {ok, clientTxn, duplicate?, error?}. */
  function sendText(conversationId, text, { replyToSeq = null } = {}) {
    const body = typeof text === "string" ? text.trim() : "";
    if (!body) return refused("invalid_request");
    return send(conversationId, { text: body, replyToSeq });
  }

  /** Sends an uploaded attachment ({id, name, size, inline}) with an optional caption. */
  function sendFile(conversationId, attachment, { text = "", replyToSeq = null } = {}) {
    if (!attachment?.id) return refused("invalid_request");
    const { id, name, size, inline } = attachment;
    return send(conversationId, { text: text.trim(), replyToSeq, attachment: { id, name, size, inline: Boolean(inline) } });
  }

  /** Sends a failed message again with the same clientTxn. */
  function retrySend(clientTxn) {
    const p = getModel().pending[clientTxn];
    if (!p || p.status !== "failed") return refused("not_found", clientTxn);
    setModel(markSending(getModel(), { clientTxn, conversationId: p.conversationId }));
    return deliver(clientTxn);
  }

  /** Marks read up to `seq` (default: the newest held message). Only forward; shown at once. */
  async function markRead(conversationId, seq) {
    const conv = getModel().conversations[conversationId];
    if (!conv) return { ok: false, error: { code: "not_found", reason: null, status: 0 } };
    const target = seq ?? conv.position;
    if (!Number.isSafeInteger(target) || target < 1 || target <= conv.readSeq) return { ok: true, readSeq: conv.readSeq };
    const token = epoch();
    setModel(setRead(getModel(), conversationId, target));
    try {
      const res = await api.markRead(conversationId, target);
      if (token === epoch() && Number.isSafeInteger(res?.readSeq)) setModel(setRead(getModel(), conversationId, res.readSeq));
      return { ok: true, readSeq: res?.readSeq ?? target };
    } catch (err) {
      const error = errorOf(err);
      if (token === epoch()) {
        if (error.status === 401) signedOut();
        else if (error.status === 404) request({ conversation: conversationId });
      }
      return { ok: false, error };
    }
  }

  const olderInFlight = new Map();
  /** Loads the page before the oldest held message; one request per conversation at a time. */
  function loadOlder(conversationId, { limit = 50 } = {}) {
    if (olderInFlight.has(conversationId)) return olderInFlight.get(conversationId);
    const conv = getModel().conversations[conversationId];
    if (!conv || !conv.hasOlder) return Promise.resolve({ ok: true, loaded: 0, hasOlder: false });
    const held = getModel().messages[conversationId] ?? [];
    const before = held.length > 0 ? held[0].seq : conv.position + 1;
    const token = epoch();
    const loading = (async () => {
      try {
        const page = await api.listMessages(conversationId, { before, limit });
        if (token !== epoch()) return { ok: false, error: { code: "stopped", reason: null, status: 0 } };
        setModel(applyOlder(getModel(), conversationId, page));
        return { ok: true, loaded: page.messages.length, hasOlder: page.nextBefore !== null };
      } catch (err) {
        const error = errorOf(err);
        if (token === epoch()) {
          if (error.status === 401) signedOut();
          else if (error.status === 404) request({ conversation: conversationId });
        }
        return { ok: false, error };
      } finally {
        olderInFlight.delete(conversationId);
      }
    })();
    olderInFlight.set(conversationId, loading);
    return loading;
  }

  /** Composer text kept in the store (survives stop() for the same account). */
  function saveDraft(conversationId, text) {
    setModel(setDraft(getModel(), conversationId, typeof text === "string" ? text : ""));
  }

  /** Runs a route; on success `after(result)`; a 401 signs out; errors reach the caller unchanged. */
  async function call(run, after) {
    const token = epoch();
    try {
      const res = await run();
      if (token === epoch()) after?.(res);
      return res;
    } catch (err) {
      if (token === epoch() && err?.status === 401) signedOut();
      throw err;
    }
  }
  const socialChanged = (principalId) => () => request({ social: true, conversation: principalId ? peerConversation(principalId) : null });

  function removeMember(conversationId, principalId) {
    const target = realId(principalId);
    const leaving = target === getModel().me?.id;
    return call(
      () => api.removeMember(conversationId, target),
      () => (leaving ? setModel(applyGone(getModel(), conversationId)) : request({ conversation: conversationId })),
    );
  }

  return {
    sendText,
    sendFile,
    retrySend,
    markRead,
    loadOlder,
    setDraft: saveDraft,
    // social
    lookupPrincipal: (handle) => call(() => api.lookupPrincipal(handle)),
    sendFriendRequest: (handle) => call(() => api.sendFriendRequest(handle), () => request({ social: true })),
    acceptFriendRequest: (requestId) =>
      call(() => api.acceptFriendRequest(requestId), (res) => request({ social: true, conversation: res?.conversationId ?? null })),
    rejectFriendRequest: (requestId) => call(() => api.rejectFriendRequest(requestId), () => request({ social: true })),
    withdrawFriendRequest: (requestId) => call(() => api.withdrawFriendRequest(requestId), () => request({ social: true })),
    removeFriend: (principalId) => call(() => api.removeFriend(realId(principalId)), socialChanged(realId(principalId))),
    blockPrincipal: (principalId) => call(() => api.blockPrincipal(realId(principalId)), socialChanged(realId(principalId))),
    unblockPrincipal: (principalId) => call(() => api.unblockPrincipal(realId(principalId)), socialChanged(realId(principalId))),
    // groups
    createGroup: (title, memberIds) =>
      call(() => api.createGroup({ title, memberIds: memberIds.map(realId) }), () => request({ sync: true })),
    renameGroup: (conversationId, title) => call(() => api.renameGroup(conversationId, title), () => request({ conversation: conversationId })),
    addMember: (conversationId, principalId) =>
      call(() => api.addMember(conversationId, realId(principalId)), () => request({ conversation: conversationId })),
    removeMember,
    leaveGroup: (conversationId) => removeMember(conversationId, ME),
  };
}
