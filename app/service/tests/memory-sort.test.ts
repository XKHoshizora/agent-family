import type { FastifyBaseLogger } from "fastify";
import { beforeEach, describe, expect, it } from "vitest";
import { siteDay } from "../src/accounts/store.ts";
import type { Config } from "../src/config.ts";
import type { Db } from "../src/db.ts";
import { JudgeError } from "../src/judge/client.ts";
import { addsNothing, duplicateOf, resortNote, sortNote, type SortDeps } from "../src/memory/sort.ts";
import { SITE_ENV } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { scriptedJudge } from "./helpers/judge.ts";

const JUDGE = {
  model: "jev-1",
  channels: [{ url: "https://judge-a.example.test/v1/systemone", apiKeyEnv: "UPSTREAM_TEST_KEY" }],
  timeoutMs: 500,
  dailyLimit: 20_000,
};
const judge = scriptedJudge();
const { app, db } = useApp({ env: SITE_ENV, judge, agentWorker: false, config: { judge: JUDGE } });

const OWNER_TEXT =
  "这是一个人的 AI 助手记下的一条关于主人的笔记，可能用任何语言写。这条内容属于日常偏好或习惯（比如饮食口味、作息、称呼、喜欢的风格、常用的工具），即使被主人的朋友、同事、群友知道也完全无妨。凡是涉及健康、钱、工作变动、感情和家庭矛盾、对别人的评价、行踪住址、账号密码、尚未公开的计划，或者拿不准的，都不算。";
const SELF_TEXT =
  "这是一个 AI 助手给自己记的一条笔记，可能用任何语言写。这条内容只是它做事的方式或习惯（比如回答的长短、先说什么、用什么格式、推荐时注意什么），不透露主人的任何私事，即使被主人的朋友、同事、群友看到也完全无妨。凡是提到主人的健康、钱、工作变动、感情和家庭、对别人的评价、行踪住址、账号密码、未公开的计划，或者拿不准的，都不算。";
const DUP_TEXT =
  "这是一个 AI 助手关于主人的两条笔记：一条已有的，一条新的。两条可能用不同的语言写。新的这条和已有的那条说的是同一件事（换了说法、换了语言、更简略或更啰嗦都算），记下新的不会让助手多知道任何东西。如果新的这条和已有的矛盾、是对它的更新、或者多了已有那条没有的信息，都不算。";
const FAITH_TEXT =
  "下面是原来的一条或几条笔记，和由它们改写、合并或拆分成的一条或几条新笔记。新的这些说的全都是原来的笔记里已经有的事，没有多出任何原来没有的内容、推测或细节；原来的笔记里的事也都还在（只是删掉了括号里“以前……”那样的旧经过不算漏）。都可能是任何语言。";

const log = { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} } as unknown as FastifyBaseLogger;
const deps = (over: Partial<SortDeps> = {}, config: Partial<Config> = {}): SortDeps => ({
  db,
  judge,
  config: { ...app.deps.config, ...config },
  log,
  ...over,
});
const used = async () => (await db.query<{ calls: number }>("select coalesce(sum(calls), 0)::int as calls from judge_usage")).rows[0]!.calls;
const optionKeys = (q: unknown): string[] => Object.keys((q as { options: object }).options);
const today = () => siteDay(new Date(), app.deps.config.siteTimezone);

beforeEach(async () => {
  judge.calls.splice(0);
  judge.answer(() => ({}));
  await db.query("delete from judge_usage");
});

describe("sortNote", () => {
  it("opens at the share threshold, counts the call, and asks one noul question with the owner text", async () => {
    judge.answer(() => ({ sort: 0.9 }));
    expect(await sortNote(deps(), "喜欢喝美式", "owner", "auto")).toEqual({ vault: false, unsure: false });
    expect(judge.calls).toHaveLength(1);
    expect(judge.calls[0]!.state).toBe("笔记：喜欢喝美式");
    expect(judge.calls[0]!.questions).toEqual([{ key: "sort", type: "noul", instructions: OWNER_TEXT }]);
    expect(await used()).toBe(1);
  });

  it("uses the self text for the Agent's own notes", async () => {
    judge.answer(() => ({ sort: 0.95 }));
    await sortNote(deps(), "answer briefly", "self", "auto");
    expect(judge.calls[0]!.questions[0]).toMatchObject({ type: "noul", instructions: SELF_TEXT });
  });

  it("0.6 opens; 0.59 stays in the vault and is unsure; 0.2 is unsure; 0.1 is not", async () => {
    const at = async (p: number) => {
      judge.answer(() => ({ sort: p }));
      return sortNote(deps(), "x", "owner", "auto");
    };
    expect(await at(0.6)).toEqual({ vault: false, unsure: false });
    expect(await at(0.59)).toEqual({ vault: true, unsure: true });
    expect(await at(0.2)).toEqual({ vault: true, unsure: true });
    expect(await at(0.1)).toEqual({ vault: true, unsure: false });
  });

  it("settings vault and open answer without a call", async () => {
    expect(await sortNote(deps(), "x", "owner", "vault")).toEqual({ vault: true, unsure: false });
    expect(await sortNote(deps(), "x", "owner", "open")).toEqual({ vault: false, unsure: false });
    expect(judge.calls).toHaveLength(0);
    expect(await used()).toBe(0);
  });

  it("an error, a missing answer, a hang, no judge, no judge config, the daily limit: into the vault", async () => {
    const vault = { vault: true, unsure: false };
    judge.answer(() => new JudgeError("auth"));
    expect(await sortNote(deps(), "x", "owner", "auto")).toEqual(vault);
    judge.answer(() => ({}));
    expect(await sortNote(deps(), "x", "owner", "auto")).toEqual(vault);
    judge.answer(() => "hang");
    expect(await sortNote(deps(), "x", "owner", "auto")).toEqual(vault);
    judge.answer(() => ({ sort: 0.99 }));
    expect(await sortNote(deps({ judge: null }), "x", "owner", "auto")).toEqual(vault);
    expect(await sortNote(deps({}, { judge: null }), "x", "owner", "auto")).toEqual(vault);
    const before = judge.calls.length;
    await db.query("insert into judge_usage (day, calls) values ($1::date, 5) on conflict (day) do update set calls = 5", [today()]);
    expect(await sortNote(deps({}, { judge: { ...JUDGE, dailyLimit: 5 } }), "x", "owner", "auto")).toEqual(vault);
    expect(judge.calls).toHaveLength(before);
  });
});

describe("failures of the database around the call", () => {
  /** A db whose statements matching `when` reject. */
  const failing = (when: RegExp): Db =>
    new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== "query") return Reflect.get(target, prop, receiver);
        return (sql: string, ...rest: unknown[]) =>
          when.test(sql) ? Promise.reject(new Error("db hiccup")) : (target.query as (...a: unknown[]) => unknown)(sql, ...rest);
      },
    });
  const notes = [{ id: "n1", text: "note 1" }];

  it("a failing limit check: vault / null, nothing thrown, no call made", async () => {
    judge.answer(() => ({ sort: 0.99, d0: 0.99 }));
    expect(await sortNote(deps({ db: failing(/^\s*select calls from judge_usage/) }), "x", "owner", "auto")).toEqual({ vault: true, unsure: false });
    expect(await duplicateOf(deps({ db: failing(/^\s*select calls from judge_usage/) }), "新", notes)).toBeNull();
    expect(judge.calls).toHaveLength(0);
  });

  it("a failing count does not change the judge's answer", async () => {
    judge.answer(() => ({ sort: 0.9, d0: 0.9 }));
    expect(await sortNote(deps({ db: failing(/insert into judge_usage/) }), "x", "owner", "auto")).toEqual({ vault: false, unsure: false });
    expect(await duplicateOf(deps({ db: failing(/insert into judge_usage/) }), "新", notes)).toBe("n1");
  });

  it("a failed or hung judge call is still counted", async () => {
    judge.answer(() => new JudgeError("auth"));
    await sortNote(deps(), "x", "owner", "auto");
    expect(await used()).toBe(1);
    judge.answer(() => "hang");
    await sortNote(deps(), "x", "owner", "auto");
    expect(await used()).toBe(2);
  });
});

describe("resortNote", () => {
  it("is the sort judgement of an existing note: always asked, and no answer is null (sortNote would say the vault)", async () => {
    judge.answer(() => ({ sort: 0.9 }));
    expect(await resortNote(deps(), "喜欢喝美式", "owner")).toEqual({ vault: false, unsure: false });
    judge.answer(() => ({ sort: 0.1 }));
    expect(await resortNote(deps(), "x", "owner")).toEqual({ vault: true, unsure: false });
    judge.answer(() => ({}));
    expect(await resortNote(deps(), "x", "owner")).toBeNull();
    judge.answer(() => new JudgeError("auth"));
    expect(await resortNote(deps(), "x", "owner")).toBeNull();
    expect(await resortNote(deps({ judge: null }), "x", "owner")).toBeNull();
  });
});

describe("duplicateOf", () => {
  const notes = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `n${i}`, text: `note ${i}` }));
  /** Every question of the request answered 0 but the one of the note with `id` (ids are `n{i}`; question keys are `d{index in the chunk}`). */
  const scoring = (scores: Record<string, number>) => (_s: string, qs: readonly { key: string; instructions: string }[]) =>
    Object.fromEntries(qs.map((q) => [q.key, scores[/已有的笔记：(.*)$/.exec(q.instructions)![1]!.replace("note ", "n")] ?? 0]));

  it("asks one yes/no question per existing note in one request, each with the pair; picks the note at 0.5, not below, and counts one call", async () => {
    judge.answer(scoring({ n1: 0.5 }));
    expect(await duplicateOf(deps(), "新", notes(3))).toBe("n1");
    expect(judge.calls).toHaveLength(1);
    expect(judge.calls[0]!.state).toBe("新的笔记：新");
    expect(judge.calls[0]!.questions).toEqual([
      { key: "d0", type: "noul", instructions: `${DUP_TEXT}\n已有的笔记：note 0` },
      { key: "d1", type: "noul", instructions: `${DUP_TEXT}\n已有的笔记：note 1` },
      { key: "d2", type: "noul", instructions: `${DUP_TEXT}\n已有的笔记：note 2` },
    ]);
    expect(await used()).toBe(1);
    judge.answer(scoring({ n1: 0.49 }));
    expect(await duplicateOf(deps(), "新", notes(3))).toBeNull();
  });

  it("asks 45 notes in three requests of 20, 20 and 5, keys d0…d19", async () => {
    judge.answer(scoring({}));
    expect(await duplicateOf(deps(), "新", notes(45))).toBeNull();
    expect(judge.calls.map((c) => c.questions.length)).toEqual([20, 20, 5]);
    expect(judge.calls[1]!.questions[19]!.key).toBe("d19");
    expect(await used()).toBe(3);
  });

  it("the note with the highest score across all chunks wins, not the first at or above the threshold", async () => {
    judge.answer(scoring({ n3: 0.6, n41: 0.9 }));
    expect(await duplicateOf(deps(), "新", notes(45))).toBe("n41");
    expect(judge.calls).toHaveLength(3);
  });

  it("null on an error (in any chunk), no judge, no notes, or at the limit", async () => {
    judge.answer(() => new JudgeError("status"));
    expect(await duplicateOf(deps(), "新", notes(3))).toBeNull();
    let n = 0;
    judge.answer((s, qs) => (++n === 2 ? new JudgeError("status") : scoring({ n1: 0.9 })(s, qs as never)));
    expect(await duplicateOf(deps(), "新", notes(45))).toBeNull();
    expect(await duplicateOf(deps({ judge: null }), "新", notes(3))).toBeNull();
    const before = judge.calls.length;
    expect(await duplicateOf(deps(), "新", [])).toBeNull();
    await db.query("insert into judge_usage (day, calls) values ($1::date, 5) on conflict (day) do update set calls = 5", [today()]);
    expect(await duplicateOf(deps({}, { judge: { ...JUDGE, dailyLimit: 5 } }), "新", notes(3))).toBeNull();
    expect(judge.calls).toHaveLength(before);
  });
});

describe("addsNothing", () => {
  it("is one question, whatever the change: the notes it was made from and what it made, at the threshold", async () => {
    judge.answer(() => ({ faithful: 0.6 }));
    expect(await addsNothing(deps(), { kind: "merge", sources: ["喜欢茶", "爱喝茶"], result: "爱喝茶" })).toBe(true);
    expect(judge.calls[0]!.questions).toEqual([{ key: "faithful", type: "noul", instructions: FAITH_TEXT }]);
    expect(JSON.parse(judge.calls[0]!.state)).toEqual({ sources: ["喜欢茶", "爱喝茶"], results: ["爱喝茶"] });
    expect(await addsNothing(deps(), { kind: "rewrite", sources: ["周三去了医院"], result: "2026 年 11 月 18 日：去了医院" })).toBe(true);
    expect(JSON.parse(judge.calls[1]!.state)).toEqual({ sources: ["周三去了医院"], results: ["2026 年 11 月 18 日：去了医院"] });
    expect(await addsNothing(deps(), { kind: "split", source: "喜欢茶，对花生过敏", parts: ["喜欢茶", "对花生过敏"] })).toBe(true);
    expect(JSON.parse(judge.calls[2]!.state)).toEqual({ sources: ["喜欢茶，对花生过敏"], results: ["喜欢茶", "对花生过敏"] });
    expect(judge.calls[2]!.questions[0]).toMatchObject({ key: "faithful" });
    expect(await used()).toBe(3);
    judge.answer(() => ({ faithful: 0.59 }));
    expect(await addsNothing(deps(), { kind: "merge", sources: ["a", "b"], result: "a" })).toBe(false);
  });

  it("false on an error, nothing usable, no judge or the limit", async () => {
    const change = { kind: "rewrite" as const, sources: ["a"], result: "b" };
    judge.answer(() => new JudgeError("auth"));
    expect(await addsNothing(deps(), change)).toBe(false);
    judge.answer(() => ({}));
    expect(await addsNothing(deps(), change)).toBe(false);
    expect(await addsNothing(deps({ judge: null }), change)).toBe(false);
  });
});
