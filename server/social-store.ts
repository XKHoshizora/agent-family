import { db } from "./db";
import { id, now } from "./config";
import { matrixLocalpart, matrixOptions } from "./matrix-account";

export const socialError = (statusCode: number, message: string) =>
  Object.assign(new Error(message), { statusCode });
db.exec(`
CREATE TABLE IF NOT EXISTS social_friends (
 id TEXT PRIMARY KEY, low_id TEXT NOT NULL, high_id TEXT NOT NULL,
 requested_by TEXT NOT NULL, status TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(low_id,high_id));
CREATE TABLE IF NOT EXISTS social_blocks (owner_id TEXT NOT NULL,target_id TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(owner_id,target_id));
CREATE TABLE IF NOT EXISTS chat_agents (
 id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,workspace_id TEXT NOT NULL,name TEXT NOT NULL,persona TEXT NOT NULL,
 provider TEXT NOT NULL,model TEXT NOT NULL,status TEXT NOT NULL, matrix_id TEXT NOT NULL UNIQUE,
 password TEXT NOT NULL DEFAULT '',token TEXT NOT NULL DEFAULT '',device_id TEXT NOT NULL DEFAULT '',room_id TEXT NOT NULL DEFAULT '',
 generation INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS chat_agent_events(agent_id TEXT NOT NULL,event_id TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(agent_id,event_id));
CREATE TABLE IF NOT EXISTS chat_agent_usage(agent_id TEXT NOT NULL,day TEXT NOT NULL,calls INTEGER NOT NULL,PRIMARY KEY(agent_id,day));
`);
export function localMatrixId(userId: string) {
  const options = matrixOptions();
  if (!options) throw socialError(503, "聊天服务尚未配置。");
  return `@${matrixLocalpart(userId)}:${options.serverName}`;
}
export function person(userId: string) {
  const u = db.prepare("SELECT id,name FROM user WHERE id=?").get(userId) as
    { id: string; name: string } | undefined;
  return u
    ? { ...u, matrixId: localMatrixId(userId), kind: "human" as const }
    : null;
}
export function findPerson(matrixId: string) {
  // Exact IDs only: no email disclosure or whole-user directory enumeration.
  const users = db.prepare("SELECT id,name FROM user").all() as {
    id: string;
    name: string;
  }[];
  const found = users.find((u) => localMatrixId(u.id) === matrixId);
  return found ? person(found.id) : null;
}
export function blocked(a: string, b: string) {
  return !!db
    .prepare(
      "SELECT 1 FROM social_blocks WHERE (owner_id=? AND target_id=?) OR (owner_id=? AND target_id=?)",
    )
    .get(a, b, b, a);
}
export function requestFriend(actor: string, target: string, note: string) {
  if (actor === target) throw socialError(400, "不能添加自己为好友。");
  if (!person(target) || blocked(actor, target))
    throw socialError(404, "暂时无法向这个账号发送申请。");
  const [low, high] = [actor, target].sort();
  return db.transaction(() => {
    const old = db
      .prepare("SELECT * FROM social_friends WHERE low_id=? AND high_id=?")
      .get(low, high) as any;
    if (old?.status === "accepted") throw socialError(409, "你们已经是好友。");
    if (old?.status === "pending")
      throw socialError(
        409,
        old.requested_by === actor
          ? "申请已发送，请等待对方处理。"
          : "对方已向你发送申请，请在新朋友中处理。",
      );
    const stamp = now();
    if (old)
      db.prepare(
        "UPDATE social_friends SET requested_by=?,status='pending',note=?,updated_at=? WHERE id=?",
      ).run(actor, note, stamp, old.id);
    else
      db.prepare("INSERT INTO social_friends VALUES(?,?,?,?,?,?,?,?)").run(
        id(),
        low,
        high,
        actor,
        "pending",
        note,
        stamp,
        stamp,
      );
    return { ok: true };
  })();
}
export function friendAction(
  actor: string,
  friendId: string,
  action: "accept" | "reject" | "cancel" | "remove",
) {
  return db.transaction(() => {
    const f = db
      .prepare(
        "SELECT * FROM social_friends WHERE id=? AND (low_id=? OR high_id=?)",
      )
      .get(friendId, actor, actor) as any;
    if (!f) throw socialError(404, "申请不存在。");
    const target = f.low_id === actor ? f.high_id : f.low_id;
    if (action === "remove") {
      if (f.status !== "accepted") throw socialError(409, "当前不是好友关系。");
    } else {
      if (f.status !== "pending") throw socialError(409, "这条申请已经处理。");
      if ((action === "cancel") !== (f.requested_by === actor))
        throw socialError(403, "不能处理其他人的申请。");
      if (action === "accept" && blocked(actor, target))
        throw socialError(409, "请先解除拉黑并重新申请。");
    }
    db.prepare(
      "UPDATE social_friends SET status=?,updated_at=? WHERE id=?",
    ).run(
      action === "accept"
        ? "accepted"
        : action === "reject"
          ? "rejected"
          : action === "cancel"
            ? "cancelled"
            : "removed",
      now(),
      f.id,
    );
    return { ok: true };
  })();
}
export function blockPerson(actor: string, target: string, enable: boolean) {
  if (actor === target || !person(target))
    throw socialError(400, "无效的账号。");
  return db.transaction(() => {
    if (enable) {
      db.prepare("INSERT OR IGNORE INTO social_blocks VALUES(?,?,?)").run(
        actor,
        target,
        now(),
      );
      const [low, high] = [actor, target].sort();
      db.prepare(
        "UPDATE social_friends SET status='removed',updated_at=? WHERE low_id=? AND high_id=?",
      ).run(now(), low, high);
    } else
      db.prepare(
        "DELETE FROM social_blocks WHERE owner_id=? AND target_id=?",
      ).run(actor, target);
    return { ok: true };
  })();
}
export function listFriends(actor: string) {
  const rows = db
    .prepare(
      "SELECT * FROM social_friends WHERE (low_id=? OR high_id=?) AND status IN ('pending','accepted') ORDER BY updated_at DESC",
    )
    .all(actor, actor) as any[];
  return {
    relations: rows
      .filter((f) => !blocked(actor, f.low_id === actor ? f.high_id : f.low_id))
      .map((f) => ({
        id: f.id,
        status: f.status,
        incoming: f.requested_by !== actor,
        note: f.note,
        person: person(f.low_id === actor ? f.high_id : f.low_id),
      })),
    blocked: (
      db
        .prepare("SELECT target_id FROM social_blocks WHERE owner_id=?")
        .all(actor) as any[]
    ).map((b) => person(b.target_id)),
  };
}
