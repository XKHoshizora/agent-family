import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { createWhisper, expireWhispers, resolveWhisper, WHISPER_OPEN_DAYS, WHISPER_SWEEP_BATCH, WHISPER_TEXT_MAX, type Whisper, type WhisperBody } from "../src/whispers/store.ts";
import { toWireWhisper } from "../src/whispers/wire.ts";
import { api, group, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { scriptedGateway } from "./helpers/models.ts";
import { closeAllSockets, connect } from "./helpers/ws.ts";

/**
 * Whispers (悄悄话, design rules 16 and 19): a small note in a conversation that only the owner of one of its Agents ever
 * sees, with the buttons it offers. Never a message (no seq); the owner is pushed it, finds it in their sync, catch-up and
 * the list route; answers it once; it expires after 7 days (the periodic sweep), when its owner or its Agent leaves, and
 * when its Agent is deleted. What nobody else may learn of it is in whispers-privacy.test.ts.
 */

const gateway = scriptedGateway();
const { app, db } = useApp({ env: SITE_ENV, models: gateway, agentWorker: false });
afterEach(closeAllSockets);

const FAST = { source: "site", id: "fast" } as const;
const DAY = 86_400_000;
const BODY: WhisperBody = { text: "在别处找到了：周五下午有空", actions: ["tell", "dismiss"] };

let txn = 0;
const say = async (who: Actor, conv: string, text: string): Promise<number> => {
  const sent = await api(app, who, "POST", `/api/conversations/${conv}/messages`, { text, clientTxn: `wh${++txn}` });
  if (sent.status !== 201) throw new Error(`say: ${sent.status} ${JSON.stringify(sent.json)}`);
  return sent.json.message.seq as number;
};
const lastSeqOf = async (conv: string) => Number((await db.query<{ seq: string }>("select seq from conversations where id = $1", [conv])).rows[0]!.seq);
const statusOf = async (id: string) => (await db.query<{ status: string }>("select status from whispers where id = $1", [id])).rows[0]?.status ?? null;

/** olive's Agent in olive's group with mia and ned; olive also has the Agent's own conversation. */
async function world() {
  const [owner, mia, ned] = [await signUp(app, "olive"), await signUp(app, "mia"), await signUp(app, "ned")];
  const agent = await mustCreateAgent(app, owner, { model: FAST, persona: "简短地回答。" });
  const g = await group(app, owner, "team", [mia, ned]);
  expect((await api(app, owner, "POST", `/api/conversations/${g}/members`, { principalId: agent.id })).status).toBe(201);
  await say(mia, g, "大家好");
  return { owner, mia, ned, agent: agent as { id: string; conversationId: string }, g };
}
type World = Awaited<ReturnType<typeof world>>;

/** A whisper of olive's about her Agent in `conv` (the group by default), pushed to her as a later task will. */
async function whisper(w: World, over: Partial<{ conversationId: string; body: WhisperBody; kind: Whisper["kind"] }> = {}): Promise<Whisper> {
  const made = await db.tx((t) => createWhisper(t, { conversationId: w.g, ownerId: w.owner.id, agentId: w.agent.id, kind: "found_elsewhere", body: BODY, ...over }));
  if (!made) throw new Error("whisper refused");
  app.realtime.pushWhisper(made.ownerId, toWireWhisper(made));
  return made;
}
/** Moves a whisper `days` days into the past. */
const age = (id: string, days: number) => db.query("update whispers set created_at = now() - $2::int * interval '1 day' where id = $1", [id, days]);

describe("createWhisper", () => {
  it("stores it after the conversation's last message without taking a seq: no message, lastSeq unchanged", async () => {
    const w = await world();
    const before = await lastSeqOf(w.g);
    const messages = Number((await db.query("select count(*) n from messages")).rows[0].n);
    const made = await whisper(w);
    expect(made).toMatchObject({ conversationId: w.g, ownerId: w.owner.id, agentId: w.agent.id, afterSeq: before, kind: "found_elsewhere", status: "open", resolvedAt: null, body: BODY });
    expect(await lastSeqOf(w.g)).toBe(before);
    expect(Number((await db.query("select count(*) n from messages")).rows[0].n)).toBe(messages);
    // The next message takes the next seq, as if nothing had happened.
    expect(await say(w.mia, w.g, "还在吗")).toBe(before + 1);
  });

  it("refuses (null) an owner who is not a current member, an Agent that is not theirs or not in the conversation, a deleted Agent", async () => {
    const w = await world();
    const stranger = await signUp(app, "sam");
    const theirs = await mustCreateAgent(app, stranger, { model: FAST });
    const outside = await mustCreateAgent(app, w.owner, { model: FAST });
    const make = (ownerId: string, agentId: string, conversationId = w.g) => db.tx((t) => createWhisper(t, { conversationId, ownerId, agentId, kind: "tools_off", body: BODY }));
    expect(await make(stranger.id, theirs.id)).toBeNull();
    // mia is a member, but the Agent is not hers.
    expect(await make(w.mia.id, w.agent.id)).toBeNull();
    // olive's other Agent is not in the group.
    expect(await make(w.owner.id, outside.id)).toBeNull();
    // A conversation that is not one.
    expect(await make(w.owner.id, w.agent.id, "6a0d4c2e-1b3f-4a5e-9c7d-8e9f0a1b2c3d")).toBeNull();
    // olive left the group (taking her Agent with her).
    const other = await group(app, w.owner, "other", [w.mia, w.ned]);
    expect((await api(app, w.owner, "POST", `/api/conversations/${other}/members`, { principalId: w.agent.id })).status).toBe(201);
    expect((await api(app, w.owner, "DELETE", `/api/conversations/${other}/members/${w.owner.id}`)).status).toBe(200);
    expect(await make(w.owner.id, w.agent.id, other)).toBeNull();
    // A deleted Agent.
    expect((await api(app, w.owner, "DELETE", `/api/agents/${w.agent.id}`)).status).toBe(200);
    expect(await make(w.owner.id, w.agent.id, w.agent.conversationId)).toBeNull();
    expect(Number((await db.query("select count(*) n from whispers")).rows[0].n)).toBe(0);
  });

  it("works in the Agent's own conversation too", async () => {
    const w = await world();
    const made = await whisper(w, { conversationId: w.agent.conversationId, kind: "tools_off", body: { text: "这个模型用不了工具", actions: ["dismiss"] } });
    expect(made.afterSeq).toBe(await lastSeqOf(w.agent.conversationId));
  });

  it("cleans the text as notices are (one line, no invisible characters), and refuses a body that is empty, too long or offers other buttons", async () => {
    const w = await world();
    const made = await whisper(w, { body: { text: "  第一行\n第二行​  ", actions: ["dismiss"], detail: { seq: 3 } } });
    expect(made.body).toEqual({ text: "第一行 第二行", actions: ["dismiss"], detail: { seq: 3 } });
    expect(WHISPER_TEXT_MAX).toBe(2000);
    for (const body of [
      { text: " \n​ ", actions: ["dismiss"] },
      { text: "字".repeat(WHISPER_TEXT_MAX + 1), actions: ["dismiss"] },
      { text: "好", actions: ["tell", "tell"] },
      { text: "好", actions: ["reply"] },
      { text: 3, actions: [] },
    ]) {
      await expect(db.tx((t) => createWhisper(t, { conversationId: w.g, ownerId: w.owner.id, agentId: w.agent.id, kind: "memory", body: body as WhisperBody }))).rejects.toThrow(/whisper body/);
    }
    // Exactly the limit is taken.
    await whisper(w, { body: { text: "字".repeat(WHISPER_TEXT_MAX), actions: [] } });
  });
});

describe("the owner learns of it", () => {
  it("as a `whisper` push to their sockets", async () => {
    const w = await world();
    const socket = await connect(app, w.owner);
    const made = await whisper(w);
    const push = await socket.next((e) => e.type === "whisper");
    expect(push).toEqual({
      type: "whisper",
      whisper: { id: made.id, conversationId: w.g, agentId: w.agent.id, afterSeq: made.afterSeq, kind: "found_elsewhere", text: BODY.text, actions: ["tell", "dismiss"], status: "open", createdAt: made.createdAt.toISOString() },
    });
  });

  it("in /api/sync (its open ones, and the answered ones of the messages it holds) and `whispers: n` on that conversation only, absent at 0", async () => {
    const w = await world();
    let sync = (await api(app, w.owner, "GET", "/api/sync")).json;
    expect(sync.whispers).toBeUndefined();
    expect(sync.conversations.every((c: any) => !("whispers" in c))).toBe(true);
    const a = await whisper(w);
    const b = await whisper(w, { body: { text: "还有一件", actions: ["dismiss"] } });
    sync = (await api(app, w.owner, "GET", "/api/sync")).json;
    expect(sync.whispers.map((x: any) => x.id)).toEqual([a.id, b.id]);
    expect(sync.conversations.find((c: any) => c.id === w.g).whispers).toBe(2);
    expect(sync.conversations.find((c: any) => c.id === w.agent.conversationId).whispers).toBeUndefined();
    expect((await api(app, w.owner, "GET", `/api/conversations/${w.g}`)).json.whispers).toBe(2);
    // Answered: no longer counted, still shown with the messages it follows.
    expect((await api(app, w.owner, "POST", `/api/whispers/${a.id}/accept`)).status).toBe(200);
    sync = (await api(app, w.owner, "GET", "/api/sync")).json;
    expect(sync.conversations.find((c: any) => c.id === w.g).whispers).toBe(1);
    expect(sync.whispers.map((x: any) => [x.id, x.status])).toEqual([
      [a.id, "accepted"],
      [b.id, "open"],
    ]);
    expect((await api(app, w.owner, "POST", `/api/whispers/${b.id}/decline`)).status).toBe(200);
    expect("whispers" in (await api(app, w.owner, "GET", `/api/conversations/${w.g}`)).json).toBe(false);
  });

  it("in /api/sync an answered whisper of a message older than the 30 it returns is left to the list route; an open one always comes", async () => {
    const w = await world();
    const old = await whisper(w);
    const oldOpen = await whisper(w, { body: { text: "还开着", actions: ["dismiss"] } });
    expect((await api(app, w.owner, "POST", `/api/whispers/${old.id}/decline`)).status).toBe(200);
    for (let i = 0; i < 31; i++) await say(w.mia, w.g, `消息 ${i}`);
    const sync = (await api(app, w.owner, "GET", "/api/sync")).json;
    expect(sync.whispers.map((x: any) => x.id)).toEqual([oldOpen.id]);
    const listed = (await api(app, w.owner, "GET", `/api/conversations/${w.g}/whispers`)).json;
    expect(listed.whispers.map((x: any) => x.id)).toEqual([oldOpen.id, old.id]);
  });

  it("in catch-up: the open ones and those after the position of the conversations caught up", async () => {
    const w = await world();
    const position = await lastSeqOf(w.g);
    expect((await api(app, w.owner, "POST", "/api/sync/catchup", { positions: { [w.g]: position } })).json).toEqual({ messages: [], gone: [], more: false });
    const made = await whisper(w);
    const caught = (await api(app, w.owner, "POST", "/api/sync/catchup", { positions: { [w.g]: position } })).json;
    expect(caught).toEqual({ messages: [], gone: [], more: false, whispers: [toWireWhisper(made)].map((x) => JSON.parse(JSON.stringify(x))) });
    // Answered, it still comes with a position before it, not with one after it.
    expect((await api(app, w.owner, "POST", `/api/whispers/${made.id}/accept`)).status).toBe(200);
    expect((await api(app, w.owner, "POST", "/api/sync/catchup", { positions: { [w.g]: position } })).json.whispers.map((x: any) => x.status)).toEqual(["accepted"]);
    await say(w.mia, w.g, "后来");
    expect((await api(app, w.owner, "POST", "/api/sync/catchup", { positions: { [w.g]: position + 1 } })).json).toEqual({ messages: [], gone: [], more: false });
  });

  it("from the list route, newest first, a page at a time (`before` an afterSeq)", async () => {
    const w = await world();
    const made: Whisper[] = [];
    for (let i = 0; i < 5; i++) {
      made.push(await whisper(w, { body: { text: `第 ${i} 条`, actions: ["dismiss"] } }));
      await say(w.mia, w.g, `然后 ${i}`);
    }
    // Two at the same place.
    const twin = await whisper(w, { body: { text: "同一处", actions: ["dismiss"] } });
    const twin2 = await whisper(w, { body: { text: "同一处 2", actions: ["dismiss"] } });
    const url = `/api/conversations/${w.g}/whispers`;
    const all = (await api(app, w.owner, "GET", url)).json;
    expect(all.whispers.map((x: any) => x.id)).toEqual([twin2.id, twin.id, ...[...made].reverse().map((x) => x.id)]);
    expect(all.nextBefore).toBeNull();
    const first = (await api(app, w.owner, "GET", `${url}?limit=3`)).json;
    expect(first.whispers.map((x: any) => x.id)).toEqual([twin2.id, twin.id, made[4]!.id]);
    expect(first.nextBefore).toBe(made[4]!.afterSeq);
    const second = (await api(app, w.owner, "GET", `${url}?limit=3&before=${first.nextBefore}`)).json;
    expect(second.whispers.map((x: any) => x.id)).toEqual([made[3]!.id, made[2]!.id, made[1]!.id]);
    const third = (await api(app, w.owner, "GET", `${url}?limit=3&before=${second.nextBefore}`)).json;
    expect([third.whispers.map((x: any) => x.id), third.nextBefore]).toEqual([[made[0]!.id], null]);
    // A page never splits the whispers of one place: the next page starts below it.
    const split = (await api(app, w.owner, "GET", `${url}?limit=1`)).json;
    expect([split.whispers.map((x: any) => x.id), split.nextBefore]).toEqual([[twin2.id, twin.id], twin.afterSeq]);
    expect((await api(app, w.owner, "GET", `${url}?before=${made[2]!.afterSeq + 1}`)).json.whispers.map((x: any) => x.id)).toEqual([made[2]!.id, made[1]!.id, made[0]!.id]);
    for (const bad of ["before=0", "before=x", "before=-1", "limit=0", "limit=101"]) expect([bad, (await api(app, w.owner, "GET", `${url}?${bad}`)).status]).toEqual([bad, 400]);
  });

  it("the list route: the owner of an Agent in the conversation, or of a whisper there, gets theirs (none: []); anyone else 404", async () => {
    const w = await world();
    const url = (conv: string) => `/api/conversations/${conv}/whispers`;
    expect((await api(app, w.owner, "GET", url(w.g))).json).toEqual({ whispers: [], nextBefore: null });
    expect((await api(app, w.owner, "GET", url(w.agent.conversationId))).json).toEqual({ whispers: [], nextBefore: null });
    expect(await api(app, w.mia, "GET", url(w.g))).toEqual({ status: 404, json: { error: "not_found" } });
    const made = await whisper(w);
    // Its Agent taken out of the group: the whisper expired, still hers to see.
    expect((await api(app, w.owner, "DELETE", `/api/conversations/${w.g}/members/${w.agent.id}`)).status).toBe(200);
    expect((await api(app, w.owner, "GET", url(w.g))).json.whispers.map((x: any) => [x.id, x.status])).toEqual([[made.id, "expired"]]);
  });
});

describe("answering", () => {
  it("accept and decline once: the whisper as it is now, pushed to the owner's sockets; again, or the other answer, 409 stale_whisper", async () => {
    const w = await world();
    const socket = await connect(app, w.owner);
    const a = await whisper(w);
    const b = await whisper(w);
    await socket.waitFor((e) => e.type === "whisper" && e.whisper.id === b.id);
    const accepted = await api(app, w.owner, "POST", `/api/whispers/${a.id}/accept`);
    expect(accepted).toEqual({ status: 200, json: { ...JSON.parse(JSON.stringify(toWireWhisper(a))), status: "accepted" } });
    expect(await socket.next((e) => e.type === "whisper" && e.whisper.status === "accepted")).toEqual({ type: "whisper", whisper: accepted.json });
    expect(await api(app, w.owner, "POST", `/api/whispers/${a.id}/accept`)).toEqual({ status: 409, json: { error: "stale_whisper" } });
    expect(await api(app, w.owner, "POST", `/api/whispers/${a.id}/decline`)).toEqual({ status: 409, json: { error: "stale_whisper" } });
    const declined = await api(app, w.owner, "POST", `/api/whispers/${b.id}/decline`, {});
    expect(declined.json.status).toBe("declined");
    expect(await api(app, w.owner, "POST", `/api/whispers/${b.id}/accept`)).toEqual({ status: 409, json: { error: "stale_whisper" } });
    const rows = (await db.query("select status, resolved_at is not null as resolved from whispers order by created_at")).rows;
    expect(rows).toEqual([
      { status: "accepted", resolved: true },
      { status: "declined", resolved: true },
    ]);
  });

  it("only with a button it offers: accept needs `tell`, decline `dismiss`", async () => {
    const w = await world();
    const onlyDismiss = await whisper(w, { body: { text: "知道了", actions: ["dismiss"] } });
    const none = await whisper(w, { body: { text: "只是告诉你", actions: [] } });
    expect(await api(app, w.owner, "POST", `/api/whispers/${onlyDismiss.id}/accept`)).toEqual({ status: 409, json: { error: "stale_whisper" } });
    expect(await api(app, w.owner, "POST", `/api/whispers/${none.id}/decline`)).toEqual({ status: 409, json: { error: "stale_whisper" } });
    expect((await api(app, w.owner, "POST", `/api/whispers/${onlyDismiss.id}/decline`)).json.status).toBe("declined");
  });

  it("resolveWhisper: gone for anyone else's or no whisper, stale for one that is not open, the row once it is answered", async () => {
    const w = await world();
    const made = await whisper(w);
    expect(await db.tx((t) => resolveWhisper(t, w.mia.id, made.id, "accepted"))).toBe("gone");
    expect(await db.tx((t) => resolveWhisper(t, w.owner.id, "6a0d4c2e-1b3f-4a5e-9c7d-8e9f0a1b2c3d", "accepted"))).toBe("gone");
    const done = await db.tx((t) => resolveWhisper(t, w.owner.id, made.id, "declined"));
    expect(done).toMatchObject({ id: made.id, status: "declined" });
    expect((done as Whisper).resolvedAt).toBeInstanceOf(Date);
    expect(await db.tx((t) => resolveWhisper(t, w.owner.id, made.id, "declined"))).toBe("stale");
  });

  it("someone else's whisper, an id that is none, or a malformed one: 404 (400 for the malformed)", async () => {
    const w = await world();
    const made = await whisper(w);
    for (const verb of ["accept", "decline"]) {
      expect(await api(app, w.mia, "POST", `/api/whispers/${made.id}/${verb}`)).toEqual({ status: 404, json: { error: "not_found" } });
      expect(await api(app, w.owner, "POST", `/api/whispers/6a0d4c2e-1b3f-4a5e-9c7d-8e9f0a1b2c3d/${verb}`)).toEqual({ status: 404, json: { error: "not_found" } });
      expect((await api(app, w.owner, "POST", `/api/whispers/nope/${verb}`)).status).toBe(400);
      expect((await api(app, null, "POST", `/api/whispers/${made.id}/${verb}`)).status).toBe(401);
    }
    expect(await statusOf(made.id)).toBe("open");
  });
});

describe("expiry", () => {
  it("an open whisper older than 7 days is set expired by the sweep (the clock is its argument); answered ones and younger ones stay", async () => {
    expect(WHISPER_OPEN_DAYS).toBe(7);
    const w = await world();
    const old = await whisper(w);
    const young = await whisper(w);
    const answered = await whisper(w);
    expect((await api(app, w.owner, "POST", `/api/whispers/${answered.id}/decline`)).status).toBe(200);
    await age(old.id, 8);
    await age(answered.id, 8);
    await age(young.id, 6);
    const expired = await expireWhispers(db);
    expect(expired.map((x) => [x.id, x.status])).toEqual([[old.id, "expired"]]);
    expect([await statusOf(old.id), await statusOf(young.id), await statusOf(answered.id)]).toEqual(["expired", "open", "declined"]);
    expect(await api(app, w.owner, "POST", `/api/whispers/${old.id}/accept`)).toEqual({ status: 409, json: { error: "stale_whisper" } });
    expect((await expireWhispers(db, new Date(Date.now() + 2 * DAY))).map((x) => x.id)).toEqual([young.id]);
  });

  it("is bounded: at most `batches` batches of `batch` rows a run (500 and 20 by default), the rest on the next run", async () => {
    expect(WHISPER_SWEEP_BATCH).toBe(500);
    const w = await world();
    for (let i = 0; i < 5; i++) await age((await whisper(w)).id, 10);
    expect((await expireWhispers(db, new Date(), { batch: 2, batches: 2 })).length).toBe(4);
    expect((await expireWhispers(db, new Date(), { batch: 2, batches: 2 })).length).toBe(1);
  });

  it("runs with the periodic sweep of memory changes (its timer, no new one) and pushes the owner the expired whisper", async () => {
    const w = await world();
    const old = await whisper(w);
    await age(old.id, 8);
    // Its first run comes 1.5 s after the start: time enough to open the owner's socket on it.
    const sweeping = await buildApp(
      { config: { ...app.deps.config, sweepIntervalMinutes: 0, memory: { ...app.deps.config.memory, changesSweepMs: 3_600_000 } }, db, blobs: app.deps.blobs, models: gateway },
      { sweepInitialDelayMs: 1500, agentWorker: false, staleRunSweep: false },
    );
    try {
      await sweeping.ready();
      const socket = await connect(sweeping, w.owner);
      const push = await socket.next((e) => e.type === "whisper", { timeoutMs: 5000 });
      expect(push.whisper).toMatchObject({ id: old.id, status: "expired" });
      expect(await statusOf(old.id)).toBe("expired");
      socket.close();
      await socket.closed;
    } finally {
      await sweeping.close();
    }
  });

  it("the owner leaving the group expires their whispers there (their Agent leaves with them); others' stay", async () => {
    const w = await world();
    const ned = w.ned;
    const nedsAgent = await mustCreateAgent(app, ned, { model: FAST });
    expect((await api(app, ned, "POST", `/api/conversations/${w.g}/members`, { principalId: nedsAgent.id })).status).toBe(201);
    const mine = await whisper(w);
    const elsewhere = await whisper(w, { conversationId: w.agent.conversationId });
    const neds = await db.tx((t) => createWhisper(t, { conversationId: w.g, ownerId: ned.id, agentId: nedsAgent.id, kind: "found_elsewhere", body: BODY }));
    expect((await api(app, w.owner, "DELETE", `/api/conversations/${w.g}/members/${w.owner.id}`)).status).toBe(200);
    expect([await statusOf(mine.id), await statusOf(elsewhere.id), await statusOf(neds!.id)]).toEqual(["expired", "open", "open"]);
    expect((await db.query("select resolved_at is not null as done from whispers where id = $1", [mine.id])).rows[0]).toEqual({ done: true });
  });

  it("being removed expires them too; so does the Agent alone being taken out, pushed to the owner who stays", async () => {
    const w = await world();
    const socket = await connect(app, w.owner);
    const made = await whisper(w);
    expect((await api(app, w.owner, "DELETE", `/api/conversations/${w.g}/members/${w.agent.id}`)).status).toBe(200);
    expect(await statusOf(made.id)).toBe("expired");
    expect((await socket.next((e) => e.type === "whisper" && e.whisper.status === "expired")).whisper.id).toBe(made.id);
    // Removed by the creator: mia's group, olive and her Agent in it.
    const hers = await group(app, w.mia, "hers", [w.owner, w.ned]);
    expect((await api(app, w.owner, "POST", `/api/conversations/${hers}/members`, { principalId: w.agent.id })).status).toBe(201);
    const there = await whisper(w, { conversationId: hers });
    expect((await api(app, w.mia, "DELETE", `/api/conversations/${hers}/members/${w.owner.id}`)).status).toBe(200);
    expect(await statusOf(there.id)).toBe("expired");
  });

  it("deleting the Agent expires its open whispers everywhere (pushed to its owner); its rows go with it when the Agent row goes", async () => {
    const w = await world();
    const socket = await connect(app, w.owner);
    const inGroup = await whisper(w);
    const own = await whisper(w, { conversationId: w.agent.conversationId });
    expect((await api(app, w.owner, "DELETE", `/api/agents/${w.agent.id}`)).status).toBe(200);
    expect([await statusOf(inGroup.id), await statusOf(own.id)]).toEqual(["expired", "expired"]);
    await socket.waitFor((e) => e.type === "whisper" && e.whisper.id === own.id && e.whisper.status === "expired");
    const fk = await db.query<{ confdeltype: string; target: string }>(
      `select c.confdeltype, t.relname as target from pg_constraint c join pg_class t on t.oid = c.confrelid
        where c.conrelid = 'whispers'::regclass and c.contype = 'f' order by t.relname`,
    );
    expect(fk.rows).toEqual([
      { confdeltype: "c", target: "agents" },
      { confdeltype: "c", target: "conversations" },
      { confdeltype: "c", target: "principals" },
    ]);
  });

  it("has the indexes the reads and the sweep use", async () => {
    const { rows } = await db.query<{ indexdef: string }>("select indexdef from pg_indexes where tablename = 'whispers'");
    expect(rows.some((r) => /\(owner_id, conversation_id, after_seq\)/.test(r.indexdef))).toBe(true);
    expect(rows.some((r) => /\(status, created_at\)/.test(r.indexdef))).toBe(true);
  });
});
