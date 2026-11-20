import { describe, expect, it } from "vitest";
import type { ModelEvent, ModelGateway } from "../src/models/gateway.ts";
import { api, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";

/**
 * Review focus 1: pause or delete racing a reply. Once the pause (or delete) request has returned, no message of the
 * Agent's with a seq above the conversation's last seq at that moment is ever stored — including the reply being
 * generated at that instant, and also when the Agent is resumed at a random moment while that reply is still going —
 * and the run ends `done` (posted before the pause) or `cancelled`. Exact interleavings: tests/runs-pause.test.ts.
 */

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(timer), reject(signal.reason)), { once: true });
  });
const random = (max: number) => Math.floor(Math.random() * (max + 1));

/** Answers every call after a random 0–20 ms, in two pieces with a random pause between them. */
const racing: ModelGateway = {
  async *stream(call): AsyncGenerator<ModelEvent> {
    await sleep(random(10), call.signal);
    yield { type: "text", delta: "好的，" };
    await sleep(random(10), call.signal);
    yield { type: "text", delta: "我明白了。" };
    yield { type: "finish", usage: null, truncated: false, toolCalls: [], assistant: [] };
  },
  async listModels() {
    return [];
  },
};

const { app, db } = useApp({ env: SITE_ENV, models: racing, agentWorker: false });

const ROUNDS = 50;
const FAST = { source: "site", id: "fast" } as const;

async function round(
  owner: Actor,
  agent: { id: string; conversationId: string },
  action: () => Promise<number>,
  n: number,
  meanwhile: () => Promise<void> = async () => {},
): Promise<string> {
  const conv = agent.conversationId;
  expect((await api(app, owner, "POST", `/api/conversations/${conv}/messages`, { text: `第 ${n} 轮`, clientTxn: `race${n}` })).status).toBe(201);
  // The worker picks the reply up, and the pause (or delete) comes, each at a random moment: before the reply was
  // claimed, before it has started, while it streams, around its post, or after it ended. `meanwhile` (a resume at a
  // random moment) runs while the reply may still be going.
  const running = sleep(random(10)).then(() => app.agentWorker.runOnce());
  await sleep(random(40));
  expect(await action()).toBe(200);
  const lastSeq = Number((await db.query<{ seq: string }>("select seq from conversations where id = $1", [conv])).rows[0]!.seq);
  const [claimed] = await Promise.all([running, meanwhile()]);

  const runs = await db.query<{ id: string; status: string; hold: string }>(
    "select id, status, hold_micro::text as hold from agent_runs where agent_id = $1 order by created_at desc limit 1",
    [agent.id],
  );
  const run = runs.rows[0]!;
  const mine = await db.query<{ seq: string; client_txn: string }>(
    "select seq, client_txn from messages where conversation_id = $1 and sender_id = $2",
    [conv, agent.id],
  );
  const posted = mine.rows.filter((m) => m.client_txn === run.id);
  expect([n, mine.rows.filter((m) => Number(m.seq) > lastSeq)]).toEqual([n, []]);
  expect([n, ["done", "cancelled"].includes(run.status)]).toEqual([n, true]);
  expect([n, run.status, posted.length]).toEqual([n, run.status, run.status === "done" ? 1 : 0]);
  expect([n, run.hold]).toEqual([n, "0"]);
  // A reply the pause cancelled while still queued never reached the worker: no usage record. Every other one has one.
  const records = await db.query("select outcome from usage_records where run_id = $1", [run.id]);
  expect([n, claimed, records.rows]).toEqual([n, claimed, claimed ? [{ outcome: run.status }] : []]);
  if (!claimed) expect([n, run.status]).toEqual([n, "cancelled"]);
  // Nothing is left to run.
  expect(await app.agentWorker.runOnce()).toBe(false);
  return run.status;
}

/** A new owner every 10 rounds: one person may start only `agentRunsPerMinute` (20) replies a minute. */
const ROUNDS_PER_OWNER = 10;

describe("pause or delete racing a reply", () => {
  it(`pause, then resume at a random moment, ${ROUNDS} rounds`, { timeout: 60_000 }, async () => {
    const seen: string[] = [];
    let owner!: Actor;
    let agent!: { id: string; conversationId: string };
    for (let n = 0; n < ROUNDS; n++) {
      if (n % ROUNDS_PER_OWNER === 0) {
        owner = await signUp(app, `pauser${n}`);
        agent = await mustCreateAgent(app, owner, { model: FAST, persona: "简短地回答。" });
      }
      // Resumed while the interrupted reply may still be streaming or about to post: it must stay unposted all the same.
      const resume = async () => {
        await sleep(random(20));
        expect((await api(app, owner, "POST", `/api/agents/${agent.id}/resume`)).status).toBe(200);
      };
      seen.push(await round(owner, agent, async () => (await api(app, owner, "POST", `/api/agents/${agent.id}/pause`)).status, n, resume));
    }
    // The race really was run both ways.
    expect(new Set(seen)).toEqual(new Set(["done", "cancelled"]));
  });

  it(`delete, ${ROUNDS} rounds`, { timeout: 60_000 }, async () => {
    const seen: string[] = [];
    let owner!: Actor;
    for (let n = 0; n < ROUNDS; n++) {
      if (n % ROUNDS_PER_OWNER === 0) owner = await signUp(app, `deleter${n}`);
      const agent = await mustCreateAgent(app, owner, { model: FAST, persona: "简短地回答。" });
      seen.push(await round(owner, agent, async () => (await api(app, owner, "DELETE", `/api/agents/${agent.id}`)).status, n));
      const after = await db.query("select count(*)::int n from messages where sender_id = $1", [agent.id]);
      expect(after.rows[0].n).toBeLessThanOrEqual(1);
    }
    expect(new Set(seen)).toEqual(new Set(["done", "cancelled"]));
  });
});
