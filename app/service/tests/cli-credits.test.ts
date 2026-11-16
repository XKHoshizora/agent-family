import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { signUp } from "./helpers/actors.ts";
import { testDatabaseUrl } from "./helpers/env.ts";
import { useApp } from "./helpers/harness.ts";

const { app, db } = useApp();

const tsx = createRequire(import.meta.url).resolve("tsx/cli");
const cwd = fileURLToPath(new URL("..", import.meta.url));
const SITE_MODELS = JSON.stringify([
  {
    id: "fast", label: "Fast", tier: "free", protocol: "openai_chat", baseUrl: "https://api.example.test/v1", apiKeyEnv: "CLI_TEST_KEY",
    model: "fast-1", inputMicroPerToken: 1, outputMicroPerToken: 3, maxOutputTokens: 2048, contextTokens: 32000, vision: false, pdf: false, reasoning: ["low"],
  },
]);
const UPSTREAM_KEY = "super-secret-upstream-key";

/** Runs the CLI as a process; resolves with its exit code and output instead of rejecting. */
async function cli(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const env = {
    ...process.env,
    DATABASE_URL: testDatabaseUrl(),
    APP_ORIGIN: "http://localhost:5173",
    AUTH_SECRET: "test-secret-test-secret-test-secret-0000",
    PROVIDER_KEY_SECRET: "test-provider-key-secret-0000000000",
    AGENT_TIERS: JSON.stringify({ free: 20, plus: 50 }),
    SITE_MODELS,
    CLI_TEST_KEY: UPSTREAM_KEY,
  };
  try {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [tsx, "src/cli.ts", ...args], { cwd, env });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

const TIMEOUT = 60_000;

describe("credits:grant", () => {
  it("refuses an unknown handle", async () => {
    const r = await cli("credits:grant", "--handle", "nobody_here", "--points", "5");
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("no such handle");
    expect((await db.query("select 1 from balance_ledger")).rowCount).toBe(0);
  }, TIMEOUT);

  it("refuses an Agent's handle: accounts belong to human principals", async () => {
    const owner = await signUp(app, "cliowner");
    const { rows } = await db.query<{ id: string }>(
      "insert into principals (kind, handle, display_name, owner_id) values ('agent', 'cli_bot', 'Bot', $1) returning id",
      [owner.id],
    );
    await db.query("insert into agents (principal_id) values ($1)", [rows[0]!.id]);
    for (const args of [["credits:grant", "--points", "5"], ["credits:show"], ["tier:set", "--tier", "plus"]]) {
      const r = await cli(args[0]!, "--handle", "cli_bot", ...args.slice(1));
      expect([args[0], r.code === 0]).toEqual([args[0], false]);
      expect(r.stderr).toContain("Agent");
    }
    expect((await db.query("select 1 from balance_ledger")).rowCount).toBe(0);
    expect((await db.query("select 1 from accounts")).rowCount).toBe(0);
  }, TIMEOUT);

  it("refuses points that are not a decimal number with at most 6 fraction digits", async () => {
    const a = await signUp(app, "clipoints");
    for (const bad of ["abc", "1.0000001", "1e3", "", "0"]) {
      const r = await cli("credits:grant", "--handle", a.handle, "--points", bad);
      expect([bad, r.code === 0]).toEqual([bad, false]);
    }
    expect((await cli("credits:grant", "--handle", a.handle)).code).not.toBe(0);
    expect((await db.query("select 1 from balance_ledger")).rowCount).toBe(0);
  }, TIMEOUT);

  it("a grant of 5 then -2 shows 3, with the note in the ledger", async () => {
    const a = await signUp(app, "clisum");
    const first = await cli("credits:grant", "--handle", a.handle, "--points", "5", "--note", "welcome");
    expect(first.code).toBe(0);
    expect(first.stdout.trim()).toBe("5");
    const second = await cli("credits:grant", "--handle", a.handle, "--points", "-2");
    expect(second.code).toBe(0);
    expect(second.stdout.trim()).toBe("3");
    const show = await cli("credits:show", "--handle", a.handle);
    expect(show.code).toBe(0);
    expect(show.stdout).toContain("balance 3");
    expect(show.stdout).toContain("tier free");
    const { rows } = await db.query("select delta_micro::text d, reason, note from balance_ledger order by id");
    expect(rows).toEqual([
      { d: "5000000", reason: "grant", note: "welcome" },
      { d: "-2000000", reason: "grant", note: null },
    ]);
    // exact fractions
    expect((await cli("credits:grant", "--handle", a.handle, "--points", "0.000001")).stdout.trim()).toBe("3.000001");
  }, TIMEOUT);
});

describe("credits:show", () => {
  it("shows zero for a person with no account yet, and refuses an unknown handle", async () => {
    const a = await signUp(app, "clishow");
    const r = await cli("credits:show", "--handle", a.handle);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("balance 0");
    expect((await db.query("select 1 from accounts")).rowCount).toBe(0);
    expect((await cli("credits:show", "--handle", "nobody_here")).code).not.toBe(0);
  }, TIMEOUT);
});

describe("tier:set", () => {
  it("sets a tier named in AGENT_TIERS and refuses any other", async () => {
    const a = await signUp(app, "clitier");
    expect((await cli("tier:set", "--handle", a.handle, "--tier", "gold")).code).not.toBe(0);
    expect((await db.query("select 1 from accounts")).rowCount).toBe(0);
    const ok = await cli("tier:set", "--handle", a.handle, "--tier", "plus");
    expect(ok.code).toBe(0);
    expect((await db.query("select tier from accounts where principal_id = $1", [a.id])).rows).toEqual([{ tier: "plus" }]);
    expect((await cli("credits:show", "--handle", a.handle)).stdout).toContain("tier plus");
    expect((await cli("tier:set", "--handle", "nobody_here", "--tier", "free")).code).not.toBe(0);
  }, TIMEOUT);
});

describe("models:list", () => {
  it("prints id, label, tier, protocol and prices, never the key", async () => {
    const r = await cli("models:list");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("fast");
    expect(r.stdout).toContain("Fast");
    expect(r.stdout).toContain("free");
    expect(r.stdout).toContain("openai_chat");
    expect(r.stdout).toMatch(/in 1\b/);
    expect(r.stdout).toMatch(/out 3\b/);
    expect(r.stdout + r.stderr).not.toContain(UPSTREAM_KEY);
    expect(r.stdout + r.stderr).not.toContain("CLI_TEST_KEY");
  }, TIMEOUT);
});
