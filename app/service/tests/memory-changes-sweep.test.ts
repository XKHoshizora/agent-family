import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { siteDay } from "../src/accounts/store.ts";
import { buildApp } from "../src/app.ts";
import { CHANGE_KEEP_DAYS, CHANGE_SWEEP_BATCH, sweepMemoryChanges } from "../src/memory/sweep.ts";
import { api, signUp } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { testDatabaseUrl } from "./helpers/env.ts";
import { useApp } from "./helpers/harness.ts";

/**
 * The record of what a review changed (`memory_changes`) is kept for the owner's undo and confirm, not forever: a change that is over
 * (applied, undone, discarded) is deleted once it is older than `CHANGE_KEEP_DAYS` days, and a pending one that old is discarded
 * (nobody will answer it now). Run by the periodic sweep (app.ts); the clock is the function's own argument.
 */

const { app, db } = useApp({ env: { ...SITE_ENV, RATE_LIMIT_SCALE: "1000" }, agentWorker: false });
const DAY = 86_400_000;

let counter = 0;
async function world() {
  const owner = await signUp(app, `swp_owner${++counter}`);
  const agent = await mustCreateAgent(app, owner);
  return { owner, agent, conv: agent.conversationId as string };
}
type World = Awaited<ReturnType<typeof world>>;

/** A change of `status` made `days` days ago (and, when resolved, resolved then). */
async function change(w: World, status: "applied" | "undone" | "pending" | "discarded", days: number, resolvedDaysAgo: number | null = null): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into memory_changes (owner_id, agent_id, conversation_id, status, ops, created_at, resolved_at)
     values ($1, $2, $3, $4, '[]'::jsonb, now() - $5::int * interval '1 day', case when $6::int is null then null else now() - $6::int * interval '1 day' end) returning id`,
    [w.owner.id, w.agent.id, w.conv, status, days, resolvedDaysAgo],
  );
  return rows[0]!.id;
}
const statusOf = async (id: string) => (await db.query<{ status: string }>("select status from memory_changes where id = $1", [id])).rows[0]?.status ?? null;

describe("the sweep of memory changes", () => {
  it("keeps a change for 30 days", () => {
    expect(CHANGE_KEEP_DAYS).toBe(30);
  });

  it("deletes the changes that are over once they are older than that, by when they were resolved (made, for one applied at once); keeps the rest", async () => {
    const w = await world();
    const oldApplied = await change(w, "applied", 40);
    const oldUndone = await change(w, "undone", 45, 35);
    const oldDiscarded = await change(w, "discarded", 50, 31);
    // Made long ago but resolved only lately: kept until 30 days after that.
    const lateUndone = await change(w, "undone", 60, 5);
    const young = await change(w, "applied", 29);
    const counts = await sweepMemoryChanges(db);
    expect(counts.deleted).toBe(3);
    expect(await statusOf(oldApplied)).toBeNull();
    expect(await statusOf(oldUndone)).toBeNull();
    expect(await statusOf(oldDiscarded)).toBeNull();
    expect(await statusOf(lateUndone)).toBe("undone");
    expect(await statusOf(young)).toBe("applied");
  });

  it("discards a pending change older than 30 days (it is then kept 30 more days, like any discarded one); a younger one stays pending", async () => {
    const w = await world();
    const stale = await change(w, "pending", 31);
    const waiting = await change(w, "pending", 3);
    const counts = await sweepMemoryChanges(db);
    expect(counts).toMatchObject({ discarded: 1, deleted: 0 });
    expect(await statusOf(stale)).toBe("discarded");
    expect(await statusOf(waiting)).toBe("pending");
    expect((await db.query("select resolved_at is not null as done from memory_changes where id = $1", [stale])).rows[0]).toEqual({ done: true });
  });

  it("a pending change confirmed while the sweep waits for its row is not discarded over it: the status is asked again in the update itself", async () => {
    const w = await world();
    const id = await change(w, "pending", 31);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const lockedNow = new Promise<void>((r) => (locked = r));
    // A confirm: it holds the change's row, then writes it applied and commits.
    const confirm = db.tx(async (t) => {
      await t.query("select status from memory_changes where id = $1 for update", [id]);
      locked();
      await held;
      await t.query("update memory_changes set status = 'applied', resolved_at = now() where id = $1", [id]);
    });
    await lockedNow;
    // The sweep, on another connection, reads the change as pending and waits for its row.
    const sweeping = sweepMemoryChanges(db);
    await vi.waitFor(
      async () => {
        const { rows } = await db.query<{ n: number }>("select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and query like '%update memory_changes set status = ''discarded''%'");
        expect(rows[0]!.n).toBeGreaterThan(0);
      },
      { timeout: 5000 },
    );
    release();
    await confirm;
    expect((await sweeping).discarded).toBe(0);
    expect(await statusOf(id)).toBe("applied");
  });

  it("the clock is the function's: the same rows are kept at day 29 and gone at day 31", async () => {
    const w = await world();
    const id = await change(w, "applied", 0);
    await sweepMemoryChanges(db, new Date(Date.now() + 29 * DAY));
    expect(await statusOf(id)).toBe("applied");
    await sweepMemoryChanges(db, new Date(Date.now() + 31 * DAY));
    expect(await statusOf(id)).toBeNull();
  });

  it("an undo of a change that is gone answers 404; a confirm of one that was discarded is stale", async () => {
    const w = await world();
    const gone = await change(w, "applied", 40);
    const stale = await change(w, "pending", 40);
    await sweepMemoryChanges(db);
    const base = `/api/agents/${w.agent.id}/memory/changes`;
    expect((await api(app, w.owner, "POST", `${base}/${gone}/undo`)).status).toBe(404);
    expect((await api(app, w.owner, "POST", `${base}/${stale}/confirm`)).status).toBe(409);
  });

  it("is bounded: at most `batches` batches of `batch` rows a run (500 and 20 by default), the rest on the next run", async () => {
    const w = await world();
    for (let i = 0; i < 5; i++) await change(w, "applied", 40 + i);
    for (let i = 0; i < 3; i++) await change(w, "pending", 40 + i);
    expect(CHANGE_SWEEP_BATCH).toBe(500);
    // 3 pending ones are discarded 2 + 1 (within 2 batches); then the deletes: 2 batches of 2 of the 5 applied (+ the 3 just discarded are not old by resolved_at).
    const first = await sweepMemoryChanges(db, new Date(), { batch: 2, batches: 2 });
    expect(first).toEqual({ discarded: 3, deleted: 4 });
    expect((await db.query("select count(*)::int as n from memory_changes")).rows[0].n).toBe(4);
    const next = await sweepMemoryChanges(db, new Date(), { batch: 2, batches: 2 });
    expect(next.deleted).toBe(1);
  });

  it("has an index on (status, resolved_at) for it", async () => {
    const { rows } = await db.query<{ indexdef: string }>("select indexdef from pg_indexes where tablename = 'memory_changes'");
    expect(rows.some((r) => /\(status, resolved_at\)/.test(r.indexdef))).toBe(true);
  });

  it("runs on its own schedule (MEMORY.changesSweepMs): also when the attachment sweep is switched off (SWEEP_INTERVAL_MINUTES 0)", async () => {
    const w = await world();
    const old = await change(w, "applied", 40);
    const sweeping = await buildApp({ config: { ...app.deps.config, sweepIntervalMinutes: 0, memory: { ...app.deps.config.memory, changesSweepMs: 3_600_000 } }, db, blobs: app.deps.blobs }, { sweepInitialDelayMs: 20 });
    try {
      await sweeping.ready();
      await vi.waitFor(async () => expect(await statusOf(old)).toBeNull(), { timeout: 5000 });
    } finally {
      await sweeping.close();
    }
  });

  it("runs inside the app, with the attachment sweep the server already schedules", async () => {
    const w = await world();
    const old = await change(w, "applied", 40);
    const sweeping = await buildApp({ config: { ...app.deps.config, sweepIntervalMinutes: 15, memory: { ...app.deps.config.memory, changesSweepMs: 3_600_000 } }, db, blobs: app.deps.blobs }, { sweepInitialDelayMs: 20 });
    try {
      await sweeping.ready();
      await vi.waitFor(async () => expect(await statusOf(old)).toBeNull(), { timeout: 5000 });
    } finally {
      await sweeping.close();
    }
  });

  it("run by hand (attachments:sweep), the cards it discards are counted (card_expired) on the site's day, as the server counts them", async () => {
    const w = await world();
    await change(w, "pending", 31);
    // A zone whose day is not UTC's at this moment: UTC+14 from 10:00 UTC on, UTC−12 before it.
    const zone = new Date().getUTCHours() >= 10 ? "Etc/GMT-14" : "Etc/GMT+12";
    const before = siteDay(new Date(), zone);
    expect(before).not.toBe(new Date().toISOString().slice(0, 10));
    const blobDir = mkdtempSync(join(tmpdir(), "af-sweep-"));
    try {
      const env = {
        ...process.env,
        DATABASE_URL: testDatabaseUrl(),
        BLOB_DIR: blobDir,
        APP_ORIGIN: "http://localhost:5173",
        AUTH_SECRET: "test-secret-test-secret-test-secret-0000",
        PROVIDER_KEY_SECRET: "test-provider-key-secret-0000000000",
        SITE_TIMEZONE: zone,
        S3_ENDPOINT: "",
        S3_REGION: "",
        S3_BUCKET: "",
        S3_ACCESS_KEY_ID: "",
        S3_SECRET_ACCESS_KEY: "",
      };
      const tsx = createRequire(import.meta.url).resolve("tsx/cli");
      const cwd = fileURLToPath(new URL("..", import.meta.url));
      const { stdout } = await promisify(execFile)(process.execPath, [tsx, "src/cli.ts", "attachments:sweep"], { cwd, env });
      expect(stdout).toContain("discarded 1 that nobody answered");
    } finally {
      rmSync(blobDir, { recursive: true, force: true });
    }
    const rows = (await db.query<{ day: string; n: number }>("select day::text as day, n::int as n from memory_stats where name = 'card_expired'")).rows;
    expect(rows).toHaveLength(1);
    expect([before, siteDay(new Date(), zone)]).toContain(rows[0]!.day);
    expect(rows[0]!.n).toBe(1);
  }, 60_000);

  it("changesSweepMs 0 is no timer at all, whatever SWEEP_INTERVAL_MINUTES says; the test harness sets 0", async () => {
    expect(app.deps.config.memory.changesSweepMs).toBe(0);
    const w = await world();
    const old = await change(w, "applied", 40);
    const quiet = await buildApp({ config: { ...app.deps.config, sweepIntervalMinutes: 15, memory: { ...app.deps.config.memory, changesSweepMs: 0 } }, db, blobs: app.deps.blobs }, { sweepInitialDelayMs: 20 });
    try {
      await quiet.ready();
      await new Promise((r) => setTimeout(r, 300));
      expect(await statusOf(old)).toBe("applied");
    } finally {
      await quiet.close();
    }
  });
});
