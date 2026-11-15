// Gate-verification spike, candidate C: a self-built message core.
// One process, one Postgres database (PGlite here so nothing has to be installed).
// Every rule check and the write it guards run in the same transaction.
// Throwaway code for the base-selection gate. Not product code.
import http from "node:http";
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT || 9300);
const ADMIN = process.env.CORE_ADMIN_SECRET;
if (!ADMIN) throw new Error("CORE_ADMIN_SECRET is required");

const db = new PGlite();
await db.exec(`
  create table principals(
    id text primary key, kind text not null check (kind in ('human','agent')),
    handle text unique not null, name text not null,
    owner_id text references principals(id), pass_hash text);
  create table tokens(hash text primary key, principal_id text not null references principals(id));
  create table conversations(
    id text primary key, type text not null, title text,
    frozen boolean not null default false, seq bigint not null default 0);
  create table memberships(
    conv_id text not null references conversations(id), principal_id text not null references principals(id),
    role text not null check (role in ('speaker','observer')),
    joined_seq bigint not null, left_seq bigint, read_seq bigint not null default 0,
    primary key (conv_id, principal_id, joined_seq));
  create table approvals(conv_id text not null, principal_id text not null, primary key (conv_id, principal_id));
  create table messages(
    gid bigserial primary key, conv_id text not null references conversations(id), seq bigint not null,
    sender_id text references principals(id), kind text not null, body jsonb not null,
    client_txn text, created_at timestamptz not null default now(),
    unique (conv_id, seq), unique (sender_id, client_txn));
  create table attachments(
    id text primary key, conv_id text not null references conversations(id),
    uploader_id text not null references principals(id), name text, mime text, data bytea not null);
`);

const id = (p) => `${p}_${randomBytes(8).toString("hex")}`;
const sha = (s) => createHash("sha256").update(s).digest("hex");
const hashPass = (pw) => {
  const salt = randomBytes(16);
  return `${salt.toString("hex")}:${scryptSync(pw, salt, 32).toString("hex")}`;
};
const checkPass = (pw, stored) => {
  const [salt, hash] = stored.split(":");
  return timingSafeEqual(scryptSync(pw, Buffer.from(salt, "hex"), 32), Buffer.from(hash, "hex"));
};
class Refuse extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}
const refuse = (status, code) => {
  throw new Refuse(status, code);
};

async function issueToken(q, principalId) {
  const token = randomBytes(24).toString("base64url");
  await q.query("insert into tokens values ($1,$2)", [sha(token), principalId]);
  return token;
}

// ───────────────────────── rules + writes (always inside one transaction)
const currentMember = async (tx, conv, pid) =>
  (await tx.query("select * from memberships where conv_id=$1 and principal_id=$2 and left_seq is null", [conv, pid])).rows[0];

async function appendMessage(tx, conv, sender, kind, body, clientTxn = null) {
  const { rows } = await tx.query("update conversations set seq = seq + 1 where id=$1 returning seq", [conv]);
  const ins = await tx.query(
    "insert into messages(conv_id, seq, sender_id, kind, body, client_txn) values ($1,$2,$3,$4,$5,$6) returning gid, conv_id, seq, sender_id, kind, body, created_at",
    [conv, rows[0].seq, sender, kind, JSON.stringify(body), clientTxn],
  );
  return ins.rows[0];
}

async function addMember(tx, conv, pid, role) {
  const out = [];
  const p = (await tx.query("select * from principals where id=$1", [pid])).rows[0];
  if (!p) refuse(404, "no_such_principal");
  const existing = await currentMember(tx, conv, pid);
  if (existing) {
    if (existing.role === "observer" && role === "speaker")
      await tx.query("update memberships set role='speaker' where conv_id=$1 and principal_id=$2 and left_seq is null", [conv, pid]);
    return out;
  }
  // An Agent never enters a conversation without its owner being able to see it.
  if (p.kind === "agent") out.push(...(await addMember(tx, conv, p.owner_id, "observer")));
  const c = (await tx.query("select seq from conversations where id=$1 for update", [conv])).rows[0];
  await tx.query("insert into memberships(conv_id, principal_id, role, joined_seq, read_seq) values ($1,$2,$3,$4,$4)", [conv, pid, role, c.seq]);
  out.push(await appendMessage(tx, conv, null, "system", { text: `${p.name} 加入` }));
  return out;
}

async function removeMember(tx, conv, pid) {
  const m = await currentMember(tx, conv, pid);
  if (!m) return [];
  const p = (await tx.query("select * from principals where id=$1", [pid])).rows[0];
  const msg = await appendMessage(tx, conv, null, "system", { text: `${p.name} 离开` });
  await tx.query("update memberships set left_seq=$3 where conv_id=$1 and principal_id=$2 and left_seq is null", [conv, pid, msg.seq]);
  return [msg];
}

async function postMessage(tx, conv, sender, input) {
  const c = (await tx.query("select * from conversations where id=$1 for update", [conv])).rows[0];
  if (!c || !(await currentMember(tx, conv, sender))) refuse(403, "not_a_member");
  if (c.frozen) refuse(403, "frozen");
  if (input.client_txn) {
    const dup = (await tx.query("select gid, conv_id, seq, sender_id, kind, body, created_at from messages where sender_id=$1 and client_txn=$2", [sender, input.client_txn])).rows[0];
    if (dup) return { msg: dup, duplicate: true };
  }
  const kind = input.kind === "file" ? "file" : "text";
  const body = { text: String(input.text || "").slice(0, 8000) };
  if (kind === "file") {
    const a = (await tx.query("select id, name from attachments where id=$1 and conv_id=$2 and uploader_id=$3", [input.attachment_id, conv, sender])).rows[0];
    if (!a) refuse(400, "bad_attachment");
    body.attachment_id = a.id;
    body.text = body.text || a.name;
  }
  if (input.reply_to != null) {
    if (!(await visibleMessage(tx, conv, sender, Number(input.reply_to)))) refuse(400, "bad_reply_target");
    body.reply_to = Number(input.reply_to);
  }
  return { msg: await appendMessage(tx, conv, sender, kind, body, input.client_txn || null) };
}

// What a principal may read: only messages after the start of their CURRENT membership.
const VISIBLE = `join memberships vm on vm.conv_id = m.conv_id and vm.principal_id = $1 and vm.left_seq is null and m.seq > vm.joined_seq`;
const COLS = "m.gid, m.conv_id, m.seq, m.sender_id, m.kind, m.body, m.created_at";
const visibleMessage = async (q, conv, pid, seq) =>
  (await q.query(`select ${COLS} from messages m ${VISIBLE} where m.conv_id=$2 and m.seq=$3`, [pid, conv, seq])).rows[0];

// ───────────────────────── realtime
const sockets = new Map(); // principal id -> Set<ws>
async function broadcast(msgs) {
  for (const msg of msgs) {
    const { rows } = await db.query("select principal_id from memberships where conv_id=$1 and left_seq is null and joined_seq < $2", [msg.conv_id, msg.seq]);
    for (const r of rows) sockets.get(r.principal_id)?.forEach((ws) => ws.send(JSON.stringify({ type: "message", message: msg })));
  }
}
const poke = (pids) => pids.forEach((p) => sockets.get(p)?.forEach((ws) => ws.send(JSON.stringify({ type: "resync" }))));

// ───────────────────────── http plumbing
async function whoami(req) {
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Bearer ")) refuse(401, "missing_token");
  const row = (await db.query("select p.* from tokens t join principals p on p.id=t.principal_id where t.hash=$1", [sha(auth.slice(7))])).rows[0];
  return row || refuse(401, "bad_token");
}
function readBody(req, limit = 60 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on("data", (c) => ((n += c.length) > limit ? reject(new Refuse(413, "too_large")) : chunks.push(c)));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
const json = async (req) => JSON.parse((await readBody(req)).toString("utf8") || "{}");
const routes = [];
const route = (method, pattern, handler) => routes.push({ method, re: new RegExp(`^${pattern.replace(/:(\w+)/g, "(?<$1>[^/]+)")}$`), handler });

// ───────────────────────── service-side (admin) endpoints: what the product's own logic would call
const admin = (handler) => async (ctx) => {
  if (ctx.req.headers["x-admin"] !== ADMIN) refuse(403, "forbidden");
  return handler(ctx, await json(ctx.req));
};
route("POST", "/admin/principals", admin(async (_c, b) => {
  const pid = id(b.kind === "agent" ? "a" : "u");
  await db.query("insert into principals values ($1,$2,$3,$4,$5,$6)", [pid, b.kind, b.handle, b.name, b.owner || null, b.password ? hashPass(b.password) : null]);
  return { id: pid };
}));
route("POST", "/admin/conversations", admin(async (_c, b) => {
  const cid = id("c");
  const msgs = await db.transaction(async (tx) => {
    await tx.query("insert into conversations(id, type, title) values ($1,$2,$3)", [cid, b.type, b.title || null]);
    const out = [];
    for (const m of b.members) out.push(...(await addMember(tx, cid, m.id, m.role || "speaker")));
    return out;
  });
  await broadcast(msgs);
  return { id: cid };
}));
route("POST", "/admin/freeze", admin(async (_c, b) => {
  await db.query("update conversations set frozen=$2 where id=$1", [b.conv, b.frozen !== false]);
  return { ok: true };
}));
route("POST", "/admin/approve", admin(async (_c, b) => {
  await db.query("insert into approvals values ($1,$2) on conflict do nothing", [b.conv, b.principal]);
  return { ok: true };
}));
route("POST", "/admin/remove", admin(async (_c, b) => {
  await broadcast(await db.transaction((tx) => removeMember(tx, b.conv, b.principal)));
  poke([b.principal]);
  return { ok: true };
}));
route("POST", "/admin/notice", admin(async (_c, b) => {
  const msg = await db.transaction((tx) => appendMessage(tx, b.conv, null, "system", { text: b.text }));
  await broadcast([msg]);
  return { seq: msg.seq };
}));
route("POST", "/admin/agent-token", admin(async (_c, b) => ({ token: await issueToken(db, b.agent) })));

// ───────────────────────── endpoints reachable with an ordinary token
route("POST", "/login", async ({ req }) => {
  const b = await json(req);
  const p = (await db.query("select * from principals where handle=$1 and kind='human'", [String(b.handle || "")])).rows[0];
  if (!p || !p.pass_hash || !checkPass(String(b.password || ""), p.pass_hash)) refuse(403, "bad_credentials");
  return { id: p.id, token: await issueToken(db, p.id) };
});
// The Agent connection interface in its smallest form: an owner mints a credential for
// their own Agent; whoever holds it speaks as that Agent and nothing else.
route("POST", "/agents/:agent/token", async ({ req, params }) => {
  const me = await whoami(req);
  const a = (await db.query("select * from principals where id=$1 and kind='agent'", [params.agent])).rows[0];
  if (!a || a.owner_id !== me.id) refuse(403, "not_your_agent");
  return { token: await issueToken(db, a.id) };
});
route("GET", "/sync", async ({ req, url }) => {
  const me = await whoami(req);
  const since = Number(url.searchParams.get("since") || 0);
  const convs = (await db.query(
    `select c.id, c.type, c.title, c.frozen, c.seq as last_seq,
       (select count(*) from messages m where m.conv_id=c.id and m.seq > greatest(my.read_seq, my.joined_seq)
          and m.kind <> 'system' and m.sender_id is distinct from $1)::int as unread,
       (select json_agg(json_build_object('id', x.principal_id, 'role', x.role) order by x.joined_seq, x.principal_id)
          from memberships x where x.conv_id=c.id and x.left_seq is null) as members
     from conversations c join memberships my on my.conv_id=c.id and my.principal_id=$1 and my.left_seq is null`, [me.id])).rows;
  const ids = [...new Set(convs.flatMap((c) => c.members.map((m) => m.id)))];
  const people = ids.length ? (await db.query("select id, kind, handle, name, owner_id from principals where id = any($1)", [ids])).rows : [];
  const messages = since
    ? (await db.query(`select ${COLS} from messages m ${VISIBLE} where m.gid > $2 order by m.gid limit 500`, [me.id, since])).rows
    : (await db.query(`select * from (select ${COLS}, row_number() over (partition by m.conv_id order by m.seq desc) rn from messages m ${VISIBLE}) t where rn <= 50 order by gid`, [me.id])).rows;
  const cursor = (await db.query("select coalesce(max(gid),0)::bigint as c from messages")).rows[0].c;
  return { me: { id: me.id, kind: me.kind, name: me.name }, conversations: convs, principals: people, messages, cursor: Number(cursor) };
});
route("GET", "/conversations/:conv/messages", async ({ req, params, url }) => {
  const me = await whoami(req);
  if (!(await currentMember(db, params.conv, me.id))) refuse(403, "not_a_member");
  const before = Number(url.searchParams.get("before") || 2 ** 52);
  const limit = Math.min(200, Number(url.searchParams.get("limit") || 50));
  return { messages: (await db.query(`select ${COLS} from messages m ${VISIBLE} where m.conv_id=$2 and m.seq < $3 order by m.seq desc limit $4`, [me.id, params.conv, before, limit])).rows };
});
route("GET", "/conversations/:conv/messages/:seq", async ({ req, params }) => {
  const me = await whoami(req);
  return (await visibleMessage(db, params.conv, me.id, Number(params.seq))) || refuse(404, "not_found");
});
route("GET", "/conversations/:conv/search", async ({ req, params, url }) => {
  const me = await whoami(req);
  if (!(await currentMember(db, params.conv, me.id))) refuse(403, "not_a_member");
  const q = `%${(url.searchParams.get("q") || "").replace(/[\\%_]/g, "\\$&")}%`;
  return { messages: (await db.query(`select ${COLS} from messages m ${VISIBLE} where m.conv_id=$2 and m.body->>'text' ilike $3 order by m.seq desc limit 100`, [me.id, params.conv, q])).rows };
});
route("GET", "/conversations/:conv/members", async ({ req, params }) => {
  const me = await whoami(req);
  if (!(await currentMember(db, params.conv, me.id))) refuse(403, "not_a_member");
  return { members: (await db.query("select principal_id as id, role from memberships where conv_id=$1 and left_seq is null", [params.conv])).rows };
});
route("POST", "/conversations/:conv/messages", async ({ req, params }) => {
  const me = await whoami(req);
  const input = await json(req);
  const { msg, duplicate } = await db.transaction((tx) => postMessage(tx, params.conv, me.id, input)); // sender comes from the token only
  if (!duplicate) await broadcast([msg]);
  return msg;
});
route("POST", "/conversations/:conv/read", async ({ req, params }) => {
  const me = await whoami(req);
  const b = await json(req);
  await db.query("update memberships set read_seq = greatest(read_seq, least($3::bigint, (select seq from conversations where id=$1))) where conv_id=$1 and principal_id=$2 and left_seq is null", [params.conv, me.id, Number(b.seq) || 0]);
  return { ok: true };
});
async function gatedJoin(conv, actor, target) {
  const msgs = await db.transaction(async (tx) => {
    if (actor !== target && !(await currentMember(tx, conv, actor))) refuse(403, "not_a_member");
    const ok = (await tx.query("delete from approvals where conv_id=$1 and principal_id=$2 returning 1", [conv, target])).rows.length;
    if (!ok) refuse(403, "not_approved");
    return addMember(tx, conv, target, "speaker");
  });
  await broadcast(msgs);
  poke([target]);
  return { ok: true };
}
route("POST", "/conversations/:conv/invite", async ({ req, params }) => gatedJoin(params.conv, (await whoami(req)).id, String((await json(req)).principal)));
route("POST", "/conversations/:conv/join", async ({ req, params }) => {
  const me = await whoami(req);
  return gatedJoin(params.conv, me.id, me.id);
});
route("POST", "/conversations/:conv/leave", async ({ req, params }) => {
  const me = await whoami(req);
  await broadcast(await db.transaction((tx) => removeMember(tx, params.conv, me.id)));
  return { ok: true };
});
route("POST", "/conversations/:conv/attachments", async ({ req, params, url }) => {
  const me = await whoami(req);
  const c = (await db.query("select frozen from conversations where id=$1", [params.conv])).rows[0];
  if (!c || !(await currentMember(db, params.conv, me.id))) refuse(403, "not_a_member");
  if (c.frozen) refuse(403, "frozen");
  const aid = id("f");
  await db.query("insert into attachments values ($1,$2,$3,$4,$5,$6)", [aid, params.conv, me.id, url.searchParams.get("name") || "file", req.headers["content-type"] || "application/octet-stream", await readBody(req)]);
  return { id: aid };
});
route("GET", "/attachments/:att", async ({ req, params, res }) => {
  const me = await whoami(req);
  // Readable only through a message the caller can currently see.
  const a = (await db.query(`select a.mime, a.data from attachments a join messages m on m.conv_id=a.conv_id and m.body->>'attachment_id' = a.id ${VISIBLE} where a.id=$2 limit 1`, [me.id, params.att])).rows[0];
  if (!a) refuse(404, "not_found");
  res.writeHead(200, { "content-type": a.mime, "content-length": a.data.length, ...CORS });
  res.end(Buffer.from(a.data));
  return undefined;
});

const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST, OPTIONS" };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (req.method === "OPTIONS") return res.writeHead(204, CORS).end();
  try {
    for (const r of routes) {
      const m = r.method === req.method && url.pathname.match(r.re);
      if (!m) continue;
      const out = await r.handler({ req, res, url, params: m.groups || {} });
      if (out !== undefined) res.writeHead(200, { "content-type": "application/json", ...CORS }).end(JSON.stringify(out));
      return undefined;
    }
    refuse(404, "no_such_route"); // anything not listed above does not exist: no user-side create, kick, rename, role change
  } catch (e) {
    const status = e instanceof Refuse ? e.status : e instanceof SyntaxError ? 400 : 500;
    if (status === 500) console.error(e);
    if (!res.headersSent) res.writeHead(status, { "content-type": "application/json", ...CORS }).end(JSON.stringify({ error: e instanceof Refuse ? e.code : "error" }));
  }
  return undefined;
});

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", async (req, socket, head) => {
  try {
    const token = new URL(req.url, "http://x").searchParams.get("token") || "";
    const me = await whoami({ headers: { authorization: `Bearer ${token}` } });
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (!sockets.has(me.id)) sockets.set(me.id, new Set());
      sockets.get(me.id).add(ws);
      ws.on("close", () => sockets.get(me.id)?.delete(ws));
    });
  } catch {
    socket.destroy();
  }
});
server.listen(PORT, "127.0.0.1", () => console.log(`core spike listening on ${PORT}`));
