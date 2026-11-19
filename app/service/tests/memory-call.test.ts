import { afterEach, describe, expect, it } from "vitest";
import { endMemoryCalls, memoryCall, memoryModel, type MemoryCallDeps } from "../src/memory/call.ts";
import type { SiteModel } from "../src/config.ts";
import { api, signUp } from "./helpers/actors.ts";
import { useApp } from "./helpers/harness.ts";
import { costOf, METER_ENV, runningRun } from "./helpers/metering.ts";
import { scriptedGateway } from "./helpers/models.ts";

/**
 * The metered memory call (src/memory/call.ts; README "Usage and points"): one model call for an owner, recorded as a
 * run of purpose `memory` with no Agent, admitted against the owner's allowance or balance, settled on what was used.
 */

const gateway = scriptedGateway();
const log = { error: () => undefined, warn: () => undefined };
const { app, db } = useApp({ env: METER_ENV, models: gateway, agentWorker: false });

afterEach(() => {
  expect(gateway.pending()).toBe(0);
});

// Under what the call holds (about 0.1 point), so the whole cost is charged.
const USAGE = { inputTokens: 100, outputTokens: 50 } as const;
const INPUT = { system: "你是记忆助手。", user: "主人说：我喜欢喝茶。", maxOutputTokens: 100 } as const;
const never = new AbortController().signal;

const deps = (over: Partial<MemoryCallDeps> = {}): MemoryCallDeps => ({ db, models: gateway, config: app.deps.config, log, inFlight: new Set(), ...over });
const runs = async (ownerId: string) =>
  (
    await db.query(
      "select purpose, agent_id, conversation_id, status, error, lane, caller_id, source, model, charge_to, hold_micro::text as hold from agent_runs where owner_id = $1 order by created_at",
      [ownerId],
    )
  ).rows;
const records = async (ownerId: string) =>
  (
    await db.query(
      `select purpose, agent_id, source, model, input_tokens::text, output_tokens::text, cost_micro::text, free_micro::text,
              balance_micro::text, memory_micro::text, forgiven_micro::text, outcome
         from usage_records where owner_id = $1 order by id`,
      [ownerId],
    )
  ).rows;
const memoryUsed = async (ownerId: string) => (await db.query("select used_micro::text as used from memory_usage where owner_id = $1", [ownerId])).rows;
const freeUsed = async (ownerId: string) => (await db.query("select used_micro::text as used from free_usage where owner_id = $1", [ownerId])).rows;

describe("memoryCall", () => {
  it("is one usage record of purpose memory that charges the memory allowance, and returns the text", async () => {
    const owner = await signUp(app, "memcall");
    gateway.reply("  喜欢喝茶  ", { usage: USAGE });
    const inFlight = new Set<string>();
    const first = gateway.calls.length;
    const text = await memoryCall(deps({ inFlight }), owner.id, INPUT, never);
    expect(text).toBe("喜欢喝茶");
    expect(inFlight.size).toBe(0);

    const call = gateway.calls[first]!;
    expect({ system: call.system, reasoning: call.reasoning, maxOutputTokens: call.maxOutputTokens, model: call.model }).toEqual({
      system: INPUT.system,
      reasoning: "none",
      maxOutputTokens: 100,
      model: "upstream-meter_free",
    });
    expect(call.messages).toEqual([{ role: "user", parts: [{ type: "text", text: INPUT.user }] }]);

    expect(await runs(owner.id)).toEqual([
      { purpose: "memory", agent_id: null, conversation_id: null, status: "done", error: null, lane: "own", caller_id: owner.id, source: "site", model: "meter_free", charge_to: "memory", hold: "0" },
    ]);
    const cost = costOf(USAGE).toString();
    expect(await records(owner.id)).toEqual([
      { purpose: "memory", agent_id: null, source: "site", model: "meter_free", input_tokens: "100", output_tokens: "50", cost_micro: cost, free_micro: "0", balance_micro: "0", memory_micro: cost, forgiven_micro: "0", outcome: "done" },
    ]);
    expect(await freeUsed(owner.id)).toEqual([]);
    expect(await memoryUsed(owner.id)).toEqual([{ used: cost }]);
  });

  it("holds only what its own output limit allows, not the model's", async () => {
    // At the model's own limit (1 000 output tokens) the hold would be over 1 point; at 100 tokens it is about 0.1.
    const owner = await signUp(app, "memhold");
    const hold = gateway.hang();
    const pending = memoryCall(deps(), owner.id, INPUT, never);
    await hold.reached;
    const [run] = await runs(owner.id);
    expect(BigInt(run.hold)).toBeGreaterThan(100_000n);
    expect(BigInt(run.hold)).toBeLessThan(200_000n);
    hold.release("好", { usage: USAGE });
    expect(await pending).toBe("好");
  });

  it("without quota (the memory allowance used up): null, nothing recorded, no call", async () => {
    const owner = await signUp(app, "memnoquota");
    await db.query("insert into memory_usage (owner_id, day, used_micro) values ($1, (now() at time zone 'Asia/Shanghai')::date, 20000000)", [owner.id]);
    const before = gateway.calls.length;
    expect(await memoryCall(deps(), owner.id, INPUT, never)).toBeNull();
    expect(gateway.calls).toHaveLength(before);
    expect(await runs(owner.id)).toEqual([]);
    expect(await records(owner.id)).toEqual([]);
  });

  it("with no model to call: null, nothing recorded", async () => {
    const owner = await signUp(app, "memnomodel");
    const config = { ...app.deps.config, siteModels: [] };
    expect(await memoryCall(deps({ config }), owner.id, INPUT, never)).toBeNull();
    expect(await runs(owner.id)).toEqual([]);
  });

  it("a model that fails: null, charged only what the upstream reported, the hold released", async () => {
    const owner = await signUp(app, "memfail");
    gateway.fail("thinking_exhausted", { usage: USAGE });
    expect(await memoryCall(deps(), owner.id, INPUT, never)).toBeNull();
    expect(await runs(owner.id)).toMatchObject([{ status: "failed", error: "thinking_exhausted", hold: "0" }]);
    expect(await records(owner.id)).toMatchObject([{ purpose: "memory", outcome: "failed", cost_micro: costOf(USAGE).toString() }]);

    const other = await signUp(app, "memfail2");
    gateway.fail("provider_unavailable");
    expect(await memoryCall(deps(), other.id, INPUT, never)).toBeNull();
    expect(await runs(other.id)).toMatchObject([{ status: "failed", error: "provider_unavailable", hold: "0" }]);
    expect(await records(other.id)).toMatchObject([{ outcome: "failed", cost_micro: "0" }]);
  });

  it("a model that hangs is cut at the run time limit: null, no run left running, the hold released", async () => {
    const owner = await signUp(app, "memhang");
    gateway.hang();
    const config = { ...app.deps.config, agentRunTimeoutMs: 100 };
    expect(await memoryCall(deps({ config }), owner.id, INPUT, never)).toBeNull();
    expect(await runs(owner.id)).toMatchObject([{ status: "failed", error: "provider_unavailable", hold: "0" }]);
    expect(await records(owner.id)).toHaveLength(1);
  });

  it("an answer cut at its limit, or an empty one: null, and the call is still recorded", async () => {
    const owner = await signUp(app, "memcut");
    gateway.reply('{"half":', { usage: USAGE, truncated: true });
    expect(await memoryCall(deps(), owner.id, INPUT, never)).toBeNull();
    gateway.empty();
    expect(await memoryCall(deps(), owner.id, INPUT, never)).toBeNull();
    expect(await records(owner.id)).toHaveLength(2);
    expect((await runs(owner.id)).map((r) => r.hold)).toEqual(["0", "0"]);
  });

  it("closing mid-call abandons it: null, no run left running, nothing charged", async () => {
    const owner = await signUp(app, "memclose");
    const hold = gateway.hang();
    const closing = new AbortController();
    const inFlight = new Set<string>();
    const pending = memoryCall(deps({ inFlight }), owner.id, INPUT, closing.signal);
    await hold.reached;
    expect(inFlight.size).toBe(1);
    closing.abort();
    await endMemoryCalls();
    expect(await pending).toBeNull();
    expect(inFlight.size).toBe(0);
    expect(await runs(owner.id)).toMatchObject([{ status: "failed", hold: "0" }]);
    expect(await records(owner.id)).toMatchObject([{ purpose: "memory", free_micro: "0", balance_micro: "0" }]);
    expect(await freeUsed(owner.id)).toEqual([]);
    // Already closing: no run is begun at all.
    expect(await memoryCall(deps(), owner.id, INPUT, closing.signal)).toBeNull();
    expect(await runs(owner.id)).toHaveLength(1);
  });

  it("is refused while the owner has as many calls running as the limit", async () => {
    const owner = await signUp(app, "memcap");
    for (let i = 0; i < app.deps.config.agentMaxConcurrentRuns; i++) await runningRun(db, owner.id);
    const before = gateway.calls.length;
    expect(await memoryCall(deps(), owner.id, INPUT, never)).toBeNull();
    expect(gateway.calls).toHaveLength(before);
    expect((await runs(owner.id)).filter((r) => r.purpose === "memory")).toEqual([]);
  });

  it("charges only its owner", async () => {
    const [a, b] = [await signUp(app, "memown_a"), await signUp(app, "memown_b")];
    gateway.reply("好", { usage: USAGE });
    await memoryCall(deps(), a.id, INPUT, never);
    expect(await records(b.id)).toEqual([]);
    expect(await freeUsed(b.id)).toEqual([]);
  });

  it("MEMORY.model overrides the cheapest: a paid-tier model is charged to the memory allowance too", async () => {
    const owner = await signUp(app, "memoverride");
    const config = { ...app.deps.config, memory: { ...app.deps.config.memory, model: "meter_paid" } };
    gateway.reply("好", { usage: USAGE });
    const first = gateway.calls.length;
    expect(await memoryCall(deps({ config }), owner.id, INPUT, never)).toBe("好");
    expect(gateway.calls[first]!.model).toBe("upstream-meter_paid");
    const cost = costOf(USAGE).toString();
    expect(await records(owner.id)).toMatchObject([{ purpose: "memory", model: "meter_paid", memory_micro: cost, balance_micro: "0", free_micro: "0" }]);
  });
});

describe("memoryModel", () => {
  const site = (id: string, tier: "free" | "paid", input: number, output: number): SiteModel => ({
    id,
    label: id,
    tier,
    protocol: "openai_chat",
    baseUrl: "https://api.example.test/v1",
    apiKeyEnv: "METER_UPSTREAM_KEY",
    model: id,
    inputMicroPerToken: input,
    outputMicroPerToken: output,
    maxOutputTokens: 1000,
    contextTokens: 100_000,
    vision: false,
    pdf: false,
    reasoning: [],
  });
  const models = [site("b_mid", "free", 1, 4), site("c_cheap", "free", 1, 1), site("a_cheap", "free", 2, 1), site("d_cheaper_paid", "paid", 0, 0)];
  const memory = (model: string | null) => ({ ...app.deps.config.memory, model });

  it("is the free-tier site model with the lowest input plus output price, the lowest id among equals", () => {
    expect(memoryModel({ siteModels: models, memory: memory(null) })?.id).toBe("c_cheap");
    expect(memoryModel({ siteModels: [site("z", "free", 1, 1), site("y", "free", 1, 1)], memory: memory(null) })?.id).toBe("y");
    expect(memoryModel({ siteModels: [...models].reverse(), memory: memory(null) })?.id).toBe("c_cheap");
  });

  it("is MEMORY.model when it names a site model (of any tier), else the cheapest", () => {
    expect(memoryModel({ siteModels: models, memory: memory("d_cheaper_paid") })?.id).toBe("d_cheaper_paid");
    expect(memoryModel({ siteModels: models, memory: memory("nope") })?.id).toBe("c_cheap");
  });

  it("is null when no site model is free-tier and none is named", () => {
    expect(memoryModel({ siteModels: [site("p", "paid", 1, 1)], memory: memory(null) })).toBeNull();
    expect(memoryModel({ siteModels: [], memory: memory(null) })).toBeNull();
  });
});

describe("GET /api/usage", () => {
  it("every recent row carries its purpose: drafts and memory calls apart", async () => {
    const owner = await signUp(app, "memusage");
    gateway.reply("好", { usage: USAGE });
    await memoryCall(deps(), owner.id, INPUT, never);
    const draft = await runningRun(db, owner.id);
    await db.query(
      "insert into usage_records (owner_id, run_id, purpose, source, model, cost_micro, free_micro, outcome) values ($1, $2, 'draft', 'site', 'meter_free', 50000, 50000, 'done')",
      [owner.id, draft],
    );
    const { json } = await api(app, owner, "GET", "/api/usage");
    expect(json.recent).toEqual([
      { agentId: null, purpose: "memory", model: "meter_free", source: "site", points: "0.06", replies: 0, paidBy: "site" },
      { agentId: null, purpose: "draft", model: "meter_free", source: "site", points: "0.05", replies: 0 },
    ]);
  });
});
