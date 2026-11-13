import {
  appendDiscussionInput,
  pendingInputs,
} from "../server/discussion-inputs";
import { beforeAll, beforeEach, afterAll, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
const state = vi.hoisted(() => {
  process.env.DATA_DIR = `${process.env.TEMP || "/tmp"}/agent-family-free-${process.pid}-${Date.now()}`;
  process.env.CANAL_KEY_FILE = `${process.env.DATA_DIR}/none`;
  process.env.CANAL_API_KEY = "";
  return { calls: [] as any[], script: [] as any[], delay: 0 };
});
vi.mock("../server/providers", async () => {
  const { MockLanguageModelV4 } = await import("ai/test");
  return {
    modelFor: (_w: string, agent: any) =>
      new MockLanguageModelV4({
        doStream: async (options: any) => {
          const step = state.script.shift() || {};
          state.calls.push({ agent: agent.id, ...options });
          if (state.delay) await new Promise((r) => setTimeout(r, state.delay));
          if (step.fail) throw new Error("provider failed");
          const text =
            step.text ?? `观点 ${state.calls.length} 来自 ${agent.name}`;
          const parts: any[] = [
            { type: "stream-start", warnings: [] },
            ...(step.reasoning
              ? [
                  { type: "reasoning-start", id: "r" },
                  { type: "reasoning-delta", id: "r", delta: step.reasoning },
                  { type: "reasoning-end", id: "r" },
                ]
              : []),
            { type: "text-start", id: "t" },
            { type: "text-delta", id: "t", delta: text },
            { type: "text-end", id: "t" },
            ...(step.decision
              ? [
                  {
                    type: "tool-call",
                    toolCallId: `c-${state.calls.length}`,
                    toolName: "discussion_turn",
                    input: JSON.stringify(step.decision),
                  },
                ]
              : []),
            {
              type: "finish",
              finishReason: {
                unified: step.finish || (step.decision ? "tool-calls" : "stop"),
                raw: "stop",
              },
              usage: {
                inputTokens: {
                  total: 10,
                  noCache: 10,
                  cacheRead: 0,
                  cacheWrite: 0,
                },
                outputTokens: { total: 10, text: 10, reasoning: 0 },
              },
            },
          ];
          return {
            stream: new ReadableStream({
              start(c) {
                parts.forEach((p) => c.enqueue(p));
                c.close();
              },
            }),
          };
        },
      }),
  };
});
import { db, createRoom, getMessages, getRuns } from "../server/db";
import {
  startRun,
  waitForRun,
  cancelRun,
  usage,
  recoverInterrupted,
} from "../server/orchestrator";
import { updateDiscussion, discussionSettings } from "../server/discussion";
import { config, id, now } from "../server/config";
import {
  DEFAULT_DISCUSSION,
  type Agent,
  type DiscussionSettings,
} from "../shared/types";
import { buildFreeHistory, CONTEXT_LIMIT } from "../server/context";
import { lineMessages } from "../server/line-output";
import { reserveRunBudget, releaseRunBudget } from "../server/budget";
const w = "free-test",
  u = "user";
const makeRoom = (count = 3, tools = false) =>
  createRoom(
    w,
    u,
    "自由测试",
    Array.from(
      { length: count },
      (_, i) =>
        ({
          id: `a${i}`,
          name: `伙伴${i}`,
          model: "mock",
          provider: "mock",
          persona: "test",
          enabled: true,
          tools,
          color: "sage",
        }) satisfies Agent,
    ),
  );
const start = (
  room: ReturnType<typeof makeRoom>,
  settings: Partial<DiscussionSettings> = {},
  content = "原始问题：如何提高质量？",
) =>
  startRun({
    room,
    actor: u,
    author: "用户",
    content,
    mode: "free",
    discussion: { ...DEFAULT_DISCUSSION, ...settings },
  });
const finished = async (
  r: ReturnType<typeof makeRoom>,
  settings: Partial<DiscussionSettings> = {},
) => {
  const rid = start(r, settings);
  await waitForRun(rid);
  return getRuns(r.id)[0];
};
const until = async (test: () => boolean) => {
  for (let i = 0; i < 100; i++) {
    if (test()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("wait timed out");
};
beforeAll(() => {
  db.prepare("INSERT INTO workspaces VALUES(?,?,?)").run(w, "test", now());
  db.prepare("INSERT INTO memberships VALUES(?,?,?)").run(w, u, "owner");
});
beforeEach(() => {
  state.calls = [];
  state.script = [];
  state.delay = 0;
  config.dailyCalls = 200;
  config.dailyLineCalls = 40;
  db.prepare("DELETE FROM usage_daily").run();
  db.prepare("UPDATE memberships SET role='owner' WHERE user_id=?").run(u);
});
afterAll(() => {
  db.close();
  const dir = path.resolve(process.env.DATA_DIR!);
  if (path.dirname(dir) !== path.resolve(os.tmpdir()))
    throw new Error("unsafe cleanup");
  fs.rmSync(dir, { recursive: true, force: true });
});

it("a named first speaker can hand off to another model, whose input includes the question and latest reply", async () => {
  const r = makeRoom();
  state.script = [
    {
      text: "我建议先审查。",
      decision: {
        action: "handoff",
        nextAgentId: "a2",
        question: "你能指出风险吗？",
      },
    },
    {
      text: "风险在权限。",
      decision: {
        action: "handoff",
        nextAgentId: "a1",
        question: "如何验证？",
      },
    },
  ];
  const rid = start(r, { maxCalls: 3 }, "@伙伴0 原始问题：如何提高质量？");
  await waitForRun(rid);
  expect(state.calls.map((c) => c.agent)).toEqual(["a0", "a2", "a1"]);
  expect(JSON.stringify(state.calls[1].prompt)).toContain("你能指出风险吗");
  expect(JSON.stringify(state.calls[2].prompt)).toContain("原始问题");
  const messages = getMessages(r.id).filter((m) => m.role === "assistant");
  expect(messages[1].discussion?.replyTo).toBe(messages[0].id);
  expect(messages[0].discussion?.nextAgentId).toBe("a2");
  expect(messages[0].content).toContain("@伙伴2");
  expect(state.calls[0].tools.map((t: any) => t.name)).toEqual([
    "discussion_turn",
  ]);
  expect(getRuns(r.id)[0].callsUsed).toBe(3);
  expect(usage(w).reserved).toBe(0);
});
it("five members get turns even when two repeatedly invite each other", async () => {
  const r = makeRoom(5);
  state.script = Array.from({ length: 10 }, (_, i) => ({
    decision: { action: "handoff", nextAgentId: i % 2 ? "a0" : "a1" },
  }));
  const run = await finished(r, { maxRounds: null, maxCalls: 10 });
  expect(new Set(state.calls.map((c) => c.agent)).size).toBe(5);
  expect(run.turns).toBe(10);
});
it("unlimited rounds remain bounded by the per-run call cap", async () => {
  const r = makeRoom(2);
  const run = await finished(r, { maxRounds: null, maxCalls: 7 });
  expect(run.turns).toBe(7);
  expect(run.notice).toContain("调用上限");
  expect(getMessages(r.id).at(-1)?.round).toBe(4);
  expect(usage(w).calls).toBe(7);
});
it("one round means one participant-count of sequential utterances", async () => {
  const run = await finished(makeRoom(5), { maxRounds: 1 });
  expect(run.turns).toBe(5);
  expect(run.notice).toContain("轮数");
});
it("one member cannot stop the group; all members passing ends the discussion", async () => {
  state.script = Array.from({ length: 3 }, () => ({
    text: "",
    decision: { action: "pass" },
  }));
  const run = await finished(makeRoom(), { maxRounds: null });
  expect(run.turns).toBe(3);
  expect(run.notice).toContain("所有伙伴");
});
it("quiet stopping can be disabled, but exact repetition still stops", async () => {
  state.script = Array.from({ length: 10 }, () => ({
    text: "同一个观点",
    decision: { action: "pass" },
  }));
  const run = await finished(makeRoom(), {
    maxRounds: null,
    stopWhenQuiet: false,
  });
  expect(run.turns).toBe(4);
  expect(run.notice).toContain("重复");
});
it("three consecutive failed responses stop without an endless retry", async () => {
  state.script = Array.from({ length: 4 }, () => ({ fail: true }));
  const run = await finished(makeRoom(), { maxRounds: null });
  expect(run.status).toBe("failed");
  expect(run.turns).toBe(3);
  expect(run.notice).toContain("失败");
  expect(usage(w).reserved).toBe(0);
});
it("rounds can be extended during a running utterance then the call cap lowered", async () => {
  const r = makeRoom(2);
  state.delay = 35;
  const rid = start(r, { maxRounds: 1, maxCalls: 20 });
  await until(() => state.calls.length === 1);
  updateDiscussion(rid, r.id, {
    ...DEFAULT_DISCUSSION,
    maxRounds: null,
    maxCalls: 20,
  });
  await until(() => state.calls.length === 3);
  updateDiscussion(rid, r.id, {
    ...DEFAULT_DISCUSSION,
    maxRounds: null,
    maxCalls: 3,
  });
  await waitForRun(rid);
  expect(state.calls).toHaveLength(3);
  expect(getRuns(r.id)[0].notice).toContain("调用上限");
});
it("reducing rounds ends after the in-flight answer without deleting it", async () => {
  const r = makeRoom(2);
  state.delay = 30;
  const rid = start(r, { maxRounds: null, maxCalls: 20 });
  await until(() => state.calls.length === 3);
  updateDiscussion(rid, r.id, { ...DEFAULT_DISCUSSION, maxRounds: 1 });
  await waitForRun(rid);
  expect(state.calls).toHaveLength(3);
  expect(getMessages(r.id).at(-1)?.status).toBe("complete");
});
it("manual stop cancels the current answer and releases future reservations", async () => {
  const r = makeRoom(2, true);
  state.delay = 30;
  const rid = start(r, { maxRounds: null });
  await until(() => state.calls.length === 1);
  cancelRun(rid, r.id);
  await waitForRun(rid);
  expect(state.calls).toHaveLength(1);
  expect(getRuns(r.id)[0].status).toBe("cancelled");
  expect(usage(w).reserved).toBe(0);
});
it("revoked membership stops subsequent speakers", async () => {
  const r = makeRoom();
  state.delay = 30;
  const rid = start(r, { maxRounds: null });
  await until(() => state.calls.length === 1);
  db.prepare("UPDATE memberships SET role='viewer' WHERE user_id=?").run(u);
  await waitForRun(rid);
  expect(state.calls).toHaveLength(1);
  expect(getRuns(r.id)[0].notice).toContain("权限");
});
it("reservation competition never overspends the workspace daily cap", async () => {
  config.dailyCalls = 4;
  const r = makeRoom(2);
  state.delay = 25;
  const rid = start(r, { maxRounds: null, maxCalls: 10 });
  await until(() => state.calls.length === 1);
  const other = id();
  db.prepare(
    "INSERT INTO runs(id,room_id,status,mode,created_at) VALUES(?,?,'queued','parallel',?)",
  ).run(other, r.id, now());
  reserveRunBudget(other, w, 3, "web");
  await waitForRun(rid);
  expect(state.calls).toHaveLength(1);
  expect(usage(w).calls + usage(w).reserved).toBe(4);
  expect(getRuns(r.id).find((r) => r.id === rid)?.notice).toContain("额度不足");
  releaseRunBudget(other);
});
it("invalid control targets cannot schedule an outsider and data tools stay disabled", async () => {
  state.script = [
    {
      decision: {
        action: "handoff",
        nextAgentId: "outsider",
        question: "偷读资料",
      },
    },
  ];
  const run = await finished(makeRoom(2), { maxCalls: 2 });
  expect(state.calls.map((c) => c.agent)).toEqual(["a0", "a1"]);
  expect(run.callsUsed).toBe(2);
});
it("long free-discussion context keeps the root question and every member's latest contribution", async () => {
  state.script = Array.from({ length: 5 }, (_, i) => ({
    text: `意见${i}-` + "长内容".repeat(4000),
  }));
  const r = makeRoom(5);
  const run = await finished(r, { maxRounds: 1 });
  const history = buildFreeHistory(r.id, run.id, "a0");
  const all = JSON.stringify(history);
  expect(all).toContain("原始问题");
  for (let i = 0; i < 5; i++) expect(all).toContain(`意见${i}-`);
  expect(
    history.reduce((n, m) => n + String(m.content).length, 0),
  ).toBeLessThanOrEqual(CONTEXT_LIMIT);
  expect(all).toContain("已截断");
});
it("LINE renders a bounded recent conversation and explicit stop reason", async () => {
  const r = makeRoom(3);
  const run = await finished(r, { maxCalls: 7 });
  const output = lineMessages(getMessages(r.id), run);
  expect(output).toHaveLength(5);
  expect(output[0].text).toContain("调用上限");
  expect(output[1].text).toContain("第 4 次发言");
  expect(output[4].text).toContain("第 7 次发言");
});
it("restart recovery releases unused free-discussion reservations and marks interruption", () => {
  const r = makeRoom(2),
    rid = id();
  db.prepare(
    "INSERT INTO runs(id,room_id,status,mode,created_at,discussion) VALUES(?,?,'running','free',?,?)",
  ).run(rid, r.id, now(), JSON.stringify(DEFAULT_DISCUSSION));
  reserveRunBudget(rid, w, 3, "web");
  recoverInterrupted();
  expect(usage(w).reserved).toBe(0);
  expect(getRuns(r.id)[0].status).toBe("interrupted");
});
it("settings reject invalid budgets and allow explicitly unlimited rounds", () => {
  expect(
    discussionSettings({ ...DEFAULT_DISCUSSION, maxRounds: null }).maxRounds,
  ).toBeNull();
  for (const maxCalls of [0, -1, 1.5, Infinity, 100001])
    expect(() =>
      discussionSettings({ ...DEFAULT_DISCUSSION, maxCalls }),
    ).toThrow();
  expect(() =>
    discussionSettings({ ...DEFAULT_DISCUSSION, maxRounds: 0 }),
  ).toThrow();
  expect(() => start(makeRoom(1))).toThrow(/至少两位/);
});

it("handoff does not duplicate a question already present in the model answer", async () => {
  state.script = [
    {
      text: "@伙伴1 请说明风险？",
      decision: {
        action: "handoff",
        nextAgentId: "a1",
        question: "请说明风险？",
      },
    },
  ];
  const r = makeRoom(2);
  await finished(r, { maxCalls: 2 });
  expect(getMessages(r.id)[1].content.match(/请说明风险？/g)).toHaveLength(1);
});
it("all five quiet members get a chance before quiet stopping", async () => {
  state.script = Array.from({ length: 5 }, () => ({
    text: "",
    decision: { action: "pass" },
  }));
  const run = await finished(makeRoom(5), { maxRounds: null });
  expect(run.turns).toBe(5);
  expect(run.notice).toContain("所有伙伴");
});

const interject = (
  r: ReturnType<typeof makeRoom>,
  rid: string,
  content: string,
  clientId = id(),
) =>
  appendDiscussionInput({
    room: r,
    runId: rid,
    actor: u,
    author: "用户",
    content,
    clientId,
  });
it("a user interjection cancels only the old utterance and prioritizes the named participant in the same run", async () => {
  const r = makeRoom();
  state.delay = 30;
  const rid = start(r, { maxCalls: 4, maxRounds: null });
  await until(() => state.calls.length === 1);
  const input = interject(r, rid, "@伙伴2 补充要求：预算只能100元。");
  await waitForRun(rid);
  expect(getRuns(r.id)).toHaveLength(1);
  expect(state.calls[1].agent).toBe("a2");
  expect(JSON.stringify(state.calls[1].prompt)).toContain("预算只能100元");
  expect(
    getMessages(r.id).find((m) => m.id === input.messageId)?.interjection
      ?.answeredBy,
  ).toBeTruthy();
  expect(getMessages(r.id).find((m) => m.role === "assistant")?.status).toBe(
    "cancelled",
  );
  expect(
    getMessages(r.id).find((m) => m.role === "assistant")?.content,
  ).toContain("收到用户补充");
  expect(getRuns(r.id)[0].status).toBe("completed");
  expect(usage(w).reserved).toBe(0);
});
it("rapid interjections preserve all requirements, handle all named targets and deduplicate retries", async () => {
  const r = makeRoom();
  state.delay = 25;
  const rid = start(r, { maxCalls: 5, maxRounds: null });
  await until(() => state.calls.length === 1);
  const key = id();
  const first = interject(r, rid, "@伙伴1 要求一：保持简单。", key);
  const same = interject(r, rid, "@伙伴1 要求一：保持简单。", key);
  expect(same.messageId).toBe(first.messageId);
  expect(same.duplicate).toBe(true);
  interject(r, rid, "@伙伴2 要求二：不要使用网络。");
  interject(r, rid, "要求三：总字数要少。");
  await waitForRun(rid);
  expect(state.calls[1].agent).toBe("a2");
  expect(state.calls[2].agent).toBe("a1");
  for (const text of ["要求一", "要求二", "要求三"])
    expect(JSON.stringify(state.calls[1].prompt)).toContain(text);
  expect(getMessages(r.id).filter((m) => m.interjection)).toHaveLength(3);
  expect(
    getMessages(r.id)
      .filter((m) => m.interjection)
      .every((m) => m.interjection?.answeredBy),
  ).toBe(true);
  expect(JSON.stringify(state.calls.at(-1).prompt)).toContain("不要使用网络");
  expect(getRuns(r.id)[0].pendingInputs).toBe(0);
});
it("one interjection can ask two participants, and remains pending until both respond", async () => {
  const r = makeRoom();
  state.delay = 25;
  const rid = start(r, { maxCalls: 4, maxRounds: null });
  await until(() => state.calls.length === 1);
  const input = interject(r, rid, "@伙伴1 @伙伴2 请各自给一个建议");
  await until(() => state.calls.length === 3);
  expect(pendingInputs(rid)[0]?.handled).toEqual(["a1"]);
  await waitForRun(rid);
  expect(
    getMessages(r.id).find((m) => m.id === input.messageId)?.interjection
      ?.handled,
  ).toEqual(["a1", "a2"]);
});
it("exhausted limits keep an interjection explicitly pending without restarting or refunding spent calls", async () => {
  const r = makeRoom(2);
  state.delay = 30;
  const rid = start(r, { maxCalls: 1, maxRounds: null });
  await until(() => state.calls.length === 1);
  interject(r, rid, "@伙伴1 新要求");
  await waitForRun(rid);
  const run = getRuns(r.id)[0];
  expect(run.callsUsed).toBe(1);
  expect(run.pendingInputs).toBe(1);
  expect(run.notice).toContain("尚未被回应");
  expect(getRuns(r.id)).toHaveLength(1);
});
it("completed or non-free runs reject new interjections without adding messages", async () => {
  const r = makeRoom(2),
    run = await finished(r, { maxCalls: 1 });
  const before = getMessages(r.id).length;
  expect(() => interject(r, run.id, "late input")).toThrow("已经结束");
  expect(getMessages(r.id)).toHaveLength(before);
});
it("pending input size guard rejects excess before writing and keeps context bounded", async () => {
  const r = makeRoom(5);
  state.delay = 40;
  const rid = start(r, { maxCalls: 2, maxRounds: null });
  await until(() => state.calls.length === 1);
  interject(r, rid, "补充甲" + "甲".repeat(7000));
  interject(r, rid, "补充乙" + "乙".repeat(7000));
  expect(() => interject(r, rid, "丙".repeat(3000))).toThrow("过长");
  const history = buildFreeHistory(r.id, rid, "a0");
  expect(JSON.stringify(history)).toContain("补充甲");
  expect(JSON.stringify(history)).toContain("补充乙");
  expect(
    history.reduce((n, m) => n + String(m.content).length, 0),
  ).toBeLessThanOrEqual(CONTEXT_LIMIT);
  cancelRun(rid, r.id);
  await waitForRun(rid);
});
it("read-only members cannot interrupt a live utterance", async () => {
  const r = makeRoom(2);
  state.delay = 30;
  const rid = start(r, { maxCalls: 2 });
  await until(() => state.calls.length === 1);
  db.prepare("INSERT OR REPLACE INTO memberships VALUES(?,?,'viewer')").run(
    w,
    "reader",
  );
  expect(() =>
    appendDiscussionInput({
      room: r,
      runId: rid,
      actor: "reader",
      author: "Reader",
      content: "new",
      clientId: id(),
    }),
  ).toThrow("无权");
  await waitForRun(rid);
  expect(
    getMessages(r.id)
      .filter((m) => m.role === "assistant")
      .every((m) => m.status === "complete"),
  ).toBe(true);
});
it.each(["stop", "length"])(
  "reasoning-only output ending with %s is not a completed answer",
  async (finish) => {
    state.script = [{ text: "", reasoning: "MODEL_REASONING_ONLY", finish }];
    const run = await finished(makeRoom(2), { maxCalls: 1 });
    const answer = getMessages(run.roomId).find((m) => m.role === "assistant")!;
    expect(answer.status).toBe("error");
    expect(answer.reasoning).toContain("MODEL_REASONING_ONLY");
    expect(answer.finishReason).toBe(finish);
    expect(answer.content).toContain(
      finish === "length" ? "输出上限" : "没有生成正式回答",
    );
    expect(run.status).toBe("failed");
  },
);
it("MiniMax gets a separate bounded output budget", async () => {
  const r = makeRoom(2);
  r.agents[0].model = "MiniMax-M3";
  db.prepare("UPDATE rooms SET agents=? WHERE id=?").run(
    JSON.stringify(r.agents),
    r.id,
  );
  await finished(r, { maxCalls: 1 });
  expect(state.calls[0].maxOutputTokens).toBe(config.minimaxMaxOutputTokens);
  expect(state.calls[0].maxOutputTokens).toBeGreaterThan(
    config.maxOutputTokens,
  );
});
