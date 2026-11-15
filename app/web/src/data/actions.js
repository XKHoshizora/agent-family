// The async actions pages call. Sends are optimistic and keyed by clientTxn (reused on retry); the social
// and group wrappers call their route and then ask the sync engine for fresh state (pushes do the same).
// Principal ids may be given as the view model's "me" alias; they are mapped to the real id here.
import * as routes from "../api/routes.js";
import { ME } from "./identities.js";
import {
  applyGone,
  applyOlder,
  discardPending,
  markFailed,
  markReadDone,
  markReading,
  markSending,
  markSent,
  markUploading,
  setCanSend,
  setDraft,
  setUploaded,
  setUploadProgress,
  stayOf,
} from "./model.js";

/** The service refuses a file over this (413 `too_large`); the client does not even try. */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
/** Uploads in flight at once across the app (the service allows 3 per person); the rest wait in order. */
export const MAX_UPLOADS = 3;

/** Lone surrogates → U+FFFD (`String.prototype.toWellFormed`, by hand where a browser lacks it). */
function wellFormed(text) {
  if (typeof text.toWellFormed === "function") return text.toWellFormed();
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    const next = text.charCodeAt(i + 1);
    if (unit >= 0xd800 && unit <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
      out += text[i] + text[i + 1];
      i += 1;
    } else if (unit >= 0xd800 && unit <= 0xdfff) out += "\uFFFD";
    else out += text[i];
  }
  return out;
}

const errorOf = (err) => ({ code: err?.code ?? "unknown", reason: err?.reason ?? null, status: err?.status ?? 0 });
const refused = (code, clientTxn = null) => Promise.resolve({ ok: false, clientTxn, error: { code, reason: null, status: 0 } });
const dropped = (code) => ({ code, reason: null, status: 0 });

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
 * @returns {{actions: object, reset: () => void}} `reset()` forgets requests in flight (call it on stop).
 */
export function createActions({ getModel, setModel, api = routes, uuid, now, epoch, request, signedOut }) {
  const realId = (id) => (id === ME ? getModel().me?.id ?? id : id);
  const peerConversation = (principalId) =>
    Object.values(getModel().conversations).find((c) => c.type === "direct" && c.peerId === principalId)?.id ?? null;

  /** When a request about a conversation was made: its answer counts only in the same run and the same stay. */
  const tokenFor = (conversationId) => ({ epoch: epoch(), stay: stayOf(getModel(), conversationId), conversationId });
  /** "stopped" (stop() since), "stale" (I left the conversation since, maybe to come back), or null. */
  const staleness = (token) =>
    token.epoch !== epoch() ? "stopped" : token.stay !== stayOf(getModel(), token.conversationId) ? "stale" : null;

  async function deliver(clientTxn) {
    const p = getModel().pending[clientTxn];
    const token = tokenFor(p.conversationId);
    const body = { clientTxn };
    if (p.attachment) body.attachmentId = p.attachment.id;
    if (p.text) body.text = p.text;
    if (p.replyToSeq !== null && p.replyToSeq !== undefined) body.replyToSeq = p.replyToSeq;
    try {
      const res = await api.sendMessage(p.conversationId, body);
      const why = staleness(token);
      if (why) return { ok: false, clientTxn, error: dropped(why) };
      setModel(markSent(getModel(), clientTxn, res.message));
      return { ok: true, clientTxn, duplicate: Boolean(res.duplicate) };
    } catch (err) {
      return failed(clientTxn, p.conversationId, token, errorOf(err));
    }
  }

  /** A send or an upload was refused or failed: the unsent entry fails (unless it is of an earlier stay). */
  function failed(clientTxn, conversationId, token, error) {
    if (token.epoch === epoch() && error.status === 401) signedOut();
    if (staleness(token)) return { ok: false, clientTxn, error };
    setModel(markFailed(getModel(), clientTxn, error));
    if (error.code === "cannot_send") {
      setModel(setCanSend(getModel(), conversationId, { ok: false, reason: error.reason ?? "not_friends" }));
      request({ social: true, conversation: conversationId });
    } else if (error.status === 404) request({ conversation: conversationId });
    return { ok: false, clientTxn, error };
  }

  function send(conversationId, { text = "", replyToSeq = null, attachment = null }) {
    if (!getModel().conversations[conversationId]) return refused("not_found");
    const clientTxn = uuid();
    setModel(markSending(getModel(), { clientTxn, conversationId, text, replyToSeq, attachment, at: now() }));
    return deliver(clientTxn);
  }

  /**
   * Sends text (trimmed; NUL dropped and lone surrogates replaced, which the service refuses; empty is refused
   * without a request). Resolves {ok, clientTxn, duplicate?, error?}.
   */
  function sendText(conversationId, text, { replyToSeq = null } = {}) {
    const body = typeof text === "string" ? wellFormed(text.replaceAll("\u0000", "")).trim() : "";
    if (!body) return refused("invalid_request");
    return send(conversationId, { text: body, replyToSeq });
  }

  // ───────── file messages: upload (at most MAX_UPLOADS at once, the rest wait in order), then send

  /** clientTxn → the File being sent; kept until the message is sent or discarded, so a failed upload can retry. */
  const files = new Map();
  /** clientTxn → {resolve, token, controller, counted, cancelled}: the upload job of an entry that is queued or uploading. */
  const jobs = new Map();
  const waiting = [];
  let uploading = 0;

  /** The job no longer uploads: its slot (if it held one) is free for the next waiting file. */
  const releaseSlot = (job) => {
    if (!job.counted) return;
    job.counted = false;
    uploading -= 1;
    pump();
  };
  const endJob = (clientTxn, job, result) => {
    if (jobs.get(clientTxn) === job) jobs.delete(clientTxn);
    if (job.counted) {
      job.counted = false;
      uploading -= 1;
    }
    job.resolve(result);
    pump();
  };
  /** Stops the job of an entry (running or waiting), if there is one, and frees its slot. */
  const dropJob = (clientTxn, error) => {
    const job = jobs.get(clientTxn);
    if (!job) return;
    job.cancelled = true;
    job.controller?.abort();
    const at = waiting.indexOf(clientTxn);
    if (at >= 0) waiting.splice(at, 1);
    endJob(clientTxn, job, { ok: false, clientTxn, error: dropped(error) });
  };

  function pump() {
    while (uploading < MAX_UPLOADS && waiting.length > 0) {
      const clientTxn = waiting.shift();
      const job = jobs.get(clientTxn);
      if (!job) continue;
      const p = getModel().pending[clientTxn];
      const why = staleness(job.token);
      // Gone, or failed meanwhile (stop, or I left the conversation and came back): not uploaded.
      if (!p || p.status !== "sending" || why) {
        endJob(clientTxn, job, { ok: false, clientTxn, error: dropped(why ?? "stale") });
        continue;
      }
      job.counted = true;
      uploading += 1;
      runUpload(clientTxn, job, p);
    }
  }

  async function runUpload(clientTxn, job, p) {
    job.controller = new AbortController();
    setModel(setUploadProgress(getModel(), clientTxn));
    let percent = 0;
    const onProgress = (fraction) => {
      const next = Math.floor(fraction * 100);
      if (job.cancelled || next === percent || staleness(job.token)) return;
      percent = next;
      setModel(setUploadProgress(getModel(), clientTxn, next / 100));
    };
    let attachment;
    try {
      attachment = await api.uploadAttachment(p.conversationId, files.get(clientTxn), { onProgress, signal: job.controller.signal });
    } catch (err) {
      if (job.cancelled || jobs.get(clientTxn) !== job) return releaseSlot(job); // cancelled, replaced or stopped
      const error = errorOf(err);
      endJob(clientTxn, job, failed(clientTxn, p.conversationId, job.token, error));
      return;
    }
    if (job.cancelled || jobs.get(clientTxn) !== job) return releaseSlot(job);
    const why = staleness(job.token);
    if (why) {
      // The upload belongs to an earlier stay: it is not posted into this one (the entry, if kept, failed already).
      endJob(clientTxn, job, { ok: false, clientTxn, error: dropped(why) });
      return;
    }
    setModel(setUploaded(getModel(), clientTxn, attachment));
    // Uploading is over (the next waiting file may start); the message send below is not limited.
    releaseSlot(job);
    const result = await deliver(clientTxn);
    if (result.ok) files.delete(clientTxn);
    endJob(clientTxn, job, result);
  }

  function queueUpload(clientTxn, conversationId) {
    // An earlier job of this entry (a stay that ended while it ran) must not outlive it: it would hold a slot or upload twice.
    dropJob(clientTxn, "stale");
    return new Promise((resolve) => {
      jobs.set(clientTxn, { resolve, token: tokenFor(conversationId), controller: null, counted: false, cancelled: false });
      waiting.push(clientTxn);
      pump();
    });
  }

  /**
   * Sends a picked file as a message: shown as unsent at once (with progress), uploaded when one of the
   * MAX_UPLOADS slots is free, then sent with the same clientTxn. A file over MAX_FILE_BYTES is refused without a
   * request or an entry. `text` is an optional caption. Resolves {ok, clientTxn, error?} when it was sent or failed.
   */
  function sendFile(conversationId, file, { text = "", replyToSeq = null } = {}) {
    if (!getModel().conversations[conversationId]) return refused("not_found");
    if (!file || !Number.isFinite(file.size)) return refused("invalid_request");
    if (file.size > MAX_FILE_BYTES) return refused("too_large");
    const clientTxn = uuid();
    const caption = typeof text === "string" ? wellFormed(text.replaceAll("\u0000", "")).trim() : "";
    // Forget files of entries that are gone (another account signed in, the conversation was left).
    for (const key of files.keys()) if (!getModel().pending[key]) files.delete(key);
    files.set(clientTxn, file);
    setModel(markUploading(getModel(), { clientTxn, conversationId, text: caption, replyToSeq, file: { name: file.name, size: file.size }, at: now() }));
    return queueUpload(clientTxn, conversationId);
  }

  /**
   * Stops an upload that is queued or running, or removes a failed one, and removes its message. Not possible
   * once the file is uploaded (the message is being sent, or waits for a retry). Returns {ok} or {ok: false, error}.
   */
  function cancelUpload(clientTxn) {
    const p = getModel().pending[clientTxn];
    if (!p || p.attachment || !p.file) return { ok: false, error: dropped("not_found") };
    dropJob(clientTxn, "cancelled");
    files.delete(clientTxn);
    setModel(discardPending(getModel(), clientTxn));
    return { ok: true };
  }

  /**
   * Sends a failed message again with the same clientTxn. A file whose upload failed is uploaded again (queued like
   * any other); one that was uploaded is only sent again, never uploaded twice.
   */
  function retrySend(clientTxn) {
    const p = getModel().pending[clientTxn];
    if (!p || p.status !== "failed") return refused("not_found", clientTxn);
    // (An upload of an earlier stay is not reused either: it is uploaded again into this one.)
    if (p.file && (!p.attachment || p.error?.code === "stale")) {
      if (!files.has(clientTxn)) return refused("not_found", clientTxn);
      setModel(markUploading(getModel(), { clientTxn, conversationId: p.conversationId }));
      return queueUpload(clientTxn, p.conversationId);
    }
    setModel(markSending(getModel(), { clientTxn, conversationId: p.conversationId }));
    return p.file ? deliverFile(clientTxn) : deliver(clientTxn);
  }

  /** Sending an uploaded file again: as `deliver`, and the file is let go once it is sent. */
  async function deliverFile(clientTxn) {
    const result = await deliver(clientTxn);
    if (result.ok) files.delete(clientTxn);
    return result;
  }

  /**
   * Marks read up to `seq` (default: the newest held message). Only forward; shown at once. If the request
   * fails, the marker goes back to the one the service confirmed, so the next call sends it again.
   */
  async function markRead(conversationId, seq) {
    const conv = getModel().conversations[conversationId];
    if (!conv) return { ok: false, error: { code: "not_found", reason: null, status: 0 } };
    const target = seq ?? conv.position;
    if (!Number.isSafeInteger(target) || target < 1 || target <= conv.readSeq) return { ok: true, readSeq: conv.readSeq };
    const token = tokenFor(conversationId);
    setModel(markReading(getModel(), conversationId, target));
    try {
      const res = await api.markRead(conversationId, target);
      const confirmed = Number.isSafeInteger(res?.readSeq) ? res.readSeq : target;
      if (!staleness(token)) setModel(markReadDone(getModel(), conversationId, confirmed));
      return { ok: true, readSeq: confirmed };
    } catch (err) {
      const error = errorOf(err);
      if (token.epoch === epoch() && error.status === 401) signedOut();
      if (!staleness(token)) {
        setModel(markReadDone(getModel(), conversationId, null));
        if (error.status === 404) request({ conversation: conversationId });
      }
      return { ok: false, error };
    }
  }

  /** conversation id → {promise} of the older-history request in flight. */
  const olderInFlight = new Map();
  /** Loads the page before the oldest held message; one request per conversation at a time. */
  function loadOlder(conversationId, { limit = 50 } = {}) {
    const inFlight = olderInFlight.get(conversationId);
    if (inFlight) return inFlight.promise;
    const conv = getModel().conversations[conversationId];
    if (!conv || !conv.hasOlder) return Promise.resolve({ ok: true, loaded: 0, hasOlder: false });
    const held = getModel().messages[conversationId] ?? [];
    const before = held.length > 0 ? held[0].seq : conv.position + 1;
    const token = tokenFor(conversationId);
    const entry = { promise: null };
    olderInFlight.set(conversationId, entry);
    entry.promise = (async () => {
      try {
        const page = await api.listMessages(conversationId, { before, limit });
        const why = staleness(token);
        if (why) return { ok: false, error: dropped(why) };
        setModel(applyOlder(getModel(), conversationId, page));
        return { ok: true, loaded: page.messages.length, hasOlder: page.nextBefore !== null };
      } catch (err) {
        const error = errorOf(err);
        if (token.epoch === epoch() && error.status === 401) signedOut();
        if (!staleness(token) && error.status === 404) request({ conversation: conversationId });
        return { ok: false, error };
      } finally {
        if (olderInFlight.get(conversationId) === entry) olderInFlight.delete(conversationId);
      }
    })();
    return entry.promise;
  }

  /**
   * Composer text kept in the store (survives stop() for the same account). Not kept for a conversation I am
   * no longer in (a composer saving on its way out after I was removed); while stopped every draft is kept.
   */
  function saveDraft(conversationId, text) {
    const model = getModel();
    if (model.synced && !model.conversations[conversationId]) return;
    setModel(setDraft(model, conversationId, typeof text === "string" ? text : ""));
  }

  /**
   * Runs a route; on success `after(result)`, on failure `onFail(error)` (to refresh what the refusal shows is stale);
   * a 401 signs out; errors reach the caller unchanged.
   */
  async function call(run, after, onFail) {
    const token = epoch();
    try {
      const res = await run();
      if (token === epoch()) after?.(res);
      return res;
    } catch (err) {
      if (token === epoch()) {
        if (err?.status === 401) signedOut();
        else onFail?.(err);
      }
      throw err;
    }
  }
  /** A refusal that says the other side or the request is not what the screen showed: fetch the real state. */
  const staleSocial = (err) => {
    if (err?.status === 404 || err?.status === 409 || err?.status === 403) request({ social: true });
  };
  const staleConversation = (conversationId) => (err) => {
    if (err?.status === 404 || err?.status === 409 || err?.status === 403) request({ conversation: conversationId });
  };
  const socialChanged = (principalId) => () => request({ social: true, conversation: principalId ? peerConversation(principalId) : null });

  function removeMember(conversationId, principalId) {
    const target = realId(principalId);
    const leaving = target === getModel().me?.id;
    const token = tokenFor(conversationId);
    return call(
      () => api.removeMember(conversationId, target),
      () => {
        if (!leaving) request({ conversation: conversationId });
        else if (!staleness(token)) setModel(applyGone(getModel(), conversationId));
      },
      staleConversation(conversationId),
    );
  }

  const actions = {
    sendText,
    sendFile,
    cancelUpload,
    retrySend,
    retryFile: retrySend,
    markRead,
    loadOlder,
    setDraft: saveDraft,
    // social
    lookupPrincipal: (handle) => call(() => api.lookupPrincipal(handle)),
    sendFriendRequest: (handle) => call(() => api.sendFriendRequest(handle), () => request({ social: true }), staleSocial),
    acceptFriendRequest: (requestId) =>
      call(
        () => api.acceptFriendRequest(requestId),
        (res) => request({ social: true, conversation: res?.conversationId ?? null }),
        staleSocial,
      ),
    rejectFriendRequest: (requestId) => call(() => api.rejectFriendRequest(requestId), () => request({ social: true }), staleSocial),
    withdrawFriendRequest: (requestId) => call(() => api.withdrawFriendRequest(requestId), () => request({ social: true }), staleSocial),
    removeFriend: (principalId) => call(() => api.removeFriend(realId(principalId)), socialChanged(realId(principalId)), staleSocial),
    blockPrincipal: (principalId) => call(() => api.blockPrincipal(realId(principalId)), socialChanged(realId(principalId)), staleSocial),
    unblockPrincipal: (principalId) => call(() => api.unblockPrincipal(realId(principalId)), socialChanged(realId(principalId)), staleSocial),
    /** Asks for a full refresh (a conversation the screen expects is not held yet). */
    syncNow: () => request({ sync: true }),
    // groups
    createGroup: (title, memberIds) =>
      call(() => api.createGroup({ title, memberIds: memberIds.map(realId) }), () => request({ sync: true })),
    renameGroup: (conversationId, title) =>
      call(() => api.renameGroup(conversationId, title), () => request({ conversation: conversationId }), staleConversation(conversationId)),
    addMember: (conversationId, principalId) =>
      call(
        () => api.addMember(conversationId, realId(principalId)),
        () => request({ conversation: conversationId }),
        staleConversation(conversationId),
      ),
    removeMember,
    leaveGroup: (conversationId) => removeMember(conversationId, ME),
  };
  return {
    actions,
    reset() {
      olderInFlight.clear();
      // Uploads stop; their entries become failed (the model's reset) and can be retried from the files kept here.
      for (const [clientTxn, job] of jobs) {
        job.counted = false;
        job.controller?.abort();
        job.resolve({ ok: false, clientTxn, error: dropped("stopped") });
      }
      jobs.clear();
      waiting.length = 0;
      uploading = 0;
    },
  };
}
