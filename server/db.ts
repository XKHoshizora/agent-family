import Database from "better-sqlite3";
import path from "node:path";
import { dataDir, id, now } from "./config";
import type { Room, Message, Agent, Run, Note } from "../shared/types";
import { splitReasoning } from "../shared/reasoning";
export const db = new Database(path.join(dataDir, "agent-family.sqlite"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 5000");
db.exec(`
CREATE TABLE IF NOT EXISTS workspaces(id TEXT PRIMARY KEY,name TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS memberships(workspace_id TEXT NOT NULL REFERENCES workspaces(id),user_id TEXT NOT NULL,role TEXT NOT NULL,PRIMARY KEY(workspace_id,user_id));
CREATE TABLE IF NOT EXISTS rooms(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id),name TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',mode TEXT NOT NULL,agents TEXT NOT NULL,created_by TEXT NOT NULL,visibility TEXT NOT NULL DEFAULT 'private',archived INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS rooms_workspace ON rooms(workspace_id);
CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,room_id TEXT NOT NULL REFERENCES rooms(id),status TEXT NOT NULL,mode TEXT NOT NULL,created_at TEXT NOT NULL,finished_at TEXT,error TEXT);
CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,room_id TEXT NOT NULL REFERENCES rooms(id),run_id TEXT REFERENCES runs(id),role TEXT NOT NULL,agent_id TEXT,author TEXT NOT NULL,model TEXT,content TEXT NOT NULL,status TEXT NOT NULL,source TEXT NOT NULL,created_at TEXT NOT NULL,tokens INTEGER NOT NULL DEFAULT 0,tool_events TEXT NOT NULL DEFAULT '[]');
CREATE INDEX IF NOT EXISTS messages_room ON messages(room_id,created_at);
CREATE TABLE IF NOT EXISTS providers(id TEXT NOT NULL,workspace_id TEXT NOT NULL REFERENCES workspaces(id),kind TEXT NOT NULL,base_url TEXT NOT NULL,secret TEXT NOT NULL,models TEXT NOT NULL DEFAULT '[]',updated_at TEXT NOT NULL,PRIMARY KEY(id,workspace_id));
CREATE TABLE IF NOT EXISTS usage_daily(workspace_id TEXT NOT NULL,day TEXT NOT NULL,calls INTEGER NOT NULL DEFAULT 0,tokens INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(workspace_id,day));
CREATE TABLE IF NOT EXISTS invites(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id),token_hash TEXT UNIQUE NOT NULL,role TEXT NOT NULL,expires_at TEXT NOT NULL,used_at TEXT,created_by TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS notes(id TEXT PRIMARY KEY,room_id TEXT NOT NULL REFERENCES rooms(id),title TEXT NOT NULL,content TEXT NOT NULL,created_by TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,actor TEXT NOT NULL,action TEXT NOT NULL,target TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS line_channels(id TEXT PRIMARY KEY,workspace_id TEXT UNIQUE NOT NULL REFERENCES workspaces(id),secret TEXT NOT NULL,token TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 0,verified INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS line_bindings(group_id TEXT PRIMARY KEY,channel_id TEXT NOT NULL REFERENCES line_channels(id),room_id TEXT NOT NULL REFERENCES rooms(id),created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS line_challenges(code TEXT PRIMARY KEY,channel_id TEXT NOT NULL,room_id TEXT NOT NULL,created_by TEXT NOT NULL,expires_at TEXT NOT NULL,group_id TEXT,confirmed INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS line_events(id TEXT PRIMARY KEY,channel_id TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL,error TEXT);
CREATE TABLE IF NOT EXISTS line_outbox(id TEXT PRIMARY KEY,channel_id TEXT NOT NULL,group_id TEXT NOT NULL,run_id TEXT,status TEXT NOT NULL,created_at TEXT NOT NULL,error TEXT);
CREATE TABLE IF NOT EXISTS project_files(room_id TEXT NOT NULL REFERENCES rooms(id),branch TEXT NOT NULL,path TEXT NOT NULL,content TEXT,version INTEGER NOT NULL,updated_at TEXT NOT NULL,updated_by TEXT NOT NULL,PRIMARY KEY(room_id,branch,path));
CREATE TABLE IF NOT EXISTS change_sets(id TEXT PRIMARY KEY,room_id TEXT NOT NULL REFERENCES rooms(id),branch TEXT NOT NULL,agent_id TEXT NOT NULL,run_id TEXT, title TEXT NOT NULL,status TEXT NOT NULL,files TEXT NOT NULL,created_at TEXT NOT NULL,reviewed_by TEXT,reviewed_at TEXT);
`);
if (
  !(db.pragma("table_info(rooms)") as any[]).some(
    (c) => c.name === "project_mode",
  )
)
  db.exec(
    "ALTER TABLE rooms ADD COLUMN project_mode TEXT NOT NULL DEFAULT 'off'",
  );
if (
  !(db.pragma("table_info(line_challenges)") as any[]).some(
    (c) => c.name === "group_name",
  )
)
  db.exec(
    "ALTER TABLE line_challenges ADD COLUMN group_name TEXT NOT NULL DEFAULT ''",
  );
if (
  !(db.pragma("table_info(messages)") as any[]).some(
    (c) => c.name === "reasoning",
  )
)
  db.exec("ALTER TABLE messages ADD COLUMN reasoning TEXT NOT NULL DEFAULT ''");
// Additive migrations preserve existing messages and counters.
for (const [table, column, definition] of [
  ["messages", "round", "INTEGER NOT NULL DEFAULT 1"],
  ["runs", "notice", "TEXT NOT NULL DEFAULT ''"],
  ["usage_daily", "reserved", "INTEGER NOT NULL DEFAULT 0"],
  ["usage_daily", "line_calls", "INTEGER NOT NULL DEFAULT 0"],
  ["usage_daily", "line_reserved", "INTEGER NOT NULL DEFAULT 0"],
  ["line_bindings", "mode", "TEXT NOT NULL DEFAULT 'parallel'"],
  ["line_bindings", "share_tools", "INTEGER NOT NULL DEFAULT 0"],
  ["line_bindings", "context_after", "INTEGER NOT NULL DEFAULT 0"],
  ["line_bindings", "scope_id", "TEXT NOT NULL DEFAULT ''"],
]) {
  if (
    !(db.pragma(`table_info(${table})`) as any[]).some((c) => c.name === column)
  )
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
db.exec(
  "CREATE TABLE IF NOT EXISTS run_budgets(run_id TEXT PRIMARY KEY REFERENCES runs(id),workspace_id TEXT NOT NULL,day TEXT NOT NULL,source TEXT NOT NULL,remaining INTEGER NOT NULL)",
);
db.transaction(() => {
  for (const b of db
    .prepare("SELECT group_id FROM line_bindings WHERE scope_id=''")
    .all() as any[]) {
    db.prepare(
      "UPDATE line_bindings SET scope_id=?,context_after=(SELECT COALESCE(MAX(rowid),0) FROM messages),share_tools=0 WHERE group_id=?",
    ).run(id(), b.group_id);
  }
})();
export function audit(
  workspaceId: string,
  actor: string,
  action: string,
  target: string,
) {
  db.prepare("INSERT INTO audit VALUES(?,?,?,?,?,?)").run(
    id(),
    workspaceId,
    actor,
    action,
    target,
    now(),
  );
}
export function roomFrom(row: any): Room {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    description: row.description,
    mode: row.mode,
    agents: JSON.parse(row.agents),
    createdBy: row.created_by,
    visibility: row.visibility,
    archived: !!row.archived,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lineLinked: !!db
      .prepare("SELECT 1 FROM line_bindings WHERE room_id=?")
      .get(row.id),
    projectMode: row.project_mode || "off",
  };
}
export function getRoom(roomId: string) {
  const row = db.prepare("SELECT * FROM rooms WHERE id=?").get(roomId);
  return row ? roomFrom(row) : undefined;
}
export function createRoom(
  workspaceId: string,
  userId: string,
  name: string,
  agents: Agent[],
  visibility: "team" | "private" = "private",
) {
  const roomId = id();
  const date = now();
  db.prepare(
    "INSERT INTO rooms(id,workspace_id,name,mode,agents,created_by,visibility,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
  ).run(
    roomId,
    workspaceId,
    name,
    "parallel",
    JSON.stringify(agents),
    userId,
    visibility,
    date,
    date,
  );
  return getRoom(roomId)!;
}
export function messageFrom(row: any): Message {
  const parts =
    row.role === "assistant"
      ? splitReasoning(row.content, row.status === "streaming")
      : { content: row.content, reasoning: "" };
  return {
    id: row.id,
    roomId: row.room_id,
    runId: row.run_id,
    role: row.role,
    agentId: row.agent_id,
    author: row.author,
    model: row.model,
    content: parts.content,
    reasoning: [row.reasoning, parts.reasoning].filter(Boolean).join("\n\n"),
    round: row.round || 1,
    status: row.status,
    source: row.source,
    createdAt: row.created_at,
    tokens: row.tokens,
    toolEvents: JSON.parse(row.tool_events),
  };
}
export function getMessages(roomId: string, limit = 300) {
  return (
    db
      .prepare(
        "SELECT * FROM (SELECT rowid AS sequence,* FROM messages WHERE room_id=? ORDER BY rowid DESC LIMIT ?) ORDER BY sequence ASC",
      )
      .all(roomId, limit) as any[]
  ).map(messageFrom);
}
export function addMessage(
  message: Omit<Message, "id" | "createdAt" | "tokens" | "toolEvents">,
) {
  const msg = {
    ...message,
    id: id(),
    createdAt: now(),
    tokens: 0,
    toolEvents: [],
  };
  db.prepare(
    "INSERT INTO messages(id,room_id,run_id,role,agent_id,author,model,content,status,source,created_at,tokens,tool_events,reasoning,round) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    msg.id,
    msg.roomId,
    msg.runId,
    msg.role,
    msg.agentId,
    msg.author,
    msg.model,
    msg.content,
    msg.status,
    msg.source,
    msg.createdAt,
    0,
    "[]",
    message.reasoning || "",
    message.round || 1,
  );
  db.prepare("UPDATE rooms SET updated_at=? WHERE id=?").run(now(), msg.roomId);
  return msg;
}
export function runFrom(row: any): Run {
  return {
    id: row.id,
    roomId: row.room_id,
    status: row.status,
    mode: row.mode,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
    error: row.error,
    notice: row.notice || "",
  };
}
export function getRuns(roomId: string) {
  return (
    db
      .prepare(
        "SELECT * FROM runs WHERE room_id=? ORDER BY created_at DESC LIMIT 20",
      )
      .all(roomId) as any[]
  ).map(runFrom);
}
export function getNotes(roomId: string): Note[] {
  return (
    db
      .prepare("SELECT * FROM notes WHERE room_id=? ORDER BY updated_at DESC")
      .all(roomId) as any[]
  ).map((r) => ({
    id: r.id,
    roomId: r.room_id,
    title: r.title,
    content: r.content,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}
export function saveNote(
  roomId: string,
  title: string,
  content: string,
  actor: string,
) {
  const noteId = id(),
    date = now();
  db.prepare("INSERT INTO notes VALUES(?,?,?,?,?,?,?)").run(
    noteId,
    roomId,
    title,
    content,
    actor,
    date,
    date,
  );
  return noteId;
}
