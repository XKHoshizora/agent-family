import { afterEach, describe, expect, it } from "vitest";
import { createAgentPort, staleAfterMs, type DbAgentPort, type Toolbox } from "../src/agents/port-impl.ts";
import { isRunEnd, type Prepared, type ToolOutcome } from "../src/agents/runtime/port.ts";
import { createAgentWorker, type AgentWorker } from "../src/agents/runtime/worker.ts";
import type { Config } from "../src/config.ts";
import { holdTokens } from "../src/metering/tokens.ts";
import type { ModelCall, ToolCall, ToolSpec } from "../src/models/gateway.ts";
import { api, group, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { costOf, grant, METER_ENV } from "./helpers/metering.ts";
import { scriptedGateway, type ScriptedGateway } from "./helpers/models.ts";
import { providerBody } from "./helpers/providers.ts";
import { closeAllSockets } from "./helpers/ws.ts";

/**
 * The money of a reply that offers tools (agents/runtime/worker.ts, port-impl.ts `extend`, metering/admit.ts
 * `raiseHold`): one admission, a hold raised between rounds to what the reply has cost so far and the most its next call
 * can cost, a cap on what its tool rounds spend (`TOOLS.maxPoints`), the lanes' budgets read again with what it has
 * cost, and one settlement on the rounds' summed usage. On the real port and database, the meter models (METER_ENV: 100
 * micro-points an input token, 1 000 an output token, at most 1 000 output tokens, a context of 100 000; 3 free points a
 * day), with tools offered through a toolbox the test gives the port.
 */

const { app, db } = useApp({ env: METER_ENV, agentWorker: false });

afterEach(async () => {
  await closeAllSockets();
});

const FINAL_LINE = "你已经不能再查了，请用上面查到的内容直接回答。";
const FREE = { source: "site", id: "meter_free" } as const;
const PAID = { source: "site", id: "meter_paid" } as const;
const POINT = 1_000_000n;
/** The meter models' output limit and context. */
const MAX_OUT = 1000;
const CONTEXT = 100_000;

const SEARCH: ToolSpec = {
  name: "search",
  description: "Search this conversation's messages.",
  parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
};
const TOOLS = [SEARCH];

const U = (inputTokens: number, outputTokens: number) => ({ inputTokens, outputTokens });
const plus = (...us: Array<{ inputTokens: number; outputTokens: number }>) =>
  us.reduce((a, b) => U(a.inputTokens + b.inputTokens, a.outputTokens + b.outputTokens), U(0, 0));

/** A toolbox that offers the search tool and runs it with `run` (default: an empty result at once). */
function toolbox(run: (call: ToolCall) => Promise<ToolOutcome> | ToolOutcome = () => ({ output: { hits: [] }, activity: "search" })): Toolbox {
  return { offer: () => ({ tools: TOOLS, perTool: { search: 6 } }), run: async (_run, call) => run(call) };
}

/** The app's own port, but with `box`, and a worker on it run by hand. */
function toolWorker(gateway: ScriptedGateway, box: Toolbox | null = toolbox(), config: Config = app.deps.config): { port: DbAgentPort; worker: AgentWorker } {
  const { db: pool, blobs, conversations, reads } = app.deps;
  const port = createAgentPort({ db: pool, config, blobs, realtime: app.realtime, conversations, reads, log: app.log, toolbox: box });
  const worker = createAgentWorker({ port, models: gateway, runTimeoutMs: config.agentRunTimeoutMs, maxRunsInFlight: 1, background: false, log: app.log, tools: config.tools });
  return { port, worker };
}

const withTools = (over: Partial<Config["tools"]>): Config => ({ ...app.deps.config, tools: { ...app.deps.config.tools, ...over } });

let txn = 0;
const say = async (who: Actor, conv: string, text: string) => {
  const sent = await api(app, who, "POST", `/api/conversations/${conv}/messages`, { text, clientTxn: `tm${++txn}` });
  expect(sent.status).toBe(201);
};

async function owned(name: string, model: typeof FREE | typeof PAID | { source: "provider"; providerId: string; model: string } = FREE, over: Record<string, unknown> = {}) {
  const owner = await signUp(app, name);
  const agent = await mustCreateAgent(app, owner, { model, persona: "简短地回答。", ...over });
  return { owner, agent, conv: agent.conversationId as string };
}

const runOf = async (ownerId: string) =>
  (
    await db.query<{ id: string; status: string; error: string | null; hold: string; input_estimate: number | null }>(
      "select id, status, error, hold_micro::text as hold, input_estimate from agent_runs where owner_id = $1 and purpose = 'reply' order by created_at desc limit 1",
      [ownerId],
    )
  ).rows[0]!;
const holdOf = async (runId: string) => BigInt((await db.query<{ hold: string }>("select hold_micro::text as hold from agent_runs where id = $1", [runId])).rows[0]!.hold);
const recordsOf = async (runId: string) =>
  (
    await db.query(
      `select input_tokens::int as input, output_tokens::int as output, estimated, source, outcome, cost_micro::text as cost, free_micro::text as free,
              balance_micro::text as balance, forgiven_micro::text as forgiven
         from usage_records where run_id = $1`,
      [runId],
    )
  ).rows;
const freeUsed = async (ownerId: string) =>
  (await db.query<{ used: string }>("select coalesce(sum(used_micro), 0)::text as used from free_usage where owner_id = $1", [ownerId])).rows[0]!.used;

/** The text parts a call sends. */
const textsOf = (call: ModelCall) => call.messages.flatMap((m) => m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])));
/** The most the call after `call`'s rounds can take as input, as the hold counts it: what `call` sends, the last call's line too. */
const nextInput = (call: ModelCall) =>
  holdTokens([`${call.system}\n\n${FINAL_LINE}`, ...textsOf(call), JSON.stringify(call.tools), JSON.stringify(call.steps ?? [])], CONTEXT, MAX_OUT);
/** The most one call of `inputTokens` can cost on a meter model. */
const callMax = (inputTokens: number) => BigInt(inputTokens) * 100n + BigInt(MAX_OUT) * 1000n;
const isFinal = (call: ModelCall) => call.toolChoice === "none" && call.system.endsWith(`\n\n${FINAL_LINE}`);

describe("the money of a reply that offers tools", () => {
  it("three rounds are admitted once and settled once: one usage record, its tokens the rounds' sums, charged once; the run teaches the ratio nothing", async () => {
    const gateway = scriptedGateway()
      .callTools([{ name: "search", input: { query: "a" } }], { usage: U(1000, 50) })
      .callTools([{ name: "search", input: { query: "b" } }], { usage: U(1500, 60) })
      .reply("去吃川菜。", { usage: U(2000, 70) });
    const { worker } = toolWorker(gateway);
    const { owner, conv } = await owned("sumup");
    await say(owner, conv, "附近有什么好吃的？");
    expect(await worker.runOnce()).toBe(true);

    expect(gateway.calls).toHaveLength(3);
    expect(gateway.calls[0]!.tools).toEqual(TOOLS);
    const run = await runOf(owner.id);
    expect(run).toMatchObject({ status: "done", hold: "0", input_estimate: null });
    const total = plus(U(1000, 50), U(1500, 60), U(2000, 70));
    const cost = costOf(total).toString();
    expect(await recordsOf(run.id)).toEqual([{ input: total.inputTokens, output: total.outputTokens, estimated: false, source: "site", outcome: "done", cost, free: cost, balance: "0", forgiven: "0" }]);
    expect(await freeUsed(owner.id)).toBe(cost);
    expect((await db.query("select count(*)::int as n from token_ratios")).rows[0].n).toBe(0);
  });

  it("the hold for the next round is what the reply has cost so far and the most that round can cost", async () => {
    const gateway = scriptedGateway()
      .callTools([{ name: "search", input: { query: "a" } }], { usage: U(1000, 50) })
      .callTools([{ name: "search", input: { query: "b" } }], { usage: U(1500, 60) });
    const third = gateway.hang();
    const { worker } = toolWorker(gateway);
    const { owner, conv } = await owned("holder");
    await say(owner, conv, "附近有什么好吃的？");
    const running = worker.runOnce();
    const call = await third.reached;
    const run = await runOf(owner.id);
    // The text of the call the hold is for — the conversation, the tools and both rounds — at its bytes.
    expect(await holdOf(run.id)).toBe(costOf(plus(U(1000, 50), U(1500, 60))) + callMax(nextInput(call)));
    third.release("好。", { usage: U(2000, 70) });
    await running;
    expect(await holdOf(run.id)).toBe(0n);
  });

  it("maxPoints: once the reply has spent it, or its next round could take it past it, the next call is the last; it is charged at most maxPoints and that one call", async () => {
    // Spent: the first round alone costs a point (1 000 × 100 + 900 × 1 000), the cap.
    const spent = scriptedGateway().callTools([{ name: "search", input: { query: "a" } }], { usage: U(1000, 900) }).reply("就这样。", { usage: U(1000, 100) });
    const { worker } = toolWorker(spent, toolbox(), withTools({ maxPoints: 1 }));
    const a = await owned("capped", PAID);
    await grant(db, a.owner.id, 20n * POINT);
    await say(a.owner, a.conv, "查一查");
    await worker.runOnce();
    expect(spent.calls).toHaveLength(2);
    expect(isFinal(spent.calls[1]!)).toBe(true);
    expect(await recordsOf((await runOf(a.owner.id)).id)).toMatchObject([{ cost: costOf(U(2000, 1000)).toString(), outcome: "done" }]);

    // Could pass it: one point spent of two, and the next round could cost more than the point left — a round is
    // never started that could take the reply past the cap.
    const could = scriptedGateway().callTools([{ name: "search", input: { query: "a" } }], { usage: U(1000, 900) }).reply("就这样。", { usage: U(1000, 50) });
    const second = toolWorker(could, toolbox(), withTools({ maxPoints: 2 }));
    const b = await owned("capped2", PAID);
    await grant(db, b.owner.id, 20n * POINT);
    await say(b.owner, b.conv, "查一查");
    await second.worker.runOnce();
    expect(could.calls).toHaveLength(2);
    expect(isFinal(could.calls[1]!)).toBe(true);
    const [record] = await recordsOf((await runOf(b.owner.id)).id);
    expect(BigInt(record.balance)).toBeLessThanOrEqual(2n * POINT + callMax(nextInput(could.calls[1]!)));
    expect(record.balance).toBe(costOf(U(2000, 950)).toString());
  });

  it("the headroom gone mid-run: the last call when what the run holds still covers an ordinary call, else no call; the free allowance is never overdrawn", async () => {
    // Someone else's spending uses up the free allowance while the first round's tool runs.
    const spendAll = (ownerId: string) => async (): Promise<ToolOutcome> => {
      await db.query(
        `insert into free_usage (owner_id, day, used_micro) values ($1, (now() at time zone 'Asia/Shanghai')::date, 3000000)
         on conflict (owner_id, day) do update set used_micro = 3000000`,
        [ownerId],
      );
      return { output: { hits: [] }, activity: "search" };
    };

    // A cheap first round: what the run holds since admission (its text and the tools' definitions at their bytes, and a
    // whole output) still covers it and an ordinary call (the text without the tools) — the last call.
    const cheap = await owned("headfinal");
    const finalGateway = scriptedGateway().callTools([{ name: "search", input: { query: "a" } }], { usage: U(10, 1) }).reply("好的。", { usage: U(20, 2) });
    await say(cheap.owner, cheap.conv, "查一查");
    expect(await toolWorker(finalGateway, toolbox(spendAll(cheap.owner.id))).worker.runOnce()).toBe(true);
    expect(finalGateway.calls).toHaveLength(2);
    expect(isFinal(finalGateway.calls[1]!)).toBe(true);
    const cheapRun = await runOf(cheap.owner.id);
    expect(cheapRun).toMatchObject({ status: "done", hold: "0" });
    const cheapCost = costOf(U(30, 3)).toString();
    expect(await recordsOf(cheapRun.id)).toMatchObject([{ cost: cheapCost, free: "0", balance: "0", forgiven: cheapCost }]);
    expect(await freeUsed(cheap.owner.id)).toBe("3000000");

    // A dear first round: nothing left, and what it holds no longer covers another call — no call; what it wrote stands, cut.
    const dear = await owned("headstop");
    const stopGateway = scriptedGateway().callTools([{ name: "search", input: { query: "a" } }], { usage: U(1000, 500), text: "我先查一下。" });
    await say(dear.owner, dear.conv, "查一查");
    expect(await toolWorker(stopGateway, toolbox(spendAll(dear.owner.id))).worker.runOnce()).toBe(true);
    expect(stopGateway.calls).toHaveLength(1);
    const dearRun = await runOf(dear.owner.id);
    expect(dearRun).toMatchObject({ status: "done", hold: "0" });
    const replies = (await api(app, dear.owner, "GET", `/api/conversations/${dear.conv}/messages`)).json.messages.filter((m: any) => m.senderId === dear.agent.id);
    expect(replies).toMatchObject([{ text: "我先查一下。", truncated: true }]);
    const dearCost = costOf(U(1000, 500)).toString();
    expect(await recordsOf(dearRun.id)).toMatchObject([{ cost: dearCost, free: "0", balance: "0", forgiven: dearCost }]);
    expect(await freeUsed(dear.owner.id)).toBe("3000000");

    // And with nothing written: no_quota.
    const mute = await owned("headmute");
    const muteGateway = scriptedGateway().callTools([{ name: "search", input: { query: "a" } }], { usage: U(1000, 500) });
    await say(mute.owner, mute.conv, "查一查");
    expect(await toolWorker(muteGateway, toolbox(spendAll(mute.owner.id))).worker.runOnce()).toBe(true);
    expect(await runOf(mute.owner.id)).toMatchObject({ status: "failed", error: "no_quota", hold: "0" });
  });

  it("the Agent's others' daily budget reached mid-run by what the reply has cost: the next call is the last", async () => {
    const owner = await signUp(app, "budgetowner");
    const member = await signUp(app, "budgetmember");
    const g = await group(app, owner, "饭搭子", [member, await signUp(app, "budgetthird")]);
    // A paid model and a balance of 20 points: nothing but the budget stops a round.
    const agent = await mustCreateAgent(app, owner, { handle: "chef", name: "chef", model: PAID, persona: "简短地回答。", othersBudget: "1" });
    await grant(db, owner.id, 20n * POINT);
    await db.query("insert into memberships (conversation_id, principal_id, role, joined_seq) select $1, $2, 'speaker', seq from conversations where id = $1", [g, agent.id]);
    // A point: the budget, reached by the first round alone.
    const gateway = scriptedGateway().callTools([{ name: "search", input: { query: "a" } }], { usage: U(1000, 900) }).reply("就这样。", { usage: U(100, 10) });
    const { worker } = toolWorker(gateway);
    await say(member, g, "@chef 附近有什么好吃的？");
    expect(await worker.runOnce()).toBe(true);
    expect(gateway.calls).toHaveLength(2);
    expect(isFinal(gateway.calls[1]!)).toBe(true);
    expect(await runOf(owner.id)).toMatchObject({ status: "done", hold: "0" });
  });

  it("a crashed run with a raised hold is swept after 2 × max(AGENT_RUN_TIMEOUT_MS, TOOLS.runTimeoutMs) + 1 minute, and its hold released", async () => {
    // 2 × max(120 000, 300 000) + 60 000 = 660 000 ms: 11 minutes.
    expect(staleAfterMs(app.deps.config)).toBe(660_000);
    expect(staleAfterMs({ agentRunTimeoutMs: 600_000, tools: { runTimeoutMs: 300_000 } })).toBe(2 * 600_000 + 60_000);

    const { port } = toolWorker(scriptedGateway());
    const { owner, conv } = await owned("crashed");
    await say(owner, conv, "你好");
    const ticket = (await port.claimNext())!;
    const prepared = await port.begin(ticket);
    expect(isRunEnd(prepared)).toBe(false);
    expect((prepared as Prepared).tools).toEqual(TOOLS);
    const admitted = await holdOf(ticket.id);
    // Raised as a reply between its rounds raises it: what one round cost and the most the next can cost.
    expect(await port.extend(ticket, U(1000, 100), { inputChars: 0, outputChars: 0 }, 5000)).toBe("ok");
    expect(await holdOf(ticket.id)).toBe(costOf(U(1000, 100)) + callMax(5000));
    expect(await holdOf(ticket.id)).not.toBe(admitted);

    const age = (minutes: number) => db.query("update agent_runs set started_at = now() - make_interval(mins => $2) where id = $1", [ticket.id, minutes]);
    await age(10);
    expect(await app.staleRunSweep.run()).toBe(0);
    await age(12);
    expect(await app.staleRunSweep.run()).toBe(1);
    expect(await runOf(owner.id)).toMatchObject({ status: "failed", error: "provider_unavailable", hold: "0" });
    expect(await recordsOf(ticket.id)).toMatchObject([{ cost: "0", free: "0", balance: "0" }]);
    expect(await freeUsed(owner.id)).toBe("0");
  });

  it("a provider's model: nothing held, nothing charged, and the loop still bounded by its rounds", async () => {
    const owner = await signUp(app, "ownmodel");
    const provider = (await api(app, owner, "POST", "/api/providers", providerBody({ models: [{ name: "mine" }] }))).json;
    const agent = await mustCreateAgent(app, owner, { model: { source: "provider", providerId: provider.id, model: "mine" }, persona: "简短地回答。" });
    const gateway = scriptedGateway();
    for (let i = 0; i < 8; i++) gateway.callTools([{ name: "search", input: { query: `第${i}次` } }], { usage: U(100_000, 1000) });
    const last = gateway.hang();
    const { worker } = toolWorker(gateway);
    await say(owner, agent.conversationId, "查到底");
    const running = worker.runOnce();
    const call = await last.reached;
    expect(isFinal(call)).toBe(true);
    const run = await runOf(owner.id);
    expect(await holdOf(run.id)).toBe(0n);
    last.release("够了。", { usage: U(100_000, 1000) });
    await running;
    expect(gateway.calls).toHaveLength(9);
    expect(await recordsOf(run.id)).toMatchObject([{ source: "provider", cost: "0", free: "0", balance: "0", input: 900_000, output: 9000 }]);
  });

  it("TOOLS.enabled false: no reply is offered tools, whatever the port could offer; the reply is one call, as before, and teaches the ratio", async () => {
    const gateway = scriptedGateway().reply("你好。", { usage: U(300, 10) });
    const { worker } = toolWorker(gateway, toolbox(), withTools({ enabled: false }));
    const { owner, conv } = await owned("notools");
    await say(owner, conv, "你好");
    await worker.runOnce();
    expect(gateway.calls).toHaveLength(1);
    expect(gateway.calls[0]).not.toHaveProperty("tools");
    expect(gateway.calls[0]).not.toHaveProperty("toolChoice");
    expect((await runOf(owner.id)).input_estimate).not.toBe(null);
  });
});
