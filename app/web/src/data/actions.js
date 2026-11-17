// The async actions pages call. Sends are optimistic and keyed by clientTxn (reused on retry); the social
// and group wrappers call their route and then ask the sync engine for fresh state (pushes do the same).
// Principal ids may be given as the view model's "me" alias; they are mapped to the real id here.
//
// The Agent, proposal, reply, provider, usage and model actions (batch 2A) never throw: each resolves
// `{ok: true, value}` or `{ok: false, error: {code, reason, status, resetsAt?, agents?}, text}`, `text` being the Chinese
// sentence for the refusal (errorTexts.js). A provider's API key goes into its request body and nowhere else.
import * as routes from "../api/routes.js";
import { hasVisibleText, messageText } from "../auth/validation.js";
import { ME } from "./identities.js";
import { agentErrorText, commonErrorText, providerErrorText, replyErrorText } from "./errorTexts.js";
import {
  applyAgent,
  applyAgents,
  applyGone,
  applyModels,
  applyMyName,
  applyNewerInWindow,
  applyOlder,
  applyOlderInWindow,
  applyPosted,
  applyPrincipals,
  applyProvider,
  applyProviders,
  applyRun,
  applyUsage,
  bumpAvatar,
  closeWindow,
  discardPending,
  markFailed,
  markReadDone,
  markReading,
  markSending,
  markSent,
  markUploading,
  openWindow,
  publicProvider,
  removeProvider,
  setCanSend,
  setDraft,
  setProposalStatus,
  setUploaded,
  setUploadProgress,
  stayOf,
} from "./model.js";

/** The service refuses a file over this (413 `too_large`); the client does not even try. */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
/** Hits per page of either search (the service's default). */
export const SEARCH_PAGE = 20;
/** A hit is shown in a window of this many messages (at most), the hit being near its middle. */
export const JUMP_WINDOW = 50;
/** The window ends this far after the hit: `before = seq + JUMP_AFTER`. */
export const JUMP_AFTER = 25;

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

  /** What I send goes to the end of the conversation: a detached window is left first. */
  const toNewest = (conversationId) => setModel(closeWindow(getModel(), conversationId));

  function send(conversationId, { text = "", replyToSeq = null, attachment = null }) {
    if (!getModel().conversations[conversationId]) return refused("not_found");
    toNewest(conversationId);
    const clientTxn = uuid();
    setModel(markSending(getModel(), { clientTxn, conversationId, text, replyToSeq, attachment, at: now() }));
    return deliver(clientTxn);
  }

  /**
   * Sends text as the service stores it (bidi overrides and isolates removed, trimmed; NUL dropped and lone
   * surrogates replaced, which the service refuses); text with nothing visible is refused without a request.
   * Resolves {ok, clientTxn, duplicate?, error?}.
   */
  function sendText(conversationId, text, { replyToSeq = null } = {}) {
    const body = typeof text === "string" ? messageText(wellFormed(text.replaceAll("\u0000", ""))) : "";
    if (!hasVisibleText(body)) return refused("invalid_request");
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
    const caption = typeof text === "string" ? messageText(wellFormed(text.replaceAll("\u0000", ""))) : "";
    // Forget files of entries that are gone (another account signed in, the conversation was left).
    for (const key of files.keys()) if (!getModel().pending[key]) files.delete(key);
    files.set(clientTxn, file);
    toNewest(conversationId);
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
    // A detached window is not the newest messages: nothing there says the newest were seen.
    if (getModel().windows[conversationId]) return { ok: true, readSeq: conv.readSeq };
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

  /** `conversation id#window number` → {promise} of the older-history request in flight (window 0: the held messages). */
  const olderInFlight = new Map();
  /** Loads the page before the oldest message shown (the window's, when one is open); one request at a time per list. */
  function loadOlder(conversationId, { limit = 50 } = {}) {
    const win = getModel().windows[conversationId] ?? null;
    const key = `${conversationId}#${win?.n ?? 0}`;
    const inFlight = olderInFlight.get(key);
    if (inFlight) return inFlight.promise;
    const conv = getModel().conversations[conversationId];
    if (!conv || !(win ? win.hasOlder : conv.hasOlder)) return Promise.resolve({ ok: true, loaded: 0, hasOlder: false });
    const held = win ? win.messages : getModel().messages[conversationId] ?? [];
    const before = held.length > 0 ? held[0].seq : conv.position + 1;
    const token = tokenFor(conversationId);
    const entry = { promise: null };
    olderInFlight.set(key, entry);
    entry.promise = (async () => {
      try {
        const page = await api.listMessages(conversationId, { before, limit });
        const why = staleness(token);
        if (why) return { ok: false, error: dropped(why) };
        if ((getModel().windows[conversationId]?.n ?? 0) !== (win?.n ?? 0)) return { ok: false, error: dropped("stale") };
        setModel(win ? applyOlderInWindow(getModel(), conversationId, page, win.n) : applyOlder(getModel(), conversationId, page));
        return { ok: true, loaded: page.messages.length, hasOlder: page.nextBefore !== null };
      } catch (err) {
        const error = errorOf(err);
        if (token.epoch === epoch() && error.status === 401) signedOut();
        if (!staleness(token) && error.status === 404) request({ conversation: conversationId });
        return { ok: false, error };
      } finally {
        if (olderInFlight.get(key) === entry) olderInFlight.delete(key);
      }
    })();
    return entry.promise;
  }

  /** `conversation id#window number` → {promise} of the newer-messages request in flight. */
  const newerInFlight = new Map();
  /**
   * Loads the messages after the newest one of the detached window. Once the window reaches the held messages it is
   * absorbed (`attached: true`) and the conversation shows its newest messages again. No window: nothing to load.
   */
  function loadNewer(conversationId, { limit = 50 } = {}) {
    const win = getModel().windows[conversationId] ?? null;
    if (!win) return Promise.resolve({ ok: true, loaded: 0, attached: true });
    const key = `${conversationId}#${win.n}`;
    const inFlight = newerInFlight.get(key);
    if (inFlight) return inFlight.promise;
    const newest = win.messages.length > 0 ? win.messages[win.messages.length - 1].seq : win.focusSeq;
    const token = tokenFor(conversationId);
    const entry = { promise: null };
    newerInFlight.set(key, entry);
    entry.promise = (async () => {
      try {
        // The service pages backwards only: the page below `newest + 1 + limit` holds the messages after `newest`.
        const page = await api.listMessages(conversationId, { before: newest + 1 + limit, limit });
        const why = staleness(token);
        if (why) return { ok: false, error: dropped(why) };
        if (getModel().windows[conversationId]?.n !== win.n) return { ok: false, error: dropped("stale") };
        const had = getModel().windows[conversationId].messages.length;
        setModel(applyNewerInWindow(getModel(), conversationId, page, win.n));
        const now = getModel().windows[conversationId];
        return { ok: true, loaded: now ? now.messages.length - had : page.messages.length, attached: !now };
      } catch (err) {
        const error = errorOf(err);
        if (token.epoch === epoch() && error.status === 401) signedOut();
        if (!staleness(token) && error.status === 404) request({ conversation: conversationId });
        return { ok: false, error };
      } finally {
        if (newerInFlight.get(key) === entry) newerInFlight.delete(key);
      }
    })();
    return entry.promise;
  }

  /** Back to the newest messages: the detached window (if any) is dropped. */
  function closeWindowOf(conversationId) {
    setModel(closeWindow(getModel(), conversationId));
  }

  /** conversation id → number of the latest jump asked for: an answer of an earlier one is dropped. */
  const jumps = new Map();
  let windowCounter = 0;
  /**
   * Makes message `seq` of a conversation shown: it is already held (the detached window, if any, is dropped), or
   * it is already in the open window, or the window around it is loaded (`before = seq + JUMP_AFTER`, `JUMP_WINDOW`
   * messages) and replaces what is shown, detached from the newest messages. Resolves {ok: true} or {ok: false,
   * error}: `not_found` when the message is no longer visible to me (the service says so, or the page lacks it).
   */
  async function jumpToMessage(conversationId, seq) {
    const model = getModel();
    if (!model.conversations[conversationId]) return { ok: false, error: dropped("not_found") };
    if (!Number.isSafeInteger(seq) || seq < 1) return { ok: false, error: dropped("invalid_request") };
    // Whatever way this jump goes, it is the latest: a far jump still loading must not replace it afterwards.
    const n = ++windowCounter;
    jumps.set(conversationId, n);
    if ((model.messages[conversationId] ?? []).some((m) => m.seq === seq)) {
      closeWindowOf(conversationId);
      return { ok: true };
    }
    if (model.windows[conversationId]?.messages.some((m) => m.seq === seq)) return { ok: true };
    const token = tokenFor(conversationId);
    try {
      const page = await api.listMessages(conversationId, { before: seq + JUMP_AFTER, limit: JUMP_WINDOW });
      const why = staleness(token);
      if (why) return { ok: false, error: dropped(why) };
      if (jumps.get(conversationId) !== n) return { ok: false, error: dropped("superseded") };
      if (!(page.messages ?? []).some((m) => m.seq === seq)) return { ok: false, error: { code: "not_found", reason: null, status: 404 } };
      setModel(openWindow(getModel(), conversationId, page, { focusSeq: seq, n }));
      return { ok: true };
    } catch (err) {
      const error = errorOf(err);
      if (token.epoch === epoch() && error.status === 401) signedOut();
      if (!staleness(token) && error.status === 404) request({ conversation: conversationId });
      return { ok: false, error };
    }
  }

  /**
   * One search request: the people it names join the model (so hits show names and avatars); the hits themselves are
   * not kept here (they may lie far from the loaded messages). Resolves {ok, hits, nextBefore} or {ok: false, error}.
   */
  async function runSearch(run, conversationId = null) {
    const token = epoch();
    try {
      const page = await run();
      if (token !== epoch()) return { ok: false, error: dropped("stopped") };
      setModel(applyPrincipals(getModel(), page.principals));
      return { ok: true, hits: page.messages ?? [], nextBefore: page.nextBefore ?? null };
    } catch (err) {
      const error = errorOf(err);
      if (token === epoch()) {
        if (error.status === 401) signedOut();
        else if (error.status === 404 && conversationId) request({ conversation: conversationId });
      }
      return { ok: false, error };
    }
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

  // ───────── Agents, proposals, replies, providers, usage, models (batch 2A)

  /** The error an action resolves with: the code and what the service said with it. */
  const failureOf = (err) => {
    const error = errorOf(err);
    if (err?.resetsAt) error.resetsAt = err.resetsAt;
    if (err?.agents) error.agents = err.agents;
    return error;
  };
  const failure = (error, text) => ({ ok: false, error, text });

  /**
   * Runs a route: on success `after(value)` (unless stop() came in between) and `{ok: true, value}`; on failure a 401
   * signs out, `onFail(error)` may fetch what the refusal shows is stale, and `{ok: false, error, text: text(error)}`.
   */
  async function attempt(run, after, { text, onFail } = {}) {
    const token = epoch();
    try {
      const value = await run();
      if (token === epoch()) after?.(value);
      return { ok: true, value };
    } catch (err) {
      const error = failureOf(err);
      if (token === epoch()) {
        if (error.status === 401) signedOut();
        else onFail?.(error);
      }
      return failure(error, text(error));
    }
  }

  const agentText = (action) => (error) => agentErrorText(action, error, now());
  const replyText = (action) => (error) => replyErrorText(action, error);
  const providerText = (action) => (error) => providerErrorText(action, error);
  const isStale = (error) => error.status === 400 || error.status === 404 || error.status === 409;

  /** The conversation of one of my Agents. */
  const conversationOfAgent = (agentId) =>
    getModel().agents[agentId]?.conversationId ?? Object.values(getModel().conversations).find((c) => c.agentId === agentId)?.id ?? null;
  /** A refusal says my picture of the Agent is out of date (deleted elsewhere, not mine): fetch it and its cards again. */
  const staleAgent = (agentId) => (error) => {
    if (isStale(error)) request({ agent: agentId });
  };
  /** A refusal says the reply or the conversation is not what the screen shows: fetch both. */
  const staleReply = (conversationId) => (error) => {
    if (isStale(error)) request({ run: conversationId, conversation: conversationId });
  };
  /** An Agent changed by my own request: kept at once, and its conversation's flags (paused, deleted, canSend) refreshed. */
  const agentChanged = (agent) => {
    setModel(applyAgent(getModel(), agent));
    if (agent?.conversationId) request({ conversation: agent.conversationId });
  };

  const agentActions = {
    loadAgents: () => attempt(() => api.listAgents(), (res) => setModel(applyAgents(getModel(), res?.agents)), { text: commonErrorText }),
    /** body: {handle, name, intro?, field?, persona?, replyMode?, reasoning?, model?} → value: the Agent. Its conversation follows by sync. */
    createAgent: (body) =>
      attempt(
        () => api.createAgent(body),
        (agent) => {
          setModel(applyAgent(getModel(), agent));
          request({ sync: true });
        },
        { text: agentText("create") },
      ),
    patchAgent: (agentId, patch) =>
      attempt(() => api.patchAgent(agentId, patch), (agent) => setModel(applyAgent(getModel(), agent)), { text: agentText("edit"), onFail: staleAgent(agentId) }),
    pauseAgent: (agentId) => attempt(() => api.pauseAgent(agentId), agentChanged, { text: agentText("pause"), onFail: staleAgent(agentId) }),
    resumeAgent: (agentId) => attempt(() => api.resumeAgent(agentId), agentChanged, { text: agentText("resume"), onFail: staleAgent(agentId) }),
    deleteAgent: (agentId) => attempt(() => api.deleteAgent(agentId), agentChanged, { text: agentText("delete"), onFail: staleAgent(agentId) }),
    /** Uploads the Agent's new avatar; on success its URL gets the next version at once. */
    uploadAgentAvatar: (agentId, file) =>
      attempt(() => api.uploadAgentAvatar(agentId, file), () => setModel(bumpAvatar(getModel(), 0, agentId)), {
        text: agentText("avatar"),
        onFail: staleAgent(agentId),
      }),
    /** body: {name, intro?, field?, model} → value: {persona}, for the persona box (nothing is stored). */
    draftPersona: (body) => attempt(() => api.draftPersona(body), null, { text: agentText("draft") }),
    /** edits: optional {persona?, intro?, field?}. On success the Agent is kept and the card reads confirmed. */
    confirmProposal: (agentId, proposalId, edits) =>
      attempt(
        () => api.confirmProposal(agentId, proposalId, edits),
        (agent) => {
          setModel(applyAgent(getModel(), agent));
          setModel(setProposalStatus(getModel(), conversationOfAgent(agentId), proposalId, "confirmed"));
        },
        { text: agentText("confirm"), onFail: staleAgent(agentId) },
      ),
    discardProposal: (agentId, proposalId) =>
      attempt(
        () => api.discardProposal(agentId, proposalId),
        () => setModel(setProposalStatus(getModel(), conversationOfAgent(agentId), proposalId, "discarded")),
        { text: agentText("discard"), onFail: staleAgent(agentId) },
      ),

    /** Stops the reply in progress in an Agent conversation (the `run` push says when it has stopped). */
    stopRun: (conversationId) => {
      const run = getModel().runs[conversationId];
      if (!run || (run.status !== "queued" && run.status !== "running")) {
        const error = dropped("not_found");
        return Promise.resolve(failure(error, replyErrorText("stop", error)));
      }
      return attempt(() => api.stopRun(conversationId, run.id), null, { text: replyText("stop"), onFail: staleReply(conversationId) });
    },
    /** Tries the failed reply again: the new run replaces the failed one (unless a newer one was pushed meanwhile). */
    retryRun: (conversationId) => {
      const failed = getModel().runs[conversationId]?.id ?? null;
      return attempt(
        () => api.retryRun(conversationId),
        (res) => {
          if ((getModel().runs[conversationId]?.id ?? null) === failed && res?.run) setModel(applyRun(getModel(), conversationId, res.run));
        },
        { text: replyText("retry"), onFail: staleReply(conversationId) },
      );
    },
    /** Closes the failure notice: the failed run is shown no more (unless a newer one came meanwhile). */
    dismissRun: (conversationId) => {
      const failed = getModel().runs[conversationId]?.id ?? null;
      return attempt(
        () => api.dismissRun(conversationId),
        () => {
          if (failed !== null && getModel().runs[conversationId]?.id === failed) setModel(applyRun(getModel(), conversationId, null));
        },
        { text: replyText("dismiss"), onFail: staleReply(conversationId) },
      );
    },
    /** Starts a new topic: the notice shows at once (it is pushed too). */
    resetTopic: (conversationId) =>
      attempt(
        () => api.resetTopic(conversationId),
        (res) => {
          if (res?.message?.conversationId === conversationId) setModel(applyPosted(getModel(), res.message));
        },
        {
          text: replyText("topic"),
          onFail: (error) => {
            if (error.code === "cannot_send") setModel(setCanSend(getModel(), conversationId, { ok: false, reason: error.reason ?? "agent_deleted" }));
            if (error.code === "cannot_send" || error.status === 404) request({ conversation: conversationId });
          },
        },
      ),

    loadProviders: () => attempt(() => api.listProviders(), (res) => setModel(applyProviders(getModel(), res?.providers)), { text: commonErrorText }),
    /**
     * body: {name, protocol, baseUrl, apiKey, models?}. The key is sent once and kept nowhere: neither the model nor the
     * value resolved holds it (value: the provider's public fields, `keyLast4` only).
     */
    createProvider: (body) =>
      attempt(async () => publicProvider(await api.createProvider(body)), (p) => setModel(applyProvider(getModel(), p)), { text: providerText("create") }),
    /** patch: any of {name, baseUrl, apiKey, models}; the same as createProvider for a new key. */
    patchProvider: (providerId, patch) =>
      attempt(async () => publicProvider(await api.patchProvider(providerId, patch)), (p) => setModel(applyProvider(getModel(), p)), {
        text: providerText("edit"),
        onFail: (error) => {
          if (error.status === 404) setModel(removeProvider(getModel(), providerId));
        },
      }),
    /** Refused with `provider_in_use` while Agents use it: the text names them. */
    deleteProvider: (providerId) =>
      attempt(() => api.deleteProvider(providerId), () => setModel(removeProvider(getModel(), providerId)), {
        text: providerText("delete"),
        onFail: (error) => {
          if (error.status === 404) setModel(removeProvider(getModel(), providerId));
        },
      }),
    /** One call to the provider: {ok: true} or the reason it failed (the service answers 200 either way). */
    testProvider: async (providerId) => {
      const result = await attempt(() => api.testProvider(providerId), null, { text: providerText("test") });
      if (!result.ok || result.value?.ok !== false) return result;
      const error = { code: typeof result.value.error === "string" ? result.value.error : "unknown", reason: null, status: 200 };
      return failure(error, providerErrorText("test", error));
    },
    /** The provider's model list merged in from the provider → value: {listed, provider}. */
    refreshProviderModels: (providerId) =>
      attempt(
        async () => {
          const res = await api.refreshProviderModels(providerId);
          return { listed: Array.isArray(res?.listed) ? res.listed : [], provider: publicProvider(res?.provider ?? {}) };
        },
        (res) => setModel(applyProvider(getModel(), res.provider)),
        { text: providerText("refresh") },
      ),

    loadUsage: () => attempt(() => api.getUsage(), (usage) => setModel(applyUsage(getModel(), usage)), { text: commonErrorText }),
    /** The site's models again (Settings and the Agent form open). */
    loadModels: () => attempt(() => api.getModels(), (res) => setModel(applyModels(getModel(), res)), { text: commonErrorText }),
  };

  const actions = {
    ...agentActions,
    sendText,
    sendFile,
    cancelUpload,
    retrySend,
    retryFile: retrySend,
    markRead,
    loadOlder,
    loadNewer,
    jumpToMessage,
    closeWindow: closeWindowOf,
    /** `before`: the previous page's `nextBefore` (a seq here). */
    searchConversation: (conversationId, { q, before } = {}) =>
      runSearch(() => api.searchConversation(conversationId, { q, before, limit: SEARCH_PAGE }), conversationId),
    /** `before`: the previous page's `nextBefore` (an opaque cursor). */
    searchAll: ({ q, before } = {}) => runSearch(() => api.searchAll({ q, before, limit: SEARCH_PAGE })),
    setDraft: saveDraft,
    // my profile
    /** Resolves the name as stored; throws the route's error (a 401 signs out). */
    updateDisplayName: (displayName) =>
      call(() => api.updateMe(displayName), (res) => setModel(applyMyName(getModel(), res?.displayName ?? displayName))),
    /** Uploads my new avatar; on success every URL of it gets a new version. */
    uploadAvatar: (file) => call(() => api.uploadAvatar(file), () => setModel(bumpAvatar(getModel(), now()))),
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
      newerInFlight.clear();
      jumps.clear();
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
