import type { FastifyBaseLogger } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { siteDay } from "../src/accounts/store.ts";
import { decideProactive } from "../src/agents/proactive/decide.ts";
import { runReview } from "../src/memory/pipeline.ts";
import { count, formatStats, readStats, settled } from "../src/memory/stats.ts";
import { api, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { scriptedJudge, type ScriptedAnswers } from "./helpers/judge.ts";
import { FAST, flagHelpers, JUDGE, MIN, PERSONA } from "./helpers/memory-flags.ts";
import { scriptedGateway } from "./helpers/models.ts";
import { closeAllSockets } from "./helpers/ws.ts";

/**
 * The memory counters (src/memory/stats.ts; README "Memory counters"): content-free numbers per site day that tell the site's
 * operators how the feature really behaves. Each test drives a real flow and reads `memory_stats`; nothing counted carries an
 * id or a text.
 */

const gateway = scriptedGateway();
const judge = scriptedJudge();
const lines: string[] = [];
const { app, db, clock } = useApp({ env: SITE_ENV, models: gateway, judge, agentWorker: false, memory: true, config: { judge: JUDGE }, logStream: { write: (line) => void lines.push(line) } });
const { memory, say, world, flag, wake, flagRows, chips } = flagHelpers({ app, db, clock, gateway });

const HOUR = 60 * MIN;
const today = () => siteDay(new Date(), app.deps.config.siteTimezone);

beforeEach(async () => {
  clock.reset();
  lines.length = 0;
  judge.calls.splice(0);
  judge.answer(() => ({ sort: 0.05 }));
  await db.query("delete from memory_stats");
  // The dream sweep is armed once at start; the clock was reset above, which forgot its timer.
  await memory().resume();
});
afterEach(async () => {
  app.deps.config.memory.hearsayMute = "observe";
  app.deps.config.memory.flaggedMax = 20;
  await closeAllSockets();
  await memory().idle();
  expect(gateway.pending()).toBe(0);
});

/** Everything counted so far, by name (every day summed), once what is under way has ended. */
async function stats(): Promise<Record<string, number>> {
  await memory().idle();
  await settled();
  const { rows } = await db.query<{ name: string; n: number }>("select name, sum(n)::int as n from memory_stats group by name order by name");
  return Object.fromEntries(rows.map((r) => [r.name, r.n]));
}

async function owned(name: string, over: Record<string, unknown> = {}) {
  const owner = await signUp(app, name);
  const agent = await mustCreateAgent(app, owner, { model: FAST, persona: PERSONA, ...over });
  return { owner, agent, conv: agent.conversationId as string };
}
type Owned = Awaited<ReturnType<typeof owned>>;

async function exchange(w: Owned, text: string): Promise<void> {
  await say(w.owner, w.conv, text);
  gateway.reply("好的。");
  expect(await app.agentWorker.runOnce()).toBe(true);
  await memory().idle();
}
const ops = (...o: unknown[]) => JSON.stringify({ ops: o });
const add = (text: string, kind: "owner" | "self" = "owner") => ({ op: "add", kind, text });
async function quietThen(answer: string, ms = 10 * MIN): Promise<void> {
  gateway.reply(answer);
  clock.advance(ms);
  await memory().idle();
}
/** The owner says something that asks for a review at once (EXPLICIT); the Agent answers, and then the review answers `answer`. */
async function sayAndReview(w: Owned, text: string, answer: string): Promise<void> {
  await say(w.owner, w.conv, text);
  gateway.reply("好的。").reply(answer);
  expect(await app.agentWorker.runOnce()).toBe(true);
  await memory().idle();
}
const seeded = async (who: Actor, text: string, vault: boolean) => (await api(app, who, "POST", "/api/memory/notes", { text, vault })).json;
const ownerNotes = async (who: Actor) => (await api(app, who, "GET", "/api/memory/notes")).json.notes as Array<{ id: string; text: string; vault: boolean }>;
/** Judge: a duplicate question says no, a sorting question `sort`. */
const judging = (sort: number, faithful = 0.9) =>
  judge.answer((_s, qs): ScriptedAnswers => (qs[0]!.key === "d0" ? { d0: 0.1 } : qs[0]!.key === "faithful" ? { faithful } : { sort }));

describe("count", () => {
  it("adds up on the site day, by 1 or by n, and ignores what is not a positive whole number", async () => {
    count(db, "note_added");
    count(db, "note_added", 2);
    count(db, "note_removed", 0);
    count(db, "note_removed", -1);
    count(db, "note_removed", 1.5);
    expect(await stats()).toEqual({ note_added: 3 });
    expect((await db.query<{ day: string }>("select day::text as day from memory_stats")).rows).toEqual([{ day: today() }]);
  });

  it("never throws, and never makes its caller wait, whatever the database does", async () => {
    const throwing = { query: () => { throw new Error("boom"); } };
    const rejecting = { query: () => Promise.reject(new Error("boom")) };
    expect(() => count(throwing as never, "note_added")).not.toThrow();
    expect(() => count(rejecting as never, "note_added")).not.toThrow();
    await settled();
    expect(await stats()).toEqual({});
  });

  it("emits one metric line with the name and the amount, and nothing else", async () => {
    count(db, "undo_rest", 2);
    await settled();
    const found = lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((e) => e.metric === "memory_stat");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ name: "undo_rest", by: 2 });
    expect(JSON.stringify(found[0])).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  });
});

describe("the table", () => {
  it("has the days as columns, oldest first, ending at the latest day with a count, and the names as rows", async () => {
    expect(formatStats(await readStats(db, 3), 3)).toBe("no memory counters yet");
    await db.query("insert into memory_stats (day, name, n) values ('2026-11-18', 'note_added', 4), ('2026-11-20', 'note_added', 2), ('2026-11-20', 'undo_rest', 1), ('2026-11-01', 'old', 9)");
    const text = formatStats(await readStats(db, 3), 3);
    expect(text.split("\n")).toEqual(["name         11-18   11-19   11-20", "note_added       4       -       2", "undo_rest        -       -       1"]);
  });
});

describe("a review", () => {
  it("that adds a note counts the run, the note and the judgements it needed", async () => {
    const w = await owned("st1");
    await seeded(w.owner, "喜欢喝茶", true);
    await exchange(w, "我不吃香菜");
    judging(0.95);
    await quietThen(ops(add("不吃香菜")));
    expect(await stats()).toEqual({ review_run: 1, note_added: 1, judge_memory_call_same: 1, judge_memory_call_sort: 1 });
  });

  it("that repeats a note makes it stronger, and counts that and no addition", async () => {
    const w = await owned("st2");
    await seeded(w.owner, "喜欢喝茶", false);
    await exchange(w, "我还是喜欢喝茶");
    await quietThen(ops(add("喜欢喝茶")));
    expect(await stats()).toEqual({ review_run: 1, strength_bump: 1 });
  });

  it("with an explicit request replaces, removes and locks: one count each, the lock as applied at once (lock_auto), and the question whether the owner asked to forget: one request, one statement", async () => {
    const w = await owned("st3");
    await seeded(w.owner, "喜欢鱼香肉丝", false);
    await seeded(w.owner, "住在东门", false);
    await seeded(w.owner, "不吃辣", false);
    judge.answer(() => ({ sort: 0.95, explicit_forget: 0.9, explicit_lock: 0.9 }));
    await sayAndReview(w, "我现在喜欢麻婆豆腐了，住址忘掉吧，不吃辣那条锁起来", ops({ op: "replace", ref: "n1", text: "喜欢麻婆豆腐" }, { op: "remove", ref: "n2" }, { op: "lock", ref: "n3" }));
    // The replace and the remove have a merge's shape: the faithful question came first (no answer here: not faithful).
    expect(await stats()).toMatchObject({ review_run: 1, note_replaced: 1, note_removed: 1, note_locked: 1, lock_auto: 1, explicit_asked: 1, explicit_yes: 1, judge_memory_call_explicit: 1, judge_memory_call_faithful: 1 });
    expect(await stats()).not.toHaveProperty("explicit_no");
    expect(await stats()).not.toHaveProperty("merge_auto");
  });

  it("the judgement's no and no answer at all are counted apart, and it is asked whatever the words", async () => {
    const w = await owned("st3b");
    await seeded(w.owner, "住在东门", false);
    await seeded(w.owner, "不吃辣", false);
    // A no for the forget statement; the lock is applied without a question.
    judge.answer(() => ({ sort: 0.95, explicit_forget: 0.2 }));
    await sayAndReview(w, "住址忘掉吧，不吃辣那条锁起来", ops({ op: "remove", ref: "n1" }, { op: "lock", ref: "n2" }));
    expect(await stats()).toEqual({ review_run: 1, explicit_asked: 1, explicit_no: 1, judge_memory_call_explicit: 1, note_locked: 1, lock_auto: 1, card_shown_remove: 1 });
    // No word of forgetting at all, and no answer: asked all the same, counted as no answer, a card.
    judge.answer(() => ({ sort: 0.95 }));
    const v = await owned("st3c");
    await seeded(v.owner, "住在东门", false);
    await sayAndReview(v, "记住我养了猫", ops({ op: "remove", ref: "n1" }));
    expect(await stats()).toEqual({ review_run: 2, explicit_asked: 2, explicit_no: 1, explicit_no_answer: 1, judge_memory_call_explicit: 2, note_locked: 1, lock_auto: 1, card_shown_remove: 2 });
  });

  it("a faithful merge applied at once counts merge_auto (no note_replaced, no note_removed) and the faithful question it needed", async () => {
    const w = await owned("st3d");
    await seeded(w.owner, "路由器在客厅", false);
    await seeded(w.owner, "路由器是华硕的", false);
    judge.answer(() => ({ sort: 0.95, faithful: 0.9 }));
    await sayAndReview(w, "把路由器那两条合成一条，多的删掉", ops({ op: "replace", ref: "n1", text: "路由器在客厅，是华硕的" }, { op: "remove", ref: "n2" }));
    expect(await stats()).toEqual({ review_run: 1, merge_auto: 1, judge_memory_call_faithful: 1, judge_memory_call_sort: 1 });
  });

  it("whose call fails counts the run and the failure; one that answers garbage is no failure", async () => {
    const w = await owned("st4");
    await say(w.owner, w.conv, "请记住我不吃香菜");
    gateway.reply("好的。").fail("provider_unavailable");
    expect(await app.agentWorker.runOnce()).toBe(true);
    expect(await stats()).toEqual({ review_run: 1, review_failed: 1 });
    await say(w.owner, w.conv, "请记住我喜欢茶");
    gateway.reply("好的。").reply("我不知道");
    expect(await app.agentWorker.runOnce()).toBe(true);
    expect(await stats()).toEqual({ review_run: 2, review_failed: 1 });
  });

  it("a review that is not started because the memory allowance is empty is counted as refused by the allowance, not as a failure", async () => {
    const w = await owned("st4b");
    await db.query("insert into memory_usage (owner_id, day, used_micro) values ($1, $2::date, 900000000000) on conflict (owner_id, day) do update set used_micro = 900000000000", [w.owner.id, siteDay(new Date(), app.deps.config.siteTimezone)]);
    await say(w.owner, w.conv, "请记住我不吃香菜");
    gateway.reply("好的。");
    expect(await app.agentWorker.runOnce()).toBe(true);
    expect(await stats()).toEqual({ review_run: 1, memory_refused_allowance: 1 });
  });

  it("with nothing the owner said to look at is counted as skipped, and makes no call", async () => {
    const w = await world("s5");
    await say(w.mia, w.g, `@${w.agent.handle} 你好`);
    gateway.reply("你好。");
    await app.agentWorker.runOnce();
    await memory().idle();
    const before = gateway.calls.length;
    await runReview(
      { db, config: app.deps.config, models: gateway, judge, log: app.log, inFlight: new Set(), conversations: app.deps.conversations, now: clock.now },
      { kind: "review", agentId: w.agent.id, conversationId: w.g },
      { closing: new AbortController().signal, attempted: () => undefined },
    );
    expect(gateway.calls.length).toBe(before);
    expect(await stats()).toEqual({ review_skipped_no_owner_words: 1 });
  });
});

describe("what the owner does about what a review made", () => {
  it("undoing it counts once, however often the owner asks", async () => {
    const w = await owned("st6");
    await exchange(w, "我不吃香菜");
    judging(0.95);
    await quietThen(ops(add("不吃香菜")));
    const [chip] = await chips(w.owner, w.conv);
    const undo = () => api(app, w.owner, "POST", `/api/agents/${w.agent.id}/memory/changes/${chip.system.changeId}/undo`);
    expect((await undo()).status).toBe(200);
    expect((await undo()).status).toBe(200);
    expect((await stats()).undo_rest).toBe(1);
  });

  it("deleting or editing a note a review made, and only such a note", async () => {
    const w = await owned("st7");
    await exchange(w, "我不吃香菜，也不吃葱");
    judging(0.95);
    await quietThen(ops(add("不吃香菜"), add("不吃葱")));
    const mine = await seeded(w.owner, "喜欢喝茶", false);
    const [a, b] = (await ownerNotes(w.owner)).filter((n) => n.id !== mine.id);
    expect((await api(app, w.owner, "PATCH", `/api/memory/notes/${a!.id}`, { text: "不吃香菜和葱" })).status).toBe(200);
    expect((await api(app, w.owner, "DELETE", `/api/memory/notes/${b!.id}`)).status).toBe(200);
    expect((await api(app, w.owner, "PATCH", `/api/memory/notes/${mine.id}`, { text: "喜欢喝红茶" })).status).toBe(200);
    expect((await api(app, w.owner, "DELETE", `/api/memory/notes/${mine.id}`)).status).toBe(200);
    const found = await stats();
    expect([found.owner_edited_auto_note, found.owner_deleted_auto_note]).toEqual([1, 1]);
    // Edits are counted, not notes: no column says who wrote a note's text last, so editing it again counts again (README).
    expect((await api(app, w.owner, "PATCH", `/api/memory/notes/${a!.id}`, { text: "不吃香菜，也不吃葱" })).status).toBe(200);
    expect((await stats()).owner_edited_auto_note).toBe(2);
  });

  it("taking a note out of the vault, and putting one in", async () => {
    const w = await owned("st8");
    const locked = await seeded(w.owner, "对花生过敏", true);
    const open = await seeded(w.owner, "喜欢喝茶", false);
    expect((await api(app, w.owner, "PATCH", `/api/memory/notes/${locked.id}`, { vault: false })).status).toBe(200);
    expect((await api(app, w.owner, "PATCH", `/api/memory/notes/${open.id}`, { vault: true })).status).toBe(200);
    // No change of the vault: no count.
    expect((await api(app, w.owner, "PATCH", `/api/memory/notes/${open.id}`, { vault: true })).status).toBe(200);
    const found = await stats();
    expect([found.owner_unlocked, found.owner_locked]).toEqual([1, 1]);
  });

  it("with 先问我再记 each card is counted as shown (ask_first), and confirmed or discarded once each", async () => {
    const w = await owned("st9", { memoryAsk: true });
    await exchange(w, "我不吃香菜");
    judging(0.95);
    await quietThen(ops(add("不吃香菜")));
    await exchange(w, "我喜欢茶");
    await quietThen(ops(add("喜欢茶")), 21 * HOUR);
    const cards = await chips(w.owner, w.conv);
    expect(cards.map((c) => c.system.pending)).toEqual([true, true]);
    const decide = (verb: string, id: string) => api(app, w.owner, "POST", `/api/agents/${w.agent.id}/memory/changes/${id}/${verb}`);
    expect((await decide("confirm", cards[0]!.system.changeId)).status).toBe(200);
    expect((await decide("confirm", cards[0]!.system.changeId)).status).toBe(200);
    expect((await decide("discard", cards[1]!.system.changeId)).status).toBe(200);
    const found = await stats();
    expect([found.card_shown_ask_first, found.card_confirmed, found.card_discarded]).toEqual([2, 1, 1]);
    expect(found).not.toHaveProperty("pending_confirmed");
    expect(found).not.toHaveProperty("pending_discarded");
  });

  it("a card is counted by why it waits — a remove not asked for, a merge not found faithful, anything else (a replace before the owner's word, an unlock) — and a card nobody answered is counted when the sweep discards it", async () => {
    // A remove the owner did not ask for.
    const a = await owned("cs1");
    await seeded(a.owner, "住在东门", false);
    judge.answer(() => ({ sort: 0.95, explicit_forget: 0.1 }));
    await sayAndReview(a, "住址那条处理一下，记住", ops({ op: "remove", ref: "n1" }));
    // A merge that is not faithful, with the owner not asking for its remove.
    const b = await owned("cs2");
    await seeded(b.owner, "路由器在客厅", false);
    await seeded(b.owner, "路由器是华硕的", false);
    judge.answer(() => ({ sort: 0.95, faithful: 0.2, explicit_forget: 0.1 }));
    await sayAndReview(b, "把路由器那两条合成一条，多的删掉", ops({ op: "replace", ref: "n1", text: "路由器在客厅，是小米的" }, { op: "remove", ref: "n2" }));
    // A replace of a note changed after the owner's last line, and a request to take a note out of the vault.
    const c = await owned("cs3");
    await exchange(c, "其实我不喝茶了");
    await seeded(c.owner, "喜欢喝茶", false);
    await seeded(c.owner, "对花生过敏", true);
    judge.answer(() => ({ sort: 0.95 }));
    await quietThen(ops({ op: "replace", ref: "n1", text: "不喝茶了" }, { op: "unlock", ref: "n2" }));
    const found = await stats();
    expect(found).toMatchObject({ card_shown_remove: 1, card_shown_unfaithful_merge: 1, card_shown_other: 2 });
    expect(found).not.toHaveProperty("card_shown_ask_first");
    expect((await chips(c.owner, c.conv)).map((n) => n.system.pending)).toEqual([true, true]);
    // A month later nobody has answered them: the sweep discards each, counted once.
    const { sweepMemoryChanges } = await import("../src/memory/sweep.ts");
    expect((await sweepMemoryChanges(db, new Date(Date.now() + 31 * 24 * HOUR))).discarded).toBe(4);
    expect((await stats()).card_expired).toBe(4);
  });

  it("with 先问我再记 a dream's card counts as ask_first; a pending change with nothing in it (a full room) is no card and is not counted", async () => {
    const w = await owned("cs4", { memoryAsk: true });
    await seeded(w.owner, "喜欢喝茶", false);
    await seeded(w.owner, "爱喝茶", false);
    judge.answer((_s, qs): ScriptedAnswers => (qs[0]!.key === "faithful" ? { faithful: 0.9 } : { sort: 0.95 }));
    gateway.reply(JSON.stringify({ ops: [{ op: "merge", into: "n1", from: ["n2"], text: "爱喝茶" }] }));
    clock.advance(3 * HOUR + MIN);
    await memory().idle();
    expect((await chips(w.owner, w.conv)).map((n) => [n.system.phase, n.system.pending])).toEqual([["dream", true]]);
    expect((await stats()).card_shown_ask_first).toBe(1);
    const v = await owned("cs5", { memoryAsk: true });
    for (let i = 0; i < 10; i++) await seeded(v.owner, `${"字".repeat(199)}${i}`, true);
    await exchange(v, "我喜欢茶");
    await quietThen(ops(add("喜欢茶")));
    expect((await chips(v.owner, v.conv)).map((n) => [n.system.pending, n.system.full])).toEqual([[false, true]]);
    expect((await stats()).card_shown_ask_first).toBe(1);
  });
});

describe("listening for memory", () => {
  const decide = (conv: string, seq: number, over: Record<string, unknown> = {}) =>
    decideProactive({ db, judge, config: { ...app.deps.config, ...over } as never, log: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} } as unknown as FastifyBaseLogger }, conv, seq);

  it("a hearsay flag and an owner's own flag are counted by kind", async () => {
    const w = await world("fl");
    const heard = await say(w.mia, w.g, "owner 打算明年换工作");
    judge.answer(() => ({ h1: 0.9 }));
    await decide(w.g, heard);
    const own = await say(w.owner, w.g, "我不吃香菜，别忘了");
    judge.answer(() => ({ h1o: 0.9 }));
    await decide(w.g, own);
    expect(await stats()).toMatchObject({ flag_hearsay: 1, flag_own: 1 });
  });

  it("a judgement skipped because the day's judgements reached listenShare is counted", async () => {
    const w = await world("sh");
    await db.query("insert into judge_usage (day, calls) values ($1::date, 6) on conflict (day) do update set calls = 6", [today()]);
    const heard = await say(w.mia, w.g, "owner 打算明年换工作");
    judge.answer(() => ({ h1: 0.9 }));
    await decide(w.g, heard, { judge: { ...JUDGE, dailyLimit: 10 } });
    expect(judge.calls).toHaveLength(0);
    expect(await stats()).toEqual({ judge_memory_skipped_share: 1 });
  });
});

describe("hearsay", () => {
  const SAID = "主人下周要去北京出差";
  const answer = (...entries: Array<{ from: string; text: string }>) => JSON.stringify({ entries, drop: [] });
  const verdict = (fresh: number, abuse: number) => judge.answer(() => ({ sort: 0.05, hearsay_new: fresh, hearsay_abuse: abuse }));
  const flagMany = async (w: Awaited<ReturnType<typeof world>>, senders: Actor[]): Promise<void> => {
    for (const [i, who] of senders.entries()) await flag(w.agent.id, w.g, await say(who, w.g, `小李的第${i + 1}件事`), "hearsay");
  };

  it("a batch is checked, paid for and written: the check, the call, the entry", async () => {
    const w = await world("h1");
    verdict(0.9, 0.1);
    gateway.reply(answer({ from: "m1", text: SAID }));
    await flag(w.agent.id, w.g, await say(w.mia, w.g, "小李下周要去北京出差"), "hearsay");
    await wake();
    expect(await stats()).toEqual({ hearsay_call: 1, judge_memory_call_precheck: 1 });
  });

  it("a batch with nothing new is dropped before any call", async () => {
    const w = await world("h2");
    verdict(0.1, 0.1);
    await flag(w.agent.id, w.g, await say(w.mia, w.g, "小李下周要去北京出差"), "hearsay");
    await wake();
    expect(await stats()).toEqual({ hearsay_skipped_nothing_new: 1, judge_memory_call_precheck: 1 });
  });

  it("a flooding speaker is counted as one who would be muted, in observe and in on mode alike", async () => {
    const w = await world("h3");
    verdict(0.9, 0.95);
    gateway.reply(answer({ from: "m1", text: SAID }));
    await flagMany(w, [w.mia, w.mia, w.third, w.mia, w.mia]);
    await wake();
    expect(await stats()).toMatchObject({ hearsay_would_mute: 1, hearsay_call: 1 });
    app.deps.config.memory.hearsayMute = "on";
    await flagMany(w, [w.mia, w.mia, w.third, w.mia, w.mia]);
    await wake();
    expect(await stats()).toMatchObject({ hearsay_would_mute: 2, hearsay_call: 1 });
  });

  it("the hour's cap holds a wake-up back", async () => {
    const w = await world("h4");
    verdict(0.95, 0.05);
    for (let i = 1; i <= 5; i++) {
      const seq = await say(w.mia, w.g, `小李的第${i}件事`);
      if (i <= 4) gateway.reply(answer({ from: "m1", text: `主人的第${i}件事` }));
      await flag(w.agent.id, w.g, seq, "hearsay");
      await wake();
    }
    expect(await stats()).toMatchObject({ hearsay_call: 4, hearsay_held_by_cap: 1 });
  });

  it("flags beyond flaggedMax, older than a day, or tried twice are dropped and counted apart", async () => {
    const w = await world("h5");
    app.deps.config.memory.flaggedMax = 2;
    verdict(0.9, 0.1);
    gateway.reply(answer({ from: "m1", text: SAID }));
    await flagMany(w, [w.mia, w.mia, w.mia, w.mia]);
    await wake();
    expect((await stats()).flags_dropped_overflow).toBe(2);
    // A day-old flag.
    const old = await say(w.mia, w.g, "很久以前的事");
    await flag(w.agent.id, w.g, old, "hearsay", false);
    await db.query("update memory_flags set created_at = now() - interval '25 hours' where agent_id = $1 and seq = $2", [w.agent.id, old]);
    memory().flagged(w.agent.id, w.g, "hearsay");
    await wake();
    expect((await stats()).flags_dropped_age).toBe(1);
    // Tried twice: the call fails both times.
    const seq = await say(w.mia, w.g, "小李下周要去北京出差");
    gateway.fail("provider_unavailable").fail("provider_unavailable");
    await flag(w.agent.id, w.g, seq, "hearsay");
    await wake();
    await wake();
    expect(await flagRows(w.agent.id, "hearsay")).toEqual([]);
    expect((await stats()).flags_dropped_tries).toBe(1);
  });

  it("confirming and deleting an entry, and undoing the change that wrote them", async () => {
    const w = await world("h6");
    verdict(0.9, 0.1);
    gateway.reply(answer({ from: "m1", text: SAID }));
    await flag(w.agent.id, w.g, await say(w.mia, w.g, "小李下周要去北京出差"), "hearsay");
    await wake();
    gateway.reply(answer({ from: "m1", text: "主人喜欢喝茶" }));
    await flag(w.agent.id, w.g, await say(w.mia, w.g, "小李喜欢喝茶"), "hearsay");
    await wake();
    const entries = (await db.query<{ id: string }>("select id from agent_hearsay where agent_id = $1 order by created_at", [w.agent.id])).rows;
    expect((await api(app, w.owner, "POST", `/api/agents/${w.agent.id}/memory/hearsay/${entries[0]!.id}/confirm`)).status).toBe(201);
    expect((await api(app, w.owner, "DELETE", `/api/agents/${w.agent.id}/memory/hearsay/${entries[1]!.id}`)).status).toBe(200);
    const [, second] = await chips(w.owner, w.agent.conversationId);
    // The second change's entry was deleted: it is stale; the undo of a change still whole is of the first, whose entry is a note now: also stale.
    await api(app, w.owner, "POST", `/api/agents/${w.agent.id}/memory/changes/${second.system.changeId}/undo`);
    const found = await stats();
    expect([found.hearsay_confirmed, found.hearsay_deleted]).toEqual([1, 1]);
    expect(found.undo_hearsay).toBeUndefined();
  });

  it("undoing a hearsay change counts as such", async () => {
    const w = await world("h7");
    verdict(0.9, 0.1);
    gateway.reply(answer({ from: "m1", text: SAID }));
    await flag(w.agent.id, w.g, await say(w.mia, w.g, "小李下周要去北京出差"), "hearsay");
    await wake();
    const [chip] = await chips(w.owner, w.agent.conversationId);
    expect((await api(app, w.owner, "POST", `/api/agents/${w.agent.id}/memory/changes/${chip.system.changeId}/undo`)).status).toBe(200);
    expect((await stats()).undo_hearsay).toBe(1);
  });
});

describe("a dream", () => {
  const dreamAns = (...o: unknown[]) => JSON.stringify({ ops: o });
  async function night(ms = 3 * HOUR + MIN): Promise<void> {
    clock.advance(ms);
    await memory().idle();
  }
  const seededAuto = async (who: Actor, text: string) => (await api(app, who, "POST", "/api/memory/notes", { text })).json;

  it("merges, rewrites, splits and locks are counted apart, and the checks they needed", async () => {
    const w = await owned("d1");
    await seeded(w.owner, "喜欢喝茶", false);
    await seeded(w.owner, "爱喝茶", false);
    await seeded(w.owner, "喜欢咖啡，对花生过敏", false);
    await seeded(w.owner, "爱吃辣", false);
    judge.answer((_s, qs): ScriptedAnswers => (qs[0]!.key === "faithful" ? { faithful: 0.9 } : { sort: 0.95 }));
    // The owner's own choice is final: only a note the sorting put outside the vault may be locked by a dream.
    await seededAuto(w.owner, "周末爬山");
    gateway.reply(
      dreamAns(
        { op: "merge", into: "n1", from: ["n2"], text: "爱喝茶，不加糖" },
        { op: "split", ref: "n3", texts: ["喜欢咖啡", "对花生过敏"] },
        { op: "rewrite", ref: "n4", text: "爱吃辣的" },
        { op: "lock", ref: "n5" },
      ),
    );
    await night();
    const found = await stats();
    expect(found).toMatchObject({ dream_run: 1, dream_merge: 1, dream_split: 1, dream_rewrite: 1, dream_lock: 1, judge_memory_call_faithful: 3 });
    expect(found.dream_resort_locked).toBeUndefined();
    const [chip] = await chips(w.owner, w.conv);
    expect((await api(app, w.owner, "POST", `/api/agents/${w.agent.id}/memory/changes/${chip.system.changeId}/undo`)).status).toBe(200);
    expect((await stats()).undo_dream).toBe(1);
  });

  it("a new open note locked again by the sorting is counted as a re-sort, not as the model's lock", async () => {
    const w = await owned("d2");
    judge.answer(() => ({ sort: 0.95, faithful: 0.9 }));
    await seededAuto(w.owner, "喜欢喝茶");
    judge.answer(() => ({ sort: 0.1 }));
    gateway.reply(dreamAns());
    await night();
    const found = await stats();
    expect(found).toMatchObject({ dream_run: 1, dream_resort_locked: 1 });
    expect(found.dream_lock).toBeUndefined();
  });

  it("a call that fails is a failed dream", async () => {
    const w = await owned("d3");
    await seeded(w.owner, "喜欢喝茶", false);
    gateway.fail("provider_unavailable");
    await night();
    expect(await stats()).toEqual({ dream_failed: 1 });
  });

  it("a dream the memory allowance refuses is counted as refused, not as failed, and uses none of the day's three tries", async () => {
    const w = await owned("d5");
    const before = gateway.calls.length;
    await seeded(w.owner, "喜欢喝茶", false);
    await db.query("insert into memory_usage (owner_id, day, used_micro) values ($1, $2::date, 900000000000) on conflict (owner_id, day) do update set used_micro = 900000000000", [w.owner.id, today()]);
    await night();
    // Sweeps go on every quarter of an hour: the refused owner is not asked again before the allowance is back.
    for (let i = 0; i < 4; i++) await night(16 * MIN);
    expect(await stats()).toEqual({ memory_refused_allowance: 1 });
    expect(gateway.calls.slice(before)).toHaveLength(0);
    // A new site day: the allowance is there again and the dream is made (three refusals counted as tries would have barred it for a day).
    const { nextSiteMidnight } = await import("../src/accounts/store.ts");
    await db.query("delete from memory_usage where owner_id = $1", [w.owner.id]);
    gateway.reply(JSON.stringify({ ops: [] }));
    await night(nextSiteMidnight(new Date(clock.now()), app.deps.config.siteTimezone).getTime() - clock.now() + MIN);
    expect(await stats()).toEqual({ memory_refused_allowance: 1, dream_run: 1 });
  });

  it("a room left nearly full by a change is a nap, not a dream", async () => {
    const w = await owned("d4");
    for (let i = 0; i < 8; i++) await db.query("insert into owner_notes (owner_id, text, vault) values ($1, $2, false)", [w.owner.id, `${"茶".repeat(199)}${i}`]);
    judge.answer(() => ({ sort: 0.95, faithful: 0.9 }));
    await exchange(w, "我喜欢喝咖啡");
    gateway.reply(ops(add("喜欢喝咖啡")));
    gateway.reply(dreamAns());
    clock.advance(10 * MIN);
    await memory().idle();
    const found = await stats();
    expect(found).toMatchObject({ review_run: 1, note_added: 1, nap_run: 1 });
    expect(found.dream_run).toBeUndefined();
  });
});
