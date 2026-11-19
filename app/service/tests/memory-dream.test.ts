import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { api, group, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { scriptedJudge } from "./helpers/judge.ts";
import { scriptedGateway } from "./helpers/models.ts";
import { closeAllSockets } from "./helpers/ws.ts";

/**
 * 小憩 strengthens and 入梦 consolidates (src/memory/pipeline.ts, dream.ts; README "An Agent's memory"): a note the owner
 * mentions again gets stronger without a word to anyone; once the owner has been away a while a pass over the notes alone
 * (never a conversation) merges, rewrites, splits and locks them. Everything runs on the harness's test clock.
 */

const JUDGE = {
  model: "jev-1",
  channels: [{ url: "https://judge-a.example.test/v1/systemone", apiKeyEnv: "UPSTREAM_TEST_KEY" }],
  timeoutMs: 500,
  dailyLimit: 20_000,
};
const gateway = scriptedGateway();
const judge = scriptedJudge();
const { app, db, clock } = useApp({ env: SITE_ENV, models: gateway, judge, agentWorker: false, memory: true, config: { judge: JUDGE } });

const FAST = { source: "site", id: "fast" } as const;
const PERSONA = "你是一个说话简洁的助手。";
const MIN = 60_000;
const HOUR = 60 * MIN;
const memory = () => app.deps.memory!;

let first = 0;
beforeEach(() => {
  clock.reset();
  first = gateway.calls.length;
  judge.calls.splice(0);
  judge.answer(() => ({ sort: 0.05 }));
});
afterEach(async () => {
  await closeAllSockets();
  await memory().idle();
  expect(gateway.pending()).toBe(0);
});

let txn = 0;
const say = async (who: Actor, conv: string, text: string): Promise<number> => {
  const sent = await api(app, who, "POST", `/api/conversations/${conv}/messages`, { text, clientTxn: `dr${++txn}` });
  if (sent.status !== 201) throw new Error(`say: ${sent.status} ${JSON.stringify(sent.json)}`);
  return sent.json.message.seq as number;
};

async function owned(name: string, over: Record<string, unknown> = {}) {
  const owner = await signUp(app, name);
  const agent = await mustCreateAgent(app, owner, { model: FAST, persona: PERSONA, ...over });
  return { owner, agent, conv: agent.conversationId as string };
}
type World = Awaited<ReturnType<typeof owned>>;

async function exchange(w: World, text: string, reply = "好的。"): Promise<void> {
  await say(w.owner, w.conv, text);
  gateway.reply(reply);
  expect(await app.agentWorker.runOnce()).toBe(true);
  await memory().idle();
}
const ops = (...o: unknown[]) => JSON.stringify({ ops: o });
const add = (text: string, kind: "owner" | "self" = "owner") => ({ op: "add", kind, text });
const messagesOf = async (who: Actor, conv: string): Promise<any[]> => (await api(app, who, "GET", `/api/conversations/${conv}/messages`)).json.messages;
const chips = async (who: Actor, conv: string) => (await messagesOf(who, conv)).filter((m) => m.system?.event === "memory_changed");
const seeded = async (who: Actor, agentId: string, text: string, vault: boolean, kind: "owner" | "self" = "owner") =>
  (await api(app, who, "POST", kind === "owner" ? "/api/memory/notes" : `/api/agents/${agentId}/memory/notes`, { text, vault })).json;
async function quietThen(answer: string, ms = 10 * MIN): Promise<void> {
  gateway.reply(answer);
  clock.advance(ms);
  await memory().idle();
}
const noteRow = async (id: string, table: "owner_notes" | "agent_notes" = "owner_notes") =>
  (await db.query(`select text, vault, vault_by, unsure, strength, seen_at, created_at, updated_at, origin, origin_conversation_id from ${table} where id = $1`, [id])).rows[0];
const changeRows = async (ownerId: string) => (await db.query("select id, agent_id, status, ops from memory_changes where owner_id = $1 order by created_at", [ownerId])).rows;
const old = (id: string, table: "owner_notes" | "agent_notes" = "owner_notes") =>
  db.query(`update ${table} set seen_at = now() - interval '2 days' where id = $1`, [id]);

describe("小憩 strengthens: a note the owner mentions again", () => {
  it("an add that repeats a note word for word makes it stronger and seen now, and nothing else: no change row, no notice, updated_at untouched", async () => {
    const w = await owned("sa1");
    const note = await seeded(w.owner, w.agent.id, "喜欢喝茶", false);
    await old(note.id);
    const before = await noteRow(note.id);
    await exchange(w, "我还是喜欢喝茶");
    await quietThen(ops(add("喜欢喝茶")));
    const after = await noteRow(note.id);
    expect(after.strength).toBe(1);
    expect(after.seen_at.getTime()).toBeGreaterThan(before.seen_at.getTime());
    expect(after.updated_at).toEqual(before.updated_at);
    expect(after.text).toBe("喜欢喝茶");
    expect(await changeRows(w.owner.id)).toEqual([]);
    expect(await chips(w.owner, w.conv)).toEqual([]);
  });

  it("an add the judgement calls a repeat does the same, once per note per review however many adds repeat it; one it does not call a repeat adds a note as before", async () => {
    const w = await owned("sa2");
    const note = await seeded(w.owner, w.agent.id, "喜欢喝茶", false);
    judge.answer((_s, qs) => {
      const answers: Record<string, number | Record<string, number>> = qs[0]!.key === "dup" ? { dup: { [note.id]: 0.9, 都不是: 0.1 } } : { sort: 0.9 };
      return answers;
    });
    await exchange(w, "茶是我的最爱，爱喝茶");
    await quietThen(ops(add("爱喝茶"), add("茶是最爱")));
    expect((await noteRow(note.id)).strength).toBe(1);
    const all = (await api(app, w.owner, "GET", "/api/memory/notes")).json;
    expect(all.notes.map((n: any) => n.text)).toEqual(["喜欢喝茶"]);
    expect(await changeRows(w.owner.id)).toEqual([]);
  });

  it("a note a review adds or replaces is seen now, and its strength starts at 0", async () => {
    const w = await owned("sa3");
    await exchange(w, "我喜欢茶");
    await quietThen(ops(add("喜欢茶")));
    const [row] = (await db.query("select id, strength, seen_at, created_at from owner_notes where owner_id = $1", [w.owner.id])).rows;
    expect(row.strength).toBe(0);
    expect(Math.abs(row.seen_at.getTime() - row.created_at.getTime())).toBeLessThan(5_000);
  });

  it("a bump never makes an earlier change stale: the add it repeated can still be undone", async () => {
    const w = await owned("sa4");
    await exchange(w, "我喜欢茶");
    await quietThen(ops(add("喜欢茶")));
    const [change] = await changeRows(w.owner.id);
    await exchange(w, "说过了，我喜欢茶");
    await quietThen(ops(add("喜欢茶")));
    const [row] = (await db.query("select strength from owner_notes where owner_id = $1", [w.owner.id])).rows;
    expect(row.strength).toBe(1);
    expect((await changeRows(w.owner.id)).length).toBe(1);
    const undone = await api(app, w.owner, "POST", `/api/agents/${w.agent.id}/memory/changes/${change.id}/undo`);
    expect(undone.status).toBe(200);
    expect((await db.query("select count(*)::int as n from owner_notes where owner_id = $1", [w.owner.id])).rows[0].n).toBe(0);
  });

  it("a note's wire shape carries strength and seenAt, in both rooms", async () => {
    const w = await owned("sa5");
    const mine = await seeded(w.owner, w.agent.id, "喜欢喝茶", false);
    const own = await seeded(w.owner, w.agent.id, "回答要简短", false, "self");
    for (const n of [mine, own]) {
      expect(n.strength).toBe(0);
      expect(typeof n.seenAt).toBe("string");
      expect(Number.isNaN(Date.parse(n.seenAt))).toBe(false);
    }
    await db.query("update owner_notes set strength = 4 where id = $1", [mine.id]);
    expect((await api(app, w.owner, "GET", "/api/memory/notes")).json.notes[0]).toMatchObject({ strength: 4 });
    expect((await api(app, w.owner, "GET", `/api/agents/${w.agent.id}/memory`)).json.notes[0]).toMatchObject({ strength: 0 });
  });
});
