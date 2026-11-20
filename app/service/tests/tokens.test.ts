import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ContextPlan, type ContextEntry } from "../src/agents/runtime/context.ts";
import { ReplyStream } from "../src/agents/runtime/stream.ts";
import type { Tx } from "../src/db.ts";
import { cutToWeight as memoryCutToWeight, TOKENS_PER_WEIGHT as MEMORY_TOKENS_PER_WEIGHT, weight as memoryWeight, weightOf as memoryWeightOf } from "../src/memory/weight.ts";
import { estimateTokens as pricesEstimateTokens, IMAGE_TOKENS } from "../src/metering/prices.ts";
import { settle, type SettleLog } from "../src/metering/settle.ts";
import { cutToWeight, estimateTokens, learnRatio, ratioKey, readRatio, TOKENS_PER_WEIGHT, weight, weightOf } from "../src/metering/tokens.ts";
import type { ModelCall } from "../src/models/gateway.ts";
import { api, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent, PNG, SITE_ENV } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { grant } from "./helpers/metering.ts";
import { scriptedGateway } from "./helpers/models.ts";
import { MULTIPART, multipart } from "./helpers/multipart.ts";

/**
 * One ruler for tokens (README "Metering", "Token estimates"): every estimate is weight — ceil(utf-8 bytes / 3), the
 * measure memory already used — and a call's input estimate is corrected by its model's ratio, learned from the input
 * tokens upstreams report for replies.
 */

const gateway = scriptedGateway();
const { app, db } = useApp({ env: SITE_ENV, models: gateway, agentWorker: false });

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

  it("an English conversation cut at 3 messages by code points now keeps 9 within the same budget", () => {
    // Twenty-one messages, the owner's and the Agent's in turn, the owner's last; each is 300 English letters: 300 code
    // points, 100 weight.
    const text = (i: number) => `Message ${i}: `.padEnd(300, "the quick brown fox jumps over the lazy dog ");
    const entries: ContextEntry[] = Array.from({ length: 21 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", text: text(i), attachment: null }));
    expect(entries.map((e) => [Array.from(e.text).length, weight(e.text)])).toEqual(entries.map(() => [300, 100]));
    const budget = 950;
    // A token a code point, as before: 3 × 300 fit in 950, 4 do not.
    expect([3 * 300 <= budget, 4 * 300 <= budget]).toEqual([true, false]);
    const plan = new ContextPlan(entries, budget);
    plan.keepOlder();
    const shown = textsOf({ messages: plan.build().messages } as ModelCall);
    expect(shown).toEqual(entries.slice(12).map((e) => e.text));
    expect(shown).toHaveLength(9);
  });

  it("the owner's newest message alone over the budget is cut from the front in weight: as much of its end as the budget holds", () => {
    const whole = `HEAD${"a".repeat(5000)}TAIL`;
    const { messages, tokens } = new ContextPlan([{ role: "user", text: whole, attachment: null }], 100).build();
    const [shown] = textsOf({ messages } as ModelCall);
    // "…" weighs 1; 297 letters weigh 99.
    expect(shown).toBe(`…${whole.slice(-297)}`);
    expect([estimateTokens(shown!), tokens]).toEqual([100, 100]);
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
  it("is keyed by the model, never by its owner: a site model by its id, a provider model by protocol and name", () => {
    const site = { source: "site", name: "fast", call: { protocol: "openai_chat" } } as const;
    expect(ratioKey(site)).toBe("site:fast");
    const provider = {
      source: "provider",
      name: "gpt-4o-mini",
      call: { protocol: "openai_chat", baseUrl: "https://owner-relay.example.com/v1", apiKey: "sk-owner-secret", upstreamId: "provider:0f0e…@https://owner-relay.example.com/v1" },
      ownerId: "owner-0001",
    } as const;
    const key = ratioKey(provider);
    expect(key).toBe("provider:openai_chat:gpt-4o-mini");
    for (const secret of ["owner-relay", "sk-owner-secret", "0f0e", "owner-0001"]) expect(key).not.toContain(secret);
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

  it("stays within [0.5, 3] whatever is reported, and a stored ratio outside it is read clamped", async () => {
    for (let n = 0; n < 60; n++) {
      await db.tx((t) => learnRatio(t, "site:high", 300, 30_000));
      await db.tx((t) => learnRatio(t, "site:low", 30_000, 300));
    }
    const high = (await ratioRow("site:high"))!;
    const low = (await ratioRow("site:low"))!;
    expect(high.ratio).toBeLessThanOrEqual(3);
    expect(high.ratio).toBeGreaterThan(2.99);
    expect(low.ratio).toBeGreaterThanOrEqual(0.5);
    expect(low.ratio).toBeLessThan(0.51);
    // One outlier moves it by a tenth of the clamp at most.
    await db.tx((t) => learnRatio(t, "site:once", 1000, 1_000_000));
    await expectRatio("site:once", 0.9 + 0.3, 1);

    await db.query("insert into token_ratios (key, ratio, samples, updated_at) values ('site:x', 7, 9, now()), ('site:y', 0.1, 9, now())");
    expect(await db.tx((t) => readRatio(t, "site:x"))).toBe(3);
    expect(await db.tx((t) => readRatio(t, "site:y"))).toBe(0.5);
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
