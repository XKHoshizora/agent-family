import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { zipSync, strToU8 } from "fflate";
import { backupData, restoreData } from "../scripts/backup-lib";
describe("database backup and restore", () => {
  it("backs up an active WAL database with recovery secrets and restores it intact", async () => {
    const base = fs.mkdtempSync(
      path.join(os.tmpdir(), "agent-family-backup-test-"),
    );
    const source = path.join(base, "source"),
      target = path.join(base, "restored"),
      archive = path.join(base, "backup.zip");
    fs.mkdirSync(source);
    const db = new Database(path.join(source, "agent-family.sqlite"));
    try {
      db.pragma("journal_mode = WAL");
      db.exec("CREATE TABLE evidence(id INTEGER PRIMARY KEY,value TEXT)");
      db.prepare("INSERT INTO evidence(value) VALUES(?)").run("durable data");
      const secrets = {
        auth: "x".repeat(48),
        encryption: "ab".repeat(32),
        setup: "setup-token",
      };
      fs.writeFileSync(
        path.join(source, ".secrets.json"),
        JSON.stringify(secrets),
      );
      const result = await backupData(source, archive);
      expect(result.bytes).toBeGreaterThan(100);
      restoreData(archive, target);
      const restored = new Database(path.join(target, "agent-family.sqlite"), {
        readonly: true,
      });
      expect(
        (restored.prepare("SELECT value FROM evidence").get() as any).value,
      ).toBe("durable data");
      expect(restored.pragma("integrity_check", { simple: true })).toBe("ok");
      restored.close();
      expect(
        JSON.parse(fs.readFileSync(path.join(target, ".secrets.json"), "utf8")),
      ).toEqual(secrets);
      expect(() => restoreData(archive, target)).toThrow("空目录");
      await expect(backupData(source, archive)).rejects.toThrow("已存在");
    } finally {
      db.close();
      expect(
        path.resolve(base).startsWith(path.resolve(os.tmpdir()) + path.sep),
      ).toBe(true);
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
  it("rejects archives with unexpected paths before creating the target", () => {
    const base = fs.mkdtempSync(
      path.join(os.tmpdir(), "agent-family-backup-test-"),
    );
    try {
      const archive = path.join(base, "bad.zip"),
        target = path.join(base, "restored");
      fs.writeFileSync(archive, zipSync({ "../escape.txt": strToU8("bad") }));
      expect(() => restoreData(archive, target)).toThrow("格式");
      expect(fs.existsSync(target)).toBe(false);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
