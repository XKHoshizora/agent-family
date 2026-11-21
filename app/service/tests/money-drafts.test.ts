import { describe, expect, it } from "vitest";
import type { ModelEvent, ModelGateway } from "../src/models/gateway.ts";
import { api, signUp } from "./helpers/actors.ts";
import { useApp } from "./helpers/harness.ts";
import { METER_ENV } from "./helpers/metering.ts";

/**
 * A burst of persona drafts (README "Metering", Money that does not block, The debt bound): a draft never waits — its
 * owner is waiting at the page — so it starts while anything is left of its source, whatever is held; what bounds a
 * burst is `AGENT_MAX_CONCURRENT_RUNS`, counted under the account lock (metering/owner-call.ts). So at the end of the day's
 * allowance at most that many start at once, and what the site forgives past the allowance is at most that many drafts'
 * most. On the meter models (3 free points a day; at most 1 000 output tokens at 1 000 micro-points each).
 */

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(timer), reject(signal.reason)), { once: true });
  });

/** Every draft takes 400 ms and writes its whole output limit, so the burst's calls overlap. */
const slow: ModelGateway = {
  async *stream(call): AsyncGenerator<ModelEvent> {
    await sleep(400, call.signal);
    yield { type: "text", delta: "你是一个乐于助人的助手。" };
    yield { type: "finish", usage: { inputTokens: 0, outputTokens: call.maxOutputTokens }, truncated: false, toolCalls: [], assistant: {} };
  },
  async listModels() {
    return [];
  },
};

const { app, db } = useApp({ env: METER_ENV, models: slow });
const FREE = { source: "site", id: "meter_free" } as const;

describe("a burst of persona drafts", () => {
  it("eight at once with half a point of the day's allowance left: at most AGENT_MAX_CONCURRENT_RUNS (4) start, the rest are refused (429), and what is forgiven past the allowance is at most that many drafts' most", { timeout: 60_000 }, async () => {
    const owner = await signUp(app, "draftburst");
    await db.query("insert into free_usage (owner_id, day, used_micro) values ($1, (now() at time zone 'Asia/Shanghai')::date, 2500000)", [owner.id]);
    const answers = await Promise.all(Array.from({ length: 8 }, (_, i) => api(app, owner, "POST", "/api/agents/draft-persona", { name: `草稿${i}`, model: FREE })));
    const started = answers.filter((a) => a.status === 200);
    expect(started.length).toBeGreaterThanOrEqual(1);
    expect(started.length).toBeLessThanOrEqual(4);
    for (const a of answers.filter((x) => x.status !== 200)) expect([[429, "rate_limited"], [402, "no_quota"]]).toContainEqual([a.status, a.json.error]);
    const { rows } = await db.query<{ cost: string; free: string; forgiven: string }>(
      "select cost_micro::text as cost, free_micro::text as free, forgiven_micro::text as forgiven from usage_records where owner_id = $1 and purpose = 'draft'",
      [owner.id],
    );
    expect(rows).toHaveLength(started.length);
    const most = rows.reduce((m, r) => (BigInt(r.cost) > m ? BigInt(r.cost) : m), 0n);
    const forgiven = rows.reduce((sum, r) => sum + BigInt(r.forgiven), 0n);
    expect(forgiven).toBeLessThanOrEqual(BigInt(started.length) * most);
    expect(rows.reduce((sum, r) => sum + BigInt(r.free), 0n)).toBe(500_000n);
    expect((await db.query("select count(*)::int as n from agent_runs where owner_id = $1 and status = 'running'", [owner.id])).rows[0].n).toBe(0);
  });
});
