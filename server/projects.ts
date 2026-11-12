import { z } from "zod";
import { zipSync, strToU8 } from "fflate";
import { db, audit } from "./db";
import { id, now } from "./config";
import type { Room, ProjectFile, ChangeSet, FileChange } from "../shared/types";
export function safeProjectPath(value: string) {
  if (
    value !== value.trim() ||
    value.length > 180 ||
    !value ||
    /[\\\x00-\x1f<>:"|?*]/.test(value) ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value
      .split("/")
      .some(
        (s) =>
          !s ||
          s === "." ||
          s === ".." ||
          /[. ]$/.test(s) ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s) ||
          s === ".git" ||
          (/^\.env(?:\.|$)/i.test(s) && s !== ".env.example") ||
          /^(?:CanalAPI-Key|id_rsa|id_ed25519)(?:\.|$)/i.test(s),
      )
  )
    throw new Error(
      "文件路径不安全。请使用项目内相对路径，不含密钥文件或上级目录。",
    );
  return value;
}
export const fileChangeSchema = z.object({
  path: z
    .string()
    .min(1)
    .max(180)
    .refine((v) => {
      try {
        safeProjectPath(v);
        return true;
      } catch {
        return false;
      }
    }, "请使用安全的项目相对路径"),
  content: z.string().max(30000).nullable(),
  baseVersion: z.number().int().min(0),
});
export const proposalSchema = z.object({
  title: z.string().trim().min(1).max(100),
  files: z.array(fileChangeSchema).min(1).max(12),
});
export function branchFor(room: Room, agentId: string) {
  return room.projectMode === "independent" ? `agent-${agentId}` : "main";
}
export function listProjectFiles(
  roomId: string,
  branch?: string,
): ProjectFile[] {
  const rows = (
    branch
      ? db
          .prepare(
            "SELECT * FROM project_files WHERE room_id=? AND branch=? ORDER BY path",
          )
          .all(roomId, branch)
      : db
          .prepare(
            "SELECT * FROM project_files WHERE room_id=? ORDER BY branch,path",
          )
          .all(roomId)
  ) as any[];
  return rows.map((r) => ({
    path: r.path,
    content: r.content,
    version: r.version,
    branch: r.branch,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
  }));
}
export function listChanges(roomId: string): ChangeSet[] {
  return (
    db
      .prepare(
        "SELECT * FROM change_sets WHERE room_id=? ORDER BY (status='pending') DESC, created_at DESC LIMIT 100",
      )
      .all(roomId) as any[]
  ).map((r) => ({
    id: r.id,
    roomId: r.room_id,
    branch: r.branch,
    agentId: r.agent_id,
    runId: r.run_id,
    title: r.title,
    status: r.status,
    files: JSON.parse(r.files),
    createdAt: r.created_at,
    reviewedBy: r.reviewed_by,
    reviewedAt: r.reviewed_at,
  }));
}
export function proposeChanges(
  room: Room,
  agentId: string,
  runId: string | null,
  title: string,
  files: FileChange[],
  branch = branchFor(room, agentId),
) {
  if (room.projectMode === "off") throw new Error("本群未开启项目协作。");
  proposalSchema.parse({ title, files });
  if (new Set(files.map((f) => f.path.toLowerCase())).size !== files.length)
    throw new Error("一次变更不能重复包含同一个路径。");
  if (files.reduce((n, f) => n + (f.content?.length || 0), 0) > 80000)
    throw new Error("一次变更总内容最多 80,000 字符。");
  if (
    (
      db
        .prepare(
          "SELECT count(*) AS n FROM change_sets WHERE room_id=? AND status='pending'",
        )
        .get(room.id) as any
    ).n >= 30
  )
    throw new Error("待审查变更已达 30 份，请先处理。");
  const changeId = id();
  const baseline = listProjectFiles(room.id, branch);
  const changes = files.map((f) => ({
    ...f,
    beforeContent: baseline.find((old) => old.path === f.path)?.content ?? null,
  }));
  db.prepare("INSERT INTO change_sets VALUES(?,?,?,?,?,?,?,?,?,NULL,NULL)").run(
    changeId,
    room.id,
    branch,
    agentId,
    runId,
    title,
    "pending",
    JSON.stringify(changes),
    now(),
  );
  return changeId;
}
export function reviewChange(
  room: Room,
  changeId: string,
  actor: string,
  decision: "approve" | "reject",
) {
  return db.transaction(() => {
    const change = db
      .prepare("SELECT * FROM change_sets WHERE id=? AND room_id=?")
      .get(changeId, room.id) as any;
    if (!change || change.status !== "pending")
      throw new Error("这份变更不存在或已经处理。");
    if (decision === "approve") {
      const files = JSON.parse(change.files) as FileChange[];
      const existing = listProjectFiles(room.id, change.branch);
      for (const f of files) {
        safeProjectPath(f.path);
        const old = existing.find(
          (x) => x.path.toLowerCase() === f.path.toLowerCase(),
        );
        if (old && old.path !== f.path)
          throw new Error(`路径大小写冲突：${f.path}`);
        if ((old?.version || 0) !== f.baseVersion)
          throw new Error(
            `文件 ${f.path} 已变化，请让伙伴读取最新版本后重新提交。`,
          );
      }
      const added = files.filter(
        (f) =>
          f.content !== null &&
          !existing.some((x) => x.path === f.path && x.content !== null),
      ).length;
      const removed = files.filter(
        (f) =>
          f.content === null &&
          existing.some((x) => x.path === f.path && x.content !== null),
      ).length;
      if (
        existing.filter((f) => f.content !== null).length + added - removed >
        100
      )
        throw new Error("每个项目分支最多 100 个文件。");
      let size = existing.reduce((n, f) => n + (f.content?.length || 0), 0);
      for (const f of files)
        size +=
          (f.content?.length || 0) -
          (existing.find((x) => x.path === f.path)?.content?.length || 0);
      if (size > 1000000) throw new Error("项目内容最多 1,000,000 字符。");
      for (const f of files)
        db.prepare(
          "INSERT INTO project_files VALUES(?,?,?,?,?,?,?) ON CONFLICT(room_id,branch,path) DO UPDATE SET content=excluded.content,version=excluded.version,updated_at=excluded.updated_at,updated_by=excluded.updated_by",
        ).run(
          room.id,
          change.branch,
          f.path,
          f.content,
          f.baseVersion + 1,
          now(),
          actor,
        );
    }
    db.prepare(
      "UPDATE change_sets SET status=?,reviewed_by=?,reviewed_at=? WHERE id=?",
    ).run(
      decision === "approve" ? "approved" : "rejected",
      actor,
      now(),
      changeId,
    );
    audit(room.workspaceId, actor, `project.${decision}`, changeId);
    return { ok: true };
  })();
}
export function projectZip(roomId: string, branch: string) {
  const files = listProjectFiles(roomId, branch).filter(
    (f) => f.content !== null,
  );
  if (!files.length) throw new Error("这个分支还没有已批准的文件。");
  const archive: Record<string, Uint8Array> = Object.create(null);
  for (const f of files) archive[safeProjectPath(f.path)] = strToU8(f.content!);
  return Buffer.from(zipSync(archive, { level: 6 }));
}
