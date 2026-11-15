// Gate-verification spike, candidate C (self-built core). Same checks, same ids as candidate A.
//   CORE_ADMIN_SECRET=... node gate-test.mjs      (server.mjs must be running)
// Ordinary-user actions use that user's own token. "service" = calls the product's own
// server-side logic would make (x-admin header).
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import WebSocket from "ws";

const BASE = process.env.CORE_URL || "http://127.0.0.1:9300";
const ADMIN = process.env.CORE_ADMIN_SECRET;
const rid = randomBytes(3).toString("hex");
const results = [];
const check = (id, desc, pass, evidence) => {
  results.push({ id, desc, result: pass ? "PASS" : "FAIL", evidence });
  console.log(`${pass ? "PASS" : "FAIL"}  ${id}  ${desc}`);
};
const note = (id, desc, evidence) => {
  results.push({ id, desc, result: "N/A", evidence });
  console.log(`N/A   ${id}  ${desc}`);
};

async function req(method, path, { token, body, raw, admin } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (admin) headers["x-admin"] = ADMIN;
  let payload;
  if (raw) payload = raw;
  else if (body !== undefined) {
    payload = JSON.stringify(body);
    headers["content-type"] = "application/json";
  }
  const r = await fetch(BASE + path, { method, headers, body: payload });
  const buf = Buffer.from(await r.arrayBuffer());
  let json = null;
  try {
    json = JSON.parse(buf.toString("utf8"));
  } catch {}
  return { status: r.status, json, buf, text: buf.toString("utf8") };
}
const svc = (path, body) => req("POST", path, { admin: true, body });
const st = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v.json?.error ? `${v.status} ${v.json.error}` : v.status]));

async function human(name) {
  const handle = `${name}_${rid}`;
  const password = randomBytes(12).toString("hex");
  const { json } = await svc("/admin/principals", { kind: "human", handle, name, password });
  const login = await req("POST", "/login", { body: { handle, password } });
  return { id: json.id, handle, password, token: login.json.token };
}
async function agent(name, owner) {
  const { json } = await svc("/admin/principals", { kind: "agent", handle: `agent_${name}_${rid}`, name, owner: owner.id });
  // A built-in Agent's credential stays on the server side.
  const tok = await svc("/admin/agent-token", { agent: json.id });
  return { id: json.id, token: tok.json.token };
}
const room = async (type, title, members) => (await svc("/admin/conversations", { type, title, members })).json.id;
const say = (u, conv, text, extra = {}) => req("POST", `/conversations/${conv}/messages`, { token: u.token, body: { text, ...extra } });
const history = (u, conv, q = "") => req("GET", `/conversations/${conv}/messages?limit=200${q}`, { token: u.token });
const listen = (u) =>
  new Promise((resolve) => {
    const got = [];
    const ws = new WebSocket(`${BASE.replace("http", "ws")}/ws?token=${u.token}`);
    ws.on("message", (d) => got.push(JSON.parse(d.toString())));
    ws.on("open", () => resolve({ got, close: () => ws.close(), text: () => JSON.stringify(got) }));
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ───────────────────────── setup
const owner1 = await human("owner1");
const owner2 = await human("owner2");
const outsider = await human("outsider");
const late = await human("late");
const guest = await human("guest");
const a1 = await agent("a1", owner1);
const a2 = await agent("a2", owner2);

// ───────────────────────── 1 basics
{
  const dm = await room("human", null, [{ id: owner1.id }, { id: owner2.id }]);
  const s1 = await say(owner1, dm, `dm-hello-${rid}`);
  const s2 = await say(owner2, dm, `dm-reply-${rid}`);
  const h = await history(owner1, dm);
  check("1a", "私聊双向收发", s1.status === 200 && s2.status === 200 && h.text.includes(`dm-hello-${rid}`) && h.text.includes(`dm-reply-${rid}`), st({ s1, s2 }));

  const g = await room("group", "humans", [{ id: owner1.id }, { id: owner2.id }, { id: guest.id }]);
  const gs = await say(owner1, g, `grp-${rid}`);
  check("1b", "建群并群内收发（纯真人群）", gs.status === 200 && (await history(guest, g)).text.includes(`grp-${rid}`), st({ gs }));

  const bytes = randomBytes(2048);
  const up = await req("POST", `/conversations/${g}/attachments?name=a.bin`, { token: owner1.token, raw: bytes });
  const fe = await say(owner1, g, "", { kind: "file", attachment_id: up.json?.id });
  const dl = await req("GET", `/attachments/${up.json?.id}`, { token: owner2.token });
  check("1c", "成员上传附件并由另一成员取回，内容一致", up.status === 200 && fe.status === 200 && dl.status === 200 && dl.buf.equals(bytes), { ...st({ up, fe, dl }), bytes: dl.buf.length });

  const relog = await req("POST", "/login", { body: { handle: owner2.handle, password: owner2.password } });
  const h2 = await req("GET", `/conversations/${dm}/messages`, { token: relog.json?.token });
  const sync = await req("GET", "/sync", { token: relog.json?.token });
  check("1d", "重新登录（新令牌）后历史完整，初次同步含全部会话", relog.status === 200 && h2.text.includes(`dm-hello-${rid}`) && h2.text.includes(`dm-reply-${rid}`) && sync.json?.conversations.length === 2, st({ relog, h2, sync }));

  const txn = `txn-${rid}`;
  const d1 = await say(owner1, dm, `once-${rid}`, { client_txn: txn });
  const d2 = await say(owner1, dm, `once-${rid}`, { client_txn: txn });
  const count = (await history(owner2, dm)).json.messages.filter((m) => m.body.text === `once-${rid}`).length;
  check("1e", "同一条消息重发（断线重试）不会产生第二条", d1.status === 200 && d2.status === 200 && d1.json.seq === d2.json.seq && count === 1, { seq1: d1.json?.seq, seq2: d2.json?.seq, count });
}

// ───────────────────────── 8 owners as observers (builds G used below)
// Only the two Agents are listed; their owners are attached by the core itself.
const G = await room("agentGroup", "agent-group", [{ id: a1.id }, { id: a2.id }]);
{
  const members = (await req("GET", `/conversations/${G}/members`, { token: owner1.token })).json?.members || [];
  const roleOf = (p) => members.find((m) => m.id === p.id)?.role;
  check("8c", "只把 Agent 加进会话，两位主人被自动加为旁观成员；成员没有任何接口可改角色", roleOf(owner1) === "observer" && roleOf(owner2) === "observer" && roleOf(a1) === "speaker" && members.length === 4, { members: members.map((m) => m.role) });

  const l1 = await listen(owner1);
  const l2 = await listen(owner2);
  const m1 = await say(a1, G, `old-a1-${rid}`);
  const m2 = await say(a2, G, `old-a2-${rid}`);
  await sleep(300);
  const both = (l) => l.text().includes(`old-a1-${rid}`) && l.text().includes(`old-a2-${rid}`);
  check("8a", "两位主人各自的长连接实时收到两个 Agent 的消息", m1.status === 200 && m2.status === 200 && both(l1) && both(l2), { ...st({ m1, m2 }), owner1: both(l1), owner2: both(l2) });
  l1.close();
  l2.close();

  const inter = await say(owner1, G, `old-interject-${rid}`);
  check("8b", "主人以本人身份插话，Agent 侧可读到", inter.status === 200 && (await history(a2, G)).text.includes(`old-interject-${rid}`), st({ inter }));
}

const oldBytes = randomBytes(4096);
const oldUp = await req("POST", `/conversations/${G}/attachments?name=old-file-${rid}`, { token: owner1.token, raw: oldBytes });
const oldAtt = oldUp.json.id;
const oldFile = await say(owner1, G, "", { kind: "file", attachment_id: oldAtt });
const oldSeq = oldFile.json.seq;
const OLD = [`old-a1-${rid}`, `old-a2-${rid}`, `old-interject-${rid}`, `old-file-${rid}`, oldAtt];
const leaks = (text) => OLD.filter((m) => text.includes(m));

// ───────────────────────── 4 non-member
{
  const l = await listen(outsider);
  const r = {
    messages: await history(outsider, G),
    single: await req("GET", `/conversations/${G}/messages/${oldSeq}`, { token: outsider.token }),
    members: await req("GET", `/conversations/${G}/members`, { token: outsider.token }),
    search: await req("GET", `/conversations/${G}/search?q=old-a1`, { token: outsider.token }),
    send: await say(outsider, G, "intrude"),
    upload: await req("POST", `/conversations/${G}/attachments`, { token: outsider.token, raw: Buffer.from("x") }),
    join: await req("POST", `/conversations/${G}/join`, { token: outsider.token }),
    read: await req("POST", `/conversations/${G}/read`, { token: outsider.token, body: { seq: 99 } }),
  };
  const sync = await req("GET", "/sync", { token: outsider.token });
  await say(a1, G, `old-live-${rid}`);
  await sleep(200);
  const leaked = [...Object.values(r).flatMap((x) => leaks(x.text)), ...leaks(sync.text), ...leaks(l.text()), ...(l.text().includes("old-live") ? ["ws"] : [])];
  l.close();
  const denied = ["messages", "single", "members", "search", "send", "upload", "join"].every((k) => r[k].status >= 400);
  check("4", "无关人读不到也发不进（历史、单条、成员、搜索、同步、长连接推送、发送、上传、加入）", denied && leaked.length === 0, { ...st(r), leaked });
}

// ───────────────────────── 3 attachments, part 1
const media = {};
media.outsider = (await req("GET", `/attachments/${oldAtt}`, { token: outsider.token })).status;
media.noToken = (await req("GET", `/attachments/${oldAtt}`)).status;
const okDl = await req("GET", `/attachments/${oldAtt}`, { token: owner2.token });
media.member = okDl.status;
media.memberBytesMatch = okDl.buf.equals(oldBytes);

// ───────────────────────── 7 join gating
{
  const r = {};
  r.memberInviteUnapproved = await req("POST", `/conversations/${G}/invite`, { token: owner1.token, body: { principal: late.id } });
  r.agentInviteUnapproved = await req("POST", `/conversations/${G}/invite`, { token: a1.token, body: { principal: late.id } });
  r.selfJoinUnapproved = await req("POST", `/conversations/${G}/join`, { token: late.token });
  r.outsiderInvitesSomeone = await req("POST", `/conversations/${G}/invite`, { token: outsider.token, body: { principal: late.id } });
  r.userCreatesOwnRoom = await req("POST", "/conversations", { token: owner1.token, body: { members: [late.id] } });
  r.kick = await req("POST", `/conversations/${G}/kick`, { token: owner1.token, body: { principal: a2.id } });
  r.setRole = await req("POST", `/conversations/${G}/members`, { token: owner1.token, body: { principal: owner1.id, role: "speaker" } });
  r.adminEndpointWithUserToken = await req("POST", "/admin/approve", { token: owner1.token, body: { conv: G, principal: late.id } });
  await svc("/admin/approve", { conv: G, principal: late.id });
  r.inviteApproved = await req("POST", `/conversations/${G}/invite`, { token: owner1.token, body: { principal: late.id } });
  r.approvalIsSingleUse = await req("POST", `/conversations/${G}/invite`, { token: owner1.token, body: { principal: outsider.id } });
  const blocked = ["memberInviteUnapproved", "agentInviteUnapproved", "selfJoinUnapproved", "outsiderInvitesSomeone", "userCreatesOwnRoom", "kick", "setRole", "adminEndpointWithUserToken", "approvalIsSingleUse"].every((k) => r[k].status >= 400);
  check("7", "未经批准的邀请、自行加入、自建会话、踢人、改角色、调用服务端接口全部被拒；批准后加入成功，批准只能用一次", blocked && r.inviteApproved.status === 200, st(r));
}

// ───────────────────────── 2 pre-join history
{
  const fresh = await say(owner2, G, `new-${rid}`);
  const r = {
    messages: await history(late, G),
    beforeOldSeq: await history(late, G, `&before=${oldSeq + 1}`),
    single: await req("GET", `/conversations/${G}/messages/${oldSeq}`, { token: late.token }),
    singleFirst: await req("GET", `/conversations/${G}/messages/1`, { token: late.token }),
    search: await req("GET", `/conversations/${G}/search?q=old-`, { token: late.token }),
    syncInitial: await req("GET", "/sync", { token: late.token }),
    syncSinceZeroish: await req("GET", "/sync?since=1", { token: late.token }),
    replyToOld: await say(late, G, "quote", { reply_to: oldSeq }),
  };
  const leaked = Object.fromEntries(Object.entries(r).map(([k, v]) => [k, leaks(v.text)]).filter(([, v]) => v.length));
  const ownerSearch = await req("GET", `/conversations/${G}/search?q=old-`, { token: owner1.token });
  const seesNew = r.messages.text.includes(`new-${rid}`);
  check("2", "后加入者通过历史、翻页、单条、搜索、初次同步、增量同步、引用旧消息都拿不到入群前的内容；入群后的可读", Object.keys(leaked).length === 0 && seesNew && fresh.status === 200 && ownerSearch.json.messages.length >= 3 && r.replyToOld.status === 400, {
    statuses: st(r), leaked, seesNew, ownerSearchHits: ownerSearch.json.messages.length, lateSearchHits: r.search.json?.messages?.length,
  });

  media.late = (await req("GET", `/attachments/${oldAtt}`, { token: late.token })).status;
  const nb = randomBytes(1024);
  const up = await req("POST", `/conversations/${G}/attachments?name=new.bin`, { token: owner1.token, raw: nb });
  const unsent = (await req("GET", `/attachments/${up.json.id}`, { token: owner2.token })).status;
  await say(owner1, G, "", { kind: "file", attachment_id: up.json.id });
  const got = await req("GET", `/attachments/${up.json.id}`, { token: late.token });
  media.lateNewAttachment = got.status;
  media.lateNewBytesMatch = got.buf.equals(nb);
  media.uploadedButNotSent = unsent;
  check("3", "附件只能经由“本人当前看得见的那条消息”取得：无关人、后加入者、无令牌都取不到旧附件；成员和入群后的附件正常", media.outsider === 404 && media.noToken === 401 && media.late === 404 && media.member === 200 && media.memberBytesMatch && media.lateNewAttachment === 200 && media.lateNewBytesMatch && media.uploadedButNotSent === 404, media);

  // leave / rejoin: a returning member sees only what follows the return
  await svc("/admin/remove", { conv: G, principal: late.id });
  await say(owner1, G, `while-away-${rid}`);
  const gone = { history: await history(late, G), sync: await req("GET", "/sync", { token: late.token }), send: await say(late, G, "ghost") };
  await svc("/admin/approve", { conv: G, principal: late.id });
  await req("POST", `/conversations/${G}/invite`, { token: owner1.token, body: { principal: late.id } });
  await say(owner1, G, `after-return-${rid}`);
  const back = await history(late, G);
  check("2b", "被移除后读不到也发不了；重新加入后只能看到重新加入之后的消息", gone.history.status === 403 && gone.send.status === 403 && !gone.sync.text.includes(G) && back.text.includes(`after-return-${rid}`) && !back.text.includes(`while-away-${rid}`) && !back.text.includes(`new-${rid}`), {
    whileGone: st(gone), seesAfterReturn: back.text.includes(`after-return-${rid}`), seesAwayPeriod: back.text.includes(`while-away-${rid}`), seesFirstStay: back.text.includes(`new-${rid}`),
  });
}

// ───────────────────────── 5 freeze
{
  await svc("/admin/freeze", { conv: G, frozen: true });
  const r = {
    observerOwner: await say(owner1, G, "frozen-owner"),
    otherOwner: await say(owner2, G, "frozen-owner2"),
    member: await say(late, G, "frozen-late"),
    agent: await say(a1, G, "frozen-agent"),
    fileUpload: await req("POST", `/conversations/${G}/attachments`, { token: owner2.token, raw: Buffer.from("x") }),
    fileMessage: await say(owner1, G, "", { kind: "file", attachment_id: oldAtt }),
  };
  const sysNote = await svc("/admin/notice", { conv: G, text: `system-notice-${rid}` });
  const after = await history(owner2, G);
  const leakedIn = ["frozen-owner", "frozen-owner2", "frozen-late", "frozen-agent"].filter((m) => after.text.includes(m));
  const frozenFlag = (await req("GET", "/sync", { token: owner2.token })).json.conversations.find((c) => c.id === G)?.frozen;
  check("5a", "冻结后主人、成员、Agent 的消息、附件上传、附件消息全部被拒；系统通知仍可发；客户端能得知冻结状态", Object.values(r).every((x) => x.status === 403) && leakedIn.length === 0 && sysNote.status === 200 && frozenFlag === true, { ...st(r), systemNotice: sysNote.status, leakedIn, frozenFlag });
  note("5b", "成员改历史可见范围、加入规则、权限表、开启加密：这些概念和接口在自研核心里不存在，无可更改", { routesProbed: st({ a: await req("POST", `/conversations/${G}/settings`, { token: owner1.token, body: {} }), b: await req("PUT", `/conversations/${G}`, { token: owner1.token, body: {} }) }) });
  await svc("/admin/freeze", { conv: G, frozen: false });
  const thaw = await say(owner2, G, `thawed-${rid}`);
  check("5c", "解冻后恢复发送", thaw.status === 200, st({ thaw }));

  // freeze and send racing each other: nothing may land after the freeze took effect
  const racers = Array.from({ length: 40 }, (_, i) => say(owner2, G, `race-${rid}-${i}`));
  const frz = svc("/admin/freeze", { conv: G, frozen: true });
  const outcomes = await Promise.all(racers);
  await frz;
  const accepted = outcomes.filter((o) => o.status === 200).length;
  const lateSend = await say(owner2, G, `race-after-${rid}`);
  const stored = (await history(owner1, G)).json.messages.filter((m) => String(m.body.text).startsWith(`race-${rid}`)).length;
  check("5d", "冻结与并发发送同时发生：被接受的条数与实际入库条数一致，冻结生效后的发送被拒", accepted === stored && lateSend.status === 403, { accepted, rejected: 40 - accepted, stored, afterFreeze: lateSend.status });
  await svc("/admin/freeze", { conv: G, frozen: false });
}

// ───────────────────────── 9 agent identity
{
  const sent = await say(a1, G, `agent-says-${rid}`);
  const r = {
    spoofSenderField: await say(owner1, G, `spoof-${rid}`, { sender_id: a1.id, sender: a1.id, from: a1.id }),
    loginAsAgent: await req("POST", "/login", { body: { handle: `agent_a1_${rid}`, password: "guess-guess" } }),
    mintOthersAgentToken: await req("POST", `/agents/${a2.id}/token`, { token: owner1.token }),
    agentMintsOwnToken: await req("POST", `/agents/${a1.id}/token`, { token: a1.token }),
    serviceTokenEndpointWithUserToken: await req("POST", "/admin/agent-token", { token: owner1.token, body: { agent: a1.id } }),
  };
  const own = await req("POST", `/agents/${a1.id}/token`, { token: owner1.token });
  const viaOwnerIssued = await req("POST", `/conversations/${G}/messages`, { token: own.json?.token, body: { text: `external-agent-${rid}` } });
  const dmOwner = await room("agent", null, [{ id: owner2.id }, { id: a2.id }]);
  const agentScope = await history(a1, dmOwner);
  check("9", "发送者只取自令牌：冒名字段无效；Agent 不能密码登录；别人的 Agent 凭据拿不到；主人可为自己的 Agent 签发接入凭据，持有者只能以该 Agent 身份、在它所在的会话里行动", sent.status === 200 && sent.json.sender_id === a1.id && r.spoofSenderField.json?.sender_id === owner1.id && r.loginAsAgent.status === 403 && r.mintOthersAgentToken.status === 403 && r.agentMintsOwnToken.status === 403 && r.serviceTokenEndpointWithUserToken.status === 403 && own.status === 200 && viaOwnerIssued.json?.sender_id === a1.id && agentScope.status === 403, {
    ...st(r), spoofAttributedTo: r.spoofSenderField.json?.sender_id === owner1.id ? "owner1 (the real caller)" : r.spoofSenderField.json?.sender_id,
    ownerIssuesOwnAgentToken: own.status, messageViaOwnerIssuedToken: viaOwnerIssued.json?.sender_id === a1.id ? "attributed to agent a1" : viaOwnerIssued.status, agentReadsUnrelatedConversation: agentScope.status,
  });
}

// ───────────────────────── 6
note("6", "规则服务故障时拒绝：不适用。自研核心没有独立的规则服务，规则判断和写入在同一个数据库事务里；数据库不可用时所有请求一起失败。并发一致性见 5d", {});

// ───────────────────────── extra: Chinese search
{
  const dm = await room("human", null, [{ id: owner1.id }, { id: owner2.id }]);
  await say(owner1, dm, "周六上午九点半在镰仓站集合，记得带相机");
  const hit = await req("GET", `/conversations/${dm}/search?q=${encodeURIComponent("镰仓站")}`, { token: owner2.token });
  const miss = await req("GET", `/conversations/${dm}/search?q=${encodeURIComponent("镰仓站")}`, { token: outsider.token });
  check("x1", "中文按片段搜索可命中，且只在本人可见范围内", hit.json?.messages?.length === 1 && miss.status === 403, { hits: hit.json?.messages?.length, outsider: miss.status });
}

writeFileSync(new URL("./results.json", import.meta.url), JSON.stringify({ candidate: "C: self-built core (Node + Postgres via PGlite)", runId: rid, at: new Date().toISOString(), results }, null, 1));
const fails = results.filter((r) => r.result === "FAIL").length;
console.log(`\n${results.filter((r) => r.result === "PASS").length} pass, ${fails} fail, ${results.filter((r) => r.result === "N/A").length} n/a`);
