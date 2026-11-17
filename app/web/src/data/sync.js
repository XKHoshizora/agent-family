// First load, pushes, gap repair and the reconnect procedure (app/service/README.md, "Client contract").
//
// Every connection: get a ticket and open the socket, buffering its pushes; then (if something is held
// already) catch up every held position while `more`, then GET /api/sync and /api/social; then apply the
// buffered pushes. While live, a gap, an unknown conversation, a `conversation` or `social` push starts
// the same kind of repair, and pushes are buffered again until it is done.
//
// Agents (README "Agents and runs", "Replies"): every connection drops what was streamed before it (deltas are not
// sent again), loads my Agents and, after its /api/sync, the run of every Agent conversation (`GET .../run`). A
// reconnect also fetches the proposal cards still open again (`agent` pushes are not replayed either); the first
// connection after start loads the site's models. An `agent` push fetches that Agent and its open cards; `principal`,
// `run` and `delta` pushes are applied as they come.
import * as routes from "../api/routes.js";
import { openSocket } from "../api/socket.js";
import {
  applyAgent,
  applyAgents,
  applyCatchup,
  applyConversation,
  applyDelta,
  applyGone,
  applyMessage,
  applyMessageUpdate,
  applyModels,
  applyPrincipals,
  applyRun,
  applySocial,
  applySync,
  clearStreams,
  dropAgent,
  openProposals,
  positionsOf,
  setAvatarVersion,
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
/** Close code: a newer socket of mine (another tab) took this one's place; at most 5 are allowed. */
export const CLOSE_REPLACED = 4002;
/** After CLOSE_REPLACED wait this long (plus up to REPLACED_JITTER_MS) so tabs do not keep displacing each other. */
export const REPLACED_DELAY_MS = 60_000;
export const REPLACED_JITTER_MS = 30_000;

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
    listAgents: routes.listAgents,
    getAgent: routes.getAgent,
    getMessage: routes.getMessage,
    getRun: routes.getRun,
    getModels: routes.getModels,
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
 * conversation, agents, agent, run})` (ask for fresh state after an action).
 *
 * @param transport {connect({onEvent, onClose}) → Promise<{close()}>, getSync(), catchUp(positions),
 *   getConversation(id), getSocial(), listAgents(), getAgent(id), getMessage(conversationId, seq),
 *   getRun(conversationId), getModels()}
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
    return {
      catchupAll: false,
      catchup: new Set(),
      sync: false,
      convs: new Set(),
      social: false,
      // My Agents: the whole list, single Agents (by id), and the open proposal cards of an Agent (by Agent id).
      agents: false,
      agentIds: new Set(),
      cards: new Set(),
      // Once this connection's /api/sync is in: the run of every Agent conversation (`runAll`), and on a reconnect
      // the open cards of every Agent (`cardsAll`). `runs`: the conversations whose run to fetch.
      runAll: false,
      cardsAll: false,
      runs: new Set(),
      models: false,
    };
  }
  const hasNeeds = () =>
    need.catchupAll ||
    need.catchup.size > 0 ||
    need.sync ||
    need.convs.size > 0 ||
    need.social ||
    need.agents ||
    need.agentIds.size > 0 ||
    need.cards.size > 0 ||
    need.runs.size > 0 ||
    need.models;
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
    // Nor are `agent`, `run` and `delta`: the Agents, every run and (on a reconnect) the open cards are fetched again,
    // and nothing streamed before this connection is shown any more.
    need.agents = true;
    need.runAll = true;
    need.cardsAll = !fresh;
    need.models = fresh;
    setModel(clearStreams(getModel()));
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
        else if (need.agents) await agents(my);
        else if (need.agentIds.size > 0) await refreshAgent(my);
        else if (need.cards.size > 0) await refreshCards(my);
        else if (need.runs.size > 0) await refreshRun(my);
        else if (need.models) await models(my);
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
    const before = getModel();
    setModel(applySync(before, res));
    // Agent conversations: the run of each new one (of every one, the first time on this connection), the Agent of
    // one not known yet (made in another tab), and on a reconnect the cards still open.
    const after = getModel();
    for (const conv of Object.values(after.conversations)) {
      if (conv.type !== "agent") continue;
      if (need.runAll || !before.conversations[conv.id]) need.runs.add(conv.id);
      if (conv.agentId && need.cardsAll) need.cards.add(conv.agentId);
      if (conv.agentId && !after.agents[conv.agentId]) need.agents = true;
    }
    need.runAll = false;
    need.cardsAll = false;
  }

  /**
   * Refetches one held conversation (`GET /api/conversations/:id`: its /api/sync entry). 404: not a member
   * now — drop it (a `gone` follows). Any other error falls back to a full sync, and so does a member
   * nobody has named yet (the full sync lists principals).
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
      else need.sync = true;
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

  /** `GET /api/agents`: the whole list (it also answers every single Agent asked for meanwhile). */
  async function agents(my) {
    need.agents = false;
    need.agentIds.clear();
    const res = await transport.listAgents();
    if (my !== conn) return;
    setModel(applyAgents(getModel(), res?.agents));
  }

  /** One Agent after an `agent` push. 404: not mine any more (dropped); another failure: the whole list instead. */
  async function refreshAgent(my) {
    const [id] = need.agentIds;
    need.agentIds.delete(id);
    let agent;
    try {
      agent = await transport.getAgent(id);
    } catch (err) {
      if (my !== conn) return;
      if (isSignedOut(err)) throw err;
      if (err?.status === 404) setModel(dropAgent(getModel(), id));
      else need.agents = true;
      return;
    }
    if (my !== conn) return;
    setModel(applyAgent(getModel(), agent));
  }

  /**
   * The proposal cards of an Agent that are still open (`GET /api/conversations/:id/messages/:seq` each): one may have
   * been confirmed, discarded, superseded or gone stale. Cards in another state cannot change any more. A card that
   * cannot be fetched now keeps what it shows (confirming or discarding it fetches it again).
   */
  async function refreshCards(my) {
    const [agentId] = need.cards;
    need.cards.delete(agentId);
    const { conversationId, seqs } = openProposals(getModel(), agentId);
    for (const seq of seqs) {
      let res;
      try {
        res = await transport.getMessage(conversationId, seq);
      } catch (err) {
        if (my !== conn) return;
        if (isSignedOut(err)) throw err;
        continue;
      }
      if (my !== conn) return;
      if (res?.message?.conversationId === conversationId) setModel(applyMessageUpdate(applyPrincipals(getModel(), res.principals), res.message));
    }
  }

  /**
   * The latest run of an Agent conversation (`GET /api/conversations/:id/run`). 404: not a member now (the
   * conversation is checked). Another failure leaves what is held: the next `run` push brings the truth.
   */
  async function refreshRun(my) {
    const [id] = need.runs;
    need.runs.delete(id);
    if (!getModel().conversations[id]) return;
    let res;
    try {
      res = await transport.getRun(id);
    } catch (err) {
      if (my !== conn) return;
      if (isSignedOut(err)) throw err;
      if (err?.status === 404) need.convs.add(id);
      return;
    }
    if (my !== conn) return;
    if (res && "run" in res) setModel(applyRun(getModel(), id, res.run));
  }

  /** The site's models (`GET /api/models`). On failure the list stays as it is; Settings and the Agent form ask again. */
  async function models(my) {
    need.models = false;
    let res;
    try {
      res = await transport.getModels();
    } catch (err) {
      if (my === conn && isSignedOut(err)) throw err;
      return;
    }
    if (my !== conn) return;
    setModel(applyModels(getModel(), res));
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
        need.runs.delete(event.id);
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
      case "agent":
        // One of my Agents changed, or one of its proposals was made, confirmed or discarded.
        if (typeof event.id !== "string") return;
        need.agentIds.add(event.id);
        need.cards.add(event.id);
        return;
      case "principal":
        setModel(setAvatarVersion(model, event.id, event.avatarVersion));
        return;
      case "run":
        if (typeof event.conversationId === "string" && event.run) setModel(applyRun(model, event.conversationId, event.run));
        return;
      case "delta":
        setModel(applyDelta(model, event));
        return;
      default:
        return;
    }
  }

  function onSocketClose(code) {
    socket = null;
    if (code === CLOSE_SESSION_ENDED) signedOut();
    else if (code === CLOSE_REPLACED) fail(REPLACED_DELAY_MS + Math.round(random() * REPLACED_JITTER_MS));
    else fail();
  }

  /** Gives up this connection and schedules the next one (after `delay` ms, else the backoff). */
  function fail(delay = null) {
    conn += 1;
    safeClose(socket);
    socket = null;
    retry(delay);
  }

  function retry(delay = null) {
    if (!alive) return;
    if (liveSince !== null && now() - liveSince >= STABLE_MS) attempt = 0;
    liveSince = null;
    setStatus("reconnecting");
    let wait = delay;
    if (wait === null) {
      wait = backoffDelay(attempt, random);
      attempt += 1;
    }
    retryTimer = timers.setTimeout(connect, wait);
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
    /**
     * Asks for fresh state after an action; done right away when live, else on the next connection. `agents`: my
     * Agents again; `agent`: one Agent and its open proposal cards (as an `agent` push does); `run`: a conversation's run.
     */
    request({ sync = false, social = false, conversation = null, agents = false, agent = null, run = null } = {}) {
      if (!alive) return;
      if (sync) need.sync = true;
      if (social) need.social = true;
      if (conversation) {
        if (getModel().conversations[conversation]) need.convs.add(conversation);
        else need.sync = true;
      }
      if (agents) need.agents = true;
      if (agent) {
        need.agentIds.add(agent);
        need.cards.add(agent);
      }
      if (run) need.runs.add(run);
      if (!buffering) work();
    },
    /** Called when a request of the data layer got a 401. */
    signedOut,
  };
}
