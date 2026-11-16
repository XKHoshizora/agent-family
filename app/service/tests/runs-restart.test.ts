import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { isRunEnd } from "../src/agents/runtime/port.ts";
import { buildApp } from "../src/app.ts";
import type { BlobStore } from "../src/attachments/blob.ts";
import { settle } from "../src/metering/settle.ts";
import type { ModelGateway } from "../src/models/gateway.ts";
import { api, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { useProbeBlobs } from "./helpers/blobs.ts";
import { NO_ANSWER_FLOOR, useApp } from "./helpers/harness.ts";
import { runningRun } from "./helpers/metering.ts";
import { scriptedGateway } from "./helpers/models.ts";
import { MULTIPART, multipart } from "./helpers/multipart.ts";
import { closeAllSockets, connect, type Push } from "./helpers/ws.ts";

/**
 * The service dying mid-reply (review focus 5, spec 6.4 and 6.5, README "Agents and runs"): at the next start, before
 * the worker, every run left `running` is ended without a model call — `failed` / `provider_unavailable` and
 * retryable, or `done` when its reply had been posted, or `cancelled` when its Agent's pause or delete had interrupted
 * it — and its hold released by a settlement that costs nothing. No second call, no duplicate message, no hold left.
 * Each test builds an app, closes it mid-reply (the closest a test gets to a crash: nothing more of the run is
 * recorded) and builds a new one on the same database.
 */

const store = useProbeBlobs("af-restart-");
// The file's own app only gives the configuration and empties the database before each test; every test builds the
// apps it stops and starts.
const { app: base, db } = useApp({ env: SITE_ENV, models: scriptedGateway(), agentWorker: false });

const FAST = { source: "site", id: "fast" } as const;
const PERSONA = "简短地回答。";
const NOTHING = { inputChars: 0, outputChars: 0 };

const open: FastifyInstance[] = [];
afterEach(async () => {
  await closeAllSockets();
  for (const app of open.splice(0)) await app.close();
});

/** A new app on the test database (as if the service started), ready, its worker driven by hand. */
async function start(models: ModelGateway, blobs: BlobStore = store.blobs): Promise<FastifyInstance> {
  const app = await buildApp({ config: base.deps.config, db, models, blobs }, { agentWorker: false, answerFloor: NO_ANSWER_FLOOR });
  await app.ready();
  open.push(app);
  return app;
}
/** Closes `app` (the service stops) and forgets it. */
async function stop(app: FastifyInstance): Promise<void> {
  open.splice(open.indexOf(app), 1);
  await app.close();
}

let txn = 0;
const say = (app: FastifyInstance, owner: Actor, conv: string, text: string) =>
  api(app, owner, "POST", `/api/conversations/${conv}/messages`, { text, clientTxn: `rs${++txn}` });
const latestRun = async (app: FastifyInstance, owner: Actor, conv: string) => (await api(app, owner, "GET", `/api/conversations/${conv}/run`)).json.run;
const fromAgent = async (app: FastifyInstance, owner: Actor, conv: string, agentId: string): Promise<any[]> =>
  (await api(app, owner, "GET", `/api/conversations/${conv}/messages`)).json.messages.filter((m: any) => m.senderId === agentId);
const holds = async () => (await db.query<{ h: string }>("select coalesce(sum(hold_micro), 0)::text as h from agent_runs")).rows[0]!.h;
const records = async (runId: string) =>
  (
    await db.query(
      `select outcome, source, model, estimated, cost_micro::text as cost, free_micro::text as free, balance_micro::text as balance
         from usage_records where run_id = $1`,
      [runId],
    )
  ).rows;
const statusOf = async (runId: string) =>
  (await db.query("select status, error, source, hold_micro::text as hold from agent_runs where id = $1", [runId])).rows[0];
const isRun = (conv: string, status: string) => (e: Push) => e.type === "run" && e.conversationId === conv && e.run.status === status;

/** A person (signed up on `app`) with an Agent on the free site model. */
async function owned(app: FastifyInstance, name: string) {
  const owner = await signUp(app, name);
  const agent = await mustCreateAgent(app, owner, { model: FAST, persona: PERSONA });
  return { owner, agent, conv: agent.conversationId as string };
}

describe("a run left running when the service stopped", () => {
  it("is failed and retryable at the next start: no model call for it, no message, no hold; retry then works", async () => {
    const before = scriptedGateway();
    const old = await start(before);
    const { owner, agent, conv } = await owned(old, "rex");
    const hold = before.hang();
    await say(old, owner, conv, "你好");
    const running = old.agentWorker.runOnce();
    await hold.reached;
    const run = await latestRun(old, owner, conv);
    expect(run).toMatchObject({ status: "running" });
    expect(await holds()).not.toBe("0"); // admitted: its maximum cost is held

    await stop(old);
    await running;
    expect(await statusOf(run.id)).toMatchObject({ status: "running" });

    const after = scriptedGateway();
    const fresh = await start(after);
    expect(after.calls).toHaveLength(0);
    expect(await latestRun(fresh, owner, conv)).toEqual({ id: run.id, status: "failed", error: "provider_unavailable", retryable: true });
    expect(await holds()).toBe("0");
    expect(await records(run.id)).toEqual([{ outcome: "failed", source: "site", model: "fast", estimated: true, cost: "0", free: "0", balance: "0" }]);
    expect(await fromAgent(fresh, owner, conv, agent.id)).toEqual([]);
    expect(await fresh.agentWorker.runOnce()).toBe(false);
    expect(after.calls).toHaveLength(0);

    after.reply("我回来了。");
    expect((await api(fresh, owner, "POST", `/api/conversations/${conv}/runs/retry`)).status).toBe(201);
    expect(await fresh.agentWorker.runOnce()).toBe(true);
    expect((await fromAgent(fresh, owner, conv, agent.id)).map((m) => m.text)).toEqual(["我回来了。"]);
    expect(await latestRun(fresh, owner, conv)).toMatchObject({ status: "done" });
    expect(await holds()).toBe("0");
  });

  it("whose reply was posted before the stop (the crash fell between post and finish) is done, with exactly one message", async () => {
    const old = await start(scriptedGateway());
    const { owner, agent, conv } = await owned(old, "posty");
    await say(old, owner, conv, "你好");
    const ticket = (await old.agentPort.claimNext())!;
    expect(isRunEnd(await old.agentPort.begin(ticket))).toBe(false);
    expect(await old.agentPort.post(ticket, { text: "已经说完了。", reasoning: "", stopped: false, truncated: false })).toBe("posted");
    await stop(old);

    const after = scriptedGateway();
    const fresh = await start(after);
    expect(await latestRun(fresh, owner, conv)).toEqual({ id: ticket.id, status: "done", retryable: false });
    expect((await fromAgent(fresh, owner, conv, agent.id)).map((m) => m.text)).toEqual(["已经说完了。"]);
    expect(await records(ticket.id)).toEqual([{ outcome: "done", source: "site", model: "fast", estimated: true, cost: "0", free: "0", balance: "0" }]);
    expect(await holds()).toBe("0");
    expect(await fresh.agentWorker.runOnce()).toBe(false);
    expect(after.calls).toHaveLength(0);
  });

  it("whose reply was posted as stopped by its owner is recorded stopped, as finish would have", async () => {
    const old = await start(scriptedGateway());
    const { owner, agent, conv } = await owned(old, "halted");
    await say(old, owner, conv, "讲吧");
    const ticket = (await old.agentPort.claimNext())!;
    await old.agentPort.begin(ticket);
    expect(await old.agentPort.post(ticket, { text: "讲到一半", reasoning: "", stopped: true, truncated: false })).toBe("posted");
    await stop(old);

    const fresh = await start(scriptedGateway());
    expect(await latestRun(fresh, owner, conv)).toEqual({ id: ticket.id, status: "stopped", retryable: false });
    expect(await fromAgent(fresh, owner, conv, agent.id)).toMatchObject([{ text: "讲到一半", stopped: true }]);
    expect(await records(ticket.id)).toMatchObject([{ outcome: "stopped", cost: "0" }]);
  });

  it("whose reply was posted while the owner wrote more: done, and the follow-up answers what came meanwhile", async () => {
    const old = await start(scriptedGateway());
    const { owner, agent, conv } = await owned(old, "follow");
    await say(old, owner, conv, "第一句");
    const ticket = (await old.agentPort.claimNext())!;
    await old.agentPort.begin(ticket);
    await say(old, owner, conv, "第二句"); // noted on the running reply
    expect(await old.agentPort.post(ticket, { text: "回第一句。", reasoning: "", stopped: false, truncated: false })).toBe("posted");
    await stop(old);

    const after = scriptedGateway();
    const fresh = await start(after);
    expect(await statusOf(ticket.id)).toMatchObject({ status: "done" });
    expect(await latestRun(fresh, owner, conv)).toMatchObject({ status: "queued" });
    after.reply("回第二句。");
    expect(await fresh.agentWorker.runOnce()).toBe(true);
    expect((await fromAgent(fresh, owner, conv, agent.id)).map((m) => m.text)).toEqual(["回第一句。", "回第二句。"]);
  });

  it("that its Agent's pause had interrupted is cancelled with that reason; queued runs stay queued and the new service answers them", async () => {
    const old = await start(scriptedGateway());
    const a = await owned(old, "paws");
    const b = await mustCreateAgent(old, a.owner, { model: FAST, persona: PERSONA });
    await say(old, a.owner, a.conv, "你好");
    const ticket = (await old.agentPort.claimNext())!;
    await old.agentPort.begin(ticket);
    expect((await api(old, a.owner, "POST", `/api/agents/${a.agent.id}/pause`)).status).toBe(200);
    await say(old, a.owner, b.conversationId, "另一个"); // queued, never claimed
    const queued = await latestRun(old, a.owner, b.conversationId);
    expect(queued).toMatchObject({ status: "queued" });
    await stop(old);

    const after = scriptedGateway();
    const fresh = await start(after);
    expect(await latestRun(fresh, a.owner, a.conv)).toEqual({ id: ticket.id, status: "cancelled", error: "agent_paused", retryable: false });
    expect(await records(ticket.id)).toMatchObject([{ outcome: "cancelled", cost: "0" }]);
    expect(await latestRun(fresh, a.owner, b.conversationId)).toEqual(queued);
    expect(after.calls).toHaveLength(0);

    after.reply("现在回答。");
    expect(await fresh.agentWorker.runOnce()).toBe(true);
    expect((await fromAgent(fresh, a.owner, b.conversationId, b.id)).map((m) => m.text)).toEqual(["现在回答。"]);
    expect(await fresh.agentWorker.runOnce()).toBe(false);
    expect(await holds()).toBe("0");
  });

  it("that already has its usage record gets no second one; a persona draft left running is released too", async () => {
    const old = await start(scriptedGateway());
    const { owner, conv } = await owned(old, "twice");
    await say(old, owner, conv, "你好");
    const ticket = (await old.agentPort.claimNext())!;
    await old.agentPort.begin(ticket);
    // Settled, but the service stopped before the run left `running`.
    await db.tx((t) => settle(t, old.deps.config, ticket.id, null, NOTHING, "failed", new Date()));
    const draft = await runningRun(db, owner.id);
    await stop(old);

    await start(scriptedGateway());
    expect(await statusOf(ticket.id)).toMatchObject({ status: "failed", error: "provider_unavailable", hold: "0" });
    expect(await records(ticket.id)).toHaveLength(1);
    expect(await statusOf(draft)).toMatchObject({ status: "failed", error: "provider_unavailable", hold: "0" });
    expect(await records(draft)).toEqual([{ outcome: "failed", source: null, model: null, estimated: true, cost: "0", free: "0", balance: "0" }]);
  });

  it("the new service carries nothing over from the old one's stop and pause flags: its replies stream and post as usual", async () => {
    const old = await start(scriptedGateway());
    const { owner, agent, conv } = await owned(old, "flags");
    await say(old, owner, conv, "你好");
    const ticket = (await old.agentPort.claimNext())!;
    await old.agentPort.begin(ticket);
    old.agentPort.requestStop(ticket.id);
    old.agentPort.interruptRuns([ticket.id]);
    await stop(old);

    const after = scriptedGateway();
    const fresh = await start(after);
    expect(await statusOf(ticket.id)).toMatchObject({ status: "failed" });
    const s = await connect(fresh, owner);
    after.reply("这一次完整地说完了。");
    expect((await api(fresh, owner, "POST", `/api/conversations/${conv}/runs/retry`)).status).toBe(201);
    expect(await fresh.agentWorker.runOnce()).toBe(true);
    await s.next(isRun(conv, "done"));
    const deltas = s.events.filter((e) => e.type === "delta").map((e) => e.text ?? "");
    expect(deltas.join("")).toBe("这一次完整地说完了。");
    expect((await fromAgent(fresh, owner, conv, agent.id)).map((m) => m.text)).toEqual(["这一次完整地说完了。"]);
  });
});

describe("the service stopping while a reply reads its attachments", () => {
  it("abandons the read at once, admits nothing and leaves the run running, unadmitted; the next start fails it", async () => {
    let reached!: () => void;
    const reading = new Promise<void>((resolve) => (reached = resolve));
    // A store whose reads never come (the service closes before they would).
    const hanging: BlobStore = {
      ...store.blobs,
      get: () => {
        reached();
        return new Promise(() => {});
      },
    };
    const before = scriptedGateway();
    const old = await start(before, hanging);
    const { owner, agent, conv } = await owned(old, "reader");
    const upload = await old.inject({
      method: "POST",
      url: `/api/conversations/${conv}/attachments`,
      headers: { cookie: owner.cookie, "content-type": MULTIPART },
      payload: multipart([{ name: "file", filename: "notes.txt", type: "text/plain", data: "一些笔记" }]),
    });
    expect(upload.statusCode).toBe(201);
    expect((await api(old, owner, "POST", `/api/conversations/${conv}/messages`, { attachmentId: upload.json().id, clientTxn: "rs-file" })).status).toBe(201);
    const running = old.agentWorker.runOnce();
    await reading;
    const run = await latestRun(old, owner, conv);

    const t0 = performance.now();
    await stop(old);
    await running;
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(before.calls).toHaveLength(0);
    expect(await statusOf(run.id)).toEqual({ status: "running", error: null, source: null, hold: "0" });
    expect(await records(run.id)).toEqual([]);

    await start(scriptedGateway());
    expect(await statusOf(run.id)).toMatchObject({ status: "failed", error: "provider_unavailable", source: null, hold: "0" });
    expect(await records(run.id)).toEqual([{ outcome: "failed", source: null, model: null, estimated: true, cost: "0", free: "0", balance: "0" }]);
    expect(await db.query("select 1 from messages where sender_id = $1", [agent.id]).then((r) => r.rowCount)).toBe(0);
  });
});
