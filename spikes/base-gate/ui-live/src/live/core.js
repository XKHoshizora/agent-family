// Gate-verification spike: feeds the approved prototype UI from the self-built core
// (candidate C) using plain fetch + WebSocket. Throwaway code.
import { makeAgent } from "../data/identities.js";

const HUMAN_CELLS = [[1, 0], [2, 0]];
const AGENT_CELLS = [[0, 1], [1, 1], [2, 1], [0, 2], [1, 2]];
const hash = (s) => [...s].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 7);
const hhmm = (iso) => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

export async function connectCore({ baseUrl, user, password }) {
  const call = async (method, path, body, token) => {
    const r = await fetch(baseUrl + path, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(json.error || String(r.status)), { code: json.error });
    return json;
  };
  const login = await call("POST", "/login", { handle: user, password }).catch(() => {
    throw new Error("账号或密码不正确");
  });
  const token = login.token;
  const me = login.id;
  const lid = (id) => (id === me ? "me" : id);

  let convs = [];
  let principals = {};
  let cursor = 0;
  const messages = new Map(); // conv id -> Map<seq, message>
  const failed = new Map(); // conv id -> local failed sends
  const listeners = new Set();

  const store = (m) => {
    if (!messages.has(m.conv_id)) messages.set(m.conv_id, new Map());
    messages.get(m.conv_id).set(Number(m.seq), m);
  };
  async function sync(full = false) {
    const s = await call("GET", `/sync${full || !cursor ? "" : `?since=${cursor}`}`, null, token);
    const alive = new Set(s.conversations.map((c) => c.id));
    [...messages.keys()].forEach((id) => alive.has(id) || messages.delete(id));
    convs = s.conversations;
    principals = { ...principals, ...Object.fromEntries(s.principals.map((p) => [p.id, p])) };
    s.messages.forEach(store);
    cursor = s.cursor;
    publish();
  }

  function build() {
    const people = { me: { id: "me", kind: "person", name: "你", handle: user, cell: [0, 0] } };
    const agents = {};
    const out = {};
    const relations = {};
    for (const p of Object.values(principals)) {
      const id = lid(p.id);
      if (p.kind === "agent") agents[id] = makeAgent({ id, name: p.name, ownerId: lid(p.owner_id), handle: `@${p.handle}`, cell: AGENT_CELLS[hash(p.id) % AGENT_CELLS.length] });
      else if (id !== "me") people[id] = { id, kind: "person", name: p.name, handle: `@${p.handle}`, cell: HUMAN_CELLS[hash(p.id) % HUMAN_CELLS.length] };
    }
    const ordered = [...convs].sort((a, b) => lastGid(b.id) - lastGid(a.id));
    for (const c of ordered) {
      const observers = new Set(c.members.filter((m) => m.role === "observer").map((m) => m.id));
      const speaking = c.members.filter((m) => m.role === "speaker").map((m) => lid(m.id));
      const type = c.type === "group" ? "mixed" : c.type; // the prototype has no humans-only group type yet
      if (type === "human" || type === "agent") relations[`me|${speaking.find((x) => x !== "me")}`] = { status: "established" };
      const list = [...(messages.get(c.id)?.values() || [])].sort((a, b) => a.seq - b.seq).map((m) =>
        m.sender_id == null
          ? { id: `s${m.gid}`, from: null, kind: "system", text: m.body.text, at: hhmm(m.created_at) }
          : { id: `m${m.gid}`, from: lid(m.sender_id), kind: m.kind === "file" ? "file" : "text", text: m.body.text, at: hhmm(m.created_at), status: "sent", interject: observers.has(m.sender_id) },
      );
      list.push(...(failed.get(c.id) || []));
      out[c.id] = {
        id: c.id, type, title: type === "human" || type === "agent" ? undefined : c.title, members: speaking, admin: null,
        at: list.length ? list[list.length - 1].at : "", unread: c.unread,
        hold: c.frozen ? { kind: "frozen" } : null, visibility: "ok", expansion: null, discussion: null, recovery: null,
        myPause: false, generating: null, version: 1, cutoffs: {}, messages: list,
      };
    }
    return { people, agents, convs: out, order: ordered.map((c) => c.id), relations };
  }
  const lastGid = (id) => Math.max(0, ...[...(messages.get(id)?.values() || [])].map((m) => Number(m.gid)));
  const publish = () => {
    const snap = build();
    listeners.forEach((fn) => fn(snap));
  };

  function open() {
    const ws = new WebSocket(`${baseUrl.replace(/^http/, "ws")}/ws?token=${token}`);
    ws.onmessage = (e) => {
      const ev = JSON.parse(e.data);
      if (ev.type === "resync") return void sync(true);
      store(ev.message);
      cursor = Math.max(cursor, Number(ev.message.gid));
      const c = convs.find((x) => x.id === ev.message.conv_id);
      if (!c) return void sync(true);
      if (ev.message.sender_id && ev.message.sender_id !== me && ev.message.kind !== "system") c.unread += 1;
      if (ev.message.kind === "system") return void sync(true); // membership changed
      publish();
    };
    ws.onclose = () => setTimeout(() => sync().then(open, open), 1500); // catch up on whatever was missed, then reconnect
  }
  await sync(true);
  open();

  return {
    me,
    subscribe(fn) {
      listeners.add(fn);
      fn(build());
      return () => listeners.delete(fn);
    },
    async send(convId, text) {
      try {
        store(await call("POST", `/conversations/${convId}/messages`, { text, client_txn: crypto.randomUUID() }, token));
        publish();
      } catch (e) {
        if (!failed.has(convId)) failed.set(convId, []);
        failed.get(convId).push({ id: `f${Date.now()}`, from: "me", kind: "text", text, at: hhmm(Date.now()), status: "failed" });
        await sync(true).catch(() => publish());
        throw Object.assign(new Error(e.code === "frozen" ? "本会话已冻结" : e.message), { errcode: "" });
      }
    },
    markRead(convId) {
      const c = convs.find((x) => x.id === convId);
      if (!c) return;
      c.unread = 0;
      call("POST", `/conversations/${convId}/read`, { seq: c.last_seq + 1e6 }, token).catch(() => {});
    },
  };
}
