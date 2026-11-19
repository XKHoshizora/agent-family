import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, group, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { scriptedJudge } from "./helpers/judge.ts";
import { scriptedGateway } from "./helpers/models.ts";
import { closeAllSockets, connect } from "./helpers/ws.ts";

/**
 * What the owner says about themselves in a group (src/memory/hearsay.ts `runFlags`, pipeline.ts `runReview` with `own`;
 * README "An Agent's memory", "Acting on flags"): the judgement flags it, and once the group has been quiet the owner's
 * reviewing Agent reviews that group for notes about the owner — additions only, even if the Agent never replied there.
 * The app is built with the proactive scheduler too (a short real debounce), so a test can go from a person's message
 * through the judgement to the review.
 */

const JUDGE = {
  model: "jev-1",
  channels: [{ url: "https://judge-a.example.test/v1/systemone", apiKeyEnv: "UPSTREAM_TEST_KEY" }],
  timeoutMs: 500,
  dailyLimit: 20_000,
};
const gateway = scriptedGateway();
const judge = scriptedJudge();
const { app, db, clock } = useApp({ env: SITE_ENV, models: gateway, judge, agentWorker: false, memory: true, proactive: { delayMs: 30 }, config: { judge: JUDGE } });

const FAST = { source: "site", id: "fast" } as const;
const PERSONA = "你是一个说话简洁的助手。";
const MIN = 60_000;
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
  await app.deps.proactive!.idle();
  await memory().idle();
  expect(gateway.pending()).toBe(0);
});

const settle = async (): Promise<void> => {
  for (let i = 0; i < 30; i++) await new Promise<void>((r) => setImmediate(r));
};

let txn = 0;
const say = async (who: Actor, conv: string, text: string): Promise<number> => {
  const sent = await api(app, who, "POST", `/api/conversations/${conv}/messages`, { text, clientTxn: `gr${++txn}` });
  if (sent.status !== 201) throw new Error(`say: ${sent.status} ${JSON.stringify(sent.json)}`);
  return sent.json.message.seq as number;
};

async function world(tag: string, over: Record<string, unknown> = {}) {
  const owner = await signUp(app, `own${tag}`);
  const mia = await signUp(app, `mia${tag}`);
  const g = await group(app, mia, "读书会", [owner, await signUp(app, `thr${tag}`)]);
  const agent = await mustCreateAgent(app, owner, { handle: `gr_${tag}`, name: `gr_${tag}`, model: FAST, persona: PERSONA, ...over });
  expect((await api(app, owner, "POST", `/api/conversations/${g}/members`, { principalId: agent.id })).status).toBe(201);
  return { owner, mia, g, agent };
}
type World = Awaited<ReturnType<typeof world>>;

const ops = (...o: unknown[]) => JSON.stringify({ ops: o });
const add = (text: string, kind: "owner" | "self" = "owner") => ({ op: "add", kind, text });
const entries = (...e: Array<[string, string]>) => JSON.stringify({ entries: e.map(([from, text]) => ({ from, text })), drop: [] });
const reviewCalls = () => gateway.calls.slice(first).filter((c) => c.system.includes("记忆整理员"));
const hearsayCalls = () => gateway.calls.slice(first).filter((c) => c.system.includes("听说整理员"));
const textOf = (call: { messages: Array<{ parts: unknown[] }> }): string => (call.messages[0]!.parts[0] as { text: string }).text;
const flagRows = async (agentId: string, kind = "own") => (await db.query<{ s: string }>("select seq::text as s from memory_flags where agent_id = $1 and kind = $2 order by memory_flags.seq", [agentId, kind])).rows.map((r) => Number(r.s));
const messagesOf = async (who: Actor, conv: string): Promise<any[]> => (await api(app, who, "GET", `/api/conversations/${conv}/messages`)).json.messages;
const chips = async (who: Actor, conv: string) => (await messagesOf(who, conv)).filter((m) => m.system?.event === "memory_changed");
const notesOf = async (who: Actor) => (await api(app, who, "GET", "/api/memory/notes")).json.notes as Array<{ id: string; text: string; vault: boolean }>;
const reviewedSeq = async (agentId: string, conv: string): Promise<number | null> => {
  const r = await db.query<{ s: string }>("select reviewed_seq::text as s from memory_review_state where agent_id = $1 and conversation_id = $2", [agentId, conv]);
  return r.rows[0] ? Number(r.rows[0].s) : null;
};
async function flag(agentId: string, conv: string, seq: number, kind: "hearsay" | "own" = "own", tell = true): Promise<void> {
  await db.query("insert into memory_flags (agent_id, conversation_id, seq, kind) values ($1, $2, $3, $4) on conflict do nothing", [agentId, conv, seq, kind]);
  if (tell) memory().flagged(agentId, conv, kind);
}
async function wake(ms = 2 * MIN): Promise<void> {
  clock.advance(ms);
  await memory().idle();
}
/** Runs the Agent once in `conv` for the owner's `@` call; the system text it was given. */
async function runIn(w: World, conv: string): Promise<string> {
  await say(w.owner, conv, conv === w.agent.conversationId ? "你好" : `@${w.agent.handle} 你好`);
  gateway.reply("好的。");
  const ran = await app.agentWorker.runOnce();
  expect(ran).toBe(true);
  return gateway.calls.at(-1)!.system;
}

describe("the owner's own remark, flagged", () => {
  it("two minutes of quiet: one review of the group, from the owner's lines after the Agent joined, though the Agent never replied there", async () => {
    const w = await world("a");
    await say(w.mia, w.g, "MIA-SAID 我喜欢香菜");
    const seq = await say(w.owner, w.g, "我下周三要搬家了");
    judge.answer(() => ({ sort: 0.95 }));
    gateway.reply(ops(add("下周三要搬家")));
    await flag(w.agent.id, w.g, seq);
    await wake(MIN);
    expect(reviewCalls()).toHaveLength(0);
    await wake(MIN);
    expect(reviewCalls()).toHaveLength(1);
    const parsed = JSON.parse(textOf(reviewCalls()[0]!));
    expect(parsed.conversation).toEqual([{ who: "owner", text: "我下周三要搬家了" }]);
    expect(textOf(reviewCalls()[0]!)).not.toContain("MIA-SAID");
    const origin = await db.query("select origin_conversation_id from owner_notes where owner_id = $1", [w.owner.id]);
    expect(origin.rows).toEqual([{ origin_conversation_id: w.g }]);
    expect(await notesOf(w.owner)).toMatchObject([{ text: "下周三要搬家", vault: false }]);
    expect(await flagRows(w.agent.id)).toEqual([]);
    expect(await reviewedSeq(w.agent.id, w.g)).toBe(seq);
    expect((await chips(w.owner, w.agent.conversationId))[0].system).toMatchObject({ lines: ["记住了：下周三要搬家"], pending: false });
    // The Agent itself never posted in the group.
    const posted = await db.query("select count(*)::int as n from messages where conversation_id = $1 and sender_id = $2", [w.g, w.agent.id]);
    expect(posted.rows[0].n).toBe(0);
  });

  it("may only add notes about the owner: a scripted remove, lock, replace and an add of the Agent's own are dropped; only the owner's room is shown", async () => {
    const w = await world("b");
    const seeded = (await api(app, w.owner, "POST", "/api/memory/notes", { text: "喜欢喝茶", vault: false })).json;
    await api(app, w.owner, "POST", `/api/agents/${w.agent.id}/memory/notes`, { text: "回答要简短", vault: false });
    const seq = await say(w.owner, w.g, "我现在不喝茶了，改喝咖啡");
    judge.answer(() => ({ sort: 0.95 }));
    gateway.reply(
      ops({ op: "remove", ref: "n1" }, { op: "lock", ref: "n1" }, { op: "replace", ref: "n1", text: "喜欢咖啡" }, add("回答要啰嗦", "self"), add("喝咖啡")),
    );
    await flag(w.agent.id, w.g, seq);
    await wake();
    const [call] = reviewCalls();
    const sent = JSON.parse(textOf(call!));
    expect(sent.notes).toEqual([{ ref: "n1", room: "owner", text: "喜欢喝茶" }]);
    expect(sent.room_left).toEqual({ owner: 2000 - 4 });
    for (const word of ["replace", "remove", "unlock", "合并", "替换", "删除", "锁"]) expect([word, call!.system.includes(word)]).toEqual([word, false]);
    expect((await notesOf(w.owner)).map((n) => [n.id, n.text, n.vault])).toEqual([
      [seeded.id, "喜欢喝茶", false],
      [expect.any(String), "喝咖啡", false],
    ]);
    const own = await api(app, w.owner, "GET", `/api/agents/${w.agent.id}/memory`);
    expect(own.json.notes.map((n: any) => n.text)).toEqual(["回答要简短"]);
  });

  it("a note the sorting locked into the vault is still usable in that group, and in the owner's own conversation, and not in another group", async () => {
    const w = await world("c");
    const other = await group(app, w.mia, "别的群", [w.owner, await signUp(app, "thrx")]);
    expect((await api(app, w.owner, "POST", `/api/conversations/${other}/members`, { principalId: w.agent.id })).status).toBe(201);
    const seq = await say(w.owner, w.g, "我下周三要搬家了");
    judge.answer(() => ({ sort: 0.05 }));
    gateway.reply(ops(add("下周三要搬家")));
    await flag(w.agent.id, w.g, seq);
    await wake();
    expect(await notesOf(w.owner)).toMatchObject([{ text: "下周三要搬家", vault: true }]);
    expect((await chips(w.owner, w.agent.conversationId))[0].system).toMatchObject({ vaultLines: [true] });
    expect(await runIn(w, w.g)).toContain("下周三要搬家");
    expect(await runIn(w, other)).not.toContain("下周三要搬家");
    expect(await runIn(w, w.agent.conversationId)).toContain("下周三要搬家");
  });

  it("a co-member connected to the group sees no notice, push or trace; the model is not shown another member's lines", async () => {
    const w = await world("d");
    const theirs = await connect(app, w.mia);
    const mine = await connect(app, w.owner);
    await say(w.mia, w.g, "MIA-SAID 我讨厌香菜");
    const seq = await say(w.owner, w.g, "我下周三要搬家了");
    gateway.reply(ops(add("下周三要搬家")));
    await flag(w.agent.id, w.g, seq);
    await wake();
    await mine.next((e) => e.type === "message" && e.message.system?.event === "memory_changed");
    await settle();
    expect(textOf(reviewCalls()[0]!)).not.toContain("MIA-SAID");
    expect(JSON.stringify(theirs.events)).not.toMatch(/memory_changed|记忆已更新|记住了/);
    expect(JSON.stringify(await messagesOf(w.mia, w.g))).not.toMatch(/memory_changed|记忆已更新|记住了/);
    expect((await api(app, w.mia, "GET", `/api/conversations/${w.agent.conversationId}/messages`)).status).toBe(404);
  });
});

describe("what happens to the flags", () => {
  it("a flag whose message is not the owner's visible one is deleted at once: nothing is asked", async () => {
    const w = await world("e");
    const theirs = await say(w.mia, w.g, "我下周三要搬家了");
    await flag(w.agent.id, w.g, theirs);
    await flag(w.agent.id, w.g, 9_999);
    await wake();
    expect(reviewCalls()).toHaveLength(0);
    expect(await flagRows(w.agent.id)).toEqual([]);
  });

  it("a review that moves reviewed_seq past them deletes them, whichever review it is (a reply-triggered one too)", async () => {
    const w = await world("f");
    const seq = await say(w.owner, w.g, `@${w.agent.handle} 记住我下周三要搬家`);
    await flag(w.agent.id, w.g, seq, "own", false);
    judge.answer(() => ({ sort: 0.95 }));
    gateway.reply("好的。").reply(ops(add("下周三要搬家")));
    expect(await app.agentWorker.runOnce()).toBe(true);
    await memory().idle();
    expect(reviewCalls()).toHaveLength(1);
    expect(await flagRows(w.agent.id)).toEqual([]);
    expect(await reviewedSeq(w.agent.id, w.g)).toBeGreaterThanOrEqual(seq);
    // A later wake-up has nothing to do.
    memory().flagged(w.agent.id, w.g, "own");
    await wake();
    expect(reviewCalls()).toHaveLength(1);
  });

  it("a call that could not be made keeps the flags for exactly one more try; reviewed_seq does not move", async () => {
    const w = await world("g");
    const seq = await say(w.owner, w.g, "我下周三要搬家了");
    gateway.fail("provider_unavailable");
    await flag(w.agent.id, w.g, seq);
    await wake();
    expect(reviewCalls()).toHaveLength(1);
    expect(await flagRows(w.agent.id)).toEqual([seq]);
    expect(await reviewedSeq(w.agent.id, w.g)).toBeNull();
    gateway.fail("provider_unavailable");
    memory().flagged(w.agent.id, w.g, "own");
    await wake();
    expect(reviewCalls()).toHaveLength(2);
    expect(await flagRows(w.agent.id)).toEqual([]);
    memory().flagged(w.agent.id, w.g, "own");
    await wake();
    expect(reviewCalls()).toHaveLength(2);
  });

  it("a charged answer nothing of which can be used counts as reviewed: the flags go with reviewed_seq", async () => {
    const w = await world("h");
    const seq = await say(w.owner, w.g, "我下周三要搬家了");
    gateway.reply("好的，记下了。", { usage: { inputTokens: 100, outputTokens: 20 } });
    await flag(w.agent.id, w.g, seq);
    await wake();
    expect(await flagRows(w.agent.id)).toEqual([]);
    expect(await reviewedSeq(w.agent.id, w.g)).toBe(seq);
    expect(await notesOf(w.owner)).toEqual([]);
  });

  it("an Agent that is no longer the owner's reviewing one there (shared notes off): nothing is asked, the flags are deleted", async () => {
    const w = await world("i");
    const seq = await say(w.owner, w.g, "我下周三要搬家了");
    await flag(w.agent.id, w.g, seq);
    await db.query("update agents set shared_notes = false where principal_id = $1", [w.agent.id]);
    await wake();
    expect(reviewCalls()).toHaveLength(0);
    expect(await flagRows(w.agent.id)).toEqual([]);
  });
});

describe("both kinds in one wake-up", () => {
  it("the own review first, then the hearsay call; never overlapping", async () => {
    const w = await world("j");
    const mine = await say(w.owner, w.g, "我下周三要搬家了");
    const theirs = await say(w.mia, w.g, "小李下周要去北京出差");
    const hold = gateway.hang();
    gateway.reply(entries(["m1", "主人下周要去北京出差"]));
    await flag(w.agent.id, w.g, mine, "own");
    await flag(w.agent.id, w.g, theirs, "hearsay");
    clock.advance(2 * MIN);
    await hold.reached;
    await settle();
    expect(reviewCalls()).toHaveLength(1);
    expect(hearsayCalls()).toHaveLength(0);
    hold.release(ops());
    await memory().idle();
    expect(hearsayCalls()).toHaveLength(1);
    expect(gateway.calls.slice(first).map((c) => (c.system.includes("记忆整理员") ? "review" : "hearsay"))).toEqual(["review", "hearsay"]);
    expect(await flagRows(w.agent.id, "own")).toEqual([]);
    expect(await flagRows(w.agent.id, "hearsay")).toEqual([]);
    const rows = await db.query("select text from agent_hearsay where agent_id = $1", [w.agent.id]);
    expect(rows.rows).toEqual([{ text: "主人下周要去北京出差" }]);
  });
});

describe("from the judgement to the review (the proactive scheduler tells the reviewer)", () => {
  it("a person's message answered as the owner's own remark is flagged, and reviewed after the quiet", async () => {
    const w = await world("k", { proactive: false });
    judge.answer(() => ({ h1o: 0.95, sort: 0.95 }));
    gateway.reply(ops(add("下周三要搬家")));
    const seq = await say(w.owner, w.g, "我下周三要搬家了");
    await vi.waitFor(() => expect(clock.timers()).toBeGreaterThan(0), { timeout: 5000 });
    expect(await flagRows(w.agent.id)).toEqual([seq]);
    await wake();
    expect(reviewCalls()).toHaveLength(1);
    expect(await notesOf(w.owner)).toMatchObject([{ text: "下周三要搬家" }]);
    expect(await flagRows(w.agent.id)).toEqual([]);
  });

  it("someone else's message answered as hearsay is flagged, and becomes an entry after the quiet", async () => {
    const w = await world("l", { proactive: false });
    judge.answer(() => ({ h1: 0.95 }));
    gateway.reply(entries(["m1", "主人下周要去北京出差"]));
    const seq = await say(w.mia, w.g, "小李下周要去北京出差");
    await vi.waitFor(() => expect(clock.timers()).toBeGreaterThan(0), { timeout: 5000 });
    expect(await flagRows(w.agent.id, "hearsay")).toEqual([seq]);
    await wake();
    expect(hearsayCalls()).toHaveLength(1);
    const rows = await db.query("select text, speaker_id from agent_hearsay where agent_id = $1", [w.agent.id]);
    expect(rows.rows).toEqual([{ text: "主人下周要去北京出差", speaker_id: w.mia.id }]);
  });
});

describe("after a restart", () => {
  it("flags left over are armed again; flags older than a day are dropped", async () => {
    const w = await world("m");
    const seq = await say(w.owner, w.g, "我下周三要搬家了");
    await flag(w.agent.id, w.g, seq, "own", false);
    const old = await say(w.mia, w.g, "很早以前的话");
    await flag(w.agent.id, w.g, old, "hearsay", false);
    await db.query("update memory_flags set created_at = now() - interval '25 hours' where kind = 'hearsay'");
    expect(await memory().resume()).toBe(1);
    expect(clock.timers()).toBe(2);
    expect(await flagRows(w.agent.id, "hearsay")).toEqual([]);
    gateway.reply(ops(add("下周三要搬家")));
    await wake();
    expect(reviewCalls()).toHaveLength(1);
    expect(await flagRows(w.agent.id)).toEqual([]);
  });
});
