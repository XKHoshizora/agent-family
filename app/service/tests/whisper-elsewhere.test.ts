import { afterEach, describe, expect, it } from "vitest";
import { createAgentPort } from "../src/agents/port-impl.ts";
import { TOOL_MATERIAL } from "../src/agents/runtime/prompt.ts";
import { createAgentWorker, type AgentWorker } from "../src/agents/runtime/worker.ts";
import { createElsewhere, ELSEWHERE_HITS_MAX, FOUND_ELSEWHERE, TELL_THEM, type ElsewhereDeps, type ElsewhereHook } from "../src/agents/tools/elsewhere.ts";
import { createToolbox, SEARCH_MESSAGES, type ToolDeps } from "../src/agents/tools/index.ts";
import type { Db } from "../src/db.ts";
import type { ModelCall } from "../src/models/gateway.ts";
import { api, group, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { scriptedGateway } from "./helpers/models.ts";
import { closeAllSockets, connect } from "./helpers/ws.ts";

/**
 * "Not in this group, but I have it elsewhere" (Task 8; design rules 17, 18, decision 9): in a group, when a reply's search
 * finds nothing there and its Agent's `whisperElsewhere` is on, the same words are looked for once more — on their own,
 * after the search has answered — in the Agent's other conversations that its owner can read now; hits become one whisper
 * to the owner (`告诉他们` / `不用`). The run's model is told nothing, and no one else learns anything. `告诉他们` queues one
 * reply of the Agent in the group, its owner's own, that is shown the hits and offered no tools.
 */

const gateway = scriptedGateway();
const { app, db } = useApp({ env: SITE_ENV, models: gateway, agentWorker: false, tools: true });
afterEach(async () => {
  await closeAllSockets();
  expect(gateway.pending()).toBe(0);
});

const FAST = { source: "site", id: "fast" } as const;
const CANARY = "CANARY-ew 蓝鲸计划在三楼";

/** Every statement sent through `real`, its transactions' too. */
function spyDb(real: Db): { db: Db; sql: string[] } {
  const sql: string[] = [];
  const spied = <T extends object>(target: T): T =>
    new Proxy(target, {
      get(t, prop) {
        const value = Reflect.get(t, prop, t);
        if (prop === "query") return (text: unknown, params?: unknown) => (sql.push(typeof text === "string" ? text : String((text as { text?: string }).text)), (value as Function).call(t, text, params));
        return typeof value === "function" ? value.bind(t) : value;
      },
    });
  return { sql, db: { pool: real.pool, query: spied(real).query, tx: (fn) => real.tx((client) => fn(spied(client))), close: () => real.close() } as Db };
}
const searchesIn = (sql: string[]) => sql.filter((s) => /ilike/i.test(s)).length;

function elsewhereDeps(over: Partial<ElsewhereDeps> = {}): ElsewhereDeps {
  return { db: app.deps.db, config: app.deps.config, realtime: app.realtime, log: app.log, ...over };
}
function toolDeps(elsewhere: ElsewhereHook, d: Db = app.deps.db): ToolDeps {
  const { config, searches, blobs } = app.deps;
  return { db: d, blobs, searches, config, log: app.log, elsewhere };
}
function toolWorker(d: ToolDeps): AgentWorker {
  const { db: pool, blobs, conversations, reads, config } = app.deps;
  const port = createAgentPort({ db: pool, config, blobs, realtime: app.realtime, conversations, reads, log: app.log, toolbox: createToolbox(d) });
  return createAgentWorker({ port, models: gateway, runTimeoutMs: config.agentRunTimeoutMs, maxRunsInFlight: 1, background: false, log: app.log, tools: config.tools });
}

let txn = 0;
const say = async (who: Actor, conv: string, text: string): Promise<number> => {
  const sent = await api(app, who, "POST", `/api/conversations/${conv}/messages`, { text, clientTxn: `we${++txn}` });
  if (sent.status !== 201) throw new Error(`say: ${sent.status} ${JSON.stringify(sent.json)}`);
  return sent.json.message.seq as number;
};
const outputs = (call: ModelCall): unknown[] => (call.steps ?? []).flatMap((s) => s.results.map((r) => r.output));
const whispersOf = async (ownerId: string, conv: string) =>
  (await db.query<{ id: string; status: string; body: { text: string; actions: string[]; detail?: { hits: Array<{ where: string; who: string; when: string; text: string }> } } }>(
    "select id, status, body from whispers where owner_id = $1 and conversation_id = $2 order by created_at",
    [ownerId, conv],
  )).rows;
const runsOf = async (agentId: string, conv: string) =>
  (await db.query<{ id: string; status: string; lane: string; triggered_by: string; caller_id: string | null; whisper_id: string | null }>(
    "select id, status, lane, triggered_by, caller_id, whisper_id from agent_runs where agent_id = $1 and conversation_id = $2 order by created_at",
    [agentId, conv],
  )).rows;

/**
 * olive and her Agent: in group G with mia and ned, where nothing says 蓝鲸计划; in group B with them too, where the canary is
 * said; and in its own conversation, where olive said something about it too.
 */
async function world() {
  const [owner, mia, ned] = [await signUp(app, "olive"), await signUp(app, "mia"), await signUp(app, "ned")];
  const agent = await mustCreateAgent(app, owner, { handle: "olive_bot", name: "小助手", model: FAST, persona: "简短地回答。" });
  const g = await group(app, owner, "饭搭子", [mia, ned]);
  const b = await group(app, owner, "乙群", [mia, ned]);
  for (const c of [g, b]) expect((await api(app, owner, "POST", `/api/conversations/${c}/members`, { principalId: agent.id })).status).toBe(201);
  await say(mia, b, CANARY);
  await say(owner, agent.conversationId, "记一下：蓝鲸计划的口令是七七");
  // (The Agent's own conversation: the message started a reply there; it is not this file's business.)
  await db.query("update agent_runs set status = 'cancelled', finished_at = now() where agent_id = $1 and status = 'queued'", [agent.id]);
  return { owner, mia, ned, agent: agent as { id: string; conversationId: string }, g, b };
}
type World = Awaited<ReturnType<typeof world>>;

/** One reply in G, asked by `asker`, whose search finds nothing in G: what its model was handed. */
async function askInGroup(w: World, hook: ElsewhereHook, asker: Actor = w.mia, d?: Db) {
  await say(asker, w.g, "@olive_bot 上次说的那个计划在哪？");
  gateway.callTools([{ name: SEARCH_MESSAGES, input: { query: "蓝鲸计划" } }]).reply("这个群的记录里没找到。");
  expect(await toolWorker(toolDeps(hook, d)).runOnce()).toBe(true);
  await hook.idle();
  return outputs(gateway.calls.at(-1)!)[0];
}

describe("a search in a group that finds nothing there", () => {
  it("found elsewhere: one whisper to the owner with the hits; the model is told the plain not-found, and nobody else is sent or shown anything", async () => {
    const w = await world();
    const sockets = { owner: await connect(app, w.owner), mia: await connect(app, w.mia), ned: await connect(app, w.ned) };
    const hook = createElsewhere(elsewhereDeps());
    const told = await askInGroup(w, hook);
    expect(told).toEqual({ results: [], note: "这个群的记录里没找到。" });
    const [made] = await whispersOf(w.owner.id, w.g);
    expect(made).toMatchObject({ status: "open", body: { text: FOUND_ELSEWHERE, actions: ["tell", "dismiss"] } });
    const hits = made!.body.detail!.hits;
    expect(hits.map((h) => [h.where, h.text])).toEqual([
      ["我们的专属会话", "记一下：蓝鲸计划的口令是七七"],
      ["乙群", CANARY],
    ]);
    expect(Object.keys(hits[0]!).sort()).toEqual(["text", "when", "where", "who"]);
    expect(hits.map((h) => h.who)).toEqual(["olive", "mia"]);
    await sockets.owner.waitFor((e) => e.type === "whisper" && e.whisper.id === made!.id);
    // A round trip each, ordered after everything the run pushed, before their frames are read.
    for (const who of [w.mia, w.ned]) expect((await api(app, who, "GET", "/api/sync")).status).toBe(200);
    for (const socket of [sockets.mia, sockets.ned]) {
      expect(JSON.stringify(socket.events)).not.toContain("CANARY-ew");
      expect(socket.events.some((e) => e.type === "whisper")).toBe(false);
    }
    // The model's whole call, and the reply in the group: nothing of it.
    expect(JSON.stringify(gateway.calls.at(-1))).not.toContain("CANARY-ew");
    expect(JSON.stringify((await api(app, w.mia, "GET", `/api/conversations/${w.g}/messages`)).json)).not.toContain("CANARY-ew");
  });

  it("the model's tool result is the same, byte for byte, whether anything was found elsewhere or not", async () => {
    const w = await world();
    const hook = createElsewhere(elsewhereDeps());
    const withHits = await askInGroup(w, hook);
    await db.query("update agents set whisper_elsewhere = false where principal_id = $1", [w.agent.id]);
    const without = await askInGroup(w, hook);
    expect(JSON.stringify(withHits)).toBe(JSON.stringify(without));
  });

  it("nothing found elsewhere either: no whisper", async () => {
    const w = await world();
    const hook = createElsewhere(elsewhereDeps());
    await say(w.mia, w.g, "@olive_bot 有那个东西吗？");
    gateway.callTools([{ name: SEARCH_MESSAGES, input: { query: "哪里都没有的词" } }]).reply("没找到。");
    expect(await toolWorker(toolDeps(hook)).runOnce()).toBe(true);
    await hook.idle();
    expect(await whispersOf(w.owner.id, w.g)).toEqual([]);
  });

  it("the switch off (`whisperElsewhere`): no second query at all", async () => {
    const w = await world();
    expect((await api(app, w.owner, "PATCH", `/api/agents/${w.agent.id}`, { whisperElsewhere: false })).json).toMatchObject({ whisperElsewhere: false });
    const spy = spyDb(app.deps.db);
    const hook = createElsewhere(elsewhereDeps({ db: spy.db }));
    await askInGroup(w, hook, w.mia, spy.db);
    expect(searchesIn(spy.sql)).toBe(1);
    expect(await whispersOf(w.owner.id, w.g)).toEqual([]);
    // On again: the second query runs.
    expect((await api(app, w.owner, "PATCH", `/api/agents/${w.agent.id}`, { whisperElsewhere: true })).json).toMatchObject({ whisperElsewhere: true });
    spy.sql.length = 0;
    await askInGroup(w, hook, w.mia, spy.db);
    expect(searchesIn(spy.sql)).toBe(2);
  });

  it("at most one whisper a reply, and at most 3 open for the owner in a group: more are not made", async () => {
    const w = await world();
    const hook = createElsewhere(elsewhereDeps());
    await say(w.mia, w.g, "@olive_bot 两件事");
    gateway
      .callTools([{ name: SEARCH_MESSAGES, input: { query: "蓝鲸计划" } }])
      .callTools([{ name: SEARCH_MESSAGES, input: { query: "口令是七七" } }])
      .reply("都没找到。");
    expect(await toolWorker(toolDeps(hook)).runOnce()).toBe(true);
    await hook.idle();
    expect(await whispersOf(w.owner.id, w.g)).toHaveLength(1);
    for (let i = 0; i < 3; i++) await askInGroup(w, hook);
    expect((await whispersOf(w.owner.id, w.g)).map((x) => x.status)).toEqual(["open", "open", "open"]);
    // One answered: room for another.
    const [first] = await whispersOf(w.owner.id, w.g);
    expect((await api(app, w.owner, "POST", `/api/whispers/${first!.id}/decline`)).status).toBe(200);
    await askInGroup(w, hook);
    expect((await whispersOf(w.owner.id, w.g)).map((x) => x.status)).toEqual(["declined", "open", "open", "open"]);
  });

  it("at most 5 hits, the newest first, each text at most 200 characters", async () => {
    const w = await world();
    for (let i = 0; i < 6; i++) await say(w.mia, w.b, `第${i}次：蓝鲸计划${"很长的话".repeat(80)}`);
    const hook = createElsewhere(elsewhereDeps());
    await askInGroup(w, hook);
    const [made] = await whispersOf(w.owner.id, w.g);
    const hits = made!.body.detail!.hits;
    expect(hits).toHaveLength(ELSEWHERE_HITS_MAX);
    expect(hits.map((h) => h.text.slice(0, 3))).toEqual(["第5次", "第4次", "第3次", "第2次", "第1次"]);
    expect(hits.every((h) => Array.from(h.text).length <= 200)).toBe(true);
  });

  it("hits come only from what the owner can read now: not a message of B from before her current stay there, nor a group she is not in now", async () => {
    const w = await world();
    // As if olive had joined B after everything said there: the Agent sees it all, she sees none of it.
    await say(w.mia, w.b, "她看不到的：蓝鲸计划在地下室");
    await db.query("update memberships set joined_seq = (select seq from conversations where id = $1) where conversation_id = $1 and principal_id = $2", [w.b, w.owner.id]);
    // And group C, which (as if) she has left while her Agent stayed.
    const c = await group(app, w.owner, "丙群", [w.mia, w.ned]);
    expect((await api(app, w.owner, "POST", `/api/conversations/${c}/members`, { principalId: w.agent.id })).status).toBe(201);
    await say(w.mia, c, "也看不到的：蓝鲸计划在顶楼");
    await db.query("update memberships set left_seq = (select seq from conversations where id = $1) where conversation_id = $1 and principal_id = $2", [c, w.owner.id]);
    const hook = createElsewhere(elsewhereDeps());
    await askInGroup(w, hook);
    const [made] = await whispersOf(w.owner.id, w.g);
    expect(made!.body.detail!.hits.map((h) => [h.where, h.text])).toEqual([["我们的专属会话", "记一下：蓝鲸计划的口令是七七"]]);
  });
});

describe("告诉他们", () => {
  async function whispered() {
    const w = await world();
    const hook = createElsewhere(elsewhereDeps());
    await askInGroup(w, hook);
    const [made] = await whispersOf(w.owner.id, w.g);
    return { w, whisper: made! };
  }

  it("queues one reply of the Agent in the group, its owner's own, shown the hits as material and offered no tools; it posts there", async () => {
    const { w, whisper } = await whispered();
    const ownerSocket = await connect(app, w.owner);
    const accepted = await api(app, w.owner, "POST", `/api/whispers/${whisper.id}/accept`);
    expect(accepted.status).toBe(200);
    expect(accepted.json.status).toBe("accepted");
    const runs = (await runsOf(w.agent.id, w.g)).filter((r) => r.status === "queued");
    expect(runs).toEqual([{ id: expect.any(String), status: "queued", lane: "own", triggered_by: "human", caller_id: w.owner.id, whisper_id: whisper.id }]);
    await ownerSocket.waitFor((e) => e.type === "run" && e.run?.id === runs[0]!.id);
    gateway.reply("蓝鲸计划在三楼。");
    expect(await app.agentWorker.runOnce()).toBe(true);
    const call = gateway.calls.at(-1)!;
    expect(call.tools ?? []).toEqual([]);
    expect(call.system).toContain(TELL_THEM);
    expect(call.system).toContain(TOOL_MATERIAL);
    expect(call.system).toContain(CANARY);
    const last = (await api(app, w.mia, "GET", `/api/conversations/${w.g}/messages`)).json.messages.at(-1);
    expect([last.senderId, last.text]).toEqual([w.agent.id, "蓝鲸计划在三楼。"]);
    // Answered once: again is stale.
    expect((await api(app, w.owner, "POST", `/api/whispers/${whisper.id}/accept`)).status).toBe(409);
  });

  it("不用: nothing happens", async () => {
    const { w, whisper } = await whispered();
    const before = await runsOf(w.agent.id, w.g);
    expect((await api(app, w.owner, "POST", `/api/whispers/${whisper.id}/decline`)).json.status).toBe("declined");
    expect(await runsOf(w.agent.id, w.g)).toEqual(before);
  });

  it("after the owner left the group: gone (404), and nothing is queued", async () => {
    const { w, whisper } = await whispered();
    const before = await runsOf(w.agent.id, w.g);
    expect((await api(app, w.owner, "DELETE", `/api/conversations/${w.g}/members/${w.owner.id}`)).status).toBe(200);
    expect((await api(app, w.owner, "POST", `/api/whispers/${whisper.id}/accept`)).status).toBe(404);
    expect((await runsOf(w.agent.id, w.g)).length).toBe(before.length);
  });

  it("an owner at their replies a minute gets the ordinary refusal (429), and the whisper stays open to answer later", async () => {
    const { w, whisper } = await whispered();
    const limit = app.deps.config.agentRunsPerMinute;
    for (let i = 0; i < limit; i++) {
      await db.query(
        `insert into agent_runs (purpose, conversation_id, agent_id, owner_id, status, covers_seq, triggered_by, caller_id, lane, finished_at)
         values ('reply', $1, $2, $3, 'done', 1, 'human', $3, 'own', now())`,
        [w.agent.conversationId, w.agent.id, w.owner.id],
      );
    }
    const refused = await api(app, w.owner, "POST", `/api/whispers/${whisper.id}/accept`);
    expect([refused.status, refused.json.error]).toEqual([429, "rate_limited"]);
    expect((await whispersOf(w.owner.id, w.g))[0]!.status).toBe("open");
    expect((await runsOf(w.agent.id, w.g)).some((r) => r.whisper_id !== null)).toBe(false);
  });
});

describe("the service's own hook", () => {
  it("a reply on the app's worker whispers too (the toolbox the app builds carries the hook)", async () => {
    const w = await world();
    const ownerSocket = await connect(app, w.owner);
    await say(w.mia, w.g, "@olive_bot 上次说的那个计划在哪？");
    gateway.callTools([{ name: SEARCH_MESSAGES, input: { query: "蓝鲸计划" } }]).reply("这个群的记录里没找到。");
    expect(await app.agentWorker.runOnce()).toBe(true);
    const frame = await ownerSocket.next((e) => e.type === "whisper");
    expect(frame).toMatchObject({ type: "whisper", whisper: { conversationId: w.g, kind: "found_elsewhere", text: FOUND_ELSEWHERE } });
  });
});
