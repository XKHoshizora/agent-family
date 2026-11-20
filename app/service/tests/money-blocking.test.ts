import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentPort, type DbAgentPort, type Toolbox } from "../src/agents/port-impl.ts";
import type { ToolOutcome } from "../src/agents/runtime/port.ts";
import { createAgentWorker, type AgentWorker } from "../src/agents/runtime/worker.ts";
import type { Config } from "../src/config.ts";
import { AppError } from "../src/errors.ts";
import { admitRun, HeldBack } from "../src/metering/admit.ts";
import type { ModelCall, ModelEvent, ModelGateway, ToolCall, ToolSpec } from "../src/models/gateway.ts";
import { api, group, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { ESTIMATE, grant, MAX_COST, METER_ENV, meteredAgent, runningRun } from "./helpers/metering.ts";
import { scriptedGateway, type ScriptedGateway } from "./helpers/models.ts";
import { closeAllSockets } from "./helpers/ws.ts";

/**
 * Money that does not block (Task H; README "Metering", Admission, Extension, The debt bound): a reply starts while
 * something is left of its source, however large its hold; what the owner's other running calls hold only makes it wait
 * (queued, then claimed once one of them has ended), unless it would be the only call holding against that source; a
 * reply that has started is never refused for money — short of it, its next call is its last; so what one owner's calls
 * can take below zero is one call that started alone, and one last call (or a draft) for each other call open beside it.
 * On the real port and database, the meter models (METER_ENV: 100 micro-points an input token, 1 000 an output token, at
 * most 1 000 output tokens; 3 free points a day) and `hold5`, a paid model whose every call holds a little over 5 points
 * (5 000 output tokens at 1 000 each, its input at 1 a token).
 */

const HOLD5 = {
  id: "hold5",
  label: "Hold five",
  tier: "paid",
  protocol: "openai_chat",
  baseUrl: "https://api.example.test/v1",
  apiKeyEnv: "METER_UPSTREAM_KEY",
  model: "hold5-1",
  inputMicroPerToken: 1,
  outputMicroPerToken: 1000,
  maxOutputTokens: 5000,
  contextTokens: 100000,
  vision: false,
  pdf: false,
  reasoning: [],
};
const ENV = {
  ...METER_ENV,
  SITE_MODELS: JSON.stringify([...JSON.parse(METER_ENV.SITE_MODELS), HOLD5]),
  AGENT_MAX_CONCURRENT_RUNS: "8",
  AGENT_MAX_CONCURRENT_OTHERS_RUNS: "8",
};

const { app, db } = useApp({ env: ENV, agentWorker: false });

afterEach(async () => {
  await closeAllSockets();
});

const POINT = 1_000_000n;
const FIVE = { source: "site", id: "hold5" } as const;
const PAID = { source: "site", id: "meter_paid" } as const;
const U = (inputTokens: number, outputTokens: number) => ({ inputTokens, outputTokens });

const SEARCH: ToolSpec = {
  name: "search",
  description: "Search this conversation's messages.",
  parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
};
/** A toolbox that offers the search tool, which finds nothing at once. */
const toolbox = (): Toolbox => ({
  offer: () => ({ tools: [SEARCH], perTool: { search: 1000 }, kinds: { search: "search" } }),
  run: async (): Promise<ToolOutcome> => ({ output: { hits: [] }, activity: "search" }),
});

/** A port of its own (with `box`) and a worker on it; by hand unless `background`. */
function workerWith(gateway: ModelGateway, { box = null, config = app.deps.config, background = false }: { box?: Toolbox | null; config?: Config; background?: boolean } = {}) {
  const { db: pool, blobs, conversations, reads } = app.deps;
  const port: DbAgentPort = createAgentPort({ db: pool, config, blobs, realtime: app.realtime, conversations, reads, log: app.log, toolbox: box });
  const worker: AgentWorker = createAgentWorker({ port, models: gateway, runTimeoutMs: config.agentRunTimeoutMs, maxRunsInFlight: 16, background, log: app.log, tools: config.tools });
  if (background) port.onQueued(() => worker.wake());
  return { port, worker };
}

const withTools = (over: Partial<Config["tools"]>): Config => ({ ...app.deps.config, tools: { ...app.deps.config.tools, ...over } });

/**
 * A model that calls the search tool — a new query each time, saying a few words first — until it is made to answer (the
 * last call: `toolChoice` `none`), every call reporting `usage`. Stateless: any number of replies may use it at once.
 */
function searcher(usage: { inputTokens: number; outputTokens: number }): ModelGateway & { calls: ModelCall[] } {
  let n = 0;
  const calls: ModelCall[] = [];
  return {
    calls,
    async *stream(call): AsyncGenerator<ModelEvent> {
      calls.push(call);
      if (call.toolChoice === "none" || !call.tools || call.tools.length === 0) {
        yield { type: "text", delta: "就这些。" };
        yield { type: "finish", usage, truncated: false, toolCalls: [], assistant: { text: "就这些。" } };
        return;
      }
      const toolCall: ToolCall = { id: `s${++n}`, name: "search", input: { query: `第${n}次` } };
      yield { type: "text", delta: "查一下。" };
      yield { type: "tool_call", call: toolCall };
      yield { type: "finish", usage, truncated: false, toolCalls: [toolCall], assistant: { text: "查一下。", calls: [toolCall] } };
    },
    async listModels() {
      return [];
    },
  };
}

let txn = 0;
const say = async (who: Actor, conv: string, text: string) => {
  const sent = await api(app, who, "POST", `/api/conversations/${conv}/messages`, { text, clientTxn: `mb${++txn}` });
  expect(sent.status).toBe(201);
};

async function agentOf(owner: Actor, model: typeof FIVE | typeof PAID, name: string) {
  const agent = await mustCreateAgent(app, owner, { model, name, persona: `简短地回答。${name}` });
  return { id: agent.id as string, conv: agent.conversationId as string };
}

type RunRow = { id: string; status: string; error: string | null; hold: string; held_back_by: string[] | null; charge_to: string | null };
const runIn = async (conv: string): Promise<RunRow> =>
  (
    await db.query<RunRow>(
      "select id, status, error, hold_micro::text as hold, held_back_by, charge_to from agent_runs where conversation_id = $1 and purpose = 'reply' order by created_at desc limit 1",
      [conv],
    )
  ).rows[0]!;
const holdOf = async (runId: string) => BigInt((await db.query<{ hold: string }>("select hold_micro::text as hold from agent_runs where id = $1", [runId])).rows[0]!.hold);
const balanceOf = async (ownerId: string) =>
  BigInt((await db.query<{ b: string }>("select balance_micro::text as b from accounts where principal_id = $1", [ownerId])).rows[0]!.b);
const recordOf = async (runId: string) =>
  (
    await db.query<{ cost: string; balance: string; free: string; forgiven: string }>(
      "select cost_micro::text as cost, balance_micro::text as balance, free_micro::text as free, forgiven_micro::text as forgiven from usage_records where run_id = $1",
      [runId],
    )
  ).rows;
/** Every balance equals its ledger, no hold is left, nothing is left queued or running. */
async function expectSettledBooks(ownerId: string): Promise<void> {
  const ledger = await db.query<{ sum: string }>("select coalesce(sum(delta_micro), 0)::text as sum from balance_ledger where owner_id = $1", [ownerId]);
  expect(BigInt(ledger.rows[0]!.sum)).toBe(await balanceOf(ownerId));
  expect((await db.query("select id from agent_runs where owner_id = $1 and (hold_micro > 0 or status in ('queued', 'running'))", [ownerId])).rows).toEqual([]);
}

describe("a reply starts while something is left, however large its hold, and ends charged what it cost", () => {
  it("balance 3, a reply that holds 5: it starts and finishes, charged what it cost; at 4 the balance ends at −1 and the next reply is refused; a grant of 10 leaves 9", async () => {
    const gateway = scriptedGateway();
    const call = gateway.hang();
    const { worker } = workerWith(gateway);
    const owner = await signUp(app, "three");
    const a = await agentOf(owner, FIVE, "Tri");
    await grant(db, owner.id, 3n * POINT);
    await say(owner, a.conv, "你好");
    const running = worker.runOnce();
    await call.reached;
    const run = await runIn(a.conv);
    expect(run).toMatchObject({ status: "running", charge_to: "balance" });
    expect(BigInt(run.hold)).toBeGreaterThan(5n * POINT);
    call.release("好。", { usage: U(0, 4000) });
    await running;
    expect(await runIn(a.conv)).toMatchObject({ status: "done", hold: "0" });
    expect(await recordOf(run.id)).toEqual([{ cost: "4000000", balance: "4000000", free: "0", forgiven: "0" }]);
    expect(await balanceOf(owner.id)).toBe(-1n * POINT);

    await say(owner, a.conv, "再说一句");
    await worker.runOnce();
    expect(await runIn(a.conv)).toMatchObject({ status: "failed", error: "no_quota" });
    await grant(db, owner.id, 10n * POINT);
    expect(await balanceOf(owner.id)).toBe(9n * POINT);
    expect(gateway.pending()).toBe(0);
    await expectSettledBooks(owner.id);
  });
});

describe("the holds of one owner's replies are capped together by queueing, not refusing", () => {
  it("two Agents called at once, 6 points left and a hold of 5 each: the second waits, queued, not refused, and starts when the first has ended; with 20 both run at once", async () => {
    const gateway = scriptedGateway();
    const first = gateway.hang();
    gateway.reply("二。", { usage: U(0, 1000) });
    const { worker } = workerWith(gateway);
    const owner = await signUp(app, "sixer");
    const [a, b] = [await agentOf(owner, FIVE, "Ann"), await agentOf(owner, FIVE, "Bob")];
    await grant(db, owner.id, 6n * POINT);
    await say(owner, a.conv, "你好");
    await say(owner, b.conv, "你好");

    const running = worker.runOnce();
    await first.reached;
    const runA = await runIn(a.conv);
    // The second is claimed, read, then held back at admission: back to queued, nothing held, behind the first.
    expect(await worker.runOnce()).toBe(true);
    const held = await runIn(b.conv);
    expect(held).toMatchObject({ status: "queued", error: null, hold: "0", charge_to: null, held_back_by: [runA.id] });
    // Its owner is told it is queued, as any queued reply: not failed, not `no_quota`.
    expect((await api(app, owner, "GET", `/api/conversations/${b.conv}/run`)).json.run).toMatchObject({ id: held.id, status: "queued" });
    expect(gateway.calls).toHaveLength(1);
    // Nothing more is claimed while the first runs.
    expect(await worker.runOnce()).toBe(false);

    first.release("一。", { usage: U(0, 1000) });
    await running;
    expect(await worker.runOnce()).toBe(true);
    expect(await runIn(b.conv)).toMatchObject({ id: held.id, status: "done", held_back_by: null });
    expect(gateway.calls).toHaveLength(2);
    expect(await balanceOf(owner.id)).toBe(4n * POINT);
    await expectSettledBooks(owner.id);

    // 20 points: both holds fit, both run at once.
    const both = scriptedGateway();
    const [one, two] = [both.hang(), both.hang()];
    const second = workerWith(both);
    const rich = await signUp(app, "twenty");
    const [c, d] = [await agentOf(rich, FIVE, "Cid"), await agentOf(rich, FIVE, "Dee")];
    await grant(db, rich.id, 20n * POINT);
    await say(rich, c.conv, "你好");
    await say(rich, d.conv, "你好");
    const runs = [second.worker.runOnce(), second.worker.runOnce()];
    await Promise.all([one.reached, two.reached]);
    expect([(await runIn(c.conv)).status, (await runIn(d.conv)).status]).toEqual(["running", "running"]);
    one.release("一。", { usage: U(0, 1000) });
    two.release("二。", { usage: U(0, 1000) });
    await Promise.all(runs);
    expect(await balanceOf(rich.id)).toBe(18n * POINT);
    await expectSettledBooks(rich.id);
  });

  it("a held-back reply is woken by the end of the reply it waited for, not by the worker's poll", async () => {
    const gateway = scriptedGateway();
    const first = gateway.hang();
    gateway.reply("二。", { usage: U(0, 1000) });
    const { worker } = workerWith(gateway, { background: true });
    const owner = await signUp(app, "woken");
    const [a, b] = [await agentOf(owner, FIVE, "Ann"), await agentOf(owner, FIVE, "Bob")];
    await grant(db, owner.id, 6n * POINT);
    await say(owner, a.conv, "你好");
    await say(owner, b.conv, "你好");
    worker.start();
    try {
      await first.reached;
      await vi.waitFor(async () => expect(await runIn(b.conv)).toMatchObject({ status: "queued", held_back_by: [(await runIn(a.conv)).id] }), { timeout: 5_000 });
      first.release("一。", { usage: U(0, 1000) });
      await vi.waitFor(async () => expect(await runIn(b.conv)).toMatchObject({ status: "done" }), { timeout: 5_000 });
      const { rows } = await db.query<{ gap: number }>(
        `select (extract(epoch from (b.started_at - a.finished_at)) * 1000)::int as gap
           from agent_runs a, agent_runs b where a.id = $1 and b.id = $2`,
        [(await runIn(a.conv)).id, (await runIn(b.conv)).id],
      );
      // The worker polls every 2 s; the end of the first wakes it at once.
      expect(rows[0]!.gap).toBeLessThan(400);
    } finally {
      await worker.stop();
    }
  });

  it("first come, first served per owner: a younger reply of the same owner waits behind a held-back one; another owner's does not", async () => {
    const gateway = scriptedGateway();
    const first = gateway.hang();
    gateway.reply("别人的。", { usage: U(0, 1000) }).reply("二。", { usage: U(0, 1000) }).reply("三。", { usage: U(0, 1000) });
    const { worker } = workerWith(gateway);
    const owner = await signUp(app, "fifo");
    const [a, b, c] = [await agentOf(owner, FIVE, "Ann"), await agentOf(owner, FIVE, "Bob"), await agentOf(owner, PAID, "Cal")];
    const other = await signUp(app, "fifoother");
    const o = await agentOf(other, FIVE, "Oz");
    // 7 points: two holds of 5 do not fit, Ann's and Cal's (about one point) do.
    await grant(db, owner.id, 7n * POINT);
    await grant(db, other.id, 6n * POINT);
    await say(owner, a.conv, "你好");
    await say(owner, b.conv, "你好");
    const running = worker.runOnce();
    await first.reached;
    expect(await worker.runOnce()).toBe(true);
    expect(await runIn(b.conv)).toMatchObject({ status: "queued" });
    // Cal's hold (about a point) would fit beside Ann's; it still waits behind Bob. Oz, another owner's, does not.
    await say(owner, c.conv, "你好");
    await say(other, o.conv, "你好");
    expect(await worker.runOnce()).toBe(true);
    expect(await runIn(o.conv)).toMatchObject({ status: "done" });
    expect(await runIn(c.conv)).toMatchObject({ status: "queued", held_back_by: null });
    expect(await worker.runOnce()).toBe(false);

    first.release("一。", { usage: U(0, 1000) });
    await running;
    expect(await worker.runOnce()).toBe(true);
    expect(await runIn(b.conv)).toMatchObject({ status: "done" });
    expect(await worker.runOnce()).toBe(true);
    expect(await runIn(c.conv)).toMatchObject({ status: "done" });
    expect(gateway.pending()).toBe(0);
  });

  it("a held-back reply is an ordinary queued one: its owner's stop ends it at once, a pause cancels it; neither leaves anything held", async () => {
    const gateway = scriptedGateway();
    const first = gateway.hang();
    const { worker } = workerWith(gateway);
    const owner = await signUp(app, "heldstop");
    const [a, b, c] = [await agentOf(owner, FIVE, "Ann"), await agentOf(owner, FIVE, "Bob"), await agentOf(owner, FIVE, "Cy")];
    await grant(db, owner.id, 6n * POINT);
    await say(owner, a.conv, "你好");
    await say(owner, b.conv, "你好");
    await say(owner, c.conv, "你好");
    const running = worker.runOnce();
    await first.reached;
    expect(await worker.runOnce()).toBe(true);
    const held = await runIn(b.conv);
    expect(held).toMatchObject({ status: "queued" });
    expect((await api(app, owner, "POST", `/api/conversations/${b.conv}/runs/${held.id}/stop`)).status).toBe(200);
    expect(await runIn(b.conv)).toMatchObject({ status: "stopped", hold: "0" });
    // Cy's is held back now too; its Agent's pause cancels it as any queued reply.
    expect(await worker.runOnce()).toBe(true);
    expect(await runIn(c.conv)).toMatchObject({ status: "queued", held_back_by: [(await runIn(a.conv)).id] });
    expect((await api(app, owner, "POST", `/api/agents/${c.id}/pause`)).status).toBe(200);
    expect(await runIn(c.conv)).toMatchObject({ status: "cancelled", error: "agent_paused", hold: "0" });

    first.release("一。", { usage: U(0, 1000) });
    await running;
    expect(await worker.runOnce()).toBe(false);
    await expectSettledBooks(owner.id);
  });

  it("decided under the account lock: whether the reply it waits for settles just before or just after, a held-back reply is never left waiting for a reply that has ended", async () => {
    for (const order of ["settle first", "admit first"] as const) {
      const gateway = scriptedGateway();
      const first = gateway.hang();
      gateway.reply("二。", { usage: U(0, 1000) });
      const { worker } = workerWith(gateway);
      const owner = await signUp(app, order === "settle first" ? "racesettle" : "raceadmit");
      const [a, b] = [await agentOf(owner, FIVE, "Ann"), await agentOf(owner, FIVE, "Bob")];
      await grant(db, owner.id, 6n * POINT);
      await say(owner, a.conv, "你好");
      await say(owner, b.conv, "你好");
      const runningA = worker.runOnce();
      await first.reached;

      // Both the first's settlement and the second's admission wait on the owner's account row; which goes first is
      // the order they were queued in behind it.
      const holder = await db.pool.connect();
      let runningB: Promise<boolean>;
      try {
        await holder.query("begin");
        await holder.query("select 1 from accounts where principal_id = $1 for update", [owner.id]);
        const waiting = (n: number) =>
          vi.waitFor(
            async () =>
              expect(
                (await db.query<{ n: number }>("select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query like '%from accounts where principal_id = $1 for update%'"))
                  .rows[0]!.n,
              ).toBe(n),
            { timeout: 5_000 },
          );
        if (order === "settle first") {
          first.release("一。", { usage: U(0, 1000) });
          await waiting(1);
          runningB = worker.runOnce();
        } else {
          runningB = worker.runOnce();
          await waiting(1);
          first.release("一。", { usage: U(0, 1000) });
        }
        await waiting(2);
        await holder.query("commit");
      } finally {
        await holder.query("rollback").catch(() => {});
        holder.release();
      }
      await runningA;
      await runningB;
      // Held back behind a reply that has ended, or never held back: either way it is answered.
      if ((await runIn(b.conv)).status === "queued") expect(await worker.runOnce()).toBe(true);
      expect(await runIn(b.conv)).toMatchObject({ status: "done" });
      expect(await worker.runOnce()).toBe(false);
      expect(gateway.pending()).toBe(0);
      await expectSettledBooks(owner.id);
    }
  });

  it("a persona draft never waits: it starts while something is left, whatever the replies hold, and its hold counts against the next reply", async () => {
    const owner = await signUp(app, "drafter");
    const paid = await meteredAgent(app, db, owner, PAID);
    await grant(db, owner.id, 1n * POINT);
    const reply = await runningRun(db, owner.id, paid);
    expect(await db.tx((t) => admitRun(t, app.deps.config, reply, owner.id, paid.resolved, ESTIMATE, new Date()))).toEqual({ chargeTo: "balance", holdMicro: MAX_COST });
    // 1 point left, 2 held: a draft starts all the same.
    const draft = await runningRun(db, owner.id);
    expect(await db.tx((t) => admitRun(t, app.deps.config, draft, owner.id, paid.resolved, ESTIMATE, new Date()))).toEqual({ chargeTo: "balance", holdMicro: MAX_COST });
    // A reply now waits behind both.
    const other = await meteredAgent(app, db, owner, PAID);
    const next = await runningRun(db, owner.id, other);
    const waited = await db.tx((t) => admitRun(t, app.deps.config, next, owner.id, other.resolved, ESTIMATE, new Date())).catch((e: unknown) => e);
    expect(waited).toBeInstanceOf(HeldBack);
    expect([...(waited as HeldBack).behind].sort()).toEqual([reply, draft].sort());
    // Nothing left: a reply and a draft are refused, as always.
    await grant(db, owner.id, -1n * POINT);
    const lastDraft = await runningRun(db, owner.id);
    for (const run of [next, lastDraft]) {
      const refused = await db.tx((t) => admitRun(t, app.deps.config, run, owner.id, other.resolved, ESTIMATE, new Date())).catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(AppError);
      expect(refused).toMatchObject({ code: "no_quota", details: { reason: "balance" } });
    }
  });

  it("in a group, a held-back reply looks to the other members exactly as any queued one: replying", async () => {
    const gateway = scriptedGateway();
    const first = gateway.hang();
    const { worker } = workerWith(gateway);
    const owner = await signUp(app, "groupheld");
    const mia = await signUp(app, "groupmia");
    const ned = await signUp(app, "groupned");
    const a = await mustCreateAgent(app, owner, { model: FIVE, handle: "held_ann", name: "Ann", persona: "简短地回答。" });
    const b = await mustCreateAgent(app, owner, { model: FIVE, handle: "held_bob", name: "Bob", persona: "简短地回答。" });
    await grant(db, owner.id, 6n * POINT);
    const g = await group(app, owner, "team", [mia, ned]);
    for (const agent of [a, b]) expect((await api(app, owner, "POST", `/api/conversations/${g}/members`, { principalId: agent.id })).status).toBe(201);
    await say(owner, a.conversationId, "你好");
    const running = worker.runOnce();
    await first.reached;
    await say(mia, g, "@held_bob 你好");
    const before = (await api(app, mia, "GET", `/api/conversations/${g}/runs`)).json;
    expect(await worker.runOnce()).toBe(true);
    expect(await runIn(g)).toMatchObject({ status: "queued", held_back_by: [(await runIn(a.conversationId)).id] });
    // What mia reads of the group's replies is what she read while it was queued the first time.
    expect((await api(app, mia, "GET", `/api/conversations/${g}/runs`)).json).toEqual(before);
    expect(JSON.stringify(before)).not.toMatch(/held_back|hold|balance|quota/);
    expect(before.runs).toMatchObject([{ agentId: b.id, state: "replying" }]);
    first.release("一。", { usage: U(0, 1000) });
    await running;
  });
});

describe("a reply that has started is never refused for money", () => {
  it("a tool reply whose rounds outgrow what is left still answers: the next call is its last, made below zero, and it is charged what it cost, within TOOLS.maxPoints", async () => {
    const gateway = scriptedGateway()
      .callTools([{ name: "search", input: { query: "a" } }], { usage: U(1000, 500), text: "我先查一下。" })
      .reply("就这样。", { usage: U(2000, 300) });
    const { worker } = workerWith(gateway, { box: toolbox() });
    const owner = await signUp(app, "outgrow");
    const a = await agentOf(owner, PAID, "Tess");
    // Half a point: the first round alone costs 0.6.
    await grant(db, owner.id, POINT / 2n);
    await say(owner, a.conv, "查一查");
    expect(await worker.runOnce()).toBe(true);
    expect(gateway.calls).toHaveLength(2);
    expect(gateway.calls[1]!.toolChoice).toBe("none");
    const run = await runIn(a.conv);
    expect(run).toMatchObject({ status: "done", hold: "0" });
    const replies = (await api(app, owner, "GET", `/api/conversations/${a.conv}/messages`)).json.messages.filter((m: { senderId: string }) => m.senderId === a.id);
    expect(replies).toHaveLength(1);
    expect(replies[0].text).toContain("就这样。");
    expect(replies[0].truncated ?? false).toBe(false);
    const cost = 1000n * 100n + 500n * 1000n + 2000n * 100n + 300n * 1000n;
    expect(await recordOf(run.id)).toEqual([{ cost: cost.toString(), balance: cost.toString(), free: "0", forgiven: "0" }]);
    expect(cost).toBeLessThanOrEqual(BigInt(app.deps.config.tools.maxPoints) * POINT);
    expect(await balanceOf(owner.id)).toBe(POINT / 2n - cost);
    expect(gateway.pending()).toBe(0);
  });
});

describe("the debt bound: one reply that started alone, and one call more for each other call open beside it", () => {
  /** Each call of `searcher` here: 1 000 input and 300 output tokens on a meter model, 0.4 points. */
  const CALL = U(1000, 300);
  const CALL_COST = 1000n * 100n + 300n * 1000n;

  async function contend(name: string, n: number, balance: bigint, config: Config) {
    const gateway = searcher(CALL);
    const { worker } = workerWith(gateway, { box: toolbox(), config });
    const owner = await signUp(app, name);
    const agents = [];
    for (let i = 0; i < n; i++) agents.push(await agentOf(owner, PAID, `A${i}`));
    await grant(db, owner.id, balance);
    for (const a of agents) await say(owner, a.conv, "查一查附近的店");
    // All at once, each on its own connection, then whatever was held back as the others end.
    await Promise.all(agents.map(() => worker.runOnce()));
    while (await worker.runOnce());
    const records = (
      await db.query<{ cost: string }>("select cost_micro::text as cost from usage_records where owner_id = $1 and purpose = 'reply'", [owner.id])
    ).rows.map((r) => BigInt(r.cost));
    const statuses = (await db.query<{ status: string; error: string | null }>("select status, error from agent_runs where owner_id = $1 and purpose = 'reply'", [owner.id])).rows;
    await expectSettledBooks(owner.id);
    return { owner, records, statuses, end: await balanceOf(owner.id), calls: gateway.calls.length };
  }

  it("six tool replies of one owner called at once on 3 points: every reply ends — answered, or refused once nothing is left —, no lock waits for ever, and the balance ends no lower than one reply's cost and one last call for each of the other five", { timeout: 120_000 }, async () => {
    const { records, statuses, end } = await contend("sixcalls", 6, 3n * POINT, app.deps.config);
    expect(statuses).toHaveLength(6);
    for (const s of statuses) expect([["done", null], ["failed", "no_quota"]]).toContainEqual([s.status, s.error]);
    expect(statuses.filter((s) => s.status === "done").length).toBeGreaterThanOrEqual(1);
    const largest = records.reduce((a, b) => (a > b ? a : b), 0n);
    expect(end).toBeGreaterThanOrEqual(-(largest + 5n * CALL_COST));
  });

  it("the case that broke the first draft of these rules: 6 points, two tool replies that would each run to TOOLS.maxPoints (20) — they end within one reply and one last call, not near −34", { timeout: 120_000 }, async () => {
    const { records, statuses, end } = await contend("counter", 2, 6n * POINT, withTools({ maxRounds: 50 }));
    expect(statuses).toEqual([
      { status: "done", error: null },
      { status: "done", error: null },
    ]);
    const largest = records.reduce((a, b) => (a > b ? a : b), 0n);
    expect(end).toBeGreaterThanOrEqual(-(largest + CALL_COST));
    expect(end).toBeGreaterThan(-4n * POINT);
    // Neither ran anywhere near its cap.
    for (const r of records) expect(r).toBeLessThan(10n * POINT);
  });
});
