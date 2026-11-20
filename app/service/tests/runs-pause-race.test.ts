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
 *
 * The moment of the pause is not a matter of speed. Each round holds the reply at a named point of its life (the model's
 * call has begun, one piece has been said, the last piece has been said) and lets the pause or delete land there, or
 * lets both go at once and meet around the post, or runs it before the reply is claimed, or after it was posted. The
 * rounds go through those moments in turn, so that the race is run both ways (a reply posted before the pause, a reply
 * cancelled by it) however fast or slow the machine is; only the few milliseconds of jitter that spread the "at once"
 * rounds around the post are random, and nothing depends on them.
 */

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const random = (max: number) => Math.floor(Math.random() * (max + 1));

type Point = "start" | "mid" | "end";
/** A reply held at one of its points: `reached` says it is there, `release()` lets it go on. */
interface Hold {
  at: Point;
  reached: Promise<void>;
  released: Promise<void>;
  arrive(): void;
  release(): void;
}
let hold: Hold | null = null;

function newHold(at: Point): Hold {
  const held = { at } as Hold;
  held.reached = new Promise<void>((r) => (held.arrive = r));
  held.released = new Promise<void>((r) => (held.release = r));
  return held;
}

/** Waits here while the round's hold is at `at` (and ends at once if the call is abandoned, as the worker's stop does). */
async function pointAt(at: Point, signal?: AbortSignal): Promise<void> {
  const held = hold;
  if (!held || held.at !== at) return;
  held.arrive();
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    void held.released.then(resolve);
  });
}

/** Answers every call in two pieces; the round decides where it waits. */
const racing: ModelGateway = {
  async *stream(call): AsyncGenerator<ModelEvent> {
    await pointAt("start", call.signal);
    yield { type: "text", delta: "好的，" };
    await pointAt("mid", call.signal);
    yield { type: "text", delta: "我明白了。" };
    await pointAt("end", call.signal);
    yield { type: "finish", usage: null, truncated: false, toolCalls: [], assistant: [] };
  },
  async listModels() {
    return [];
  },
};

const { app, db } = useApp({ env: SITE_ENV, models: racing, agentWorker: false });

const ROUNDS = 48;
const FAST = { source: "site", id: "fast" } as const;

/**
 * When the pause (or delete) comes: before the reply is claimed (`queued`); while it is held at the beginning of the call
 * (`start`), between the pieces (`mid`), after the last piece (`end`); at the same time as it is let go from there
 * (`race`: the stop meets the post); after it was posted (`after`).
 */
const MOMENTS = ["queued", "start", "mid", "end", "race", "after"] as const;
type Moment = (typeof MOMENTS)[number];

async function round(
  owner: Actor,
  agent: { id: string; conversationId: string },
  action: () => Promise<number>,
  n: number,
  meanwhile: () => Promise<void> = async () => {},
): Promise<string> {
  const conv = agent.conversationId;
  const moment: Moment = MOMENTS[n % MOMENTS.length]!;
  expect((await api(app, owner, "POST", `/api/conversations/${conv}/messages`, { text: `第 ${n} 轮`, clientTxn: `race${n}` })).status).toBe(201);
  const seq = async () => Number((await db.query<{ seq: string }>("select seq from conversations where id = $1", [conv])).rows[0]!.seq);

  let status = 0;
  let lastSeq = 0;
  let claimed = false;
  const at = moment === "start" || moment === "mid" || moment === "end" ? moment : moment === "race" ? "end" : null;
  hold = at ? newHold(at) : null;
  const held = hold;
  try {
    if (moment === "queued") {
      status = await action();
      lastSeq = await seq();
      [claimed] = await Promise.all([app.agentWorker.runOnce(), meanwhile()]);
    } else if (moment === "after") {
      claimed = await app.agentWorker.runOnce();
      status = await action();
      lastSeq = await seq();
      await meanwhile();
    } else {
      const running = app.agentWorker.runOnce();
      // The reply is at its point (it cannot be anywhere else but done, were it never to arrive: then the round goes on).
      await Promise.race([held!.reached, running]);
      if (moment === "race") {
        // Let go, and ask for the pause within the next few milliseconds: the two meet around the post.
        held!.release();
        await sleep(random(8));
        status = await action();
        lastSeq = await seq();
        [claimed] = await Promise.all([running, meanwhile()]);
      } else {
        status = await action();
        lastSeq = await seq();
        // The interrupted reply goes on only now, the Agent possibly resumed in the same moment.
        held!.release();
        [claimed] = await Promise.all([running, meanwhile()]);
      }
    }
  } finally {
    held?.release();
    hold = null;
  }
  expect([n, moment, status]).toEqual([n, moment, 200]);

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
  expect([n, moment, mine.rows.filter((m) => Number(m.seq) > lastSeq)]).toEqual([n, moment, []]);
  expect([n, moment, ["done", "cancelled"].includes(run.status)]).toEqual([n, moment, true]);
  expect([n, moment, run.status, posted.length]).toEqual([n, moment, run.status, run.status === "done" ? 1 : 0]);
  expect([n, run.hold]).toEqual([n, "0"]);
  // A reply the pause cancelled while still queued never reached the worker: no usage record. Every other one has one.
  const records = await db.query("select outcome from usage_records where run_id = $1", [run.id]);
  expect([n, moment, claimed, records.rows]).toEqual([n, moment, claimed, claimed ? [{ outcome: run.status }] : []]);
  if (!claimed) expect([n, run.status]).toEqual([n, "cancelled"]);
  // The moments that fix the outcome do: before the claim or while the reply is held, the pause wins; after the post, the post does.
  if (moment === "queued") expect([n, claimed, run.status]).toEqual([n, false, "cancelled"]);
  if (moment === "after") expect([n, run.status]).toEqual([n, "done"]);
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
        await sleep(random(5));
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
