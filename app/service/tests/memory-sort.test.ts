import type { FastifyBaseLogger } from "fastify";
import { beforeEach, describe, expect, it } from "vitest";
import { siteDay } from "../src/accounts/store.ts";
import type { Config } from "../src/config.ts";
import type { Db } from "../src/db.ts";
import { JudgeError } from "../src/judge/client.ts";
import { duplicateOf, sortNote, type SortDeps } from "../src/memory/sort.ts";
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
  "下面是一个 AI 助手已经记下的几条笔记和一条新的笔记（都可能用任何语言写）。新的这条和哪一条说的是同一件事（换了说法、换了语言、更简略或更啰嗦都算），记下它不会让助手多知道任何东西？如果它和已有的矛盾、是对它的更新、或者多了已有的没有的信息，选“都不是”。";

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

  it("0.8 opens; 0.79 stays in the vault and is unsure; 0.2 is unsure; 0.1 is not", async () => {
    const at = async (p: number) => {
      judge.answer(() => ({ sort: p }));
      return sortNote(deps(), "x", "owner", "auto");
    };
    expect(await at(0.8)).toEqual({ vault: false, unsure: false });
    expect(await at(0.79)).toEqual({ vault: true, unsure: true });
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
    judge.answer(() => ({ sort: 0.99, dup: { n1: 0.99, "都不是": 0 } }));
    expect(await sortNote(deps({ db: failing(/^\s*select calls from judge_usage/) }), "x", "owner", "auto")).toEqual({ vault: true, unsure: false });
    expect(await duplicateOf(deps({ db: failing(/^\s*select calls from judge_usage/) }), "新", notes)).toBeNull();
    expect(judge.calls).toHaveLength(0);
  });

  it("a failing count does not change the judge's answer", async () => {
    judge.answer(() => ({ sort: 0.9, dup: { n1: 0.9, "都不是": 0 } }));
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

describe("duplicateOf", () => {
  const notes = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `n${i}`, text: `note ${i}` }));
  const scoring = (id: string, p: number) => (_s: string, qs: readonly { type: string }[]) => ({
    dup: Object.fromEntries(optionKeys(qs[0]).map((k) => [k, k === id ? p : 0])),
  });

  it("picks the note at 0.7, not at 0.5, and shapes the request", async () => {
    judge.answer(scoring("n1", 0.7));
    expect(await duplicateOf(deps(), "新", notes(3))).toBe("n1");
    const q = judge.calls[0]!.questions[0]!;
    expect(judge.calls[0]!.state).toBe("新的笔记：新");
    expect(q).toMatchObject({ key: "dup", type: "choice", instructions: DUP_TEXT });
    expect(Object.values((q as { options: Record<string, string> }).options)).toEqual(expect.arrayContaining(["note 0", "note 1", "note 2", "都不是"]));
    expect(optionKeys(q)).toHaveLength(4);
    expect(await used()).toBe(1);
    judge.answer(scoring("n1", 0.5));
    expect(await duplicateOf(deps(), "新", notes(3))).toBeNull();
  });

  it("asks 45 notes in three requests of 20, 20 and 5 (plus none-of-them)", async () => {
    judge.answer(scoring("none", 0));
    expect(await duplicateOf(deps(), "新", notes(45))).toBeNull();
    expect(judge.calls.map((c) => optionKeys(c.questions[0]).length)).toEqual([21, 21, 6]);
    expect(await used()).toBe(3);
  });

  it("a match in a later chunk is found", async () => {
    judge.answer(scoring("n41", 0.9));
    expect(await duplicateOf(deps(), "新", notes(45))).toBe("n41");
  });

  it("null on an error, no judge, no notes, or at the limit", async () => {
    judge.answer(() => new JudgeError("status"));
    expect(await duplicateOf(deps(), "新", notes(3))).toBeNull();
    expect(await duplicateOf(deps({ judge: null }), "新", notes(3))).toBeNull();
    const before = judge.calls.length;
    expect(await duplicateOf(deps(), "新", [])).toBeNull();
    await db.query("insert into judge_usage (day, calls) values ($1::date, 5) on conflict (day) do update set calls = 5", [today()]);
    expect(await duplicateOf(deps({}, { judge: { ...JUDGE, dailyLimit: 5 } }), "新", notes(3))).toBeNull();
    expect(judge.calls).toHaveLength(before);
  });
});
