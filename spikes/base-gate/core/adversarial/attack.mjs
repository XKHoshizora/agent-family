// Adversarial probe against the running core spike (non-destructive: never tries to kill the server).
// node adversarial/attack.mjs
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import WebSocket from "ws";

const BASE = "http://127.0.0.1:9300";
const ADMIN = readFileSync(process.env.ADMIN_FILE, "utf8").trim();
const rid = randomBytes(3).toString("hex");
const out = (label, v) => console.log(`\n### ${label}\n${typeof v === "string" ? v : JSON.stringify(v)}`);

async function req(method, path, { token, body, raw, admin, headers: h = {} } = {}) {
  const headers = { ...h };
  if (token) headers.authorization = `Bearer ${token}`;
  if (admin) headers["x-admin"] = ADMIN;
  let payload;
  if (raw !== undefined) payload = raw;
  else if (body !== undefined) { payload = JSON.stringify(body); headers["content-type"] = "application/json"; }
  const t0 = performance.now();
  const r = await fetch(BASE + path, { method, headers, body: payload });
  const buf = Buffer.from(await r.arrayBuffer());
  let json = null;
  try { json = JSON.parse(buf.toString("utf8")); } catch {}
  return { status: r.status, json, buf, text: buf.toString("utf8"), ms: performance.now() - t0, ct: r.headers.get("content-type") };
}
const svc = (path, body) => req("POST", path, { admin: true, body });
const s = (r) => `${r.status}${r.json?.error ? " " + r.json.error : ""}`;
async function human(name) {
  const handle = `${name}_${rid}`, password = randomBytes(12).toString("hex");
  const { json } = await svc("/admin/principals", { kind: "human", handle, name, password });
  const login = await req("POST", "/login", { body: { handle, password } });
  return { id: json.id, handle, password, token: login.json.token };
}
async function agent(name, owner) {
  const handle = `agent_${name}_${rid}`;
  const { json } = await svc("/admin/principals", { kind: "agent", handle, name, owner: owner.id });
  const tok = await svc("/admin/agent-token", { agent: json.id });
  return { id: json.id, token: tok.json.token, handle };
}
const room = async (type, title, members) => (await svc("/admin/conversations", { type, title, members })).json.id;
const say = (u, conv, text, extra = {}) => req("POST", `/conversations/${conv}/messages`, { token: u.token, body: { text, ...extra } });
const hist = (u, conv, q = "") => req("GET", `/conversations/${conv}/messages?limit=200${q}`, { token: u.token });
const listen = (u) => new Promise((resolve) => {
  const got = [];
  const ws = new WebSocket(`ws://127.0.0.1:9300/ws?token=${u.token}`);
  ws.on("message", (d) => got.push(JSON.parse(d.toString())));
  ws.on("error", () => {});
  ws.on("open", () => resolve({ got, ws, close: () => ws.close(), text: () => JSON.stringify(got) }));
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const members = async (u, conv) => (await req("GET", `/conversations/${conv}/members`, { token: u.token }));

const alice = await human("alice"), bob = await human("bob"), eve = await human("eve"), late = await human("late");
const aA = await agent("aA", alice), aB = await agent("aB", bob);

// ───── R6: owner leaves, agent stays
{
  const G = await room("agentGroup", "g", [{ id: aA.id }, { id: aB.id }]);
  const before = (await members(alice, G)).json.members;
  const leave = await req("POST", `/conversations/${G}/leave`, { token: alice.token });
  const after = (await members(bob, G)).json.members;
  const agentSays = await say(aA, G, `secret-after-owner-left-${rid}`);
  const ownerRead = await hist(alice, G);
  const ownerSync = await req("GET", "/sync", { token: alice.token });
  out("R6 owner leaves, agent stays", {
    before: before.length, leave: s(leave),
    agentStillMember: after.some((m) => m.id === aA.id), ownerStillMember: after.some((m) => m.id === alice.id),
    agentSays: s(agentSays), ownerRead: s(ownerRead), ownerSyncHasConv: ownerSync.text.includes(G),
  });
  // owner can still read through a self-minted agent token
  const minted = await req("POST", `/agents/${aA.id}/token`, { token: alice.token });
  const viaAgent = await req("GET", `/conversations/${G}/messages`, { token: minted.json.token });
  out("R6b departed owner reads via self-minted agent token", { mint: s(minted), read: s(viaAgent), n: viaAgent.json?.messages?.length });
  // owner cannot come back without approval
  out("R6c owner rejoin", s(await req("POST", `/conversations/${G}/join`, { token: alice.token })));
}

// ───── main room for the rest
const R = await room("group", "r", [{ id: alice.id }, { id: bob.id }]);
const old1 = await say(alice, R, `old-secret-${rid}`);
const upOld = await req("POST", `/conversations/${R}/attachments?name=oldfile-${rid}`, { token: alice.token, raw: Buffer.from("OLDDATA") });
const oldFileMsg = await say(alice, R, "", { kind: "file", attachment_id: upOld.json.id });
const OLD = [`old-secret-${rid}`, `oldfile-${rid}`, upOld.json.id, "OLDDATA"];
const leak = (t) => OLD.filter((x) => t.includes(x));

// ───── R1 outsider probing + enumeration
{
  const fake = "c_0000000000000000";
  const r = {};
  for (const [k, c] of [["real", R], ["fake", fake]]) {
    r[k] = {
      list: s(await hist(eve, c)), single: s(await req("GET", `/conversations/${c}/messages/1`, { token: eve.token })),
      members: s(await members(eve, c)), search: s(await req("GET", `/conversations/${c}/search?q=old`, { token: eve.token })),
      post: s(await say(eve, c, "x")), upload: s(await req("POST", `/conversations/${c}/attachments`, { token: eve.token, raw: Buffer.from("x") })),
      join: s(await req("POST", `/conversations/${c}/join`, { token: eve.token })), invite: s(await req("POST", `/conversations/${c}/invite`, { token: eve.token, body: { principal: eve.id } })),
      inviteOther: s(await req("POST", `/conversations/${c}/invite`, { token: eve.token, body: { principal: late.id } })),
      read: s(await req("POST", `/conversations/${c}/read`, { token: eve.token, body: { seq: 5 } })), leave: s(await req("POST", `/conversations/${c}/leave`, { token: eve.token })),
    };
  }
  out("R1 outsider real vs fake conv (enumeration)", r);
  out("R1 identical?", JSON.stringify(r.real) === JSON.stringify(r.fake));
  out("R1 attachment by outsider / no token / bad token", [s(await req("GET", `/attachments/${upOld.json.id}`, { token: eve.token })), s(await req("GET", `/attachments/${upOld.json.id}`)), s(await req("GET", `/attachments/${upOld.json.id}`, { token: "x" }))]);
  // path tricks
  const tricks = [`/conversations/${R}%2Fmessages`, `/conversations/${R}/messages/`, `/conversations/${R}/../${R}/messages`, `/conversations/${encodeURIComponent(R + "' or '1'='1")}/messages`, `/conversations/%25/messages`, `/Conversations/${R}/messages`, `/conversations/${R}/messages/1%20or%201=1`, `/conversations/${R}/messages/0x1`, `/attachments/${upOld.json.id}%00`, `/attachments/%25`];
  const tr = {};
  for (const t of tricks) { const x = await req("GET", t, { token: eve.token }); tr[t.replace(R, "R")] = s(x) + (leak(x.text).length ? " LEAK" : ""); }
  out("R1 path tricks (outsider)", tr);
  // sync leaks
  const c1 = (await req("GET", "/sync", { token: eve.token })).json;
  await say(alice, R, `activity-${rid}`); await say(bob, R, `activity2-${rid}`);
  const c2 = (await req("GET", "/sync", { token: eve.token })).json;
  out("Global cursor leak to an outsider (cursor before/after 2 msgs in a room they are not in)", { before: c1.cursor, after: c2.cursor, convs: c2.conversations.length, msgs: c2.messages.length });
  const odd = {};
  for (const q of ["-1", "-999999", "0.5", "abc", "1e400", "NaN", "1;drop table messages", "9007199254740993", "1&since=0", "%00", "[]"]) { const x = await req("GET", `/sync?since=${q}`, { token: eve.token }); odd[q] = s(x) + ` msgs=${x.json?.messages?.length}` + (leak(x.text).length ? " LEAK" : ""); }
  out("sync odd since (outsider)", odd);
}

// ───── R7 admin
{
  const r = {};
  for (const p of ["principals", "conversations", "freeze", "approve", "remove", "notice", "agent-token"]) {
    r[p] = [
      s(await req("POST", `/admin/${p}`, { token: eve.token, body: { conv: R, principal: eve.id, agent: aB.id } })),
      s(await req("POST", `/admin/${p}`, { token: eve.token, headers: { "x-admin": "" }, body: {} })),
      s(await req("POST", `/admin/${p}`, { headers: { "x-admin": eve.token }, body: {} })),
      s(await req("POST", `/admin/${p}`, { headers: { "x-admin": "undefined" }, body: {} })),
      s(await req("POST", `/admin/${p}?x-admin=1`, { token: eve.token, headers: { "X-Admin": "null" }, body: {} })),
    ].join(" | ");
  }
  out("R7 admin with ordinary tokens", r);
}

// ───── R4 join gating
{
  const r = {};
  r.memberInvitesUnapproved = s(await req("POST", `/conversations/${R}/invite`, { token: alice.token, body: { principal: eve.id } }));
  r.arrayPrincipal = s(await req("POST", `/conversations/${R}/invite`, { token: alice.token, body: { principal: [eve.id] } }));
  r.nullBody = s(await req("POST", `/conversations/${R}/invite`, { token: alice.token, raw: "null", headers: { "content-type": "application/json" } }));
  await svc("/admin/approve", { conv: R, principal: late.id });
  r.eveUsesLatesApprovalForSelf = s(await req("POST", `/conversations/${R}/join`, { token: eve.token }));
  r.eveBurnsLatesApproval = s(await req("POST", `/conversations/${R}/invite`, { token: eve.token, body: { principal: late.id } }));
  // approval concurrency: 10 parallel joins -> exactly one join message?
  const par = await Promise.all(Array.from({ length: 10 }, () => req("POST", `/conversations/${R}/join`, { token: late.token })));
  r.parallelJoin = par.map(s).join(",");
  const mem = (await members(alice, R)).json.members.filter((m) => m.id === late.id).length;
  r.lateMembershipRows = mem;
  r.secondUse = s(await req("POST", `/conversations/${R}/join`, { token: late.token }));
  out("R4 join gating", r);
  // stale approval surviving a removal
  await svc("/admin/approve", { conv: R, principal: eve.id }); // approved, never used
  await svc("/admin/remove", { conv: R, principal: eve.id }); // "ban" (no-op, eve isn't a member)
  const stale = await req("POST", `/conversations/${R}/join`, { token: eve.token });
  out("R4b approval granted, then admin/remove, then join (approval not revoked by removal)", s(stale));
  await svc("/admin/remove", { conv: R, principal: eve.id });
}

// ───── R2 history for late joiner
{
  const oldSeq = old1.json.seq, fileSeq = oldFileMsg.json.seq;
  await say(alice, R, `new-${rid}`);
  const r = {};
  const probes = {
    list: `/conversations/${R}/messages?limit=200`, before: `/conversations/${R}/messages?before=${fileSeq + 1}`, beforeNeg: `/conversations/${R}/messages?before=-1`,
    limitBig: `/conversations/${R}/messages?limit=999999999`, limitNeg: `/conversations/${R}/messages?limit=-1`, limitNaN: `/conversations/${R}/messages?limit=abc`, limitFrac: `/conversations/${R}/messages?limit=1.5`,
    beforeNaN: `/conversations/${R}/messages?before=abc`, beforeInf: `/conversations/${R}/messages?before=1e999`,
    single: `/conversations/${R}/messages/${oldSeq}`, singleFile: `/conversations/${R}/messages/${fileSeq}`, singleNaN: `/conversations/${R}/messages/abc`, singleNeg: `/conversations/${R}/messages/-1`, singleFloat: `/conversations/${R}/messages/${oldSeq}.0`, singleHuge: `/conversations/${R}/messages/99999999999999999999999`,
    search: `/conversations/${R}/search?q=old`, searchEmpty: `/conversations/${R}/search`, searchPct: `/conversations/${R}/search?q=%25`, searchUnderscore: `/conversations/${R}/search?q=_`, searchBackslash: `/conversations/${R}/search?q=%5C`, searchFile: `/conversations/${R}/search?q=oldfile`,
    sync: `/sync`, sync1: `/sync?since=1`, syncNeg: `/sync?since=-5`, att: `/attachments/${upOld.json.id}`,
  };
  for (const [k, p] of Object.entries(probes)) { const x = await req("GET", p, { token: late.token }); r[k] = s(x) + (leak(x.text).length ? ` LEAK ${leak(x.text)}` : ""); }
  r.replyOld = s(await say(late, R, "q", { reply_to: oldSeq }));
  r.replyArr = s(await say(late, R, "q", { reply_to: [oldSeq] }));
  r.replyStr = s(await say(late, R, "q", { reply_to: `${oldSeq}` }));
  r.replyNaN = s(await say(late, R, "q", { reply_to: "abc" }));
  r.replyObj = s(await say(late, R, "q", { reply_to: {} }));
  r.replyFalse = s(await say(late, R, "q", { reply_to: false }));
  r.attachOthersOld = s(await say(late, R, "", { kind: "file", attachment_id: upOld.json.id }));
  r.attachArr = s(await say(late, R, "", { kind: "file", attachment_id: [upOld.json.id] }));
  r.attachObj = s(await say(late, R, "", { kind: "file", attachment_id: { id: upOld.json.id } }));
  r.attachMissing = s(await say(late, R, "", { kind: "file" }));
  r.textWithAttField = await (async () => { const m = await say(late, R, "t", { attachment_id: upOld.json.id, body: { attachment_id: upOld.json.id } }); return s(m) + " body=" + JSON.stringify(m.json?.body); })();
  r.attAfterTextTrick = s(await req("GET", `/attachments/${upOld.json.id}`, { token: late.token }));
  const sync = (await req("GET", "/sync", { token: late.token })).json;
  const cv = sync.conversations.find((c) => c.id === R);
  r.syncMeta = { last_seq: cv.last_seq, unread: cv.unread, firstVisibleSeq: Math.min(...sync.messages.filter((m) => m.conv_id === R).map((m) => m.seq)) };
  r.readHuge = s(await req("POST", `/conversations/${R}/read`, { token: late.token, body: { seq: 1e30 } }));
  r.readNeg = s(await req("POST", `/conversations/${R}/read`, { token: late.token, body: { seq: -5 } }));
  r.readStr = s(await req("POST", `/conversations/${R}/read`, { token: late.token, body: { seq: "abc" } }));
  r.readFrac = s(await req("POST", `/conversations/${R}/read`, { token: late.token, body: { seq: 1.5 } }));
  out("R2 late joiner probes", r);

  // remove, gap, re-add
  const ws = await listen(late);
  await svc("/admin/remove", { conv: R, principal: late.id });
  await say(alice, R, `gap-${rid}`);
  const upGap = await req("POST", `/conversations/${R}/attachments?name=gapfile-${rid}`, { token: alice.token, raw: Buffer.from("GAPDATA") });
  await say(alice, R, "", { kind: "file", attachment_id: upGap.json.id });
  await sleep(200);
  const gone = { wsGotGap: ws.text().includes(`gap-${rid}`), wsEvents: ws.got.map((e) => e.type + (e.message ? ":" + e.message.seq : "")).join(","), list: s(await hist(late, R)), post: s(await say(late, R, "ghost")), upload: s(await req("POST", `/conversations/${R}/attachments`, { token: late.token, raw: Buffer.from("x") })), read: s(await req("POST", `/conversations/${R}/read`, { token: late.token, body: { seq: 999 } })) };
  await svc("/admin/approve", { conv: R, principal: late.id });
  await req("POST", `/conversations/${R}/join`, { token: late.token });
  await say(alice, R, `after-${rid}`);
  await sleep(200);
  const G2 = [`gap-${rid}`, `gapfile-${rid}`, `new-${rid}`, ...OLD];
  const back = {};
  for (const [k, p] of Object.entries({ list: `/conversations/${R}/messages?limit=200`, sync: "/sync", sync1: "/sync?since=1", search: `/conversations/${R}/search?q=`, att: `/attachments/${upGap.json.id}` })) { const x = await req("GET", p, { token: late.token }); back[k] = s(x) + " leaked=" + JSON.stringify(G2.filter((g) => x.text.includes(g))); }
  back.wsAfter = ws.text().includes(`after-${rid}`);
  back.wsLeak = G2.filter((g) => ws.text().includes(g) && g !== `new-${rid}`);
  ws.close();
  out("R2b removed + re-added", { gone, back });
}

// ───── WS: socket opened before joining
{
  const ws = await listen(eve);
  await say(alice, R, `prejoin-${rid}`);
  await sleep(150);
  const pre = ws.text().includes(`prejoin-${rid}`);
  ws.close();
  const badWs = await new Promise((res) => { const w = new WebSocket("ws://127.0.0.1:9300/ws?token=nope"); w.on("open", () => res("OPEN")); w.on("error", (e) => res("refused: " + e.message)); });
  const noTok = await new Promise((res) => { const w = new WebSocket("ws://127.0.0.1:9300/anything"); w.on("open", () => res("OPEN")); w.on("error", (e) => res("refused: " + e.message)); });
  out("WS non-member socket receives pushes? / bad token / no token", { pre, badWs, noTok });
}

// ───── R5 identity
{
  const r = {};
  const spoof = await say(alice, R, "spoof", { sender_id: bob.id, sender: bob.id, kind: "system", conv_id: "x", seq: 1, gid: 1, created_at: "2000-01-01" });
  r.spoof = { sender: spoof.json.sender_id === alice.id ? "caller" : spoof.json.sender_id, kind: spoof.json.kind };
  r.agentLogin = s(await req("POST", "/login", { body: { handle: aA.handle, password: "" } }));
  r.agentLoginNoPw = s(await req("POST", "/login", { body: { handle: aA.handle } }));
  r.loginArr = s(await req("POST", "/login", { body: { handle: [alice.handle], password: [alice.password] } }));
  r.loginObj = s(await req("POST", "/login", { body: { handle: { $ne: 1 }, password: { $ne: 1 } } }));
  r.loginSqli = s(await req("POST", "/login", { body: { handle: `${alice.handle}' or '1'='1`, password: "x" } }));
  r.loginNull = s(await req("POST", "/login", { raw: "null" }));
  r.loginNul = s(await req("POST", "/login", { body: { handle: "a\u0000b", password: "x" } }));
  r.loginBadJson = s(await req("POST", "/login", { raw: "{" }));
  r.mintOther = s(await req("POST", `/agents/${aB.id}/token`, { token: alice.token }));
  r.agentMintSelf = s(await req("POST", `/agents/${aA.id}/token`, { token: aA.token }));
  r.agentMintOther = s(await req("POST", `/agents/${aB.id}/token`, { token: aA.token }));
  r.mintHuman = s(await req("POST", `/agents/${bob.id}/token`, { token: alice.token }));
  r.mintSelfHuman = s(await req("POST", `/agents/${alice.id}/token`, { token: alice.token }));
  r.mintFake = s(await req("POST", `/agents/a_0000000000000000/token`, { token: alice.token }));
  r.agentReadsOwnersRoom = s(await hist(aA, R));
  r.agentSync = (await req("GET", "/sync", { token: aA.token })).json.conversations.length;
  r.tokenVariants = [s(await req("GET", "/sync", { headers: { authorization: `bearer ${alice.token}` } })), s(await req("GET", "/sync", { headers: { authorization: `Bearer  ${alice.token}` } })), s(await req("GET", "/sync", { headers: { authorization: "Bearer " } })), s(await req("GET", `/sync?token=${alice.token}`))].join(" | ");
  out("R5 identity", r);

  // login timing: existing human vs unknown vs agent handle
  const time = async (handle) => { const ts = []; for (let i = 0; i < 12; i++) ts.push((await req("POST", "/login", { body: { handle, password: "wrong" } })).ms); ts.sort((a, b) => a - b); return +ts[6].toFixed(1); };
  out("login timing median ms (existing / unknown / agent handle)", { existing: await time(alice.handle), unknown: await time(`nobody_${rid}`), agent: await time(aA.handle) });
}

// ───── client_txn
{
  const R2 = await room("group", "r2", [{ id: alice.id }, { id: bob.id }]);
  const r = {};
  const a1 = await say(alice, R, `txn-A-${rid}`, { client_txn: `T-${rid}` });
  const bobSame = await say(bob, R, `txn-B-${rid}`, { client_txn: `T-${rid}` });
  r.otherUserSameTxn = { status: s(bobSame), gotOwn: bobSame.json?.body?.text === `txn-B-${rid}` };
  const cross = await say(alice, R2, `different-text-in-R2-${rid}`, { client_txn: `T-${rid}` });
  const inR2 = (await hist(bob, R2)).text.includes(`different-text-in-R2-${rid}`);
  r.sameTxnOtherConv = { status: s(cross), returnedConvIsR: cross.json?.conv_id === R, returnedText: cross.json?.body?.text, storedInR2: inR2 };
  r.types = {};
  for (const [k, v] of Object.entries({ num: 12345, obj: { a: 1 }, arr: ["x"], bool: true, nul: "a\u0000b", long: "x".repeat(100000) })) { const x = await say(alice, R, `t-${k}`, { client_txn: v }); const y = await say(alice, R, `t-${k}-again`, { client_txn: v }); r.types[k] = `${s(x)} / replay ${s(y)} sameSeq=${x.json?.seq === y.json?.seq}`; }
  // frozen replay
  await svc("/admin/freeze", { conv: R, frozen: true });
  r.frozenReplay = s(await say(alice, R, `txn-A-${rid}`, { client_txn: `T-${rid}` }));
  r.frozenReplayViaOtherConv = await (async () => { const x = await say(alice, R2, "zzz", { client_txn: `T-${rid}` }); return s(x) + " text=" + x.json?.body?.text; })();
  // freeze probes
  const f = {};
  f.post = s(await say(alice, R, "frozen"));
  f.file = s(await say(alice, R, "", { kind: "file", attachment_id: upOld.json.id }));
  f.upload = s(await req("POST", `/conversations/${R}/attachments`, { token: alice.token, raw: Buffer.from("x") }));
  f.frozenFieldSpoof = s(await say(alice, R, "x", { frozen: false, kind: "system" }));
  const seqBefore = (await req("GET", "/sync", { token: alice.token })).json.conversations.find((c) => c.id === R).last_seq;
  f.leave = s(await req("POST", `/conversations/${R}/leave`, { token: bob.token }));
  const after = (await req("GET", "/sync", { token: alice.token })).json;
  const cv = after.conversations.find((c) => c.id === R);
  f.leaveWroteMessageIntoFrozenConv = { seqBefore, seqAfter: cv.last_seq, last: after.messages.filter((m) => m.conv_id === R).at(-1)?.body };
  await svc("/admin/freeze", { conv: R, frozen: false });
  out("client_txn + freeze", { r, f });

  // upload that straddles the freeze: headers sent before freeze, body finished after
  const result = await new Promise((resolve) => {
    const rq = http.request(`${BASE}/conversations/${R}/attachments?name=straddle`, { method: "POST", headers: { authorization: `Bearer ${alice.token}`, "content-type": "application/octet-stream", "transfer-encoding": "chunked" } }, (res) => { let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve({ status: res.statusCode, body: d })); });
    rq.on("error", (e) => resolve({ error: e.message }));
    rq.write("part1");
    setTimeout(async () => { await svc("/admin/freeze", { conv: R, frozen: true }); const chk = await req("POST", `/conversations/${R}/attachments`, { token: alice.token, raw: Buffer.from("x") }); console.log("   (fresh upload while frozen:", s(chk), ")"); rq.end("part2"); }, 300);
  });
  out("Upload begun before freeze, completed after freeze", result);
  await svc("/admin/freeze", { conv: R, frozen: false });

  // same for removal: upload begun as member, finished after removal
  await svc("/admin/approve", { conv: R, principal: bob.id });
  await req("POST", `/conversations/${R}/join`, { token: bob.token });
}

// ───── attachments cross conversation
{
  const X = await room("group", "x", [{ id: alice.id }, { id: eve.id }]);
  const r = {};
  const upX = await req("POST", `/conversations/${X}/attachments?name=inX`, { token: alice.token, raw: Buffer.from("XDATA"), headers: { "content-type": "text/html" } });
  r.attachXinR = s(await say(alice, R, "", { kind: "file", attachment_id: upX.json.id }));
  r.unsentReadByUploader = s(await req("GET", `/attachments/${upX.json.id}`, { token: alice.token }));
  const upBob = await req("POST", `/conversations/${R}/attachments?name=bobs`, { token: bob.token, raw: Buffer.from("BOB") });
  r.aliceAttachesBobsUpload = s(await say(alice, R, "", { kind: "file", attachment_id: upBob.json.id }));
  await say(alice, X, "", { kind: "file", attachment_id: upX.json.id });
  const got = await req("GET", `/attachments/${upX.json.id}`, { token: eve.token });
  r.htmlMimeServedBack = `${s(got)} content-type=${got.ct}`;
  r.bobReadsX = s(await req("GET", `/attachments/${upX.json.id}`, { token: bob.token }));
  // late re-added: can the uploader re-send an old attachment so that late sees it? (uploader's choice - expected yes)
  r.uploadNoBody = s(await req("POST", `/conversations/${R}/attachments`, { token: alice.token }));
  r.uploadNameTraversal = s(await req("POST", `/conversations/${R}/attachments?name=..%2F..%2Fetc%2Fpasswd`, { token: alice.token, raw: Buffer.from("x") }));
  out("attachments", r);
}

// ───── misc 500 hunting
{
  const r = {};
  const bodies = { null: "null", number: "5", string: '"x"', array: "[]", deep: "[".repeat(5000) + "]".repeat(5000), proto: '{"__proto__":{"frozen":false},"text":"p"}', nulText: JSON.stringify({ text: "a\u0000b" }), loneSurrogate: '{"text":"\\ud800"}', empty: "", textObj: JSON.stringify({ text: { toString: 1 } }), textArr: JSON.stringify({ text: ["a", "b"] }), huge: JSON.stringify({ text: "x".repeat(2_000_000) }) };
  for (const [k, raw] of Object.entries(bodies)) { const x = await req("POST", `/conversations/${R}/messages`, { token: alice.token, raw, headers: { "content-type": "application/json" } }); r[k] = s(x); }
  for (const m of ["PUT", "DELETE", "PATCH"]) r[m] = s(await req(m, `/conversations/${R}/messages`, { token: alice.token }));
  r.head = (await fetch(`${BASE}/sync`, { method: "HEAD", headers: { authorization: `Bearer ${alice.token}` } })).status;
  r.options = (await fetch(`${BASE}/admin/freeze`, { method: "OPTIONS" })).status;
  out("malformed bodies / methods", r);
  out("alive?", s(await req("GET", "/sync", { token: alice.token })));
}
process.exit(0);
