import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The browser suite's service entry (tests/helpers/e2e-server.ts) builds the app with `allowInsecureLocal`, so it must
 * never be what runs anywhere else: it is not part of the production build, and it refuses to start outside a test
 * environment on an `_e2e` database.
 */

const root = fileURLToPath(new URL("..", import.meta.url));
const entry = path.join(root, "tests", "helpers", "e2e-server.ts");
const tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;

/** The environment without anything that would configure the service, plus `extra`. */
function envWith(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !/^(NODE_ENV|DATABASE_URL|E2E_.*)$/.test(key)) env[key] = value;
  }
  return { ...env, ...extra };
}

/** Starts the entry the way the suite does (node with tsx's loader); it must end by itself. */
function start(env: Record<string, string>) {
  return spawnSync(process.execPath, ["--import", tsx, entry], { cwd: os.tmpdir(), env, encoding: "utf8", timeout: 45_000, windowsHide: true });
}

/** A database URL that is never connected to (the entry refuses before it opens one). */
const database = (name: string) => `postgres://nobody:nothing@127.0.0.1:9/${name}`;

describe("the e2e service entry", () => {
  it("refuses to start unless NODE_ENV is test", () => {
    const res = start(envWith({ DATABASE_URL: database("af_e2e") }));
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("NODE_ENV=test");
    const prod = start(envWith({ NODE_ENV: "production", DATABASE_URL: database("af_e2e") }));
    expect(prod.status).toBe(1);
    expect(prod.stderr).toContain("NODE_ENV=test");
  }, 60_000);

  it("refuses to start on a database whose name does not end in _e2e", () => {
    for (const name of ["af_dev", "af_test", "af_e2e_copy", ""]) {
      const res = start(envWith({ NODE_ENV: "test", DATABASE_URL: database(name) }));
      expect([name, res.status]).toEqual([name, 1]);
      expect(res.stderr).toContain("_e2e");
    }
  }, 120_000);

  it("is not part of the production build: that compiles src/ alone, and nothing in src/ imports tests/", () => {
    const build = JSON.parse(readFileSync(path.join(root, "tsconfig.build.json"), "utf8")) as { include: string[]; compilerOptions: { rootDir: string } };
    expect(build.include).toEqual(["src"]);
    expect(build.compilerOptions.rootDir).toBe("src");
    const sources = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sources(path.join(dir, e.name)) : [path.join(dir, e.name)]));
    for (const file of sources(path.join(root, "src"))) {
      expect([file, /["'][./]*tests\//.test(readFileSync(file, "utf8"))]).toEqual([file, false]);
    }
  });
});
