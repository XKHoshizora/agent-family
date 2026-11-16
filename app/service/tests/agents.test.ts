import { describe, expect, it } from "vitest";
import { api, signUp } from "./helpers/actors.ts";
import { createAgent, mustCreateAgent, PNG, SITE_ENV } from "./helpers/agents.ts";
import { useProbeBlobs } from "./helpers/blobs.ts";
import { useApp } from "./helpers/harness.ts";

const { blobs } = useProbeBlobs("af-agents-");
const { app, db } = useApp({ blobs, env: SITE_ENV });

const GREETING = (name: string) =>
  `你好，我是「${name}」，你刚刚创建的 Agent。我现在还没有设定。你希望我是谁、主要帮你做什么、用什么语气说话？直接告诉我就行，说完我会整理成一份设定给你确认。`;

const sync = async (who: { cookie: string }) => (await api(app, who, "GET", "/api/sync")).json;
const putAvatar = (who: { cookie: string }, id: string, payload: Buffer = PNG) =>
  app
    .inject({ method: "PUT", url: `/api/agents/${id}/avatar`, headers: { cookie: who.cookie, "content-type": "image/png" }, payload })
    .then((r) => ({ status: r.statusCode, json: r.json() }));

describe("creating an Agent", () => {
  it("returns the Agent and gives the owner one agent conversation holding only the fixed greeting", async () => {
    const owner = await signUp(app, "olivia");
    const res = await createAgent(app, owner, { handle: "helper_one", name: "小助手", intro: "hi", field: "writing" });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({
      handle: "helper_one",
      name: "小助手",
      intro: "hi",
      field: "writing",
      persona: "",
      personaVersion: 0,
      replyMode: "always",
      reasoning: "none",
      model: null,
      paused: false,
      deleted: false,
    });
    const agent = res.json;

    const view = await sync(owner);
    const agentConvs = view.conversations.filter((c: any) => c.type === "agent");
    expect(agentConvs).toHaveLength(1);
    expect(agentConvs[0]).toMatchObject({
      id: agent.conversationId,
      agentId: agent.id,
      agent: { paused: false, deleted: false },
      canSend: { ok: true },
      myRole: "speaker",
      lastSeq: 1,
      unread: 1,
    });
    expect(agentConvs[0].peerId).toBeUndefined();
    expect(agentConvs[0].members.map((m: any) => m.id).sort()).toEqual([owner.id, agent.id].sort());
    expect(view.messages).toHaveLength(1);
    expect(view.messages[0]).toMatchObject({ conversationId: agent.conversationId, seq: 1, senderId: agent.id, kind: "text", text: GREETING("小助手") });
    expect(view.principals.find((p: any) => p.id === agent.id)).toMatchObject({ kind: "agent", displayName: "小助手", handle: "helper_one" });

    const stored = await db.query("select client_txn, body from messages where conversation_id = $1", [agent.conversationId]);
    expect(stored.rows).toEqual([{ client_txn: null, body: { text: GREETING("小助手"), fixed: true } }]);

    const single = await api(app, owner, "GET", `/api/conversations/${agent.conversationId}`);
    expect(single.json).toEqual(agentConvs[0]);
  });

  it("with a persona there is no greeting, and the persona is version 1", async () => {
    const owner = await signUp(app, "pablo");
    const agent = await mustCreateAgent(app, owner, { persona: "You are a pirate." });
    expect(agent.persona).toBe("You are a pirate.");
    expect(agent.personaVersion).toBe(1);
    const view = await sync(owner);
    expect(view.messages).toEqual([]);
    expect(view.conversations.find((c: any) => c.type === "agent")).toMatchObject({ lastSeq: 0, unread: 0 });
  });

  it("refuses a taken handle (a person's or an Agent's) with 409 handle_taken", async () => {
    const owner = await signUp(app, "hank");
    const other = await signUp(app, "hilda");
    expect(await createAgent(app, owner, { handle: other.handle })).toMatchObject({ status: 409, json: { error: "handle_taken" } });
    await mustCreateAgent(app, owner, { handle: "taken_bot" });
    expect(await createAgent(app, other, { handle: "taken_bot" })).toMatchObject({ status: 409, json: { error: "handle_taken" } });
    expect(await createAgent(app, other, { handle: "TAKEN_BOT" })).toMatchObject({ status: 400 });
  });

  it("validates names, texts and unknown keys", async () => {
    const owner = await signUp(app, "vera");
    const bad: Array<Record<string, unknown>> = [
      { name: "" },
      { name: "x".repeat(21) },
      { handle: "ab" },
      { handle: "Bad-Handle" },
      { intro: "x".repeat(41) },
      { field: "x".repeat(21) },
      { persona: "x".repeat(20_001) },
      { replyMode: "sometimes" },
      { reasoning: "extreme" },
      { ownerId: owner.id },
      { model: { source: "site" } },
    ];
    for (const over of bad) expect([over, (await createAgent(app, owner, over)).status]).toEqual([over, 400]);
    expect((await createAgent(app, owner, { persona: "x".repeat(20_000) })).status).toBe(201);
    expect((await createAgent(app, owner, { name: "x".repeat(20) })).status).toBe(201);
  });
});

describe("the Agent limit", () => {
  it("is the tier's number of Agents that are not deleted", async () => {
    const owner = await signUp(app, "liam");
    const made: any[] = [];
    for (let i = 0; i < 20; i++) made.push(await mustCreateAgent(app, owner));
    expect(await createAgent(app, owner)).toMatchObject({ status: 403, json: { error: "agent_limit" } });

    expect((await api(app, owner, "DELETE", `/api/agents/${made[0].id}`)).status).toBe(200);
    expect((await createAgent(app, owner)).status).toBe(201);
    expect(await createAgent(app, owner)).toMatchObject({ status: 403, json: { error: "agent_limit" } });

    // The operator moves the account to a tier with 25.
    await db.query("update accounts set tier = 'plus' where principal_id = $1", [owner.id]);
    for (let i = 0; i < 5; i++) expect((await createAgent(app, owner)).status).toBe(201);
    expect(await createAgent(app, owner)).toMatchObject({ status: 403, json: { error: "agent_limit" } });
    expect((await api(app, owner, "GET", "/api/usage")).json).toMatchObject({ agentLimit: 25, agentCount: 25 });
  });

  it("a tier the configuration does not name gets the free limit", async () => {
    const owner = await signUp(app, "tina");
    await db.query("insert into accounts (principal_id, tier) values ($1, 'gone')", [owner.id]);
    for (let i = 0; i < 20; i++) await mustCreateAgent(app, owner);
    expect((await createAgent(app, owner)).status).toBe(403);
  });

  it("eight concurrent creates at 19 Agents yield exactly one 201", async () => {
    const owner = await signUp(app, "conrad");
    for (let i = 0; i < 19; i++) await mustCreateAgent(app, owner);
    const results = await Promise.all(Array.from({ length: 8 }, () => createAgent(app, owner)));
    expect(results.map((r) => r.status).sort()).toEqual([201, 403, 403, 403, 403, 403, 403, 403]);
    const live = await db.query("select count(*)::int as n from principals where owner_id = $1", [owner.id]);
    expect(live.rows[0].n).toBe(20);
  });

  it("another owner's Agents do not count", async () => {
    const [a, b] = [await signUp(app, "ann"), await signUp(app, "bea")];
    for (let i = 0; i < 20; i++) await mustCreateAgent(app, a);
    expect((await createAgent(app, b)).status).toBe(201);
  });
});

describe("reading and editing", () => {
  it("lists the owner's Agents, deleted ones flagged, and reads one", async () => {
    const owner = await signUp(app, "rita");
    const one = await mustCreateAgent(app, owner, { name: "One" });
    const two = await mustCreateAgent(app, owner, { name: "Two" });
    await api(app, owner, "DELETE", `/api/agents/${one.id}`);
    const list = await api(app, owner, "GET", "/api/agents");
    expect(list.json.agents.map((a: any) => [a.name, a.deleted])).toEqual([["One", true], ["Two", false]]);
    expect((await api(app, owner, "GET", `/api/agents/${two.id}`)).json).toEqual(two);
    expect((await api(app, owner, "GET", `/api/agents/${one.id}`)).json.deleted).toBe(true);
  });

  it("PATCH changes the fields, renames the principal and counts persona versions", async () => {
    const owner = await signUp(app, "pat");
    const agent = await mustCreateAgent(app, owner, { name: "Old" });
    const res = await api(app, owner, "PATCH", `/api/agents/${agent.id}`, { name: "New", intro: "i", field: "f", persona: "p1", replyMode: "mention" });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ name: "New", intro: "i", field: "f", persona: "p1", personaVersion: 1, replyMode: "mention", handle: agent.handle });
    expect((await api(app, owner, "PATCH", `/api/agents/${agent.id}`, { persona: "p1", intro: "j" })).json).toMatchObject({ personaVersion: 1, intro: "j" });
    expect((await api(app, owner, "PATCH", `/api/agents/${agent.id}`, { persona: "p2" })).json.personaVersion).toBe(2);
    expect((await api(app, owner, "PATCH", `/api/agents/${agent.id}`, {})).json).toMatchObject({ persona: "p2", personaVersion: 2 });
    expect((await sync(owner)).principals.find((p: any) => p.id === agent.id).displayName).toBe("New");
  });

  it("refuses the handle, the owner and any unknown key (400), and over-long texts", async () => {
    const owner = await signUp(app, "sven");
    const agent = await mustCreateAgent(app, owner);
    for (const body of [{ handle: "other_handle" }, { ownerId: owner.id }, { owner_id: owner.id }, { paused: true }, { deleted: true }, { persona: "x".repeat(20_001) }, { name: "" }]) {
      expect([body, (await api(app, owner, "PATCH", `/api/agents/${agent.id}`, body)).status]).toEqual([body, 400]);
    }
    expect((await api(app, owner, "PATCH", `/api/agents/${agent.id}`, { persona: "x".repeat(20_000) })).status).toBe(200);
  });
});

describe("model and reasoning", () => {
  const providerWith = async (ownerId: string, models: unknown[], name = "mine") => {
    const { rows } = await db.query<{ id: string }>(
      `insert into providers (owner_id, name, protocol, base_url, key_cipher, key_last4, models)
       values ($1, $2, 'openai_chat', 'https://api.example.test/v1', '\\x00', 'abcd', $3::jsonb) returning id`,
      [ownerId, name, JSON.stringify(models)],
    );
    return rows[0]!.id;
  };

  it("accepts a configured site model and the reasoning it allows; refuses the rest with 400", async () => {
    const owner = await signUp(app, "sam");
    expect((await createAgent(app, owner, { model: { source: "site", id: "nope" } })).status).toBe(400);
    expect((await createAgent(app, owner, { model: { source: "site", id: "fast" }, reasoning: "low" })).status).toBe(400);
    const ok = await createAgent(app, owner, { model: { source: "site", id: "thinker" }, reasoning: "medium" });
    expect(ok).toMatchObject({ status: 201, json: { model: { source: "site", id: "thinker" }, reasoning: "medium" } });
    const id = ok.json.id;
    expect((await api(app, owner, "PATCH", `/api/agents/${id}`, { reasoning: "high" })).status).toBe(400);
    expect((await api(app, owner, "PATCH", `/api/agents/${id}`, { model: { source: "site", id: "fast" } })).status).toBe(400);
    expect((await api(app, owner, "PATCH", `/api/agents/${id}`, { model: { source: "site", id: "fast" }, reasoning: "none" })).json).toMatchObject({ model: { id: "fast" }, reasoning: "none" });
    expect((await api(app, owner, "PATCH", `/api/agents/${id}`, { model: null })).json.model).toBeNull();
  });

  it("a provider model must be the caller's own and listed; it reasons only when flagged", async () => {
    const [owner, other] = [await signUp(app, "polly"), await signUp(app, "oscar")];
    const mine = await providerWith(owner.id, [
      { name: "plain", vision: false, pdf: false, reasoning: false, contextTokens: 1000 },
      { name: "deep", vision: false, pdf: false, reasoning: true, contextTokens: 1000 },
    ]);
    const theirs = await providerWith(other.id, [{ name: "plain", vision: false, pdf: false, reasoning: false, contextTokens: 1000 }]);
    const choose = (providerId: string, model: string) => ({ source: "provider", providerId, model });

    expect((await createAgent(app, owner, { model: choose(theirs, "plain") })).status).toBe(400);
    expect((await createAgent(app, owner, { model: choose(mine, "missing") })).status).toBe(400);
    expect((await createAgent(app, owner, { model: choose("3f1c2a4e-9b7d-4c1e-8a2f-5d6e7f809a1b", "plain") })).status).toBe(400);
    expect((await createAgent(app, owner, { model: choose(mine, "plain"), reasoning: "low" })).status).toBe(400);
    const deep = await createAgent(app, owner, { model: choose(mine, "deep"), reasoning: "xhigh" });
    expect(deep).toMatchObject({ status: 201, json: { model: { source: "provider", providerId: mine, model: "deep" }, reasoning: "xhigh" } });
    expect((await createAgent(app, owner, { model: choose(mine, "plain") })).status).toBe(201);
  });
});

describe("pause, resume, delete", () => {
  it("pause and resume are idempotent and show in the conversation", async () => {
    const owner = await signUp(app, "paula");
    const agent = await mustCreateAgent(app, owner);
    const conv = () => api(app, owner, "GET", `/api/conversations/${agent.conversationId}`).then((r) => r.json);
    expect((await api(app, owner, "POST", `/api/agents/${agent.id}/pause`)).json.paused).toBe(true);
    expect((await api(app, owner, "POST", `/api/agents/${agent.id}/pause`)).json.paused).toBe(true);
    expect((await conv()).agent).toEqual({ paused: true, deleted: false });
    // The owner may still write to a paused Agent.
    expect((await api(app, owner, "POST", `/api/conversations/${agent.conversationId}/messages`, { text: "hello", clientTxn: "t1" })).status).toBe(201);
    expect((await api(app, owner, "POST", `/api/agents/${agent.id}/resume`)).json.paused).toBe(false);
    expect((await conv()).agent).toEqual({ paused: false, deleted: false });
  });

  it("the owner can write in the conversation; after delete sending is 403 cannot_send/agent_deleted and history stays readable", async () => {
    const owner = await signUp(app, "dora");
    const agent = await mustCreateAgent(app, owner);
    const send = (txn: string) => api(app, owner, "POST", `/api/conversations/${agent.conversationId}/messages`, { text: "hi there", clientTxn: txn });
    expect(await send("a1")).toMatchObject({ status: 201, json: { message: { text: "hi there", senderId: owner.id } } });

    const del = await api(app, owner, "DELETE", `/api/agents/${agent.id}`);
    expect(del).toMatchObject({ status: 200, json: { deleted: true } });
    expect(await send("a2")).toEqual({ status: 403, json: { error: "cannot_send", reason: "agent_deleted" } });
    // A retry of the message that was stored is still answered.
    expect(await send("a1")).toMatchObject({ status: 200, json: { duplicate: true } });

    const history = await api(app, owner, "GET", `/api/conversations/${agent.conversationId}/messages`);
    expect(history.json.messages.map((m: any) => m.text)).toEqual([GREETING(agent.name), "hi there"]);
    const entry = (await sync(owner)).conversations.find((c: any) => c.id === agent.conversationId);
    expect(entry).toMatchObject({ canSend: { ok: false, reason: "agent_deleted" }, agent: { paused: false, deleted: true }, agentId: agent.id });
    expect((await api(app, owner, "GET", `/api/agents/${agent.id}`)).json.deleted).toBe(true);
  });

  it("delete is idempotent and irreversible; edits, pause, resume and avatar on a deleted Agent are 409 agent_deleted", async () => {
    const owner = await signUp(app, "denis");
    const agent = await mustCreateAgent(app, owner);
    expect((await api(app, owner, "DELETE", `/api/agents/${agent.id}`)).status).toBe(200);
    expect(await api(app, owner, "DELETE", `/api/agents/${agent.id}`)).toMatchObject({ status: 200, json: { deleted: true } });
    const gone = { status: 409, json: { error: "agent_deleted" } };
    expect(await api(app, owner, "PATCH", `/api/agents/${agent.id}`, { intro: "x" })).toEqual(gone);
    expect(await api(app, owner, "POST", `/api/agents/${agent.id}/pause`)).toEqual(gone);
    expect(await api(app, owner, "POST", `/api/agents/${agent.id}/resume`)).toEqual(gone);
    expect(await putAvatar(owner, agent.id)).toEqual(gone);
  });
});

describe("avatars", () => {
  it("replaces the Agent's avatar and counts the change; people's avatar changes count too", async () => {
    const owner = await signUp(app, "avery");
    const agent = await mustCreateAgent(app, owner);
    const version = async (id: string) => (await db.query("select avatar_version v from principals where id = $1", [id])).rows[0].v;
    expect(await version(agent.id)).toBe(0);
    expect(await putAvatar(owner, agent.id)).toEqual({ status: 200, json: { ok: true } });
    expect(await putAvatar(owner, agent.id)).toEqual({ status: 200, json: { ok: true } });
    expect(await version(agent.id)).toBe(2);
    const served = await app.inject({ method: "GET", url: `/api/principals/${agent.id}/avatar`, headers: { cookie: owner.cookie } });
    expect(served.headers["content-type"]).toBe("image/png");

    const put = await app.inject({ method: "PUT", url: "/api/me/avatar", headers: { cookie: owner.cookie, "content-type": "image/png" }, payload: PNG });
    expect(put.statusCode).toBe(200);
    expect(await version(owner.id)).toBe(1);

    expect((await putAvatar(owner, agent.id, Buffer.from("<svg/>"))).status).toBe(400);
    expect(await version(agent.id)).toBe(2);
  });
});
