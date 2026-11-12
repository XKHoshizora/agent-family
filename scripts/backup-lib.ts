import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { zipSync, unzipSync, strToU8, strFromU8 } from "fflate";
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
  const snapshot = path.join(
    path.dirname(destination),
    `.snapshot-${crypto.randomUUID()}.sqlite`,
  );
  const db = new Database(path.join(source, "agent-family.sqlite"), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    await db.backup(snapshot);
    const database = fs.readFileSync(snapshot);
    const secretData = secrets
      ? JSON.stringify(secrets)
      : fs.readFileSync(path.join(source, ".secrets.json"), "utf8");
    const manifest = {
      format: "agent-family-backup",
      version: 1,
      createdAt: new Date().toISOString(),
      databaseSha256: crypto
        .createHash("sha256")
        .update(database)
        .digest("hex"),
    };
    fs.writeFileSync(
      destination,
      zipSync(
        {
          "agent-family.sqlite": database,
          ".secrets.json": strToU8(secretData),
          "manifest.json": strToU8(JSON.stringify(manifest, null, 2)),
        },
        { level: 6 },
      ),
      { mode: 0o600, flag: "wx" },
    );
    return {
      path: destination,
      createdAt: manifest.createdAt,
      bytes: fs.statSync(destination).size,
    };
  } finally {
    db.close();
    if (fs.existsSync(snapshot)) fs.unlinkSync(snapshot);
  }
}
export function restoreData(archive: string, targetDir: string) {
  const target = path.resolve(targetDir);
  if (fs.existsSync(target) && fs.readdirSync(target).length)
    throw new Error("恢复目标必须是空目录；不会覆盖现有数据。");
  const zipped = fs.readFileSync(path.resolve(archive));
  if (zipped.length > 200 * 1024 * 1024)
    throw new Error("备份超过 200 MB，请由管理员手动恢复。");
  const files = unzipSync(zipped);
  const names = Object.keys(files).sort();
  if (
    JSON.stringify(names) !==
    JSON.stringify([".secrets.json", "agent-family.sqlite", "manifest.json"])
  )
    throw new Error("备份内容不符合 Agent Family 格式。");
  const manifest = JSON.parse(strFromU8(files["manifest.json"]));
  if (
    manifest.format !== "agent-family-backup" ||
    manifest.version !== 1 ||
    manifest.databaseSha256 !==
      crypto
        .createHash("sha256")
        .update(files["agent-family.sqlite"])
        .digest("hex")
  )
    throw new Error("备份校验失败。");
  const secrets = JSON.parse(strFromU8(files[".secrets.json"]));
  if (
    !/^[0-9a-f]{64}$/i.test(secrets.encryption) ||
    typeof secrets.auth !== "string" ||
    secrets.auth.length < 32
  )
    throw new Error("备份的密钥格式不正确。");
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const name of ["agent-family.sqlite", ".secrets.json"])
    fs.writeFileSync(path.join(target, name), files[name], {
      mode: 0o600,
      flag: "wx",
    });
  const db = new Database(path.join(target, "agent-family.sqlite"), {
    readonly: true,
  });
  try {
    if (db.pragma("integrity_check", { simple: true }) !== "ok")
      throw new Error("数据库完整性检查失败。");
  } finally {
    db.close();
  }
  return { path: target, createdAt: manifest.createdAt };
}
