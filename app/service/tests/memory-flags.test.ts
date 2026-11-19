import type { FastifyBaseLogger } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { siteDay } from "../src/accounts/store.ts";
import type { Config } from "../src/config.ts";
import type { Db } from "../src/db.ts";
import { listenersFor } from "../src/agents/proactive/listeners.ts";
import { decideProactive } from "../src/agents/proactive/decide.ts";
import type { Question } from "../src/judge/client.ts";
import { api, group, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { scriptedJudge, type ScriptedAnswers } from "./helpers/judge.ts";
import { closeAllSockets } from "./helpers/ws.ts";

/**
 * Task 8 of the memory plan: the proactive judgement also listens, for Agents with memory on, for what is said about
 * their owner (`hearsay`) and what the owner says about themselves (`own`), and what it hears becomes rows of
 * `memory_flags`. `decideProactive` is called directly with a scripted judgement model, as proactive-decide.test.ts does.
 */

const JUDGE = {
  model: "jev-1",
  channels: [{ url: "https://judge-a.example.test/v1/systemone", apiKeyEnv: "UPSTREAM_TEST_KEY" }],
  timeoutMs: 4000,
  dailyLimit: 20_000,
};
const judge = scriptedJudge();
const { app, db } = useApp({ env: SITE_ENV, judge, agentWorker: false, config: { judge: JUDGE } });
const FAST = { source: "site", id: "fast" } as const;

const log = { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} } as unknown as FastifyBaseLogger;

beforeEach(() => {
  judge.calls.splice(0);
  judge.answer(() => ({}));
});
afterEach(async () => {
  await closeAllSockets();
});

const decide = (conv: string, seq: number, over: Partial<Config> = {}, withDb: Db = db) =>
  decideProactive({ db: withDb, judge, config: { ...app.deps.config, ...over }, log }, conv, seq);

async function world(tag = "") {
  const [owner, member, third] = [await signUp(app, `owner${tag}`), await signUp(app, `member${tag}`), await signUp(app, `third${tag}`)];
  return { owner, member, third, g: await group(app, owner, "team", [member, third]) };
}

const join = (conv: string, id: string) =>
  db.query(`insert into memberships (conversation_id, principal_id, role, joined_seq) select $1, $2, 'speaker', seq from conversations where id = $1`, [conv, id]);

/** An Agent of `owner` in `conv`: memory on and proactive off unless `over` says otherwise. */
async function agentOf(owner: Actor, handle: string, conv: string | null, over: Record<string, unknown> = {}) {
  const agent = await mustCreateAgent(app, owner, { handle, name: handle, model: FAST, persona: "简短地回答。", proactive: false, memory: true, ...over });
  if (conv) await join(conv, agent.id);
  return agent as { id: string; handle: string };
}

let txn = 0;
const say = async (who: Actor, conv: string, text: string): Promise<number> => {
  const sent = await api(app, who, "POST", `/api/conversations/${conv}/messages`, { text, clientTxn: `mf${++txn}` });
  if (sent.status !== 201) throw new Error(`say: ${sent.status} ${JSON.stringify(sent.json)}`);
  return sent.json.message.seq as number;
};

const flagsOf = async (conv: string) =>
  (await db.query<{ agent_id: string; seq: number; kind: string }>("select agent_id, seq::int as seq, kind from memory_flags where conversation_id = $1 order by seq, kind, agent_id", [conv])).rows;
const keys = (questions: readonly Question[]) => questions.map((q) => q.key);
/** A script that answers listener question `key` with `p` and nothing else. */
const answering = (answers: ScriptedAnswers) => () => answers;

/** Judges `seq` once with nothing answered, so that the messages before it are no longer new. */
async function judgedUpTo(conv: string, seq: number) {
  await decide(conv, seq);
  judge.calls.splice(0);
}

const HEARSAY = (name: string) =>
  `群里有一位成员叫「${name}」。在标着【新】的消息里，有人（不是${name}自己）说了一件关于${name}本人的、以后还用得上的事：做过什么、打算做什么、有什么没做完、喜欢或不喜欢什么、安排或情况。只是打招呼、叫他、@ 他、顺口提到名字、开玩笑、泛泛的评价，都不算。消息可能是任何语言。`;
const OWN = (name: string) =>
  `群里有一位成员叫「${name}」。在标着【新】的消息里，${name}自己说了一件关于自己的、以后还用得上的事：喜欢或不喜欢什么、习惯、安排、情况，或者要别人记住的事。只是闲聊、接话、提问、对别人的事发表看法，都不算。消息可能是任何语言。`;

describe("listeners", () => {
  it("a group with a memory Agent and no proactive one is judged, with only the listener question, and nobody can be triggered", async () => {
    const w = await world();
    const bot = await agentOf(w.owner, "memo", w.g);
    judge.answer(answering({ h1: 0.1 }));
    const said = await say(w.member, w.g, "我明天要去北京出差");
    const decided = await decide(w.g, said);
    expect(judge.calls).toHaveLength(1);
    expect(keys(judge.calls[0]!.questions)).toEqual(["h1"]);
    expect(judge.calls[0]!.questions[0]!.instructions).toBe(HEARSAY("owner"));
    expect(decided.runs).toEqual([]);
    expect(await db.query("select 1 from agent_runs where agent_id = $1", [bot.id]).then((r) => r.rowCount)).toBe(0);
    // Judged, and stamped as judged up to the message.
    const state = await db.query("select judged_seq::int as s from agent_group_state where agent_id = $1 and conversation_id = $2", [bot.id, w.g]);
    expect(state.rows[0]!.s).toBe(said);
  });

  it("0.7 on h1 flags the new messages by others for the owner's Agent; the flags are returned", async () => {
    const w = await world();
    const bot = await agentOf(w.owner, "memo", w.g);
    await judgedUpTo(w.g, await say(w.member, w.g, "早"));
    await say(w.member, w.g, "owner 上周去了东京");
    const owner = await say(w.owner, w.g, "哈哈");
    const last = await say(w.third, w.g, "owner 打算明年换工作");
    judge.answer(answering({ h1: 0.7 }));
    const decided = await decide(w.g, last);
    expect(judge.calls[0]!.state).toContain("【新】member：owner 上周去了东京");
    // The owner's own line is new but raises no hearsay flag; the question is about what others said.
    expect(judge.calls[0]!.state).toContain(`【新】owner：哈哈`);
    const flags = await flagsOf(w.g);
    expect(flags).toEqual([
      { agent_id: bot.id, seq: last - 2, kind: "hearsay" },
      { agent_id: bot.id, seq: last, kind: "hearsay" },
    ]);
    expect(flags.some((f) => f.seq === owner)).toBe(false);
    expect(decided.flags).toEqual(flags.map((f) => ({ agentId: f.agent_id, conversationId: w.g, seq: f.seq, kind: "hearsay" })));
  });

  it("under the threshold flags nothing, and the result carries no flags", async () => {
    const w = await world();
    await agentOf(w.owner, "memo", w.g);
    judge.answer(answering({ h1: 0.59 }));
    const decided = await decide(w.g, await say(w.member, w.g, "owner 喜欢吃辣"));
    expect(await flagsOf(w.g)).toEqual([]);
    expect(decided.flags ?? []).toEqual([]);
  });

  it("0.7 on h1o flags the owner's new message for one Agent only; two Agents of one owner share the questions", async () => {
    const w = await world();
    const a = await agentOf(w.owner, "memo_a", w.g);
    const b = await agentOf(w.owner, "memo_b", w.g);
    const owner = await say(w.owner, w.g, "我不吃香菜，别忘了");
    judge.answer(answering({ h1o: 0.7, h1: 0.9 }));
    await decide(w.g, owner);
    expect(judge.calls).toHaveLength(1);
    // Only the owner spoke: no hearsay question, one own question for the one owner.
    expect(keys(judge.calls[0]!.questions)).toEqual(["h1o"]);
    expect(judge.calls[0]!.questions[0]!.instructions).toBe(OWN("owner"));
    const lowest = [a.id, b.id].sort()[0]!;
    expect(await flagsOf(w.g)).toEqual([{ agent_id: lowest, seq: owner, kind: "own" }]);
  });

  it("someone else's message gives both Agents of the owner a hearsay flag, and the owner's own message never does", async () => {
    const w = await world();
    const a = await agentOf(w.owner, "memo_a", w.g);
    const b = await agentOf(w.owner, "memo_b", w.g);
    await judgedUpTo(w.g, await say(w.member, w.g, "早"));
    const spoken = await say(w.member, w.g, "owner 答应周五请客");
    const own = await say(w.owner, w.g, "好的");
    judge.answer(answering({ h1: 0.7, h1o: 0.1 }));
    await decide(w.g, own);
    expect(keys(judge.calls[0]!.questions)).toEqual(["h1", "h1o"]);
    expect(await flagsOf(w.g)).toEqual(
      [a.id, b.id].sort().map((id) => ({ agent_id: id, seq: spoken, kind: "hearsay" })),
    );
  });

  it("the reviewing Agent is the lowest id with memory and shared notes on; with none, no own question", async () => {
    const w = await world();
    const a = await agentOf(w.owner, "memo_a", w.g, { sharedNotes: false });
    const b = await agentOf(w.owner, "memo_b", w.g);
    const c = await agentOf(w.owner, "memo_c", w.g);
    const owner = await say(w.owner, w.g, "我养了一只猫");
    judge.answer(answering({ h1o: 0.9 }));
    await decide(w.g, owner);
    const reviewer = [b.id, c.id].sort()[0]!;
    expect(await flagsOf(w.g)).toEqual([{ agent_id: reviewer, seq: owner, kind: "own" }]);
    expect([a.id].includes(reviewer)).toBe(false);

    const w2 = await world("2");
    await agentOf(w2.owner, "memo_d", w2.g, { sharedNotes: false });
    const said = await say(w2.owner, w2.g, "我养了一只狗");
    await decide(w2.g, said);
    expect(judge.calls.filter((c) => c.state.includes("我养了一只狗"))).toHaveLength(0);
    expect(await flagsOf(w2.g)).toEqual([]);
  });

  it("a blocked pair is not listened to, either way", async () => {
    const w = await world();
    await agentOf(w.owner, "memo", w.g);
    await db.query("insert into blocks (blocker_id, blocked_id) values ($1, $2)", [w.member.id, w.owner.id]);
    const said = await say(w.third, w.g, "owner 昨天感冒了");
    // third is not blocked: asked (nothing flagged here). member is blocked: not asked.
    await judgedUpTo(w.g, said);
    judge.answer(answering({ h1: 0.9 }));
    const blockedSaid = await say(w.member, w.g, "owner 其实不喜欢开会");
    await decide(w.g, blockedSaid);
    expect(judge.calls).toHaveLength(0);
    expect(await flagsOf(w.g)).toEqual([]);

    const w2 = await world("2");
    await agentOf(w2.owner, "memo_x", w2.g);
    await db.query("insert into blocks (blocker_id, blocked_id) values ($1, $2)", [w2.owner.id, w2.member.id]);
    await decide(w2.g, await say(w2.member, w2.g, "owner 其实不喜欢开会"));
    expect(judge.calls).toHaveLength(0);
  });

  it("memory off: no listener, no judgement", async () => {
    const w = await world();
    await agentOf(w.owner, "memo", w.g, { memory: false });
    await decide(w.g, await say(w.member, w.g, "owner 喜欢喝茶"));
    expect(judge.calls).toHaveLength(0);
    expect(await listenersFor(db, w.g, 1000)).toEqual([]);
  });

  it("a paused Agent, one that joined after the message, and one that left are not listeners", async () => {
    const w = await world();
    const paused = await agentOf(w.owner, "memo_p", w.g);
    await db.query("update agents set paused = true where principal_id = $1", [paused.id]);
    const left = await agentOf(w.owner, "memo_l", w.g);
    await db.query("update memberships set left_seq = joined_seq where principal_id = $1 and conversation_id = $2", [left.id, w.g]);
    const said = await say(w.member, w.g, "hello");
    const late = await agentOf(w.owner, "memo_late", w.g);
    expect(late.id).toBeTruthy();
    expect(await listenersFor(db, w.g, said)).toEqual([]);
  });

  it("a message that @-names an Agent is not judged at all", async () => {
    const w = await world();
    await agentOf(w.owner, "memo", w.g);
    await decide(w.g, await say(w.member, w.g, "@memo owner 喜欢喝茶"));
    expect(judge.calls).toHaveLength(0);
  });

  it("what the judge is shown starts after the latest join among the listeners", async () => {
    const w = await world();
    await agentOf(w.owner, "memo_a", w.g);
    await say(w.member, w.g, "加入之前的话");
    const other = await signUp(app, "other");
    await join(w.g, other.id);
    await agentOf(other, "memo_b", w.g);
    const said = await say(w.member, w.g, "加入之后的话");
    judge.answer(answering({ h1: 0.1, h2: 0.1 }));
    await decide(w.g, said);
    expect(judge.calls[0]!.state).toBe("群聊记录：\n【新】member：加入之后的话");
  });

  it("with a proactive option the window is the option's: a listener that joined later is asked about and flagged only for messages after its own join", async () => {
    const w = await world();
    await agentOf(w.owner, "anna", w.g, { proactive: true, memory: false });
    await judgedUpTo(w.g, await say(w.third, w.g, "早"));
    const before = await say(w.member, w.g, "third 去年在上海工作");
    const memo = await agentOf(w.third, "memo", w.g);
    const after = await say(w.member, w.g, "third 下周要回来");
    judge.answer((_s, questions) => {
      const pick = questions.find((q) => q.key === "pick") as Extract<Question, { type: "choice" }>;
      return { pick: Object.fromEntries(Object.keys(pick.options).map((k) => [k, k === "nobody" ? 1 : 0])), h1: 0.9 };
    });
    await decide(w.g, after);
    // Anna's window reaches back to before the listener joined; the listener's flags do not.
    expect(judge.calls[0]!.state).toContain(`【新】member：third 去年在上海工作`);
    expect(await flagsOf(w.g)).toEqual([{ agent_id: memo.id, seq: after, kind: "hearsay" }]);
    expect(before).toBeLessThan(after);
  });

  it("two owners: one pair of questions each, keyed in owner id order", async () => {
    const w = await world();
    await agentOf(w.owner, "memo_a", w.g);
    await agentOf(w.member, "memo_b", w.g);
    const said = await say(w.third, w.g, "闲聊");
    judge.answer(answering({}));
    await decide(w.g, said);
    expect(keys(judge.calls[0]!.questions)).toEqual(["h1", "h2"]);
    const names = judge.calls[0]!.questions.map((q) => /「(.+?)」/.exec(q.instructions)![1]);
    expect(new Set(names)).toEqual(new Set(["owner", "member"]));
  });

  it("with a proactive Agent too, the pick comes first and the listener questions follow; the pick still triggers", async () => {
    const w = await world();
    const bot = await agentOf(w.owner, "memo", w.g, { proactive: true });
    judge.answer((_s, questions) => {
      const pick = questions.find((q) => q.key === "pick") as Extract<Question, { type: "choice" }>;
      const [agentKey] = Object.keys(pick.options).filter((k) => k !== "nobody");
      return { pick: { [agentKey!]: 0.95, nobody: 0.05 }, h1: 0.7 };
    });
    const said = await say(w.member, w.g, "owner 的生日是五月一号，谁知道送什么好？");
    const decided = await decide(w.g, said);
    expect(keys(judge.calls[0]!.questions)).toEqual(["pick", "h1"]);
    expect(decided.runs).toHaveLength(1);
    expect(await flagsOf(w.g)).toEqual([{ agent_id: bot.id, seq: said, kind: "hearsay" }]);
  });

  it("a judgement with no proactive option is skipped once the day's judgements reach listenShare of the limit; one with options is not", async () => {
    const day = siteDay(new Date(), app.deps.config.siteTimezone);
    const over = { judge: { ...JUDGE, dailyLimit: 10 } };
    const used = (calls: number) => db.query("insert into judge_usage (day, calls) values ($1::date, $2) on conflict (day) do update set calls = $2", [day, calls]);
    const only = await world();
    await agentOf(only.owner, "memo", only.g);
    const both = await world("2");
    await agentOf(both.owner, "memo_b", both.g);
    await agentOf(both.owner, "anna", both.g, { proactive: true });
    judge.answer(answering({ h1: 0.9, h1o: 0.9 }));

    await used(5);
    expect(await decide(only.g, await say(only.member, only.g, "owner 喜欢跑步"), over)).toEqual({ runs: [], callerLimited: [], notices: [], budgetReached: [] });
    expect(judge.calls).toHaveLength(0);
    expect(await flagsOf(only.g)).toEqual([]);
    expect((await db.query("select calls from judge_usage")).rows).toEqual([{ calls: 5 }]);
    await decide(both.g, await say(both.member, both.g, "owner 喜欢跑步"), over);
    expect(judge.calls).toHaveLength(1);
    expect(keys(judge.calls[0]!.questions)).toContain("pick");
    expect((await db.query("select calls from judge_usage")).rows).toEqual([{ calls: 6 }]);

    judge.calls.splice(0);
    await used(4);
    await decide(only.g, await say(only.member, only.g, "owner 喜欢游泳"), over);
    expect(judge.calls).toHaveLength(1);
    expect((await flagsOf(only.g)).length).toBeGreaterThan(0);
  });

  it("a flag that cannot be written never drops the pick that was answered", async () => {
    const w = await world();
    await agentOf(w.owner, "memo", w.g, { proactive: true });
    judge.answer((_s, questions) => {
      const pick = questions.find((q) => q.key === "pick") as Extract<Question, { type: "choice" }>;
      const [k] = Object.keys(pick.options).filter((x) => x !== "nobody");
      return { pick: { [k!]: 0.95, nobody: 0.05 }, h1: 0.9 };
    });
    const failing = {
      query: (sql: string, params?: unknown[]) => (sql.includes("insert into memory_flags") ? Promise.reject(new Error("disk full")) : db.query(sql, params)),
      tx: db.tx.bind(db),
      pool: db.pool,
      close: db.close,
    } as unknown as Db;
    const decided = await decide(w.g, await say(w.member, w.g, "owner 的生日快到了，送什么好？"), {}, failing);
    expect(decided.runs).toHaveLength(1);
    expect(decided.flags ?? []).toEqual([]);
    expect(await flagsOf(w.g)).toEqual([]);
  });

  it("an Agent whose owner has left the group does not listen", async () => {
    const w = await world();
    await agentOf(w.owner, "memo", w.g);
    const said = await say(w.member, w.g, "hello");
    expect(await listenersFor(db, w.g, said + 1)).toHaveLength(1);
    await db.query("update memberships set left_seq = joined_seq where principal_id = $1 and conversation_id = $2", [w.owner.id, w.g]);
    expect(await listenersFor(db, w.g, said + 1)).toEqual([]);
  });

  it("with a blocked and an unblocked sender both new, only the unblocked sender's messages are flagged", async () => {
    const w = await world();
    const bot = await agentOf(w.owner, "memo", w.g);
    await db.query("insert into blocks (blocker_id, blocked_id) values ($1, $2)", [w.owner.id, w.member.id]);
    await judgedUpTo(w.g, await say(w.third, w.g, "早"));
    await say(w.member, w.g, "owner 昨晚加班");
    const last = await say(w.third, w.g, "owner 周末要搬家");
    judge.answer(answering({ h1: 0.8 }));
    await decide(w.g, last);
    expect(await flagsOf(w.g)).toEqual([{ agent_id: bot.id, seq: last, kind: "hearsay" }]);
  });

  it("at most 20 owners listen, the least recently judged first", async () => {
    const w = await world();
    const owners: Actor[] = [];
    const agents: string[] = [];
    for (let i = 0; i < 21; i++) {
      const o = await signUp(app, `lo${i}`);
      await join(w.g, o.id);
      owners.push(o);
      agents.push((await agentOf(o, `lbot${i}`, w.g)).id);
    }
    // Owner 0 was judged most recently, owner 19 longest ago, owner 20 never.
    for (let i = 0; i < 20; i++) {
      await db.query("insert into agent_group_state (agent_id, conversation_id, judged_at) values ($1, $2, now() - make_interval(mins => $3))", [agents[i], w.g, i + 1]);
    }
    const said = await say(w.member, w.g, "hello");
    const listeners = await listenersFor(db, w.g, said);
    expect(listeners).toHaveLength(20);
    expect(listeners.map((l) => l.ownerId).sort()).toEqual(owners.slice(1).map((o) => o.id).sort());
    expect(listeners.map((l) => l.key)).toEqual(Array.from({ length: 20 }, (_, i) => `h${i + 1}`));
    expect(listeners.map((l) => l.ownerId)).toEqual([...listeners.map((l) => l.ownerId)].sort());
  }, 120_000);

  it("judging the same messages again writes no duplicate flags and returns none", async () => {
    const w = await world();
    const bot = await agentOf(w.owner, "memo", w.g);
    const said = await say(w.member, w.g, "owner 报名了马拉松");
    judge.answer(answering({ h1: 0.9 }));
    const first = await decide(w.g, said);
    expect(first.flags).toHaveLength(1);
    await db.query("update agent_group_state set judged_seq = null where agent_id = $1", [bot.id]);
    const again = await decide(w.g, said);
    expect(judge.calls).toHaveLength(2);
    expect(again.flags).toBeUndefined();
    expect(await flagsOf(w.g)).toEqual([{ agent_id: bot.id, seq: said, kind: "hearsay" }]);
  });

  it("with no reviewer the owner's own question is not asked, while the hearsay one still is", async () => {
    const w = await world();
    await agentOf(w.owner, "memo", w.g, { sharedNotes: false });
    await judgedUpTo(w.g, await say(w.third, w.g, "早"));
    await say(w.owner, w.g, "我今晚加班");
    const last = await say(w.member, w.g, "owner 好辛苦");
    await decide(w.g, last);
    expect(keys(judge.calls[0]!.questions)).toEqual(["h1"]);
  });

  it("a judgement that fails leaves judged_seq unstamped (and judged_at stamped) and flags nothing", async () => {
    const w = await world();
    const bot = await agentOf(w.owner, "memo", w.g);
    judge.answer(() => new Error("upstream down"));
    await decide(w.g, await say(w.member, w.g, "owner 喜欢爬山"));
    const state = await db.query("select judged_seq, judged_at from agent_group_state where agent_id = $1", [bot.id]);
    expect(state.rows).toEqual([{ judged_seq: null, judged_at: expect.any(Date) }]);
    expect(await flagsOf(w.g)).toEqual([]);
  });
});
