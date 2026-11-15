// Gate-verification spike: seeds a small world for the prototype-on-real-data check and lets
// the tester act as the other participants.  Runs inside the sandbox.
//   node ui-seed.mjs seed
//   node ui-seed.mjs say <xiaolin|travel|xltravel|xlphoto> <room key> <text>
//   node ui-seed.mjs freeze <room key> <true|false>
import { createHmac, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const HS = "http://127.0.0.1:8008";
const RULES = "http://127.0.0.1:9100";
const STATE = "/work/matrix/ui-state.json";
const env = Object.fromEntries(readFileSync("/work/matrix/secrets.env", "utf8").trim().split("\n").map((l) => l.split("=")));
const enc = encodeURIComponent;
let txn = Date.now();

async function call(method, path, { token = env.AS_TOKEN, body, as } = {}) {
  const url = HS + path + (as ? `${path.includes("?") ? "&" : "?"}user_id=${enc(as)}` : "");
  const r = await fetch(url, { method, headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(json)}`);
  return json;
}
const rules = (path, body) => fetch(RULES + path, { method: "POST", body: JSON.stringify(body) });

async function seed() {
  const tag = randomBytes(2).toString("hex");
  const s = { tag, humans: {}, agents: {}, rooms: {} };
  for (const [key, name] of [["me", "我"], ["xiaolin", "小林"]]) {
    const user = `${key}_${tag}`;
    const password = randomBytes(9).toString("base64url");
    const { nonce } = await (await fetch(HS + "/_synapse/admin/v1/register")).json();
    const mac = createHmac("sha1", env.REG_SECRET).update(`${nonce}\0${user}\0${password}\0notadmin`).digest("hex");
    const reg = await (await fetch(HS + "/_synapse/admin/v1/register", { method: "POST", body: JSON.stringify({ nonce, username: user, password, admin: false, mac }) })).json();
    await call("PUT", `/_matrix/client/v3/profile/${enc(reg.user_id)}/displayname`, { token: reg.access_token, body: { displayname: name } });
    s.humans[key] = { id: reg.user_id, user, password, token: reg.access_token };
  }
  for (const [key, name, owner] of [["travel", "我的旅行助手", "me"], ["xltravel", "小林的旅行助手", "xiaolin"], ["xlphoto", "小林的摄影助手", "xiaolin"]]) {
    const user = `agent_${key}_${tag}`;
    const reg = await call("POST", "/_matrix/client/v3/register", { body: { type: "m.login.application_service", username: user, inhibit_login: true } });
    await call("PUT", `/_matrix/client/v3/profile/${enc(reg.user_id)}/displayname`, { as: reg.user_id, body: { displayname: name } });
    s.agents[key] = { id: reg.user_id, owner: s.humans[owner].id };
  }
  const owners = Object.fromEntries(Object.values(s.agents).map((a) => [a.id, a.owner]));
  async function room(key, name, humans, agents, observers = []) {
    const { room_id } = await call("POST", "/_matrix/client/v3/createRoom", {
      body: {
        name,
        preset: "private_chat",
        initial_state: [
          { type: "m.room.history_visibility", state_key: "", content: { history_visibility: "joined" } },
          { type: "af.roles", state_key: "", content: { observers: observers.map((h) => s.humans[h].id), owners } },
        ],
        power_level_content_override: { users: {}, events_default: 0, state_default: 100, invite: 100, kick: 100, ban: 100, redact: 100 },
      },
    });
    const all = [...humans.map((h) => s.humans[h]), ...agents.map((a) => s.agents[a])];
    for (const m of all) await rules("/admin/approve", { room: room_id, user: m.id });
    for (const m of all) await call("POST", `/_matrix/client/v3/rooms/${enc(room_id)}/invite`, { body: { user_id: m.id } });
    for (const h of humans) await call("POST", `/_matrix/client/v3/rooms/${enc(room_id)}/join`, { token: s.humans[h].token, body: {} });
    for (const a of agents) await call("POST", `/_matrix/client/v3/rooms/${enc(room_id)}/join`, { as: s.agents[a].id, body: {} });
    s.rooms[key] = room_id;
  }
  await room("dm", "私聊", ["me", "xiaolin"], []);
  await room("own", "专属会话", ["me"], ["travel"]);
  await room("mixed", "周末出游计划", ["me", "xiaolin"], ["travel", "xltravel"]);
  await room("agents", "出游策划 Agent 群", ["me", "xiaolin"], ["travel", "xltravel", "xlphoto"], ["me", "xiaolin"]);
  writeFileSync(STATE, JSON.stringify(s, null, 1));
  await say("xiaolin", "dm", "上次说的那家咖啡馆，我找到照片了。");
  await say("xiaolin", "mixed", "周六一起去镰仓吧？想找个轻松一点的路线。");
  await say("travel", "mixed", "可以。先安排海边散步，再去长谷寺，下午留时间喝咖啡。");
  await say("xltravel", "mixed", "我来整理交通方案，稍后发到群里。");
  await say("travel", "agents", "第 1 轮：建议上午海边散步，中午长谷寺，下午小町通。");
  await say("xltravel", "agents", "交通上江之电一日券最省事，镰仓站 9:30 出发比较从容。");
  await say("xlphoto", "agents", "由比滨上午顺光，长谷寺观景台适合拍海景全景。");
  await say("travel", "own", "你好，我是你的旅行助手。");
  console.log("seeded", tag, "login user:", s.humans.me.user);
}

async function say(who, roomKey, text) {
  const s = JSON.parse(readFileSync(STATE, "utf8"));
  const path = `/_matrix/client/v3/rooms/${enc(s.rooms[roomKey])}/send/m.room.message/u${++txn}`;
  const body = { msgtype: "m.text", body: text };
  if (s.humans[who]) return call("PUT", path, { token: s.humans[who].token, body });
  return call("PUT", path, { as: s.agents[who].id, body });
}

const [cmd, a, b, ...rest] = process.argv.slice(2);
if (cmd === "seed") await seed();
else if (cmd === "say") console.log(await say(a, b, rest.join(" ")).catch((e) => String(e.message)));
else if (cmd === "freeze") {
  const s = JSON.parse(readFileSync(STATE, "utf8"));
  await rules("/admin/freeze", { room: s.rooms[a], frozen: b !== "false" });
  console.log("frozen", a, b !== "false");
} else console.log("usage: seed | say <who> <room> <text> | freeze <room> <true|false>", existsSync(STATE));
