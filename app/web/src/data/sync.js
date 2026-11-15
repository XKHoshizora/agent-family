// First load, pushes, gap repair and the reconnect procedure (app/service/README.md, "Client contract").
//
// Every connection: get a ticket and open the socket, buffering its pushes; then (if something is held
// already) catch up every held position while `more`, then GET /api/sync and /api/social; then apply the
// buffered pushes. While live, a gap, an unknown conversation, a `conversation` or `social` push starts
// the same kind of repair, and pushes are buffered again until it is done.
import * as routes from "../api/routes.js";
import { openSocket } from "../api/socket.js";
import {
  applyCatchup,
  applyConversation,
  applyGone,
  applyMessage,
  applySocial,
  applySync,
  positionsOf,
  setPeerRead,
  setRead,
  unknownMembers,
} from "./model.js";

export const BACKOFF_MIN_MS = 1000;
export const BACKOFF_MAX_MS = 30_000;
/** A connection that stayed up this long resets the backoff. */
export const STABLE_MS = 30_000;
/** At most this many conversation ids per catch-up request (service: CATCHUP_MAX_POSITIONS). */
export const CATCHUP_MAX_POSITIONS = 500;
/** Close code: the session ended. Sign in again; never reconnect. */
export const CLOSE_SESSION_ENDED = 4001;

const defaultTimers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id),
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: (id) => globalThis.clearInterval(id),
};

/** Delay before reconnect attempt `attempt` (0-based): between 1 s and 30 s, doubling, with jitter. */
export function backoffDelay(attempt, random = Math.random) {
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** (attempt + 1));
  return Math.round(base / 2 + (random() * base) / 2);
}

/** The real transport: the service's routes and a ticketed WebSocket on the page's origin. */
export function httpTransport({ timers, WebSocketImpl } = {}) {
  return {
    connect: ({ onEvent, onClose }) =>
      openSocket({ requestTicket: routes.requestWsTicket, urlFor: routes.socketUrl, WebSocketImpl, timers, onEvent, onClose }),
    getSync: routes.getSync,
    catchUp: routes.catchUp,
    getConversation: routes.getConversation,
    getSocial: routes.getSocial,
  };
}

const isSignedOut = (err) => err?.status === 401 || err?.code === CLOSE_SESSION_ENDED;

function safeClose(socket) {
  try {
    socket?.close();
  } catch {
    /* already closed */
  }
}

/**
 * Starts keeping the model in step with the service. Returns a handle:
 * `stop()` (closes the socket, cancels timers; late answers are ignored) and `request({sync, social,
 * conversation})` (ask for fresh state after an action).
 *
 * @param transport {connect({onEvent, onClose}) → Promise<{close()}>, getSync(), catchUp(positions),
 *   getConversation(id), getSocial()}
 */
export function start(
  transport,
  { getModel, setModel, timers = defaultTimers, now = () => Date.now(), random = Math.random, onSignedOut = () => {}, onStatus = () => {} },
) {
  let alive = true;
  /** Incremented per connection; an async step whose connection is no longer current does nothing. */
  let conn = 0;
  let socket = null;
  let retryTimer = null;
  let attempt = 0;
  let liveSince = null;
  let buffering = true;
  let buffer = [];
  let working = false;
  let need = freshNeeds();
  let status = null;

  function freshNeeds() {
    return { catchupAll: false, catchup: new Set(), sync: false, convs: new Set(), social: false };
  }
  const hasNeeds = () => need.catchupAll || need.catchup.size > 0 || need.sync || need.convs.size > 0 || need.social;
  const setStatus = (s) => {
    if (s === status) return;
    status = s;
    onStatus(s);
  };

  async function connect() {
    retryTimer = null;
    if (!alive) return;
    const my = ++conn;
    working = false;
    buffering = true;
    buffer = [];
    need = freshNeeds();
    const fresh = !getModel().synced;
    // Reconnect: catch up what is held first; sync and social are refetched every time (their pushes are not replayed).
    need.catchupAll = !fresh;
    need.sync = true;
    need.social = true;
    setStatus(fresh ? "connecting" : "reconnecting");
    let s;
    try {
      s = await transport.connect({
        onEvent: (event) => {
          if (my === conn) onEvent(event);
        },
        onClose: (code) => {
          if (my === conn) onSocketClose(code);
        },
      });
    } catch (err) {
      if (my !== conn || !alive) return;
      if (isSignedOut(err)) signedOut();
      else retry();
      return;
    }
    if (my !== conn || !alive) {
      safeClose(s);
      return;
    }
    socket = s;
    await work();
  }

  /** Runs the repairs that are needed, then applies the buffered pushes; repeats until nothing is left. */
  async function work() {
    if (working || !alive || !socket) return;
    const my = conn;
    working = true;
    buffering = true;
    try {
      for (;;) {
        if (my !== conn) return;
        if (need.catchupAll || need.catchup.size > 0) await catchUp(my);
        else if (need.sync) await sync(my);
        else if (need.convs.size > 0) await refreshConversation(my);
        else if (need.social) await social(my);
        else if (buffer.length > 0) flush();
        else break;
      }
      buffering = false;
      if (liveSince === null) liveSince = now();
      setStatus("live");
    } catch (err) {
      if (my !== conn || !alive) return;
      if (isSignedOut(err)) signedOut();
      else fail();
    } finally {
      if (my === conn) working = false;
    }
  }

  async function catchUp(my) {
    const ids = need.catchupAll ? Object.keys(getModel().conversations) : [...need.catchup];
    need.catchupAll = false;
    need.catchup.clear();
    for (let i = 0; i < ids.length; i += CATCHUP_MAX_POSITIONS) {
      let chunk = ids.slice(i, i + CATCHUP_MAX_POSITIONS);
      for (;;) {
        const positions = positionsOf(getModel(), chunk);
        if (Object.keys(positions).length === 0) break;
        const res = await transport.catchUp(positions);
        if (my !== conn) return;
        setModel(applyCatchup(getModel(), res).state);
        if (!res.more || !res.messages?.length) break; // `more` always comes with progress; never spin without it
        chunk = chunk.filter((id) => getModel().conversations[id]);
      }
    }
  }

  async function sync(my) {
    need.sync = false;
    need.convs.clear(); // a full sync refreshes every conversation
    const res = await transport.getSync();
    if (my !== conn) return;
    setModel(applySync(getModel(), res));
  }

  /**
   * Refetches one held conversation (`GET /api/conversations/:id`: its /api/sync entry). 404: not a member
   * now — drop it, and confirm with a full sync (as for any other error). A member nobody has named yet
   * also needs the full sync (it lists principals).
   */
  async function refreshConversation(my) {
    const [id] = need.convs;
    need.convs.delete(id);
    if (!getModel().conversations[id]) return; // dropped meanwhile
    let entry;
    try {
      entry = await transport.getConversation(id);
    } catch (err) {
      if (my !== conn) return;
      if (isSignedOut(err)) throw err;
      if (err?.status === 404) setModel(applyGone(getModel(), id));
      need.sync = true;
      return;
    }
    if (my !== conn) return;
    if (entry?.id !== id) {
      need.sync = true;
      return;
    }
    setModel(applyConversation(getModel(), entry));
    if (unknownMembers(getModel(), id).length > 0) need.sync = true;
  }

  async function social(my) {
    need.social = false;
    const res = await transport.getSocial();
    if (my !== conn) return;
    setModel(applySocial(getModel(), res));
  }

  function flush() {
    const events = buffer;
    buffer = [];
    for (const event of events) handle(event);
  }

  function onEvent(event) {
    if (buffering) {
      buffer.push(event);
      return;
    }
    handle(event);
    if (hasNeeds()) work();
  }

  function handle(event) {
    const model = getModel();
    switch (event.type) {
      case "message": {
        const message = event.message;
        if (!message || typeof message.conversationId !== "string" || !Number.isSafeInteger(message.seq)) return;
        const r = applyMessage(model, message);
        if (r.state !== model) setModel(r.state);
        if (r.unknown) need.sync = true; // I was just added
        else if (r.gap) need.catchup.add(r.gap.conversationId);
        else if (message.senderId && !(message.senderId in r.state.principals)) need.convs.add(message.conversationId);
        return;
      }
      case "conversation":
        if (model.conversations[event.id]) need.convs.add(event.id);
        else need.sync = true; // added (again)
        return;
      case "gone":
        setModel(applyGone(model, event.id));
        need.catchup.delete(event.id);
        need.convs.delete(event.id);
        return;
      case "social":
        need.social = true;
        return;
      case "read": {
        if (!Number.isSafeInteger(event.seq)) return;
        const mine = event.principalId === model.me?.id;
        const next = mine ? setRead(model, event.conversationId, event.seq) : setPeerRead(model, event.conversationId, event.seq);
        if (next !== model) setModel(next);
        return;
      }
      default:
        return;
    }
  }

  function onSocketClose(code) {
    socket = null;
    if (code === CLOSE_SESSION_ENDED) signedOut();
    else fail();
  }

  /** Gives up this connection and schedules the next one. */
  function fail() {
    conn += 1;
    safeClose(socket);
    socket = null;
    retry();
  }

  function retry() {
    if (!alive) return;
    if (liveSince !== null && now() - liveSince >= STABLE_MS) attempt = 0;
    liveSince = null;
    setStatus("reconnecting");
    const delay = backoffDelay(attempt, random);
    attempt += 1;
    retryTimer = timers.setTimeout(connect, delay);
  }

  function halt() {
    alive = false;
    conn += 1;
    if (retryTimer !== null) timers.clearTimeout(retryTimer);
    retryTimer = null;
    safeClose(socket);
    socket = null;
    buffer = [];
    need = freshNeeds();
    working = false;
  }

  function signedOut() {
    if (!alive) return;
    halt();
    setStatus("signedOut");
    onSignedOut();
  }

  connect();

  return {
    stop() {
      if (!alive) return;
      halt();
      setStatus("idle");
    },
    /** Asks for fresh state after an action; done right away when live, else on the next connection. */
    request({ sync = false, social = false, conversation = null } = {}) {
      if (!alive) return;
      if (sync) need.sync = true;
      if (social) need.social = true;
      if (conversation) {
        if (getModel().conversations[conversation]) need.convs.add(conversation);
        else need.sync = true;
      }
      if (!buffering) work();
    },
    /** Called when a request of the data layer got a 401. */
    signedOut,
  };
}
