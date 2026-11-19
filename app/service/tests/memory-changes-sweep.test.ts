import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.ts";
import { CHANGE_KEEP_DAYS, sweepMemoryChanges } from "../src/memory/sweep.ts";
import { api, signUp } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
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

  it("runs inside the app, with the attachment sweep the server already schedules", async () => {
    const w = await world();
    const old = await change(w, "applied", 40);
    const sweeping = await buildApp({ config: { ...app.deps.config, sweepIntervalMinutes: 15 }, db, blobs: app.deps.blobs }, { sweepInitialDelayMs: 20 });
    try {
      await sweeping.ready();
      await vi.waitFor(async () => expect(await statusOf(old)).toBeNull(), { timeout: 5000 });
    } finally {
      await sweeping.close();
    }
  });
});
