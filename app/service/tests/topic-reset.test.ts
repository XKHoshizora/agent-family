import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { api, befriend, group, signUp } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { scriptedGateway } from "./helpers/models.ts";
import { closeAllSockets, connect } from "./helpers/ws.ts";

/**
 * `POST /api/conversations/:id/topic` (spec 6.2 "新话题"): the owner starts a new topic in their Agent's conversation; a
 * `topic_reset` notice marks where what the model is shown starts (tests/context.test.ts shows that side).
 */

const gateway = scriptedGateway();
const { app, db } = useApp({ env: SITE_ENV, models: gateway, agentWorker: false });

afterEach(async () => {
  await closeAllSockets();
  expect(gateway.pending()).toBe(0);
});

const FAST = { source: "site", id: "fast" } as const;
const topic = (actor: { cookie: string } | null, conv: string) => api(app, actor, "POST", `/api/conversations/${conv}/topic`);
const runCount = async () => (await db.query("select count(*)::int as n from agent_runs")).rows[0].n as number;

describe("a new topic", () => {
  it("writes a topic_reset notice from the owner, pushed and listed but never unread, and starts no reply", async () => {
    const owner = await signUp(app, "olive");
    const agent = await mustCreateAgent(app, owner, { model: FAST, persona: "简短。", name: "小助手" });
    const conv = agent.conversationId;
    const socket = await connect(app, owner);

    const res = await topic(owner, conv);
    expect(res.status).toBe(201);
    const notice = {
      conversationId: conv,
      seq: 1,
      senderId: null,
      kind: "system",
      text: "olive 开始了新话题，之前的对话不再发给 小助手",
      system: { event: "topic_reset", actorId: owner.id },
      createdAt: expect.any(String),
    };
    expect(res.json).toEqual({ message: notice });
    expect((await socket.next((e) => e.type === "message")).message).toEqual(notice);

    // Two in a row are fine.
    expect((await topic(owner, conv)).json.message).toMatchObject({ seq: 2, system: { event: "topic_reset" } });
    const history = await api(app, owner, "GET", `/api/conversations/${conv}/messages`);
    expect(history.json.messages.map((m: any) => m.system?.event)).toEqual(["topic_reset", "topic_reset"]);
    expect(history.json.principals[owner.id]).toMatchObject({ displayName: "olive" });
    expect((await api(app, owner, "GET", `/api/conversations/${conv}`)).json).toMatchObject({ lastSeq: 2, unread: 0 });
    expect(await runCount()).toBe(0);
    expect(await app.agentWorker.runOnce()).toBe(false);
  });

  it("is allowed while the Agent is paused and refused once it is deleted", async () => {
    const owner = await signUp(app, "pia");
    const agent = await mustCreateAgent(app, owner, { model: FAST });
    expect((await api(app, owner, "POST", `/api/agents/${agent.id}/pause`)).status).toBe(200);
    expect((await topic(owner, agent.conversationId)).status).toBe(201);
    expect((await api(app, owner, "DELETE", `/api/agents/${agent.id}`)).status).toBe(200);
    expect(await topic(owner, agent.conversationId)).toEqual({ status: 403, json: { error: "cannot_send", reason: "agent_deleted" } });
  });

  it("does not stop a reply under way, which answers from what it was given", async () => {
    const owner = await signUp(app, "rhea");
    const agent = await mustCreateAgent(app, owner, { model: FAST, persona: "简短。" });
    const conv = agent.conversationId;
    const hold = gateway.hang();
    await api(app, owner, "POST", `/api/conversations/${conv}/messages`, { text: "旧问题", clientTxn: "t1" });
    const running = app.agentWorker.runOnce();
    const call = await hold.reached;
    expect((await topic(owner, conv)).status).toBe(201);
    hold.release("旧回答");
    await running;
    expect(call.messages).toEqual([{ role: "user", parts: [{ type: "text", text: "旧问题" }] }]);
    expect((await api(app, owner, "GET", `/api/conversations/${conv}/run`)).json.run).toMatchObject({ status: "done" });
    const texts = (await api(app, owner, "GET", `/api/conversations/${conv}/messages`)).json.messages.map((m: any) => m.text);
    expect(texts).toEqual(["旧问题", expect.stringContaining("开始了新话题"), "旧回答"]);
  });
});

describe("only the owner, only in an Agent's conversation", () => {
  it("a stranger, the owner of another Agent, a direct chat and a group all answer exactly like an unknown id", async () => {
    const owner = await signUp(app, "own");
    const agent = await mustCreateAgent(app, owner, { model: FAST });
    const other = await signUp(app, "oth");
    const theirs = await mustCreateAgent(app, other, { model: FAST });
    const stranger = await signUp(app, "str");
    const [friend, third] = [await signUp(app, "fri"), await signUp(app, "thi")];
    const { conversationId: dm } = await befriend(app, owner, friend);
    const g = await group(app, owner, "群", [friend, third]);

    const unknown = await topic(owner, randomUUID());
    expect(unknown).toEqual({ status: 404, json: { error: "not_found" } });
    for (const [who, conv] of [
      [stranger, agent.conversationId],
      [other, agent.conversationId],
      [owner, theirs.conversationId],
      [owner, dm],
      [friend, dm],
      [owner, g],
    ] as const) {
      expect(await topic(who, conv)).toEqual(unknown);
    }
    expect(await topic(null, agent.conversationId)).toEqual({ status: 401, json: { error: "unauthenticated" } });
    // Nothing was written anywhere.
    expect((await db.query("select count(*)::int as n from messages where kind = 'system' and body->>'event' = 'topic_reset'")).rows[0].n).toBe(0);
  });
});
