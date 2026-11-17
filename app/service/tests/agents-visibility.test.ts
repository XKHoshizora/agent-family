import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { api, befriend, signIn, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent, PNG, SITE_ENV } from "./helpers/agents.ts";
import { useProbeBlobs } from "./helpers/blobs.ts";
import { useApp } from "./helpers/harness.ts";
import { closeAllSockets, connect, type Push } from "./helpers/ws.ts";

const { blobs } = useProbeBlobs("af-agents-vis-");
const { app, db } = useApp({ blobs, env: SITE_ENV });

afterEach(closeAllSockets);

/** What a request answers with, byte for byte: status, content type and body. */
async function observe(who: Actor, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, body?: unknown, raw?: Buffer) {
  const res = await app.inject({
    method,
    url,
    headers: { cookie: who.cookie, ...(raw ? { "content-type": "image/png" } : {}) },
    ...(raw ? { payload: raw } : body === undefined ? {} : { payload: body as object }),
  });
  return { status: res.statusCode, type: res.headers["content-type"], body: res.body };
}

describe("an Agent is invisible to everyone but its owner", () => {
  it("every Agent route answers the stranger byte-identically for the real id and a random one", async () => {
    const [owner, stranger] = [await signUp(app, "owen"), await signUp(app, "sasha")];
    const agent = await mustCreateAgent(app, owner, { persona: "a secret persona" });
    const nobody = randomUUID();

    const routes: Array<[string, string, unknown?, Buffer?]> = [
      ["GET", "/api/agents/:id"],
      ["PATCH", "/api/agents/:id", { intro: "mine now" }],
      ["PATCH", "/api/agents/:id", { handle: "stolen" }],
      ["POST", "/api/agents/:id/pause"],
      ["POST", "/api/agents/:id/resume"],
      ["DELETE", "/api/agents/:id"],
      ["PUT", "/api/agents/:id/avatar", undefined, PNG],
    ];
    for (const [method, url, body, raw] of routes) {
      const real = await observe(stranger, method as "GET", url.replace(":id", agent.id), body, raw);
      const none = await observe(stranger, method as "GET", url.replace(":id", nobody), body, raw);
      expect([method, url, real]).toEqual([method, url, none]);
    }
    expect(await observe(stranger, "GET", `/api/agents/${agent.id}`)).toMatchObject({ status: 404, body: '{"error":"not_found"}' });

    // Nothing the stranger tried changed anything.
    expect((await api(app, owner, "GET", `/api/agents/${agent.id}`)).json).toEqual(agent);
    expect((await api(app, stranger, "GET", "/api/agents")).json).toEqual({ agents: [] });
  });

  it("the conversation routes answer the stranger identically for the Agent's conversation and a random id", async () => {
    const [owner, stranger] = [await signUp(app, "oona"), await signUp(app, "stan")];
    const agent = await mustCreateAgent(app, owner);
    const real = agent.conversationId;
    const nobody = randomUUID();
    const routes: Array<[string, string, unknown?]> = [
      ["GET", "/api/conversations/:id"],
      ["GET", "/api/conversations/:id/messages"],
      ["GET", "/api/conversations/:id/messages/1"],
      ["POST", "/api/conversations/:id/messages", { text: "hello", clientTxn: "x1" }],
      ["POST", "/api/conversations/:id/read", { seq: 1 }],
      ["GET", "/api/conversations/:id/members"],
      ["GET", "/api/conversations/:id/search?q=hello"],
      ["POST", "/api/conversations/:id/members", { principalId: stranger.id }],
      ["DELETE", `/api/conversations/:id/members/${owner.id}`],
      ["PATCH", "/api/conversations/:id", { title: "renamed" }],
      ["GET", "/api/conversations/:id/run"],
      ["POST", "/api/conversations/:id/runs/retry"],
      ["POST", "/api/conversations/:id/runs/dismiss"],
      ["POST", "/api/conversations/:id/topic"],
      ["POST", `/api/conversations/:id/runs/${randomUUID()}/stop`],
    ];
    for (const [method, url, body] of routes) {
      const a = await observe(stranger, method as "GET", url.replace(":id", real), body);
      const b = await observe(stranger, method as "GET", url.replace(":id", nobody), body);
      expect([method, url, a]).toEqual([method, url, b]);
    }
    const catchUp = (id: string) => observe(stranger, "POST", "/api/sync/catchup", { positions: { [id]: 0 } });
    expect(JSON.parse((await catchUp(real)).body)).toEqual({ messages: [], gone: [real], more: false });
  });

  it("its owner cannot add a member to, rename, or leave the Agent's conversation, nor remove the Agent: 404 as for a conversation that is no group", async () => {
    const [owner, friend] = [await signUp(app, "olaf"), await signUp(app, "fern")];
    const { conversationId: direct } = await befriend(app, owner, friend);
    const agent = await mustCreateAgent(app, owner);
    const conv = agent.conversationId;
    const routes: Array<[string, (id: string) => string, unknown?]> = [
      ["POST", (id) => `/api/conversations/${id}/members`, { principalId: friend.id }],
      ["PATCH", (id) => `/api/conversations/${id}`, { title: "renamed" }],
      ["DELETE", (id) => `/api/conversations/${id}/members/${owner.id}`],
      ["DELETE", (id) => `/api/conversations/${id}/members/${agent.id}`],
    ];
    for (const [method, url, body] of routes) {
      const mine = await observe(owner, method as "GET", url(conv), body);
      expect([method, url(conv), mine]).toEqual([method, url(conv), await observe(owner, method as "GET", url(randomUUID()), body)]);
      // Exactly what a direct chat answers, the other conversation that is no group.
      expect([method, mine]).toEqual([method, await observe(owner, method as "GET", url(direct), body)]);
      expect([method, mine.status, mine.body]).toEqual([method, 404, '{"error":"not_found"}']);
    }
    const members = await api(app, owner, "GET", `/api/conversations/${conv}/members`);
    expect(members.json.members.map((m: any) => m.id).sort()).toEqual([owner.id, agent.id].sort());
    expect((await api(app, owner, "GET", `/api/conversations/${conv}`)).json.title).toBeNull();
  });

  it("the stranger's sync and the owner's friends never mention the Agent", async () => {
    const [owner, stranger, friend] = [await signUp(app, "olga"), await signUp(app, "sid"), await signUp(app, "fay")];
    const agent = await mustCreateAgent(app, owner);
    await befriend(app, owner, friend);
    await befriend(app, stranger, friend);
    for (const who of [stranger, friend]) {
      const view = await api(app, who, "GET", "/api/sync");
      const text = JSON.stringify(view.json);
      expect([who.handle, text.includes(agent.id), text.includes(agent.handle), text.includes(agent.conversationId)]).toEqual([who.handle, false, false, false]);
    }
    const social = JSON.stringify((await api(app, owner, "GET", "/api/social")).json);
    expect(social).not.toContain(agent.id);
  });

  it("looking up or befriending an Agent by handle answers as for an unknown handle, for the owner too", async () => {
    const [owner, stranger] = [await signUp(app, "ora"), await signUp(app, "sol")];
    const agent = await mustCreateAgent(app, owner, { handle: "lookup_bot" });
    for (const who of [owner, stranger]) {
      const known = await observe(who, "GET", "/api/principals/lookup?handle=lookup_bot");
      const unknown = await observe(who, "GET", "/api/principals/lookup?handle=nobody_here");
      expect([known.status, known.body]).toEqual([404, '{"error":"not_found"}']);
      expect(known).toEqual(unknown);
      const asked = await observe(who, "POST", "/api/friend-requests", { handle: "lookup_bot" });
      const askedNobody = await observe(who, "POST", "/api/friend-requests", { handle: "nobody_here" });
      expect(asked).toEqual(askedNobody);
      expect(asked.status).toBe(404);
    }
    const requests = await db.query("select 1 from friend_requests");
    expect(requests.rowCount).toBe(0);
    // A person is still found by handle.
    expect((await observe(owner, "GET", `/api/principals/lookup?handle=${stranger.handle}`)).status).toBe(200);
    expect(agent.handle).toBe("lookup_bot");
  });

  it("an Agent id cannot be put into a group: refused byte-identically to a random uuid, for its owner and for a stranger", async () => {
    const [owner, stranger, f1, f2, f3, f4] = [
      await signUp(app, "gus"),
      await signUp(app, "gil"),
      await signUp(app, "gwen"),
      await signUp(app, "gabe"),
      await signUp(app, "gina"),
      await signUp(app, "gary"),
    ];
    const agent = await mustCreateAgent(app, owner);
    await befriend(app, owner, f1);
    await befriend(app, owner, f2);
    await befriend(app, stranger, f3);
    await befriend(app, stranger, f4);
    const nobody = randomUUID();
    for (const [who, a, b] of [
      [owner, f1, f2],
      [stranger, f3, f4],
    ] as const) {
      const create = (id: string) => observe(who, "POST", "/api/conversations", { title: "g", memberIds: [a.id, b.id, id] });
      const refused = await create(agent.id);
      expect(refused).toEqual(await create(nobody));
      expect([refused.status, refused.body]).toEqual([403, '{"error":"forbidden"}']);
      const made = await api(app, who, "POST", "/api/conversations", { title: "g", memberIds: [a.id, b.id] });
      expect(made.status).toBe(201);
      const add = (id: string) => observe(who, "POST", `/api/conversations/${made.json.id}/members`, { principalId: id });
      expect(await add(agent.id)).toEqual(await add(nobody));
      expect((await add(agent.id)).status).toBe(403);
    }
    const members = await db.query("select count(*)::int as n from memberships where principal_id = $1", [agent.id]);
    expect(members.rows[0].n).toBe(1); // its own dedicated conversation only
  });

  it("changes to an Agent are pushed to its owner's sockets and nobody else's", async () => {
    const [owner, stranger] = [await signUp(app, "wanda"), await signUp(app, "walt")];
    const agent = await mustCreateAgent(app, owner);
    const [mine, theirs] = [await connect(app, owner), await connect(app, stranger)];
    const isAgent = (e: Push) => e.type === "agent" && e.id === agent.id;
    const count = () => mine.events.filter(isAgent).length;
    const step = async (run: () => Promise<unknown>) => {
      const before = count();
      await run();
      await mine.waitFor((e) => isAgent(e) && count() > before);
    };
    await step(() => api(app, owner, "PATCH", `/api/agents/${agent.id}`, { intro: "x" }));
    await step(() => api(app, owner, "POST", `/api/agents/${agent.id}/pause`));
    await step(() => api(app, owner, "POST", `/api/agents/${agent.id}/resume`));
    await step(() =>
      app.inject({ method: "PUT", url: `/api/agents/${agent.id}/avatar`, headers: { cookie: owner.cookie, "content-type": "image/png" }, payload: PNG }),
    );
    await step(() => api(app, owner, "DELETE", `/api/agents/${agent.id}`));
    expect(mine.events.filter(isAgent)).toHaveLength(5);
    // The stranger's own traffic arrives; the Agent's never does. A push of their own, sent after everything above, is
    // awaited first: by the time it is there, an `agent` push meant for them would have come too.
    await api(app, stranger, "PATCH", `/api/agents/${agent.id}`, { intro: "mine" });
    const own = await app.inject({ method: "PUT", url: "/api/me/avatar", headers: { cookie: stranger.cookie, "content-type": "image/png" }, payload: PNG });
    expect(own.statusCode).toBe(200);
    await theirs.next((e) => e.type === "principal" && e.id === stranger.id);
    expect(theirs.events.filter((e) => e.type === "agent")).toEqual([]);
  });

  it("an Agent can never be a signed-in principal: it has no sign-in account", async () => {
    const owner = await signUp(app, "ines");
    const agent = await mustCreateAgent(app, owner, { handle: "no_login" });
    const row = await db.query("select auth_user_id from principals where id = $1", [agent.id]);
    expect(row.rows[0].auth_user_id).toBeNull();
    // Nothing identifies it by e-mail either: a sign-in with the handle's address fails.
    expect((await signIn(app, "no_login@example.test", "whatever-password")).statusCode).toBeGreaterThanOrEqual(400);
    // And the constraint behind it: an agent principal with an auth user cannot be stored.
    await expect(
      db.query(`insert into principals (kind, handle, display_name, owner_id, auth_user_id) values ('agent', 'sneaky_bot', 's', $1, 'x')`, [owner.id]),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
