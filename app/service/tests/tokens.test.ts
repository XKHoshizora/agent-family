import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ContextPlan, contextBudget, type ContextEntry } from "../src/agents/runtime/context.ts";
import { ReplyStream } from "../src/agents/runtime/stream.ts";
import type { Tx } from "../src/db.ts";
import { cutToWeight as memoryCutToWeight, TOKENS_PER_WEIGHT as MEMORY_TOKENS_PER_WEIGHT, weight as memoryWeight, weightOf as memoryWeightOf } from "../src/memory/weight.ts";
import { estimateTokens as pricesEstimateTokens, IMAGE_TOKENS } from "../src/metering/prices.ts";
import { settle, type SettleLog } from "../src/metering/settle.ts";
import {
  CONTEXT_HEADROOM,
  cutToWeight,
  estimateTokens,
  learnRatio,
  planRatio,
  ratioKey,
  readRatio,
  TOKENS_PER_WEIGHT,
  weight,
  weightOf,
} from "../src/metering/tokens.ts";
import type { ModelCall } from "../src/models/gateway.ts";
import { api, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent, PNG, SITE_ENV } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { grant } from "./helpers/metering.ts";
import { scriptedGateway } from "./helpers/models.ts";
import { MULTIPART, multipart } from "./helpers/multipart.ts";
import { providerBody } from "./helpers/providers.ts";

/**
 * One ruler for tokens (README "Metering", "Token estimates"): every estimate is weight — ceil(utf-8 bytes / 3), the
 * measure memory already used — and a call's input estimate is corrected by its model's ratio, learned from the input
 * tokens upstreams report for replies. A context is planned at the ratio when it is above 1, with a tenth of its room free.
 */

/** SITE_ENV's models and `small`: a free model with a context small enough to fill (2 600 tokens, 200 for the output). */
const ENV = {
  ...SITE_ENV,
  SITE_MODELS: JSON.stringify([
    ...JSON.parse(SITE_ENV.SITE_MODELS),
    {
      id: "small",
      label: "Small",
      tier: "free",
      protocol: "openai_chat",
      baseUrl: "https://api.example.test/v1",
      apiKeyEnv: "UPSTREAM_TEST_KEY",
      model: "small-1",
      inputMicroPerToken: 1,
      outputMicroPerToken: 2,
      maxOutputTokens: 200,
      contextTokens: 2600,
      vision: false,
      pdf: false,
      reasoning: [],
    },
  ]),
};

const gateway = scriptedGateway();
const { app, db } = useApp({ env: ENV, models: gateway, agentWorker: false });

/** Twenty-one messages, the owner's and the Agent's in turn, the owner's last; each 300 English letters: 300 code points, 100 weight. */
const englishText = (i: number) => `Message ${i}: `.padEnd(300, "the quick brown fox jumps over the lazy dog ");
const ENGLISH: ContextEntry[] = Array.from({ length: 21 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", text: englishText(i), attachment: null }));
const NO_SYSTEM = { rest: "", passage: "" };

/** The texts a plan of `ENGLISH` within `budget`, planned at `ratio`, shows (the current turn, then older messages). */
function keptAt(budget: number, ratio: number): string[] {
  const plan = new ContextPlan(ENGLISH, budget, ratio);
  plan.keepOlder();
  return plan.build().messages.flatMap((m) => m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])));
}

let first = 0;
beforeEach(() => {
  first = gateway.calls.length;
});
afterEach(() => {
  expect(gateway.pending()).toBe(0);
});

const lastCall = (): ModelCall => {
  const calls = gateway.calls.slice(first);
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1]!;
};
const textsOf = (call: ModelCall) => call.messages.flatMap((m) => m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])));

/** The memory vector, verbatim (tests/memory-weight.test.ts, app/web/tests/memory-weight.test.js). */
const VECTOR: Array<[string, number]> = [
  ["", 0],
  ["你好", 2],
  ["记住了：我喜欢麻婆豆腐", 11],
  ["こんにちは", 5],
  ["안녕하세요", 5],
  ["hello", 2],
  ["I like mapo tofu", 6],
  ["a", 1],
  ["我喜欢 coffee", 6],
  ["🙂", 2],
  ["café", 2],
  ["   ", 1],
];

const ratioRow = async (key: string) =>
  (await db.query<{ ratio: number; samples: number }>("select ratio, samples from token_ratios where key = $1", [key])).rows[0] ?? null;

/** The stored ratio of `key` is `ratio` (to floating-point noise) after `samples` samples. */
async function expectRatio(key: string, ratio: number, samples: number): Promise<void> {
  const row = await ratioRow(key);
  expect(row, key).not.toBeNull();
  expect(row!.samples, key).toBe(samples);
  expect(row!.ratio, key).toBeCloseTo(ratio, 12);
}

/** A log that keeps what it was told. */
function keptLog(): SettleLog & { warned: Array<{ details: Record<string, unknown>; msg: string }> } {
  const warned: Array<{ details: Record<string, unknown>; msg: string }> = [];
  return { warned, warn: (details, msg) => void warned.push({ details, msg }) };
}

describe("one ruler", () => {
  it("the vector memory shares gives the same values through the new module, and memory's names are the same functions", () => {
    for (const [text, expected] of VECTOR) {
      expect(weight(text), JSON.stringify(text)).toBe(expected);
      expect(estimateTokens(text), JSON.stringify(text)).toBe(expected);
    }
    expect(memoryWeight).toBe(weight);
    expect(memoryWeightOf).toBe(weightOf);
    expect(memoryCutToWeight).toBe(cutToWeight);
    expect([TOKENS_PER_WEIGHT, MEMORY_TOKENS_PER_WEIGHT]).toEqual([1, 1]);
  });

  it("3 000 English letters are 1 000 tokens (they were 3 000) and 1 000 Chinese characters still 1 000; prices' estimate is this one; a ratio scales and rounds up", () => {
    expect(estimateTokens("a".repeat(3000))).toBe(1000);
    expect(pricesEstimateTokens("a".repeat(3000))).toBe(1000);
    expect(estimateTokens("字".repeat(1000))).toBe(1000);
    expect(estimateTokens("a".repeat(3000), 1.5)).toBe(1500);
    expect(estimateTokens("hello", 1.5)).toBe(3); // weight 2
    expect(estimateTokens("", 3)).toBe(0);
    // Images and PDFs keep their constants.
    expect(IMAGE_TOKENS).toBe(1500);
  });

  it("an English conversation cut at 3 messages by code points now keeps 9 within the same model's context, a tenth of its room kept free", () => {
    expect(ENGLISH.map((e) => [Array.from(e.text).length, weight(e.text)])).toEqual(ENGLISH.map(() => [300, 100]));
    // A 1 150-token context, 100 for the output, no system text: 1 050 for the conversation. A token a code point and
    // no room kept free, as before: 3 × 300 fit in 1 050, 4 do not.
    expect([3 * 300 <= 1050, 4 * 300 <= 1050]).toEqual([true, false]);
    const budget = contextBudget(1150, 100, NO_SYSTEM);
    expect(budget).toBe(945);
    expect(keptAt(budget, 1)).toEqual(ENGLISH.slice(12).map((e) => e.text));
  });

  it("the owner's newest message alone over the budget is cut from the front in weight: as much of its end as the budget holds", () => {
    const whole = `HEAD${"a".repeat(5000)}TAIL`;
    const { messages, tokens } = new ContextPlan([{ role: "user", text: whole, attachment: null }], 100).build();
    const [shown] = textsOf({ messages } as ModelCall);
    // "…" weighs 1; 297 letters weigh 99.
    expect(shown).toBe(`…${whole.slice(-297)}`);
    expect([estimateTokens(shown!), tokens]).toEqual([100, 100]);
    // At a ratio of 1.5 the budget holds 66 weight (99 tokens; 67 would be 101): "…" and 195 letters.
    const at = new ContextPlan([{ role: "user", text: whole, attachment: null }], 100, 1.5).build();
    const [cut] = textsOf({ messages: at.messages } as ModelCall);
    expect(cut).toBe(`…${whole.slice(-195)}`);
    expect([estimateTokens(cut!, 1.5), at.tokens]).toEqual([99, 66]);
  });

  it("a context is planned at its model's ratio when above 1, with a tenth of its room free: 13 English messages at 1, 9 at 1.5, 13 at 0.6 and 0.8", () => {
    expect(CONTEXT_HEADROOM).toBe(0.1);
    expect([planRatio(0.6), planRatio(0.8), planRatio(1), planRatio(1.5)]).toEqual([1, 1, 1, 1.5]);
    // A 1 600-token context, 100 for the output, no system text: 1 500 for the conversation, 150 of it kept free.
    const budget = (ratio: number) => contextBudget(1600, 100, NO_SYSTEM, planRatio(ratio));
    expect(budget(1)).toBe(1350);
    const kept = (ratio: number) => keptAt(budget(ratio), planRatio(ratio));
    expect([1, 1.5, 0.6, 0.8].map((r) => kept(r).length)).toEqual([13, 9, 13, 13]);
    expect(kept(1)).toEqual(ENGLISH.slice(8).map((e) => e.text));
    expect(kept(1.5)).toEqual(ENGLISH.slice(12).map((e) => e.text));
    expect(kept(0.6)).toEqual(kept(1));
    // The system text is counted at the ratio too: 300 letters are 100 tokens at 1, 150 at 1.5.
    const system = { rest: "a".repeat(300), passage: "" };
    expect([contextBudget(1600, 100, system, 1), contextBudget(1600, 100, system, 1.5)]).toEqual([1260, 1215]);
  });

  it("a reply's output is counted in weight when the upstream reports no usage", () => {
    const out = new ReplyStream(() => {}, 0);
    out.add("reasoning", "想".repeat(10));
    out.add("text", "a".repeat(30));
    out.end();
    expect(out.outputChars()).toBe(10 + 10);
  });
});

describe("the learned ratio", () => {
  it("is keyed by the model: a site model by its id, a provider's model by the provider's row and the model's name — never an owner, a key or an address", () => {
    const site = { source: "site", name: "fast", call: { protocol: "openai_chat" } } as const;
    expect(ratioKey(site)).toBe("site:fast");
    const provider = {
      source: "provider",
      name: "gpt-4o-mini",
      providerId: "5b1c-provider-row",
      call: { protocol: "openai_chat", baseUrl: "https://owner-relay.example.com/v1", apiKey: "sk-owner-secret", upstreamId: "provider:5b1c-provider-row@https://owner-relay.example.com/v1" },
      ownerId: "owner-0001",
    } as const;
    const key = ratioKey(provider);
    expect(key).toBe("provider:5b1c-provider-row:gpt-4o-mini");
    for (const secret of ["owner-relay", "sk-owner-secret", "owner-0001", "https"]) expect(key).not.toContain(secret);
  });

  it("moves 1.0 towards 1.3 over 20 samples of reported/estimated = 1.3; read as 1 until it has 5 samples", async () => {
    const key = "site:fast";
    let last = 1;
    for (let n = 1; n <= 20; n++) {
      await db.tx((t) => learnRatio(t, key, 1000, 1300));
      const row = (await ratioRow(key))!;
      expect(row.samples).toBe(n);
      expect(row.ratio).toBeGreaterThan(last);
      expect(row.ratio).toBeLessThan(1.3);
      expect(row.ratio).toBeCloseTo(1.3 - 0.3 * 0.9 ** n, 10);
      last = row.ratio;
      expect(await db.tx((t) => readRatio(t, key))).toBe(n < 5 ? 1 : row.ratio);
    }
    expect(last).toBeCloseTo(1.2635, 3);
    expect(await db.tx((t) => readRatio(t, "site:unknown"))).toBe(1);
  });

  it("stays within [0.8, 2] whatever is reported, and a stored ratio outside it is read clamped", async () => {
    for (let n = 0; n < 60; n++) {
      await db.tx((t) => learnRatio(t, "site:high", 300, 30_000));
      await db.tx((t) => learnRatio(t, "site:low", 30_000, 300));
    }
    const high = (await ratioRow("site:high"))!;
    const low = (await ratioRow("site:low"))!;
    expect(high.ratio).toBeLessThanOrEqual(2);
    expect(high.ratio).toBeGreaterThan(1.99);
    expect(low.ratio).toBeGreaterThanOrEqual(0.8);
    expect(low.ratio).toBeLessThan(0.81);
    // One outlier moves it by a tenth of the clamp at most: a shared hold drops by at most a fifth.
    await db.tx((t) => learnRatio(t, "site:once", 1000, 1_000_000));
    await expectRatio("site:once", 0.9 + 0.2, 1);
    await db.tx((t) => learnRatio(t, "site:down", 1000, 1));
    await expectRatio("site:down", 0.9 + 0.08, 1);

    await db.query("insert into token_ratios (key, ratio, samples, updated_at) values ('site:x', 7, 9, now()), ('site:y', 0.1, 9, now())");
    expect(await db.tx((t) => readRatio(t, "site:x"))).toBe(2);
    expect(await db.tx((t) => readRatio(t, "site:y"))).toBe(0.8);
  });

  it("learns nothing from an estimate under 200 or a reported count that is not a whole positive number", async () => {
    const ignored: Array<[number, number]> = [
      [199, 300],
      [0, 300],
      [250.5, 300],
      [Number.NaN, 300],
      [1000, 0],
      [1000, 1.5],
      [1000, -5],
      [1000, Number.NaN],
      [1000, Number.POSITIVE_INFINITY],
    ];
    for (const [estimated, reported] of ignored) await db.tx((t) => learnRatio(t, "site:fast", estimated, reported));
    expect(await ratioRow("site:fast")).toBeNull();
    await db.tx((t) => learnRatio(t, "site:fast", 200, 300));
    await expectRatio("site:fast", 0.9 + 0.15, 1);
  });

  it("never throws and never waits long: a row another transaction holds is skipped after a short wait, with a warning that names no text, and the caller's transaction goes on", async () => {
    await db.tx((t) => learnRatio(t, "site:fast", 1000, 1000));
    const holder = await db.pool.connect();
    try {
      await holder.query("begin");
      await holder.query("select 1 from token_ratios where key = 'site:fast' for update");
      const log = keptLog();
      const t0 = performance.now();
      const after = await db.tx(async (t) => {
        await learnRatio(t, "site:fast", 1000, 2000, log);
        return (await t.query<{ ok: number }>("select 1 as ok")).rows;
      });
      expect(performance.now() - t0).toBeLessThan(2000);
      expect(after).toEqual([{ ok: 1 }]);
      expect(log.warned).toHaveLength(1);
      expect(Object.keys(log.warned[0]!.details)).toEqual(["code"]);
    } finally {
      await holder.query("rollback");
      holder.release();
    }
    await expectRatio("site:fast", 1, 1);
  });

  it("a read that fails is 1 and throws nothing", async () => {
    const failing = { query: async () => Promise.reject(new Error("the database is gone")) } as unknown as Tx;
    expect(await readRatio(failing, "site:fast")).toBe(1);
    await expect(learnRatio(failing, "site:fast", 1000, 1300)).resolves.toBeUndefined();
  });
});

describe("replies learn their model's ratio and are held by it", () => {
  const PERSONA = "你说话简短。";
  let txn = 0;
  const say = async (owner: Actor, conv: string, text: string) => {
    const res = await api(app, owner, "POST", `/api/conversations/${conv}/messages`, { text, clientTxn: `t${++txn}` });
    expect(res.status).toBe(201);
  };
  async function owned(name: string, model = "fast") {
    const owner = await signUp(app, name);
    const agent = await mustCreateAgent(app, owner, { model: { source: "site", id: model }, persona: PERSONA, memory: false });
    return { owner, agent, conv: agent.conversationId as string };
  }
  const runOf = async (conv: string) =>
    (
      await db.query<{ id: string; input_estimate: number | null; ratio_key: string | null; hold: string }>(
        "select id, input_estimate, ratio_key, hold_micro::text as hold from agent_runs where conversation_id = $1 order by created_at desc limit 1",
        [conv],
      )
    ).rows[0]!;
  const recordOf = async (runId: string) =>
    (await db.query<{ input: number; estimated: boolean }>("select input_tokens::int as input, estimated from usage_records where run_id = $1", [runId])).rows[0];

  it("a reply's estimate and its model's key are written at admission; settled with reported usage it teaches the ratio once; settled on an estimate it teaches nothing", async () => {
    const { owner, conv } = await owned("learner");
    const text = "请帮我看看这段话：".concat("字".repeat(300));
    await say(owner, conv, text);
    gateway.reply("好的。", { usage: { inputTokens: 0, outputTokens: 3 } });
    await app.agentWorker.runOnce();
    const call = lastCall();
    expect(textsOf(call)).toEqual([text]);
    const estimate = estimateTokens(call.system) + estimateTokens(text);
    const run = await runOf(conv);
    expect([run.input_estimate, run.ratio_key]).toEqual([estimate, "site:fast"]);
    // A reported input of 0 is not a whole positive number: nothing learned.
    expect(await ratioRow("site:fast")).toBeNull();

    await say(owner, conv, text);
    gateway.reply("好的。", { usage: { inputTokens: 2 * estimate, outputTokens: 3 } });
    await app.agentWorker.runOnce();
    // The sample is what was reported over the run's own estimate, as admission recorded it.
    const second = await runOf(conv);
    expect(second.input_estimate).toBeGreaterThanOrEqual(200);
    await expectRatio("site:fast", 0.9 + 0.1 * ((2 * estimate) / second.input_estimate!), 1);

    const quiet = await owned("quiet");
    await say(quiet.owner, quiet.conv, text);
    gateway.reply("好的。");
    await app.agentWorker.runOnce();
    expect((await recordOf((await runOf(quiet.conv)).id))!.estimated).toBe(true);
    expect((await ratioRow("site:fast"))!.samples).toBe(1);
  });

  it("the hold uses the model's ratio: at 1.5 a reply holds 1.5 times its input estimate, and with no usage reported settles on that", async () => {
    await db.query("insert into token_ratios (key, ratio, samples, updated_at) values ('site:fast', 1.5, 5, now())");
    const { owner, conv } = await owned("holder");
    const text = "hello there, how are you today?".repeat(20);
    await say(owner, conv, text);
    const hold = gateway.hang();
    const running = app.agentWorker.runOnce();
    const call = await hold.reached;
    expect(textsOf(call)).toEqual([text]);
    const estimate = estimateTokens(call.system) + estimateTokens(text);
    const held = Math.ceil(estimate * 1.5);
    const run = await runOf(conv);
    // `fast`: 1 micro-point an input token, 2 an output token.
    expect([run.input_estimate, run.hold]).toEqual([estimate, String(held + call.maxOutputTokens * 2)]);
    hold.release("好的。");
    await running;
    expect(await recordOf(run.id)).toEqual({ input: held, estimated: true });
  });

  it("an image keeps its constant in the hold, and a reply that shows one teaches nothing (its tokens are not text's)", async () => {
    await db.query("insert into token_ratios (key, ratio, samples, updated_at) values ('site:thinker', 2, 5, now())");
    const { owner, conv } = await owned("looker", "thinker");
    await grant(db, owner.id, 10_000_000n);
    const upload = await app.inject({
      method: "POST",
      url: `/api/conversations/${conv}/attachments`,
      headers: { cookie: owner.cookie, "content-type": MULTIPART },
      payload: multipart([{ name: "file", filename: "pixel.png", type: "application/octet-stream", data: PNG }]),
    });
    expect(upload.statusCode).toBe(201);
    const sent = await api(app, owner, "POST", `/api/conversations/${conv}/messages`, { attachmentId: upload.json().id, text: "这是什么？", clientTxn: `t${++txn}` });
    expect(sent.status).toBe(201);
    const hold = gateway.hang();
    const running = app.agentWorker.runOnce();
    const call = await hold.reached;
    expect(call.messages[0]!.parts.map((p) => p.type)).toEqual(["text", "image"]);
    const text = estimateTokens(call.system) + estimateTokens("这是什么？");
    const run = await runOf(conv);
    // `thinker`: 3 micro-points an input token, 6 an output token.
    expect([run.input_estimate, run.ratio_key, run.hold]).toEqual([null, "site:thinker", String((text * 2 + IMAGE_TOKENS) * 3 + call.maxOutputTokens * 6)]);
    hold.release("一个像素。", { usage: { inputTokens: 5000, outputTokens: 5 } });
    await running;
    await expectRatio("site:thinker", 2, 5);
  });

  it("settle learns once from a reply's recorded estimate, and never from a draft, a memory call or a reply admitted with no estimate", async () => {
    const owner = await signUp(app, "settler");
    const a = await mustCreateAgent(app, owner, { model: { source: "site", id: "fast" }, persona: PERSONA });
    const b = await mustCreateAgent(app, owner, { model: { source: "site", id: "fast" }, persona: PERSONA });
    const insert = async (purpose: string, agent: { id: string; conversationId: string } | null, estimate: number | null) =>
      (
        await db.query<{ id: string }>(
          `insert into agent_runs (purpose, conversation_id, agent_id, owner_id, status, started_at, source, model, charge_to, hold_micro, input_estimate, ratio_key)
           values ($1, $2, $3, $4, 'running', now(), 'site', 'fast', 'free', 100000, $5, 'site:fast') returning id`,
          [purpose, agent?.conversationId ?? null, agent?.id ?? null, owner.id, estimate],
        )
      ).rows[0]!.id;
    const settled = (runId: string) =>
      db.tx((t) => settle(t, app.deps.config, runId, { inputTokens: 1300, outputTokens: 10 }, { inputChars: 0, outputChars: 0 }, "done", new Date(), { log: keptLog() }));

    for (const runId of [await insert("draft", null, 1000), await insert("memory", null, 1000), await insert("reply", a, null)]) await settled(runId);
    expect(await ratioRow("site:fast")).toBeNull();

    await settled(await insert("reply", b, 1000));
    await expectRatio("site:fast", 0.9 + 0.13, 1);
  });

  it("a reply is planned at its model's ratio: a learned 1.5 shows fewer messages, a learned ratio under 1 exactly as many as none", async () => {
    const shownWith = async (name: string, ratio: number | null) => {
      await db.query("delete from token_ratios");
      if (ratio !== null) await db.query("insert into token_ratios (key, ratio, samples, updated_at) values ('site:small', $1, 5, now())", [ratio]);
      // Same-length names: the system texts weigh the same.
      const owner = await signUp(app, name);
      const agent = await mustCreateAgent(app, owner, { name: "Planner", model: { source: "site", id: "small" }, persona: PERSONA, memory: false });
      const conv = agent.conversationId as string;
      expect((await api(app, owner, "POST", `/api/agents/${agent.id}/pause`)).status).toBe(200);
      for (let i = 0; i < 30; i++) await say(owner, conv, englishText(i));
      expect((await api(app, owner, "POST", `/api/agents/${agent.id}/resume`)).status).toBe(200);
      await say(owner, conv, "Go on.");
      gateway.reply("OK.");
      await app.agentWorker.runOnce();
      return textsOf(lastCall()).length;
    };
    const none = await shownWith("planaaa", null);
    const high = await shownWith("planbbb", 1.5);
    const low = await shownWith("planccc", 0.6);
    expect(none).toBeLessThan(31);
    expect(high).toBeLessThan(none);
    expect(low).toBe(none);
  });

  it("a provider's ratio is its own: two owners' providers of one protocol and model name learn apart, and deleting a provider forgets its ratio", async () => {
    const text = "请帮我看看这段话：".concat("字".repeat(300));
    const learnOn = async (name: string, reported: number) => {
      const owner = await signUp(app, name);
      const provider = (await api(app, owner, "POST", "/api/providers", providerBody({ models: [{ name: "same-model" }] }))).json;
      const agent = await mustCreateAgent(app, owner, { model: { source: "provider", providerId: provider.id, model: "same-model" }, persona: PERSONA, memory: false });
      await say(owner, agent.conversationId, text);
      gateway.reply("好的。", { usage: { inputTokens: reported, outputTokens: 3 } });
      await app.agentWorker.runOnce();
      const run = await runOf(agent.conversationId);
      const key = `provider:${provider.id}:same-model`;
      expect(run.ratio_key).toBe(key);
      expect(run.input_estimate).toBeGreaterThanOrEqual(200);
      return { owner, agent, provider, key, sample: Math.min(2, Math.max(0.8, reported / run.input_estimate!)) };
    };
    const a = await learnOn("provaaa", 1000);
    const b = await learnOn("provbbb", 3000);
    expect(a.key).not.toBe(b.key);
    for (const owner of [a.owner, b.owner]) expect(a.key + b.key).not.toContain(owner.id);
    await expectRatio(a.key, 0.9 + 0.1 * a.sample, 1);
    await expectRatio(b.key, 0.9 + 0.1 * b.sample, 1);

    expect((await api(app, a.owner, "DELETE", `/api/agents/${a.agent.id}`)).status).toBe(200);
    expect((await api(app, a.owner, "DELETE", `/api/providers/${a.provider.id}`)).status).toBeLessThan(300);
    expect(await ratioRow(a.key)).toBeNull();
    await expectRatio(b.key, 0.9 + 0.1 * b.sample, 1);
  });

  it("an owner call (a persona draft) is counted in weight and held by the ratio too", async () => {
    await db.query("insert into token_ratios (key, ratio, samples, updated_at) values ('site:fast', 2, 5, now())");
    const owner = await signUp(app, "drafter");
    const written = "<af-persona>You are a calm reading companion who speaks briefly.</af-persona>";
    gateway.reply(written);
    const res = await api(app, owner, "POST", "/api/agents/draft-persona", { name: "Reader", intro: "Reads with me.", field: "books", model: { source: "site", id: "fast" } });
    expect(res.status).toBe(200);
    const call = lastCall();
    const user = textsOf(call).join("");
    const { rows } = await db.query<{ input: number; output: number; estimated: boolean }>(
      "select input_tokens::int as input, output_tokens::int as output, estimated from usage_records where owner_id = $1",
      [owner.id],
    );
    expect(rows).toEqual([{ input: Math.ceil((estimateTokens(call.system) + estimateTokens(user)) * 2), output: estimateTokens(written), estimated: true }]);
  });
});
