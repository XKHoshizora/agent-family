import { afterEach, describe, expect, it } from "vitest";
import { api, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { scriptedGateway } from "./helpers/models.ts";

/**
 * The limits on replies (spec 6.4 "保护性上限", README "Agents and runs"): an owner starts at most
 * `AGENT_RUNS_PER_MINUTE` (20) replies a minute — counted exactly, also when two of their Agents are written to at the
 * same instant — and has at most `AGENT_MAX_CONCURRENT_RUNS` (2) running at once; further ones wait queued.
 */

const gateway = scriptedGateway();
const { app, db } = useApp({ env: SITE_ENV, models: gateway, agentWorker: false });

afterEach(() => {
  expect(gateway.pending()).toBe(0);
});

const FAST = { source: "site", id: "fast" } as const;
const PERSONA = "简短地回答。";

let txn = 0;
const say = (owner: Actor, conv: string, text: string) =>
  api(app, owner, "POST", `/api/conversations/${conv}/messages`, { text, clientTxn: `rl${++txn}` });
const latestRun = async (owner: Actor, conv: string) => (await api(app, owner, "GET", `/api/conversations/${conv}/run`)).json.run;
const runCount = async (ownerId: string) =>
  (await db.query<{ n: number }>("select count(*)::int as n from agent_runs where owner_id = $1", [ownerId])).rows[0]!.n;

/** `n` replies of `agent` that ended within the last minute, as if they had been answered. */
const answeredMinuteAgo = (ownerId: string, agent: { id: string; conversationId: string }, n: number) =>
  db.query(
    `insert into agent_runs (purpose, conversation_id, agent_id, owner_id, status, covers_seq, created_at, started_at, finished_at)
     select 'reply', $1, $2, $3, 'done', 0, now() - interval '30 seconds', now() - interval '30 seconds', now() - interval '29 seconds'
       from generate_series(1, $4)`,
    [agent.conversationId, agent.id, ownerId, n],
  );

describe("replies started a minute", () => {
  it("the 21st trigger within a minute creates no run, while the message itself is stored; a retry is 429", async () => {
    const owner = await signUp(app, "twenty");
    const agent = await mustCreateAgent(app, owner, { model: FAST, persona: PERSONA });
    const conv = agent.conversationId as string;
    expect(app.deps.config.agentRunsPerMinute).toBe(20);
    for (let i = 1; i <= 20; i++) {
      expect((await say(owner, conv, `第 ${i} 句`)).status).toBe(201);
      gateway.reply(`回复 ${i}`);
      expect(await app.agentWorker.runOnce()).toBe(true);
    }
    expect(await runCount(owner.id)).toBe(20);

    const sent = await say(owner, conv, "第 21 句");
    expect(sent.status).toBe(201);
    expect(await app.agentWorker.runOnce()).toBe(false);
    expect(await runCount(owner.id)).toBe(20);
    const history = (await api(app, owner, "GET", `/api/conversations/${conv}/messages`)).json.messages;
    expect(history.at(-1)).toMatchObject({ seq: sent.json.message.seq, senderId: owner.id, text: "第 21 句" });
    expect(await latestRun(owner, conv)).toMatchObject({ status: "done" });

    // Retrying counts too: make the last run a failure, then retry.
    await db.query("update agent_runs set status = 'failed', error = 'provider_unavailable' where id = (select id from agent_runs where owner_id = $1 order by created_at desc limit 1)", [owner.id]);
    expect(await api(app, owner, "POST", `/api/conversations/${conv}/runs/retry`)).toEqual({ status: 429, json: { error: "rate_limited" } });
    expect(await runCount(owner.id)).toBe(20);
  });

  it("exact under concurrency: at 19, two messages to two Agents at the same instant start exactly one reply", { timeout: 60_000 }, async () => {
    for (let round = 0; round < 8; round++) {
      const owner = await signUp(app, `pair${round}`);
      const [a, b] = [await mustCreateAgent(app, owner, { model: FAST, persona: PERSONA }), await mustCreateAgent(app, owner, { model: FAST, persona: PERSONA })];
      await answeredMinuteAgo(owner.id, a, 19);
      const [ra, rb] = await Promise.all([say(owner, a.conversationId, "同时一"), say(owner, b.conversationId, "同时二")]);
      expect([round, ra.status, rb.status]).toEqual([round, 201, 201]);
      const queued = await db.query("select agent_id from agent_runs where owner_id = $1 and status = 'queued'", [owner.id]);
      expect([round, queued.rows.length, await runCount(owner.id)]).toEqual([round, 1, 20]);
      // Leave nothing queued for the next round's owner.
      await db.query("update agent_runs set status = 'cancelled' where owner_id = $1 and status = 'queued'", [owner.id]);
    }
  });
});

describe("replies running at once", () => {
  it("a third reply of one owner stays queued until one of the two running finishes; another owner's is not held up", async () => {
    const owner = await signUp(app, "three");
    expect(app.deps.config.agentMaxConcurrentRuns).toBe(2);
    const agents = [];
    for (let i = 0; i < 3; i++) agents.push(await mustCreateAgent(app, owner, { model: FAST, persona: PERSONA }));
    const [one, two] = [gateway.hang(), gateway.hang()];
    for (const [i, agent] of agents.entries()) expect((await say(owner, agent.conversationId, `给第 ${i + 1} 个`)).status).toBe(201);

    const first = app.agentWorker.runOnce();
    await one.reached;
    const second = app.agentWorker.runOnce();
    await two.reached;
    expect(await app.agentWorker.runOnce()).toBe(false);
    expect(await latestRun(owner, agents[2]!.conversationId)).toMatchObject({ status: "queued" });

    // Another owner's reply runs meanwhile.
    const other = await signUp(app, "other");
    const theirs = await mustCreateAgent(app, other, { model: FAST, persona: PERSONA });
    await say(other, theirs.conversationId, "我的");
    gateway.reply("你的回复");
    expect(await app.agentWorker.runOnce()).toBe(true);
    expect(await latestRun(other, theirs.conversationId)).toMatchObject({ status: "done" });
    expect(await app.agentWorker.runOnce()).toBe(false);

    one.release("第一个回复");
    await first;
    gateway.reply("第三个回复");
    expect(await app.agentWorker.runOnce()).toBe(true);
    expect(await latestRun(owner, agents[2]!.conversationId)).toMatchObject({ status: "done" });
    two.release("第二个回复");
    await second;
    expect((await db.query("select status from agent_runs where owner_id = $1", [owner.id])).rows.map((r) => r.status)).toEqual(["done", "done", "done"]);
  });
});
