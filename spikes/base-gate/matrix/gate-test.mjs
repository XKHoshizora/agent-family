// Gate-verification spike, candidate A (Synapse + rule module). Runs inside the sandbox:
//   node /work/matrix/gate-test.mjs
// Ordinary-user actions go through the public entry (nginx :8080) with that user's own token.
// "system" = the Agent Family service acting through the appservice token on :8008.
import { createHmac, randomBytes } from "node:crypto";
import { execSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync, openSync } from "node:fs";

const PUB = "http://127.0.0.1:8080";
const HS = "http://127.0.0.1:8008";
const RULES = "http://127.0.0.1:9100";
const env = Object.fromEntries(readFileSync("/work/matrix/secrets.env", "utf8").trim().split("\n").map((l) => l.split("=")));
const rid = randomBytes(3).toString("hex");
const DOMAIN = "af.test";
const SYSTEM = `@af_system:${DOMAIN}`;
const results = [];
let txn = 0;

function check(id, desc, pass, evidence) {
  results.push({ id, desc, result: pass ? "PASS" : "FAIL", evidence });
  console.log(`${pass ? "PASS" : "FAIL"}  ${id}  ${desc}`);
}
function note(id, desc, evidence) {
  results.push({ id, desc, result: "OBSERVED", evidence });
  console.log(`NOTE  ${id}  ${desc}`);
}

async function req(base, method, path, { token, body, raw, type } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (raw) {
    payload = raw;
    headers["content-type"] = type || "application/octet-stream";
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    headers["content-type"] = "application/json";
  }
  try {
    const r = await fetch(base + path, { method, headers, body: payload, signal: AbortSignal.timeout(20000) });
    const buf = Buffer.from(await r.arrayBuffer());
    let json = null;
    try {
      json = JSON.parse(buf.toString("utf8"));
    } catch {}
    return { status: r.status, json, buf, text: buf.toString("utf8") };
  } catch (e) {
    return { status: 0, json: null, buf: Buffer.alloc(0), text: String(e) };
  }
}
const brief = (r) => ({ status: r.status, errcode: r.json?.errcode, error: r.json?.error });
const enc = encodeURIComponent;

async function registerHuman(name) {
  const user = `${name}_${rid}`;
  const pass = randomBytes(12).toString("hex");
  const { json } = await req(HS, "GET", "/_synapse/admin/v1/register");
  const mac = createHmac("sha1", env.REG_SECRET).update(`${json.nonce}\0${user}\0${pass}\0notadmin`).digest("hex");
  const r = await req(HS, "POST", "/_synapse/admin/v1/register", { body: { nonce: json.nonce, username: user, password: pass, admin: false, mac } });
  if (r.status !== 200) throw new Error("register failed " + r.text);
  const login = await req(PUB, "POST", "/_matrix/client/v3/login", { body: { type: "m.login.password", identifier: { type: "m.id.user", user }, password: pass } });
  return { id: `@${user}:${DOMAIN}`, user, pass, token: login.json.access_token };
}
async function registerAgent(name) {
  const user = `agent_${name}_${rid}`;
  const r = await req(HS, "POST", "/_matrix/client/v3/register", { token: env.AS_TOKEN, body: { type: "m.login.application_service", username: user, inhibit_login: true } });
  if (r.status !== 200) throw new Error("agent register failed " + r.text);
  return { id: `@${user}:${DOMAIN}`, user };
}
const rules = (path, body) => req(RULES, "POST", path, { body });
const approve = (room, user) => rules("/admin/approve", { room, user });

// system (appservice) helpers
const sys = (method, path, body) => req(HS, method, path, { token: env.AS_TOKEN, body });
const asAgent = (agent, method, path, body) => req(HS, method, `${path}${path.includes("?") ? "&" : "?"}user_id=${enc(agent.id)}`, { token: env.AS_TOKEN, body });

async function createRoom(name, members, { agents = [], observers = [] } = {}) {
  const r = await sys("POST", "/_matrix/client/v3/createRoom", {
    name,
    preset: "private_chat",
    initial_state: [
      { type: "m.room.history_visibility", state_key: "", content: { history_visibility: "joined" } },
      { type: "af.roles", state_key: "", content: { observers: observers.map((o) => o.id) } },
    ],
    power_level_content_override: { users: {}, events_default: 0, state_default: 100, invite: 100, kick: 100, ban: 100, redact: 100 },
  });
  if (r.status !== 200) throw new Error("createRoom failed " + r.text);
  const room = r.json.room_id;
  for (const m of [...members, ...agents]) await approve(room, m.id);
  for (const m of [...members, ...agents]) {
    const inv = await sys("POST", `/_matrix/client/v3/rooms/${enc(room)}/invite`, { user_id: m.id });
    if (inv.status !== 200) throw new Error("invite failed " + inv.text);
  }
  for (const m of members) {
    const j = await req(PUB, "POST", `/_matrix/client/v3/rooms/${enc(room)}/join`, { token: m.token, body: {} });
    if (j.status !== 200) throw new Error("join failed " + j.text);
  }
  for (const a of agents) {
    const j = await asAgent(a, "POST", `/_matrix/client/v3/rooms/${enc(room)}/join`, {});
    if (j.status !== 200) throw new Error("agent join failed " + j.text);
  }
  return room;
}
const sendPath = (room, type = "m.room.message") => `/_matrix/client/v3/rooms/${enc(room)}/send/${type}/t${rid}${++txn}`;
const say = (u, room, body) => req(PUB, "PUT", sendPath(room), { token: u.token, body: { msgtype: "m.text", body } });
const agentSay = (a, room, body) => asAgent(a, "PUT", sendPath(room), { msgtype: "m.text", body });
const history = (u, room, extra = "") => req(PUB, "GET", `/_matrix/client/v3/rooms/${enc(room)}/messages?dir=b&limit=100${extra}`, { token: u.token });

function restartRules() {
  try {
    execSync("pkill -f /work/matrix/[r]ules.py");
  } catch {}
  const out = openSync("/work/matrix/rules.log", "a");
  spawn("python3", ["/work/matrix/rules.py"], { detached: true, stdio: ["ignore", out, out], env: { ...process.env, AS_TOKEN: env.AS_TOKEN } }).unref();
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ───────────────────────────────────────────────────────────── setup
await rules("/admin/mode", { mode: "ok" }); // a previously interrupted run may have left a failure mode on
const owner1 = await registerHuman("owner1");
const owner2 = await registerHuman("owner2");
const outsider = await registerHuman("outsider");
const late = await registerHuman("late");
const guest = await registerHuman("guest");
const a1 = await registerAgent("a1");
const a2 = await registerAgent("a2");

// ───────────────────────────────────────────────────────────── 1 basics
{
  const dm = await createRoom("dm", [owner1, owner2]);
  const s1 = await say(owner1, dm, `dm-hello-${rid}`);
  const s2 = await say(owner2, dm, `dm-reply-${rid}`);
  const h = await history(owner1, dm);
  check("1a", "私聊双向收发", s1.status === 200 && s2.status === 200 && h.text.includes(`dm-hello-${rid}`) && h.text.includes(`dm-reply-${rid}`), { s1: s1.status, s2: s2.status });

  const g = await createRoom("humans", [owner1, owner2, guest]);
  const gs = await say(owner1, g, `grp-${rid}`);
  const gh = await history(guest, g);
  check("1b", "建群并群内收发（纯真人群）", gs.status === 200 && gh.text.includes(`grp-${rid}`), { send: gs.status });

  const bytes = randomBytes(2048);
  const up = await req(PUB, "POST", "/_matrix/media/v3/upload?filename=a.bin", { token: owner1.token, raw: bytes });
  const fe = await req(PUB, "PUT", sendPath(g), { token: owner1.token, body: { msgtype: "m.file", body: "a.bin", url: up.json?.content_uri } });
  const dl = await req(PUB, "GET", `/af/media?room=${enc(g)}&event=${enc(fe.json?.event_id)}`, { token: owner2.token });
  check("1c", "成员上传附件并由另一成员取回，内容一致", up.status === 200 && fe.status === 200 && dl.status === 200 && dl.buf.equals(bytes), { upload: up.status, send: fe.status, download: dl.status, bytes: dl.buf.length });

  const relog = await req(PUB, "POST", "/_matrix/client/v3/login", { body: { type: "m.login.password", identifier: { type: "m.id.user", user: owner2.user }, password: owner2.pass } });
  const h2 = await req(PUB, "GET", `/_matrix/client/v3/rooms/${enc(dm)}/messages?dir=b&limit=100`, { token: relog.json?.access_token });
  check("1d", "重新登录（新令牌、新设备）后历史完整", relog.status === 200 && h2.text.includes(`dm-hello-${rid}`) && h2.text.includes(`dm-reply-${rid}`), { login: relog.status, history: h2.status });
}

// ───────────────────────────────────────────────────────────── 8 owners as observers (builds room G used below)
const G = await createRoom("agent-group", [owner1, owner2], { agents: [a1, a2], observers: [owner1, owner2] });
{
  const init1 = await req(PUB, "GET", "/_matrix/client/v3/sync?timeout=0", { token: owner1.token });
  const init2 = await req(PUB, "GET", "/_matrix/client/v3/sync?timeout=0", { token: owner2.token });
  const wait1 = req(PUB, "GET", `/_matrix/client/v3/sync?timeout=8000&since=${init1.json.next_batch}`, { token: owner1.token });
  const wait2 = req(PUB, "GET", `/_matrix/client/v3/sync?timeout=8000&since=${init2.json.next_batch}`, { token: owner2.token });
  const m1 = await agentSay(a1, G, `old-a1-${rid}`);
  const m2 = await agentSay(a2, G, `old-a2-${rid}`);
  let t1 = (await wait1).text;
  let t2 = (await wait2).text;
  // long-poll returns on the first event; one follow-up poll collects the second
  if (!t1.includes(`old-a2-${rid}`)) t1 += (await req(PUB, "GET", `/_matrix/client/v3/sync?timeout=3000&since=${JSON.parse(t1).next_batch}`, { token: owner1.token })).text;
  if (!t2.includes(`old-a2-${rid}`)) t2 += (await req(PUB, "GET", `/_matrix/client/v3/sync?timeout=3000&since=${JSON.parse(t2).next_batch}`, { token: owner2.token })).text;
  const both = (t) => t.includes(`old-a1-${rid}`) && t.includes(`old-a2-${rid}`);
  check("8a", "两位主人各自的长连接实时收到两个 Agent 的消息", m1.status === 200 && m2.status === 200 && both(t1) && both(t2), { a1: m1.status, a2: m2.status, owner1: both(t1), owner2: both(t2) });

  const inter = await say(owner1, G, `old-interject-${rid}`);
  const seen = await asAgent(a2, "GET", `/_matrix/client/v3/rooms/${enc(G)}/messages?dir=b&limit=20`);
  check("8b", "主人以本人身份插话，Agent 侧可读到", inter.status === 200 && seen.text.includes(`old-interject-${rid}`), { send: inter.status });

  const tamper = await req(PUB, "PUT", `/_matrix/client/v3/rooms/${enc(G)}/state/af.roles/`, { token: owner1.token, body: { observers: [] } });
  const roles = await req(PUB, "GET", `/_matrix/client/v3/rooms/${enc(G)}/state/af.roles/`, { token: owner2.token });
  check("8c", "旁观标记存于房间状态，成员可读但不能改", tamper.status === 403 && roles.json?.observers?.length === 2, { tamper: brief(tamper), read: roles.status });
}

// old attachment in G, before the late joiner arrives
const oldBytes = randomBytes(4096);
const oldUp = await req(PUB, "POST", "/_matrix/media/v3/upload?filename=old.bin", { token: owner1.token, raw: oldBytes });
const oldMxc = oldUp.json.content_uri;
const oldFile = await req(PUB, "PUT", sendPath(G), { token: owner1.token, body: { msgtype: "m.file", body: `old-file-${rid}`, url: oldMxc } });
const oldEvent = oldFile.json.event_id;
const [, , mxcServer, mxcId] = oldMxc.split("/");
const ownerPage = await history(owner1, G);
const OLD = [`old-a1-${rid}`, `old-a2-${rid}`, `old-interject-${rid}`, `old-file-${rid}`, mxcId];
const leaks = (text) => OLD.filter((m) => text.includes(m));

// ───────────────────────────────────────────────────────────── 4 non-member
{
  const r = {
    messages: await history(outsider, G),
    state: await req(PUB, "GET", `/_matrix/client/v3/rooms/${enc(G)}/state`, { token: outsider.token }),
    event: await req(PUB, "GET", `/_matrix/client/v3/rooms/${enc(G)}/event/${enc(oldEvent)}`, { token: outsider.token }),
    context: await req(PUB, "GET", `/_matrix/client/v3/rooms/${enc(G)}/context/${enc(oldEvent)}`, { token: outsider.token }),
    members: await req(PUB, "GET", `/_matrix/client/v3/rooms/${enc(G)}/members`, { token: outsider.token }),
    send: await say(outsider, G, "intrude"),
    join: await req(PUB, "POST", `/_matrix/client/v3/join/${enc(G)}`, { token: outsider.token, body: {} }),
    search: await req(PUB, "POST", "/_matrix/client/v3/search", { token: outsider.token, body: { search_categories: { room_events: { search_term: `old-a1-${rid}` } } } }),
  };
  const outsiderHits = r.search.json?.search_categories?.room_events?.results ?? [];
  const leaked = [...Object.entries(r).filter(([k]) => k !== "search").flatMap(([, x]) => leaks(x.text)), ...outsiderHits];
  const denied = ["messages", "state", "event", "context", "members", "send", "join"].every((k) => r[k].status >= 400);
  check("4", "无关人读不到也发不进（消息、状态、单条事件、上下文、成员、搜索、发送、加入）", denied && leaked.length === 0, Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.status])));
}

// ───────────────────────────────────────────────────────────── 3 attachments, part 1 (people who never could see it)
const mediaChecks = {};
{
  mediaChecks.nativeDirect_outsider = (await req(HS, "GET", `/_matrix/client/v1/media/download/${mxcServer}/${mxcId}`, { token: outsider.token })).status;
  mediaChecks.nativeDirect_noToken = (await req(HS, "GET", `/_matrix/client/v1/media/download/${mxcServer}/${mxcId}`)).status;
  mediaChecks.nativeLegacy_noToken = (await req(HS, "GET", `/_matrix/media/v3/download/${mxcServer}/${mxcId}`)).status;
  mediaChecks.publicDirect_member = (await req(PUB, "GET", `/_matrix/client/v1/media/download/${mxcServer}/${mxcId}`, { token: owner1.token })).status;
  mediaChecks.publicDirect_outsider = (await req(PUB, "GET", `/_matrix/client/v1/media/download/${mxcServer}/${mxcId}`, { token: outsider.token })).status;
  mediaChecks.publicThumb_outsider = (await req(PUB, "GET", `/_matrix/client/v1/media/thumbnail/${mxcServer}/${mxcId}?width=32&height=32`, { token: outsider.token })).status;
  mediaChecks.gated_outsider = (await req(PUB, "GET", `/af/media?room=${enc(G)}&event=${enc(oldEvent)}`, { token: outsider.token })).status;
  mediaChecks.gated_noToken = (await req(PUB, "GET", `/af/media?room=${enc(G)}&event=${enc(oldEvent)}`)).status;
  const ok = await req(PUB, "GET", `/af/media?room=${enc(G)}&event=${enc(oldEvent)}`, { token: owner2.token });
  mediaChecks.gated_member = ok.status;
  mediaChecks.gated_member_bytesMatch = ok.buf.equals(oldBytes);
}

// ───────────────────────────────────────────────────────────── 7 join gating (late joiner enters here)
{
  await sys("PUT", `/_matrix/client/v3/rooms/${enc(G)}/state/m.room.power_levels/`, {
    users: { [owner1.id]: 100 }, events_default: 0, state_default: 100, invite: 100, kick: 100, ban: 100, redact: 100,
  });
  const r = {};
  r.adminInviteUnapproved = await req(PUB, "POST", `/_matrix/client/v3/rooms/${enc(G)}/invite`, { token: owner1.token, body: { user_id: late.id } });
  r.memberInviteUnapproved = await req(PUB, "POST", `/_matrix/client/v3/rooms/${enc(G)}/invite`, { token: owner2.token, body: { user_id: late.id } });
  r.selfJoinUnapproved = await req(PUB, "POST", `/_matrix/client/v3/join/${enc(G)}`, { token: late.token, body: {} });
  r.knock = await req(PUB, "POST", `/_matrix/client/v3/knock/${enc(G)}`, { token: late.token, body: {} });
  r.userCreatesOwnRoom = await req(PUB, "POST", "/_matrix/client/v3/createRoom", { token: owner1.token, body: { invite: [late.id] } });
  await approve(G, late.id);
  r.adminInviteApproved = await req(PUB, "POST", `/_matrix/client/v3/rooms/${enc(G)}/invite`, { token: owner1.token, body: { user_id: late.id } });
  // an invited-but-not-joined user must still see nothing
  r.invitedOnlyHistory = await history(late, G);
  r.joinApproved = await req(PUB, "POST", `/_matrix/client/v3/rooms/${enc(G)}/join`, { token: late.token, body: {} });
  r.adminKick = await req(PUB, "POST", `/_matrix/client/v3/rooms/${enc(G)}/kick`, { token: owner1.token, body: { user_id: late.id } });
  r.adminBan = await req(PUB, "POST", `/_matrix/client/v3/rooms/${enc(G)}/ban`, { token: owner1.token, body: { user_id: late.id } });
  const blocked = ["adminInviteUnapproved", "memberInviteUnapproved", "selfJoinUnapproved", "knock", "userCreatesOwnRoom", "adminKick", "adminBan"].every((k) => r[k].status === 403);
  const allowed = r.adminInviteApproved.status === 200 && r.joinApproved.status === 200;
  check("7", "未经规则服务批准的邀请、自行加入、敲门、自建房间、踢人、封禁全部被拒；批准后邀请与加入成功", blocked && allowed && leaks(r.invitedOnlyHistory.text).length === 0, Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.status])));
}

// ───────────────────────────────────────────────────────────── 2 pre-join history
{
  const fresh = await say(owner2, G, `new-${rid}`);
  const r = {
    messages: await history(late, G),
    messagesWithOwnerToken: await history(late, G, `&from=${enc(ownerPage.json.start)}`),
    messagesFromOwnerEnd: await history(late, G, `&from=${enc(ownerPage.json.end || ownerPage.json.start)}`),
    forwardFromStart: await req(PUB, "GET", `/_matrix/client/v3/rooms/${enc(G)}/messages?dir=f&limit=100`, { token: late.token }),
    sync: await req(PUB, "GET", `/_matrix/client/v3/sync?timeout=0&filter=${enc(JSON.stringify({ room: { timeline: { limit: 100 } } }))}`, { token: late.token }),
    syncFullState: await req(PUB, "GET", "/_matrix/client/v3/sync?timeout=0&full_state=true", { token: late.token }),
    event: await req(PUB, "GET", `/_matrix/client/v3/rooms/${enc(G)}/event/${enc(oldEvent)}`, { token: late.token }),
    context: await req(PUB, "GET", `/_matrix/client/v3/rooms/${enc(G)}/context/${enc(oldEvent)}?limit=50`, { token: late.token }),
    relations: await req(PUB, "GET", `/_matrix/client/v1/rooms/${enc(G)}/relations/${enc(oldEvent)}`, { token: late.token }),
    initialSync: await req(PUB, "GET", `/_matrix/client/v3/rooms/${enc(G)}/initialSync?limit=100`, { token: late.token }),
    search: await req(PUB, "POST", "/_matrix/client/v3/search", { token: late.token, body: { search_categories: { room_events: { search_term: `old-a1-${rid}` } } } }),
    timestampToEvent: await req(PUB, "GET", `/_matrix/client/v1/rooms/${enc(G)}/timestamp_to_event?ts=0&dir=f`, { token: late.token }),
    state: await req(PUB, "GET", `/_matrix/client/v3/rooms/${enc(G)}/state`, { token: late.token }),
  };
  const searchHits = r.search.json?.search_categories?.room_events?.results ?? [];
  const leaked = Object.fromEntries(
    Object.entries(r).map(([k, v]) => [k, k === "search" ? searchHits.map((h) => h.result?.content?.body) : leaks(v.text)]).filter(([, v]) => v.length),
  );
  const ownerSearch = await req(PUB, "POST", "/_matrix/client/v3/search", { token: owner1.token, body: { search_categories: { room_events: { search_term: `old-a1-${rid}` } } } });
  const ownerSearchHits = ownerSearch.json?.search_categories?.room_events?.results?.length ?? 0;
  const seesNew = r.messages.text.includes(`new-${rid}`);
  check("2", "后加入者通过 13 种读取途径都拿不到入群前的消息，入群后的新消息可读", Object.keys(leaked).length === 0 && seesNew && fresh.status === 200 && ownerSearchHits > 0, {
    statuses: Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.status])), leaked, seesNew,
    ownerSeesOld: leaks(ownerPage.text).length, lateSearchHits: searchHits.length, ownerSearchHits,
  });

  // 3, part 2: the late joiner and the old attachment
  mediaChecks.nativeDirect_late = (await req(HS, "GET", `/_matrix/client/v1/media/download/${mxcServer}/${mxcId}`, { token: late.token })).status;
  mediaChecks.publicDirect_late = (await req(PUB, "GET", `/_matrix/client/v1/media/download/${mxcServer}/${mxcId}`, { token: late.token })).status;
  mediaChecks.gated_late = (await req(PUB, "GET", `/af/media?room=${enc(G)}&event=${enc(oldEvent)}`, { token: late.token })).status;
  const newBytes = randomBytes(1024);
  const up = await req(PUB, "POST", "/_matrix/media/v3/upload?filename=new.bin", { token: owner1.token, raw: newBytes });
  const fe = await req(PUB, "PUT", sendPath(G), { token: owner1.token, body: { msgtype: "m.file", body: "new.bin", url: up.json.content_uri } });
  const got = await req(PUB, "GET", `/af/media?room=${enc(G)}&event=${enc(fe.json.event_id)}`, { token: late.token });
  mediaChecks.gated_late_newAttachment = got.status;
  mediaChecks.gated_late_newAttachment_bytesMatch = got.buf.equals(newBytes);

  note("3-native", "原生行为：只要有任意登录令牌并知道地址，就能直接下载（不校验房间成员）", {
    outsider: mediaChecks.nativeDirect_outsider, late: mediaChecks.nativeDirect_late, noToken: mediaChecks.nativeDirect_noToken, legacyNoToken: mediaChecks.nativeLegacy_noToken,
  });
  const fixed =
    [mediaChecks.publicDirect_member, mediaChecks.publicDirect_outsider, mediaChecks.publicDirect_late, mediaChecks.publicThumb_outsider].every((s) => s === 403) &&
    mediaChecks.gated_outsider === 403 && mediaChecks.gated_late === 403 && mediaChecks.gated_noToken === 401 &&
    mediaChecks.gated_member === 200 && mediaChecks.gated_member_bytesMatch && mediaChecks.gated_late_newAttachment === 200 && mediaChecks.gated_late_newAttachment_bytesMatch;
  check("3", "补法生效：入口封掉直接下载，附件改由规则服务按“调用者能否看到该消息”放行", fixed, mediaChecks);
}

// ───────────────────────────────────────────────────────────── 5 freeze
{
  await rules("/admin/freeze", { room: G, frozen: true });
  const target = (await history(owner2, G)).json.chunk.find((e) => e.type === "m.room.message").event_id;
  const r = {
    roomAdmin: await say(owner1, G, "frozen-admin"),
    member: await say(owner2, G, "frozen-member"),
    lateMember: await say(late, G, "frozen-late"),
    agent: await agentSay(a1, G, "frozen-agent"),
    reaction: await req(PUB, "PUT", sendPath(G, "m.reaction"), { token: owner1.token, body: { "m.relates_to": { rel_type: "m.annotation", event_id: target, key: "x" } } }),
    redaction: await req(PUB, "PUT", `/_matrix/client/v3/rooms/${enc(G)}/redact/${enc(target)}/r${rid}`, { token: owner1.token, body: {} }),
    fileMessage: await req(PUB, "PUT", sendPath(G), { token: owner2.token, body: { msgtype: "m.file", body: "x", url: oldMxc } }),
    topic: await req(PUB, "PUT", `/_matrix/client/v3/rooms/${enc(G)}/state/m.room.topic/`, { token: owner1.token, body: { topic: "x" } }),
  };
  const sysNote = await sys("PUT", sendPath(G), { msgtype: "m.notice", body: `system-notice-${rid}` });
  const after = await history(owner2, G);
  const leakedIn = ["frozen-admin", "frozen-member", "frozen-late", "frozen-agent"].filter((m) => after.text.includes(m));
  check("5a", "冻结后群管理员、普通成员、新成员、Agent 的消息/表情/撤回/附件/改话题全部被服务器拒绝；系统通知仍可发", Object.values(r).every((x) => x.status === 403) && leakedIn.length === 0 && sysNote.status === 200, {
    ...Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.status])), systemNotice: sysNote.status, leakedIn,
  });
  const lock = {
    powerLevels: await req(PUB, "PUT", `/_matrix/client/v3/rooms/${enc(G)}/state/m.room.power_levels/`, { token: owner1.token, body: { users: { [owner1.id]: 100 } } }),
    historyVisibility: await req(PUB, "PUT", `/_matrix/client/v3/rooms/${enc(G)}/state/m.room.history_visibility/`, { token: owner1.token, body: { history_visibility: "shared" } }),
    joinRules: await req(PUB, "PUT", `/_matrix/client/v3/rooms/${enc(G)}/state/m.room.join_rules/`, { token: owner1.token, body: { join_rule: "public" } }),
    encryption: await req(PUB, "PUT", `/_matrix/client/v3/rooms/${enc(G)}/state/m.room.encryption/`, { token: owner1.token, body: { algorithm: "m.megolm.v1.aes-sha2" } }),
  };
  check("5b", "群管理员（权限 100）不能改历史可见、加入规则、权限表，也不能开启加密", Object.values(lock).every((x) => x.status === 403), Object.fromEntries(Object.entries(lock).map(([k, v]) => [k, v.status])));
  await rules("/admin/freeze", { room: G, frozen: false });
  const thaw = await say(owner2, G, `thawed-${rid}`);
  check("5c", "解冻后恢复发送", thaw.status === 200, { status: thaw.status });
}

// ───────────────────────────────────────────────────────────── 9 agent identity
{
  const r = {
    passwordLogin: await req(PUB, "POST", "/_matrix/client/v3/login", { body: { type: "m.login.password", identifier: { type: "m.id.user", user: a1.user }, password: "guess-guess-guess" } }),
    publicRegisterInNamespace: await req(PUB, "POST", "/_matrix/client/v3/register", { body: { username: `agent_x_${rid}`, password: "guess-guess-guess", auth: { type: "m.login.dummy" } } }),
    userTokenImpersonate: await req(PUB, "PUT", `${sendPath(G)}?user_id=${enc(a1.id)}`, { token: owner1.token, body: { msgtype: "m.text", body: `impersonate-${rid}` } }),
    asLoginViaPublicWithoutToken: await req(PUB, "POST", "/_matrix/client/v3/login", { body: { type: "m.login.application_service", identifier: { type: "m.id.user", user: a1.user } } }),
    adminApiViaPublic: await req(PUB, "GET", `/_synapse/admin/v2/users/${enc(a1.id)}`, { token: owner1.token }),
  };
  let impersonated = false;
  if (r.userTokenImpersonate.status === 200) {
    const ev = await req(PUB, "GET", `/_matrix/client/v3/rooms/${enc(G)}/event/${enc(r.userTokenImpersonate.json.event_id)}`, { token: owner1.token });
    impersonated = ev.json?.sender === a1.id;
    r.userTokenImpersonate.sender = ev.json?.sender;
  }
  const sent = await agentSay(a1, G, `agent-says-${rid}`);
  const ev = await req(PUB, "GET", `/_matrix/client/v3/rooms/${enc(G)}/event/${enc(sent.json?.event_id)}`, { token: owner1.token });
  check("9", "服务端可代 Agent 发言；Agent 无密码、普通用户无法登录/注册/冒充 Agent，也碰不到管理接口", sent.status === 200 && ev.json?.sender === a1.id && r.passwordLogin.status === 403 && r.publicRegisterInNamespace.status >= 400 && !impersonated && r.asLoginViaPublicWithoutToken.status >= 400 && r.adminApiViaPublic.status === 403, {
    serviceSendsAsAgent: sent.status, sender: ev.json?.sender,
    ...Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.sender ? `${v.status} sender=${v.sender}` : v.status])),
  });
}

// ───────────────────────────────────────────────────────────── 6 fail closed
{
  const attempt = async (label) => {
    const t0 = Date.now();
    const send = await say(owner2, G, `failclosed-${label}-${rid}`);
    const agent = await agentSay(a2, G, `failclosed-agent-${label}-${rid}`);
    const invite = await req(PUB, "POST", `/_matrix/client/v3/rooms/${enc(G)}/invite`, { token: owner1.token, body: { user_id: outsider.id } });
    return { send: send.status, agent: agent.status, invite: invite.status, ms: Date.now() - t0 };
  };
  const out = {};
  await rules("/admin/mode", { mode: "500" });
  out.http500 = await attempt("500");
  await rules("/admin/mode", { mode: "hang" });
  out.hang = await attempt("hang");
  execSync("pkill -f /work/matrix/[r]ules.py || true");
  await sleep(500);
  out.down = await attempt("down");
  restartRules();
  await sleep(1500);
  await approve(G, outsider.id); // in-memory state was lost with the restart; nothing was approved before
  const after = await history(owner1, G);
  const leaked = after.text.includes("failclosed-");
  const recovered = await say(owner2, G, `recovered-${rid}`);
  const allDenied = Object.values(out).every((o) => o.send === 403 && o.agent === 403 && o.invite === 403);
  check("6", "规则服务返回 500、超时无响应、进程不在：发消息、Agent 发言、邀请一律被拒；服务恢复后正常", allDenied && !leaked && recovered.status === 200, { ...out, leakedIntoRoom: leaked, recoveredSend: recovered.status });
}

const versions = (await req(HS, "GET", "/_matrix/federation/v1/version")).json ?? (await req(HS, "GET", "/_synapse/admin/v1/server_version")).json;
const out = { candidate: "A: Synapse + af_gate module + rule service + nginx entry", runId: rid, at: new Date().toISOString(), server: versions, results };
writeFileSync("/work/matrix/results.json", JSON.stringify(out, null, 1));
const fails = results.filter((r) => r.result === "FAIL").length;
console.log(`\n${results.length - fails}/${results.length} non-failing, ${fails} failing`);
