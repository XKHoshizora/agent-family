// Gate-verification spike: seeds a small world on the self-built core for the UI check and
// lets the tester act as the other participants.
//   node ui-seed.mjs <state file> seed
//   node ui-seed.mjs <state file> say <xiaolin|travel|xltravel|xlphoto> <room key> <text>
//   node ui-seed.mjs <state file> freeze <room key> <true|false>
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const BASE = process.env.CORE_URL || "http://127.0.0.1:9300";
const ADMIN = process.env.CORE_ADMIN_SECRET;
const [STATE, cmd, a, b, ...rest] = process.argv.slice(2);
const post = async (path, body, token) => {
  const r = await fetch(BASE + path, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : { "x-admin": ADMIN }) }, body: JSON.stringify(body) });
  const json = await r.json();
  if (!r.ok) throw new Error(`${path} -> ${r.status} ${JSON.stringify(json)}`);
  return json;
};
const load = () => JSON.parse(readFileSync(STATE, "utf8"));
async function say(who, room, text) {
  const s = load();
  return post(`/conversations/${s.rooms[room]}/messages`, { text }, s.tokens[who]);
}

if (cmd === "seed") {
  const tag = randomBytes(2).toString("hex");
  const s = { tag, ids: {}, tokens: {}, rooms: {}, login: {} };
  for (const [key, name] of [["me", "我"], ["xiaolin", "小林"]]) {
    const handle = `${key}_${tag}`;
    const password = randomBytes(9).toString("base64url");
    s.ids[key] = (await post("/admin/principals", { kind: "human", handle, name, password })).id;
    s.tokens[key] = (await post("/login", { handle, password }, "none")).token;
    if (key === "me") s.login = { handle, password };
  }
  for (const [key, name, owner] of [["travel", "我的旅行助手", "me"], ["xltravel", "小林的旅行助手", "xiaolin"], ["xlphoto", "小林的摄影助手", "xiaolin"]]) {
    s.ids[key] = (await post("/admin/principals", { kind: "agent", handle: `agent_${key}_${tag}`, name, owner: s.ids[owner] })).id;
    s.tokens[key] = (await post("/admin/agent-token", { agent: s.ids[key] })).token;
  }
  const room = async (key, type, title, members) => (s.rooms[key] = (await post("/admin/conversations", { type, title, members: members.map((m) => ({ id: s.ids[m] })) })).id);
  await room("dm", "human", null, ["me", "xiaolin"]);
  await room("own", "agent", null, ["me", "travel"]);
  await room("mixed", "mixed", "周末出游计划", ["me", "xiaolin", "travel", "xltravel"]);
  await room("agents", "agentGroup", "出游策划 Agent 群", ["travel", "xltravel", "xlphoto"]); // owners are attached by the core
  writeFileSync(STATE, JSON.stringify(s, null, 1));
  await say("xiaolin", "dm", "上次说的那家咖啡馆，我找到照片了。");
  await say("xiaolin", "mixed", "周六一起去镰仓吧？想找个轻松一点的路线。");
  await say("travel", "mixed", "可以。先安排海边散步，再去长谷寺，下午留时间喝咖啡。");
  await say("xltravel", "mixed", "我来整理交通方案，稍后发到群里。");
  await say("travel", "agents", "第 1 轮：建议上午海边散步，中午长谷寺，下午小町通。");
  await say("xltravel", "agents", "交通上江之电一日券最省事，镰仓站 9:30 出发比较从容。");
  await say("xlphoto", "agents", "由比滨上午顺光，长谷寺观景台适合拍海景全景。");
  await say("travel", "own", "你好，我是你的旅行助手。");
  console.log("seeded; login handle:", s.login.handle);
} else if (cmd === "say") console.log((await say(a, b, rest.join(" ")).catch((e) => ({ error: e.message }))).seq ?? "rejected");
else if (cmd === "freeze") {
  await post("/admin/freeze", { conv: load().rooms[a], frozen: b !== "false" });
  console.log("frozen", a, b !== "false");
}
