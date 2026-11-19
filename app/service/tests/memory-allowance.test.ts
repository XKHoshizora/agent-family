import { afterEach, describe, expect, it } from "vitest";
import { siteDay } from "../src/accounts/store.ts";
import { memoryCall, type MemoryCallDeps } from "../src/memory/call.ts";
import { admitRun } from "../src/metering/admit.ts";
import { api, signUp, type Actor } from "./helpers/actors.ts";
import { useApp } from "./helpers/harness.ts";
import { costOf, ESTIMATE, grant, meteredAgent, METER_ENV, runningRun } from "./helpers/metering.ts";
import { providerBody } from "./helpers/providers.ts";
import { scriptedGateway } from "./helpers/models.ts";

/**
 * Memory has its own daily allowance, paid by the site (`MEMORY.freeDailyPoints`, README "Usage and points"): a memory call on
 * a site model is charged to `memory_usage`, never to the owner's free allowance or balance; at the allowance no call is made
 * for the rest of the site day while replies go on; a model of the owner's own provider is unmetered.
 */

const gateway = scriptedGateway();
const log = { error: () => undefined, warn: () => undefined };
// The allowance is 1 point: about ten calls of the size below.
const { app, db } = useApp({ env: { ...METER_ENV, MEMORY: JSON.stringify({ freeDailyPoints: 1 }) }, models: gateway, agentWorker: false });

afterEach(() => {
  expect(gateway.pending()).toBe(0);
});

const USAGE = { inputTokens: 100, outputTokens: 50 } as const;
const INPUT = { system: "你是记忆助手。", user: "主人说：我喜欢喝茶。", maxOutputTokens: 100 } as const;
const never = new AbortController().signal;
const deps = (over: Partial<MemoryCallDeps> = {}): MemoryCallDeps => ({ db, models: gateway, config: app.deps.config, log, inFlight: new Set(), ...over });
const today = () => siteDay(new Date(), app.deps.config.siteTimezone);
const memoryUsed = async (ownerId: string) => (await db.query("select day::text as day, used_micro::text as used from memory_usage where owner_id = $1 order by day", [ownerId])).rows;
const freeUsed = async (ownerId: string) => (await db.query("select used_micro::text as used from free_usage where owner_id = $1", [ownerId])).rows;
const balance = async (ownerId: string) => (await db.query("select balance_micro::text as b from accounts where principal_id = $1", [ownerId])).rows[0]?.b;
const records = async (ownerId: string) =>
  (await db.query("select purpose, free_micro::text, balance_micro::text, memory_micro::text, forgiven_micro::text, cost_micro::text from usage_records where owner_id = $1 order by id", [ownerId])).rows;
const runs = async (ownerId: string) =>
  (await db.query("select purpose, status, charge_to, hold_micro::text as hold from agent_runs where owner_id = $1 order by created_at", [ownerId])).rows;
const usage = async (who: Actor) => (await api(app, who, "GET", "/api/usage")).json;
const fill = (ownerId: string, day: string, micro: number) =>
  db.query("insert into memory_usage (owner_id, day, used_micro) values ($1, $2::date, $3)", [ownerId, day, micro]);

describe("the memory allowance", () => {
  it("a memory call on a site model is charged to the memory allowance, not to the free allowance or the balance", async () => {
    const owner = await signUp(app, "alwsite");
    gateway.reply("好", { usage: USAGE });
    expect(await memoryCall(deps(), owner.id, INPUT, never)).toBe("好");
    const cost = costOf(USAGE).toString();
    expect(await runs(owner.id)).toEqual([{ purpose: "memory", status: "done", charge_to: "memory", hold: "0" }]);
    expect(await records(owner.id)).toEqual([{ purpose: "memory", free_micro: "0", balance_micro: "0", memory_micro: cost, forgiven_micro: "0", cost_micro: cost }]);
    expect(await memoryUsed(owner.id)).toEqual([{ day: today(), used: cost }]);
    expect(await freeUsed(owner.id)).toEqual([]);
    expect(await balance(owner.id)).toBe("0");
  });

  it("the usage answer: free allowance and canStartFreeReply ignore memory rows; memory has its own figures; its rows are paid by the site", async () => {
    const owner = await signUp(app, "alwusage");
    gateway.reply("好", { usage: USAGE });
    await memoryCall(deps(), owner.id, INPUT, never);
    const json = await usage(owner);
    expect(json.free.used).toBe("0");
    expect(json.canStartFreeReply).toBe(true);
    expect(json.memory).toEqual({ allowance: "1", used: "0.06", resetsAt: json.free.resetsAt });
    expect(json.recent).toEqual([{ agentId: null, purpose: "memory", model: "meter_free", source: "site", points: "0.06", replies: 0, paidBy: "site" }]);
  });

  it("a memory row is paid by the site only when nothing of it was charged to the owner: a row from before the allowance (charged to free points) is not mislabelled", async () => {
    const owner = await signUp(app, "alwold");
    gateway.reply("好", { usage: USAGE });
    await memoryCall(deps(), owner.id, INPUT, never);
    await db.query("update usage_records set free_micro = 60000, memory_micro = 0 where owner_id = $1 and purpose = 'memory'", [owner.id]);
    const { json } = await api(app, owner, "GET", "/api/usage");
    expect(json.recent[0]).toMatchObject({ purpose: "memory", points: "0.06" });
    expect(json.recent[0].paidBy).toBeUndefined();
  });

  it("while a memory call runs its hold counts against the memory allowance only", async () => {
    const owner = await signUp(app, "alwhold");
    // The free allowance is nearly all used: a memory hold must not take the little that is left of it.
    await db.query("insert into free_usage (owner_id, day, used_micro) values ($1, $2::date, $3)", [owner.id, today(), app.deps.config.freeDailyMicro - 1000n]);
    const hold = gateway.hang();
    const pending = memoryCall(deps(), owner.id, INPUT, never);
    await hold.reached;
    const [run] = await runs(owner.id);
    expect(run).toMatchObject({ charge_to: "memory" });
    expect(BigInt(run!.hold)).toBeGreaterThan(0n);
    expect((await usage(owner)).canStartFreeReply).toBe(true);
    // The hold is about 0.1 point of the 1 point: nine more would not all fit, but the free allowance is whole.
    hold.release("好", { usage: USAGE });
    await pending;
  });

  it("two memory calls of one owner started together overrun the allowance by at most one call: the second sees the first's hold", async () => {
    const owner = await signUp(app, "alwtwo");
    await fill(owner.id, today(), 950_000);
    const hold = gateway.hang();
    const first = memoryCall(deps(), owner.id, INPUT, never);
    await hold.reached;
    const before = gateway.calls.length;
    expect(await memoryCall(deps(), owner.id, INPUT, never)).toBeNull();
    expect(gateway.calls).toHaveLength(before);
    hold.release("好", { usage: USAGE });
    await first;
    expect(BigInt((await memoryUsed(owner.id))[0]!.used)).toBeLessThanOrEqual(1_000_000n + costOf(USAGE));
  });

  it("a stale run charged to memory (a crash) is swept: nothing is charged, neither to the memory allowance nor to the free allowance or the balance, and its hold is released", async () => {
    const owner = await signUp(app, "alwcrash");
    await fill(owner.id, today(), 100_000);
    // Something in the free allowance and the balance, for the sweep to leave alone.
    await grant(db, owner.id, 5_000_000n);
    await db.query("insert into free_usage (owner_id, day, used_micro) values ($1, $2::date, 200000)", [owner.id, today()]);
    await db.query(
      `insert into agent_runs (owner_id, purpose, lane, status, charge_to, hold_micro, source, model, reasoning, created_at, started_at)
       values ($1, 'memory', 'own', 'running', 'memory', 500000, 'site', 'meter_free', 'none', now() - interval '1 day', now() - interval '1 day')`,
      [owner.id],
    );
    const { rows } = await db.query("select hold_micro::text as hold from agent_runs where owner_id = $1", [owner.id]);
    expect(rows[0]).toEqual({ hold: "500000" });
    expect(await app.staleRunSweep.run()).toBe(1);
    expect(await memoryUsed(owner.id)).toEqual([{ day: today(), used: "100000" }]);
    expect(await freeUsed(owner.id)).toEqual([{ used: "200000" }]);
    expect(await balance(owner.id)).toBe("5000000");
    expect((await db.query("select count(*)::int as n from usage_records where owner_id = $1 and (free_micro <> 0 or balance_micro <> 0)", [owner.id])).rows[0].n).toBe(0);
    expect((await db.query("select status from agent_runs where owner_id = $1 and status = 'running'", [owner.id])).rows).toEqual([]);
  });

  it("at the allowance no call is made and nothing is recorded, while a reply still starts", async () => {
    const owner = await signUp(app, "alwfull");
    await fill(owner.id, today(), 1_000_000);
    const before = gateway.calls.length;
    expect(await memoryCall(deps(), owner.id, INPUT, never)).toBeNull();
    expect(gateway.calls).toHaveLength(before);
    expect(await runs(owner.id)).toEqual([]);
    expect(await records(owner.id)).toEqual([]);
    expect(await balance(owner.id)).toBeUndefined();

    const agent = await meteredAgent(app, db, owner, { source: "site", id: "meter_free" });
    const run = await runningRun(db, owner.id, agent);
    const admission = await db.tx((t) => admitRun(t, app.deps.config, run, owner.id, agent.resolved, ESTIMATE, new Date()));
    expect(admission.chargeTo).toBe("free");
    expect((await usage(owner)).memory).toMatchObject({ allowance: "1", used: "1" });
  });

  it("the allowance is per site day: yesterday's use does not count today", async () => {
    const owner = await signUp(app, "alwday");
    const yesterday = new Date(Date.now() - 24 * 3_600_000);
    await fill(owner.id, siteDay(yesterday, app.deps.config.siteTimezone), 1_000_000);
    gateway.reply("好", { usage: USAGE });
    expect(await memoryCall(deps(), owner.id, INPUT, never)).toBe("好");
    expect((await usage(owner)).memory.used).toBe("0.06");
  });

  it("a call that costs more than is left is charged what is left; the rest is forgiven", async () => {
    const owner = await signUp(app, "alwover");
    await fill(owner.id, today(), 990_000);
    gateway.reply("好", { usage: USAGE });
    expect(await memoryCall(deps(), owner.id, INPUT, never)).toBe("好");
    expect(await records(owner.id)).toEqual([
      { purpose: "memory", free_micro: "0", balance_micro: "0", memory_micro: "10000", forgiven_micro: (costOf(USAGE) - 10_000n).toString(), cost_micro: costOf(USAGE).toString() },
    ]);
    expect((await memoryUsed(owner.id))[0]!.used).toBe("1000000");
  });

  it("a paid-tier memory model is the site's too: never the balance", async () => {
    const owner = await signUp(app, "alwpaid");
    const paid = { ...app.deps.config, memory: { ...app.deps.config.memory, model: "meter_paid" } };
    gateway.reply("好", { usage: USAGE });
    expect(await memoryCall(deps({ config: paid }), owner.id, INPUT, never)).toBe("好");
    expect(await records(owner.id)).toMatchObject([{ memory_micro: costOf(USAGE).toString(), balance_micro: "0" }]);
    expect(await balance(owner.id)).toBe("0");
  });

  it("freeDailyPoints 0 turns the site-paid memory off", async () => {
    const owner = await signUp(app, "alwzero");
    const off = { ...app.deps.config, memory: { ...app.deps.config.memory, freeDailyPoints: 0 } };
    const before = gateway.calls.length;
    expect(await memoryCall(deps({ config: off }), owner.id, INPUT, never)).toBeNull();
    expect(gateway.calls).toHaveLength(before);
    expect(await runs(owner.id)).toEqual([]);
  });

  it("a model of the owner's own provider is unmetered, whatever the allowance has used", async () => {
    const owner = await signUp(app, "alwown");
    await fill(owner.id, today(), 1_000_000);
    const added = await api(app, owner, "POST", "/api/providers", providerBody({ name: "P", baseUrl: "https://own.example.test/v1", models: [{ name: "own-model", contextTokens: 50_000 }] }));
    const choice = { source: "provider", providerId: added.json.id, model: "own-model" };
    expect((await api(app, owner, "PATCH", "/api/me", { memoryModel: choice })).status).toBe(200);
    gateway.reply("好", { usage: USAGE });
    expect(await memoryCall(deps(), owner.id, INPUT, never)).toBe("好");
    expect(await runs(owner.id)).toEqual([{ purpose: "memory", status: "done", charge_to: null, hold: "0" }]);
    expect(await records(owner.id)).toMatchObject([{ memory_micro: "0", free_micro: "0", balance_micro: "0" }]);
    expect(await memoryUsed(owner.id)).toEqual([{ day: today(), used: "1000000" }]);
  });
});
