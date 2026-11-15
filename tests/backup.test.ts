import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import crypto from "node:crypto";
import { zipSync, unzipSync, strToU8, strFromU8 } from "fflate";
import { backupData, restoreData, BACKUP_LIMITS } from "../scripts/backup-lib";
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

const secrets = {
  auth: "x".repeat(48),
  encryption: "ab".repeat(32),
  setup: "s",
};
function makeSource(base: string) {
  const source = path.join(base, "source");
  const agent = path.join(source, "matrix-agents", "agent_1");
  fs.mkdirSync(path.join(agent, "crypto"), { recursive: true });
  const main = new Database(path.join(source, "agent-family.sqlite"));
  main.exec("CREATE TABLE t(v TEXT)");
  main.close();
  fs.writeFileSync(path.join(source, ".secrets.json"), JSON.stringify(secrets));
  fs.writeFileSync(
    path.join(agent, "sync.json"),
    JSON.stringify({ syncToken: "s_1" }),
  );
  const cryptoDb = new Database(
    path.join(agent, "crypto", "matrix-sdk-crypto.sqlite3"),
  );
  cryptoDb.pragma("journal_mode = WAL");
  cryptoDb.pragma("wal_autocheckpoint = 0");
  cryptoDb.exec("CREATE TABLE keys(k TEXT)");
  cryptoDb.prepare("INSERT INTO keys VALUES(?)").run("olm-account");
  return { source, agent, cryptoDb };
}
function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-family-backup-test-"));
}

describe("v2 backup with matrix-agents crypto/sync storage", () => {
  it("round-trips WAL crypto SQLite (uncheckpointed) and sync.json, skipping sidecars", async () => {
    const base = tmp();
    const { source, cryptoDb } = makeSource(base);
    try {
      expect(
        fs.existsSync(
          path.join(
            source,
            "matrix-agents/agent_1/crypto/matrix-sdk-crypto.sqlite3-wal",
          ),
        ),
      ).toBe(true);
      const archive = path.join(base, "b.zip"),
        target = path.join(base, "r");
      const res = await backupData(source, archive);
      expect(res.files).toBe(2);
      const zipped = unzipSync(fs.readFileSync(archive));
      expect(Object.keys(zipped).some((n) => /-(wal|shm)$/.test(n))).toBe(
        false,
      );
      const manifest = JSON.parse(strFromU8(zipped["manifest.json"]));
      expect(manifest.version).toBe(2);
      expect(manifest.files.map((f: any) => [f.path, f.kind])).toEqual([
        ["matrix-agents/agent_1/crypto/matrix-sdk-crypto.sqlite3", "sqlite"],
        ["matrix-agents/agent_1/sync.json", "file"],
      ]);
      const out = restoreData(archive, target);
      expect(out.version).toBe(2);
      const r = new Database(
        path.join(
          target,
          "matrix-agents/agent_1/crypto/matrix-sdk-crypto.sqlite3",
        ),
        { readonly: true },
      );
      expect((r.prepare("SELECT k FROM keys").get() as any).k).toBe(
        "olm-account",
      );
      r.close();
      expect(
        JSON.parse(
          fs.readFileSync(
            path.join(target, "matrix-agents/agent_1/sync.json"),
            "utf8",
          ),
        ),
      ).toEqual({ syncToken: "s_1" });
    } finally {
      cryptoDb.close();
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("still restores a v1 archive", () => {
    const base = tmp();
    try {
      const dbFile = path.join(base, "v1.sqlite");
      const d = new Database(dbFile);
      d.exec("CREATE TABLE t(v)");
      d.close();
      const database = fs.readFileSync(dbFile);
      const archive = path.join(base, "v1.zip");
      fs.writeFileSync(
        archive,
        zipSync({
          "agent-family.sqlite": database,
          ".secrets.json": strToU8(JSON.stringify(secrets)),
          "manifest.json": strToU8(
            JSON.stringify({
              format: "agent-family-backup",
              version: 1,
              createdAt: "2026-01-01T00:00:00.000Z",
              databaseSha256: crypto
                .createHash("sha256")
                .update(database)
                .digest("hex"),
            }),
          ),
        }),
      );
      expect(restoreData(archive, path.join(base, "r")).version).toBe(1);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  async function tampered(
    base: string,
    mutate: (files: Record<string, Uint8Array>) => void,
  ) {
    const { source, cryptoDb } = makeSource(base);
    cryptoDb.close();
    const archive = path.join(base, "b.zip");
    await backupData(source, archive);
    const files = unzipSync(fs.readFileSync(archive));
    mutate(files);
    const bad = path.join(base, "bad.zip");
    fs.writeFileSync(bad, zipSync(files));
    return bad;
  }

  it("rejects digest mismatch, unlisted entries, traversal and sidecars before creating target", async () => {
    const cases: [(f: Record<string, Uint8Array>) => void, string][] = [
      [(f) => (f["matrix-agents/agent_1/sync.json"] = strToU8("{}")), "校验"],
      [(f) => (f["matrix-agents/agent_1/extra.json"] = strToU8("{}")), "格式"],
      [(f) => (f["matrix-agents/../../evil.json"] = strToU8("{}")), "格式"],
      [
        (f) => (f["matrix-agents/agent_1/crypto/x.sqlite3-wal"] = strToU8("x")),
        "格式",
      ],
      [(f) => (f["matrix-agents/agent_1/a/b/c.json"] = strToU8("x")), "格式"],
    ];
    for (const [mutate, msg] of cases) {
      const base = tmp();
      try {
        const bad = await tampered(base, mutate);
        const target = path.join(base, "r");
        expect(() => restoreData(bad, target)).toThrow(msg);
        expect(fs.existsSync(target)).toBe(false);
      } finally {
        fs.rmSync(base, { recursive: true, force: true });
      }
    }
  });

  it("rejects manifest path traversal even if entries match", async () => {
    const base = tmp();
    try {
      const bad = await tampered(base, (f) => {
        const m = JSON.parse(strFromU8(f["manifest.json"]));
        m.files[1].path = "matrix-agents/agent_1/../../x";
        f["matrix-agents/agent_1/../../x"] =
          f["matrix-agents/agent_1/sync.json"];
        delete f["matrix-agents/agent_1/sync.json"];
        f["manifest.json"] = strToU8(JSON.stringify(m));
      });
      expect(() => restoreData(bad, path.join(base, "r"))).toThrow();
      expect(fs.existsSync(path.join(base, "r"))).toBe(false);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("rejects oversized extracted data via limits", async () => {
    const base = tmp();
    try {
      const { source, cryptoDb } = makeSource(base);
      cryptoDb.close();
      const archive = path.join(base, "b.zip");
      await backupData(source, archive);
      expect(() =>
        restoreData(archive, path.join(base, "r"), {
          ...BACKUP_LIMITS,
          totalBytes: 1024,
        }),
      ).toThrow("上限");
      expect(fs.existsSync(path.join(base, "r"))).toBe(false);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("refuses to back up symlinks and unexpected directories", async () => {
    const base = tmp();
    try {
      const { source, agent, cryptoDb } = makeSource(base);
      cryptoDb.close();
      fs.mkdirSync(path.join(agent, "unexpected"));
      await expect(
        backupData(source, path.join(base, "a.zip")),
      ).rejects.toThrow("意外目录");
      fs.rmdirSync(path.join(agent, "unexpected"));
      let linked = false;
      try {
        fs.symlinkSync(
          path.join(source, ".secrets.json"),
          path.join(agent, "link.json"),
          "file",
        );
        linked = true;
      } catch {
        // Windows without Developer Mode/admin cannot create symlinks; skip that half.
      }
      if (linked)
        await expect(
          backupData(source, path.join(base, "b.zip")),
        ).rejects.toThrow("符号链接");
      expect(fs.existsSync(path.join(base, "b.zip"))).toBe(false);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
