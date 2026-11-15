import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { zipSync, unzipSync, strToU8, strFromU8 } from "fflate";

/**
 * Backup format
 *  v1: agent-family.sqlite + .secrets.json + manifest.json (still restorable)
 *  v2: v1 + matrix-agents/<agentId>/{sync.json,crypto/*} listed in manifest.files
 *      with per-file sha256. SQLite files (detected by header) are captured via
 *      the SQLite online backup API, so WAL content is included and -wal/-shm/
 *      -journal sidecars are never archived.
 *
 * Consistency: each SQLite file is individually consistent, but the archive as
 * a whole is NOT a globally atomic snapshot across databases/JSON files. Stop
 * Agent runners (or the server) before backing up for consistent disaster
 * recovery. See docs/design/unified-backup.md.
 */

const SQLITE_HEADER = Buffer.from("SQLite format 3\0", "latin1");
const SIDECAR = /-(wal|shm|journal)$/i;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i;
const MATRIX_DIR = "matrix-agents";
const CORE = [".secrets.json", "agent-family.sqlite", "manifest.json"];

export const BACKUP_LIMITS = {
  archiveBytes: 200 * 1024 * 1024,
  fileBytes: 512 * 1024 * 1024,
  totalBytes: 1024 * 1024 * 1024,
  entries: 5000,
};
export type BackupLimits = typeof BACKUP_LIMITS;

type FileEntry = {
  path: string;
  kind: "sqlite" | "file";
  bytes: number;
  sha256: string;
};

const sha256 = (data: Uint8Array) =>
  crypto.createHash("sha256").update(data).digest("hex");

function safeName(name: string) {
  return SAFE_NAME.test(name) && !RESERVED.test(name) && !name.endsWith(".");
}

/** Validates an archive-relative matrix-agents path. */
export function isAllowedMatrixPath(p: string) {
  const parts = p.split("/");
  if (parts[0] !== MATRIX_DIR || parts.some((s) => !safeName(s))) return false;
  if (SIDECAR.test(p)) return false;
  return parts.length === 3 || (parts.length === 4 && parts[2] === "crypto");
}

function isSqliteFile(file: string) {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(16);
    return fs.readSync(fd, buf, 0, 16, 0) === 16 && buf.equals(SQLITE_HEADER);
  } finally {
    fs.closeSync(fd);
  }
}

function assertPlainDir(p: string) {
  const st = fs.lstatSync(p);
  if (st.isSymbolicLink() || !st.isDirectory())
    throw new Error(`拒绝备份符号链接或非目录：${p}`);
}

/** Lists matrix-agents files (archive-relative), rejecting symlinks/unexpected entries. */
function listMatrixFiles(source: string) {
  const root = path.join(source, MATRIX_DIR);
  if (!fs.existsSync(root)) return [] as string[];
  assertPlainDir(root);
  const out: string[] = [];
  const walk = (dir: string, rel: string[], depth: number) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      const parts = [...rel, ent.name];
      if (ent.isSymbolicLink() || fs.lstatSync(full).isSymbolicLink())
        throw new Error(`拒绝备份符号链接：${full}`);
      if (!safeName(ent.name))
        throw new Error(`拒绝备份不安全的文件名：${full}`);
      if (ent.isDirectory()) {
        // allowed: matrix-agents/<agentId>/ and matrix-agents/<agentId>/crypto/
        if (depth === 0 || (depth === 1 && ent.name === "crypto"))
          walk(full, parts, depth + 1);
        else throw new Error(`备份中出现意外目录：${full}`);
      } else if (ent.isFile()) {
        if (depth === 0) throw new Error(`备份中出现意外文件：${full}`);
        if (SIDECAR.test(ent.name)) continue; // captured by SQLite backup API
        out.push([MATRIX_DIR, ...parts].join("/"));
      } else throw new Error(`拒绝备份特殊文件：${full}`);
    }
  };
  walk(root, [], 0);
  return out.sort();
}

async function snapshotSqlite(file: string, tmpDir: string) {
  const snap = path.join(tmpDir, `.snapshot-${crypto.randomUUID()}.sqlite`);
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    await db.backup(snap);
    return fs.readFileSync(snap);
  } finally {
    db.close();
    if (fs.existsSync(snap)) fs.unlinkSync(snap);
  }
}

export async function backupData(
  sourceDir: string,
  output: string,
  secrets?: { auth: string; encryption: string; setup: string },
) {
  const source = path.resolve(sourceDir),
    destination = path.resolve(output);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (fs.existsSync(destination))
    throw new Error("备份文件已存在，请使用新的文件名。");
  const tmpDir = path.dirname(destination);
  const mainFile = path.join(source, "agent-family.sqlite");
  if (fs.lstatSync(mainFile).isSymbolicLink())
    throw new Error("拒绝备份符号链接数据库。");
  const matrixFiles = listMatrixFiles(source);
  const database = await snapshotSqlite(mainFile, tmpDir);
  const secretData = secrets
    ? JSON.stringify(secrets)
    : fs.readFileSync(path.join(source, ".secrets.json"), "utf8");
  const zipEntries: Record<string, Uint8Array> = {
    "agent-family.sqlite": database,
    ".secrets.json": strToU8(secretData),
  };
  const files: FileEntry[] = [];
  let total = database.length;
  for (const rel of matrixFiles) {
    const full = path.join(source, ...rel.split("/"));
    const st = fs.lstatSync(full);
    if (st.isSymbolicLink() || !st.isFile())
      throw new Error(`拒绝备份符号链接：${full}`);
    const kind = isSqliteFile(full) ? "sqlite" : "file";
    const data =
      kind === "sqlite"
        ? await snapshotSqlite(full, tmpDir)
        : fs.readFileSync(full);
    if (data.length > BACKUP_LIMITS.fileBytes)
      throw new Error(`文件过大，无法备份：${rel}`);
    total += data.length;
    if (total > BACKUP_LIMITS.totalBytes)
      throw new Error("备份数据总量超过上限。");
    zipEntries[rel] = data;
    files.push({ path: rel, kind, bytes: data.length, sha256: sha256(data) });
  }
  if (files.length + CORE.length > BACKUP_LIMITS.entries)
    throw new Error("备份文件数量超过上限。");
  const manifest = {
    format: "agent-family-backup",
    version: 2,
    createdAt: new Date().toISOString(),
    databaseSha256: sha256(database),
    secretsSha256: sha256(zipEntries[".secrets.json"]),
    files,
    consistency:
      "per-file; not globally atomic across databases. Stop Agent runners for consistent disaster recovery.",
  };
  zipEntries["manifest.json"] = strToU8(JSON.stringify(manifest, null, 2));
  fs.writeFileSync(destination, zipSync(zipEntries, { level: 6 }), {
    mode: 0o600,
    flag: "wx",
  });
  return {
    path: destination,
    createdAt: manifest.createdAt,
    bytes: fs.statSync(destination).size,
    files: files.length,
  };
}

function checkIntegrity(file: string) {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    if (db.pragma("integrity_check", { simple: true }) !== "ok")
      throw new Error("数据库完整性检查失败。");
  } finally {
    db.close();
  }
}

export function restoreData(
  archive: string,
  targetDir: string,
  limits: BackupLimits = BACKUP_LIMITS,
) {
  const target = path.resolve(targetDir);
  if (fs.existsSync(target)) {
    if (fs.lstatSync(target).isSymbolicLink())
      throw new Error("恢复目标不能是符号链接。");
    if (fs.readdirSync(target).length)
      throw new Error("恢复目标必须是空目录；不会覆盖现有数据。");
  }
  const zipped = fs.readFileSync(path.resolve(archive));
  if (zipped.length > limits.archiveBytes)
    throw new Error("备份超过 200 MB，请由管理员手动恢复。");
  // Check declared sizes/paths BEFORE decompressing (zip-bomb / traversal guard).
  let count = 0,
    declared = 0,
    badPath = false,
    tooLarge = false;
  const files = unzipSync(zipped, {
    filter: (f) => {
      count++;
      declared += f.originalSize;
      if (!CORE.includes(f.name) && !isAllowedMatrixPath(f.name))
        badPath = true;
      if (f.originalSize > limits.fileBytes || declared > limits.totalBytes)
        tooLarge = true;
      return !badPath && !tooLarge && count <= limits.entries;
    },
  });
  if (badPath) throw new Error("备份内容不符合 Agent Family 格式。");
  if (tooLarge || count > limits.entries)
    throw new Error("备份解压后超过大小或数量上限。");
  let actual = 0;
  for (const v of Object.values(files)) {
    if (v.length > limits.fileBytes)
      throw new Error("备份解压后超过大小或数量上限。");
    actual += v.length;
  }
  if (actual > limits.totalBytes)
    throw new Error("备份解压后超过大小或数量上限。");
  const names = Object.keys(files).sort();
  if (!CORE.every((n) => names.includes(n)))
    throw new Error("备份内容不符合 Agent Family 格式。");
  const manifest = JSON.parse(strFromU8(files["manifest.json"]));
  if (
    manifest.format !== "agent-family-backup" ||
    (manifest.version !== 1 && manifest.version !== 2) ||
    manifest.databaseSha256 !== sha256(files["agent-family.sqlite"])
  )
    throw new Error("备份校验失败。");
  const extras = names.filter((n) => !CORE.includes(n));
  let entries: FileEntry[] = [];
  if (manifest.version === 1) {
    if (extras.length) throw new Error("备份内容不符合 Agent Family 格式。");
  } else {
    if (
      typeof manifest.secretsSha256 !== "string" ||
      manifest.secretsSha256 !== sha256(files[".secrets.json"])
    )
      throw new Error("备份校验失败。");
    if (!Array.isArray(manifest.files)) throw new Error("备份校验失败。");
    entries = manifest.files;
    const listed = entries.map((e) => e?.path);
    const lower = new Set(listed.map((p) => String(p).toLowerCase()));
    if (
      lower.size !== listed.length ||
      JSON.stringify([...listed].sort()) !== JSON.stringify(extras)
    )
      throw new Error("备份内容不符合 Agent Family 格式。");
    for (const e of entries) {
      if (
        typeof e.path !== "string" ||
        !isAllowedMatrixPath(e.path) ||
        (e.kind !== "sqlite" && e.kind !== "file") ||
        e.bytes !== files[e.path].length ||
        e.sha256 !== sha256(files[e.path])
      )
        throw new Error("备份校验失败。");
      if (
        e.kind === "sqlite" &&
        !Buffer.from(files[e.path].subarray(0, 16)).equals(SQLITE_HEADER)
      )
        throw new Error("备份校验失败。");
    }
  }
  const secrets = JSON.parse(strFromU8(files[".secrets.json"]));
  if (
    !/^[0-9a-f]{64}$/i.test(secrets.encryption) ||
    typeof secrets.auth !== "string" ||
    secrets.auth.length < 32
  )
    throw new Error("备份的密钥格式不正确。");
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  const write = (rel: string) => {
    const out = path.resolve(target, ...rel.split("/"));
    if (!out.startsWith(target + path.sep))
      throw new Error("备份内容不符合 Agent Family 格式。");
    fs.mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 });
    fs.writeFileSync(out, files[rel], { mode: 0o600, flag: "wx" });
    return out;
  };
  write("agent-family.sqlite");
  write(".secrets.json");
  checkIntegrity(path.join(target, "agent-family.sqlite"));
  for (const e of entries) {
    const out = write(e.path);
    if (e.kind === "sqlite") checkIntegrity(out);
  }
  return {
    path: target,
    createdAt: manifest.createdAt,
    version: manifest.version as 1 | 2,
    files: entries.length,
  };
}
