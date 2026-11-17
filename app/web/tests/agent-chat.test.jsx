// @vitest-environment jsdom
// The conversation with one of my Agents, over the real data layer with the fake transport and fake routes: the
// streaming bubble and its thinking, 停止生成, the run's status line, pause and delete, a new topic, proposal cards,
// the image hint, scrolling, mentions, read receipts and the details panel.
import "./markdown-ready.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import {
  A1,
  AG1,
  ANN,
  D1,
  ME_ID,
  MODELS,
  P1,
  PRINCIPALS,
  agentConv,
  agentOf,
  agentPrincipal,
  apiError,
  deferred,
  direct,
  fakeFile,
  notice,
  providerOf,
  runOf,
  syncOf,
  wire,
} from "./fixtures.js";
import { click, dialog, flush, installBrowser, mainText, openApp, push, toastText } from "./harness.jsx";

beforeEach(() => installBrowser());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const R1 = "00000000-0000-4000-8000-0000000000e5";
const R2 = "00000000-0000-4000-8000-0000000000e6";
const STRAY = "00000000-0000-4000-8000-0000000000e9";
const PID = "00000000-0000-4000-8000-0000000000f7";
const SITE_FREE = { source: "site", id: "free-1" }; // no vision
const SITE_PAID = { source: "site", id: "paid-1" }; // vision
const PROVIDER_MODEL = { source: "provider", providerId: P1, model: "gpt-x" }; // no vision

const PAUSE_TEXT = "已暂停全部会话：它不会有新回复。与「停止生成」不同，这不是只中断一次回复。恢复后，暂停期间收到的消息不会补上回复。";
const DELETED_TEXT = "这个 Agent 已删除，聊天记录仍可查看";
const IMAGE_HINT = "当前模型看不到图片，只会知道文件名";

/** The greeting (seq 1) and my message (seq 2). */
const BASE = [wire(A1, 1, AG1, "你好，我是小助手"), wire(A1, 2, ME_ID, "在吗")];

/**
 * The app with my Agent 小助手 and its conversation open. `agent`: fields of its record; `conv`: of its conversation;
 * `run`: what `GET .../run` answers; `api`: route fakes; `handlers`: the sync engine's other answers.
 */
async function openAgentChat({ agent = {}, conv = {}, messages = BASE, run = null, api = {}, handlers = {}, providers = [], extra = [] } = {}) {
  const record = agentOf(AG1, { model: SITE_FREE, ...agent });
  const lastSeq = messages.reduce((max, m) => Math.max(max, m.seq), 0);
  const conversation = agentConv(A1, AG1, {
    lastSeq,
    readSeq: lastSeq,
    agent: { paused: record.paused, deleted: record.deleted },
    canSend: record.deleted ? { ok: false, reason: "agent_deleted" } : { ok: true },
    ...conv,
  });
  const sync = () => syncOf([conversation, ...extra], messages, [...PRINCIPALS, agentPrincipal()]);
  const app = await openApp({
    sync,
    api: {
      stopRun: vi.fn(async () => ({ ok: true })),
      retryRun: vi.fn(async () => ({ run: runOf(R2, "queued") })),
      dismissRun: vi.fn(async () => ({ ok: true })),
      resetTopic: vi.fn(async () => ({ message: notice(A1, lastSeq + 1, "Mei开始了新话题，之前的对话不再发给小助手", { event: "topic_reset", actorId: ME_ID }) })),
      confirmProposal: vi.fn(async () => agentOf(AG1, { model: SITE_FREE, persona: "新人格", personaVersion: 2 })),
      discardProposal: vi.fn(async () => ({ ok: true })),
      listProviders: vi.fn(async () => ({ providers })),
      uploadAttachment: vi.fn(() => new Promise(() => {})),
      ...api,
    },
    handlers: { agents: () => ({ agents: [record] }), agent: () => record, run: () => ({ run }), models: () => MODELS, ...handlers },
  });
  await click(screen.getByText("小助手", { selector: ".list-col .row-name" }));
  return app;
}

const timeline = () => document.querySelector("ol.messages");
const bubbleLi = () => timeline().querySelector("li.streaming");
const bubbleText = () => bubbleLi()?.querySelector(".bubble").textContent ?? null;
const statusLines = () => [...timeline().querySelectorAll("li.run-status")];
const statusLine = () => statusLines()[0] ?? null;
const storedLi = (seq) => timeline().querySelector(`li[data-msg="m${seq}"]`);
const runPush = (transport, run) => push(transport, { type: "run", conversationId: A1, run });
const deltaPush = (transport, fields) => push(transport, { type: "delta", conversationId: A1, runId: R1, ...fields });
const messagePush = (transport, message) => push(transport, { type: "message", message });
const input = () => screen.getByLabelText("消息内容");

describe("the header and the list row", () => {
  it("carry the prototype's Agent tag; the header says it is my Agent's dedicated chat, nothing about friends", async () => {
    await openAgentChat();
    const row = screen.getByText("小助手", { selector: ".list-col .row-name" }).closest("button");
    expect(within(row).getByText("Agent", { selector: ".tag" })).toBeTruthy();
    const head = document.querySelector(".chat-head");
    expect(within(head).getByText("Agent", { selector: ".tag" })).toBeTruthy();
    expect(head.querySelector(".chat-title p").textContent).toBe("你的 Agent · 专属会话");
    expect(mainText()).not.toMatch(/好友|真人私聊/);
    expect(input().disabled).toBe(false);
  });

  it("a deleted Agent's row reads 已删除 after its tag", async () => {
    await openAgentChat({ agent: { deleted: true } });
    const row = screen.getByText("小助手", { selector: ".list-col .row-name" }).closest("button");
    expect([...row.querySelectorAll(".tag")].map((t) => t.textContent)).toEqual(["Agent", "已删除"]);
  });

  it("an Agent's message carries the Agent tag; my messages read 已读 up to the Agent's marker", async () => {
    await openAgentChat({ messages: [...BASE, wire(A1, 3, ME_ID, "还在吗")], conv: { peerReadSeq: 2 } });
    expect(within(storedLi(1)).getByText("Agent", { selector: ".tag" })).toBeTruthy();
    expect(storedLi(2).querySelector(".receipt").textContent.trim()).toBe("已读");
    expect(storedLi(3).querySelector(".receipt").textContent.trim()).toBe("已发送");
  });

  it("the list's preview is the stored message, never the streamed text", async () => {
    const { transport } = await openAgentChat();
    await runPush(transport, runOf(R1, "running"));
    await deltaPush(transport, { text: "正在写的秘密" });
    const row = screen.getByText("小助手", { selector: ".list-col .row-name" }).closest("button");
    expect(row.querySelector(".row-preview").textContent).toBe("在吗");
    expect(bubbleText()).toBe("正在写的秘密");
  });
});

describe("the streaming bubble", () => {
  it("shows 正在回复… until the first piece, then the text so far, and the stored message replaces it", async () => {
    const { transport } = await openAgentChat();
    expect(bubbleLi()).toBeNull();
    await runPush(transport, runOf(R1, "queued"));
    expect(bubbleText()).toContain("正在回复…");
    expect(within(bubbleLi()).getByRole("button", { name: "停止生成" })).toBeTruthy();
    await runPush(transport, runOf(R1, "running"));
    await deltaPush(transport, { text: "你" });
    expect(bubbleText()).toBe("你");
    await deltaPush(transport, { text: "好" });
    expect(bubbleText()).toBe("你好");
    await messagePush(transport, wire(A1, 3, AG1, "你好呀"));
    expect(bubbleLi()).toBeNull();
    expect(storedLi(3).querySelector(".bubble").textContent).toBe("你好呀");
    await runPush(transport, runOf(R1, "done"));
    expect(bubbleLi()).toBeNull();
    expect(timeline().querySelectorAll('li[data-msg="m3"]')).toHaveLength(1);
  });

  it("thinking sits above the answer in a collapsed 思考过程; with only thinking so far it says 正在回复…", async () => {
    const { transport } = await openAgentChat();
    await runPush(transport, runOf(R1, "running"));
    await deltaPush(transport, { reasoning: "先想一想" });
    const thinking = bubbleLi().querySelector("details");
    expect(thinking.querySelector("summary").textContent).toBe("思考过程");
    expect(thinking.open).toBe(false);
    expect(thinking.textContent).toContain("先想一想");
    expect(bubbleText()).toContain("正在回复…");
    await deltaPush(transport, { text: "答案" });
    expect(bubbleText()).toBe("答案");
    // The disclosure comes before the answer.
    const parts = [...bubbleLi().querySelector(".msg-main").children];
    expect(parts.indexOf(thinking)).toBeLessThan(parts.indexOf(bubbleLi().querySelector(".bubble")));
  });

  it("a stored reply's thinking is folded the same way", async () => {
    await openAgentChat({ messages: [...BASE, wire(A1, 3, AG1, "答案", { reasoning: "想过了" })] });
    const thinking = storedLi(3).querySelector("details");
    expect(thinking.querySelector("summary").textContent).toBe("思考过程");
    expect(thinking.open).toBe(false);
    expect(thinking.textContent).toContain("想过了");
    expect(storedLi(3).querySelector(".bubble").textContent).toBe("答案");
    expect(storedLi(2).querySelector("details")).toBeNull();
  });

  it("a reply still running when the page loads shows 正在回复… only, never a bubble starting mid-sentence", async () => {
    const { transport } = await openAgentChat({ run: runOf(R1, "running") });
    expect(bubbleText()).toContain("正在回复…");
    await deltaPush(transport, { text: "半句话" });
    expect(bubbleText()).not.toContain("半句话");
    await messagePush(transport, wire(A1, 3, AG1, "完整的回复"));
    expect(bubbleLi()).toBeNull();
    expect(storedLi(3)).not.toBeNull();
  });

  it("is never announced piece by piece: busy while it streams, the stored reply is announced once", async () => {
    const { transport } = await openAgentChat();
    const live = document.querySelector('.chat [aria-live="polite"]');
    await runPush(transport, runOf(R1, "running"));
    await deltaPush(transport, { text: "第一段" });
    expect(bubbleLi().getAttribute("aria-busy")).toBe("true");
    expect(bubbleLi().hasAttribute("aria-live")).toBe(false);
    expect(live.textContent).toBe("");
    await messagePush(transport, wire(A1, 3, AG1, "完整的回复"));
    expect(live.textContent).toBe("小助手：完整的回复");
    await runPush(transport, runOf(R1, "done"));
    expect(live.textContent).toBe("小助手：完整的回复");
  });

  // The service's pushes of one reply, and every order Task 1's model is tested with (deltas keep their order), each
  // with a stray delta of an unknown run at every position and a late delta after the end.
  const STEPS = {
    running: (t) => runPush(t, runOf(R1, "running")),
    d1: (t) => deltaPush(t, { text: "你" }),
    d2: (t) => deltaPush(t, { text: "好", reasoning: "想一想" }),
    d3: (t) => deltaPush(t, { text: "呀" }),
    message: (t) => messagePush(t, wire(A1, 3, AG1, "你好呀")),
    done: (t) => runPush(t, runOf(R1, "done")),
    late: (t) => deltaPush(t, { text: "！" }),
    stray: (t) => push(t, { type: "delta", conversationId: A1, runId: STRAY, text: "鬼" }),
  };
  function orders(items) {
    if (items.length === 0) return [[]];
    const isDelta = (step) => /^d\d$/.test(step);
    const out = [];
    items.forEach((item, i) => {
      const rest = [...items.slice(0, i), ...items.slice(i + 1)];
      if (isDelta(item) && rest.some((r) => isDelta(r) && r < item)) return;
      for (const tail of orders(rest)) out.push([item, ...tail]);
    });
    return out;
  }
  const tails = orders(["d1", "d2", "d3", "message", "done"]);

  it(`never shows the bubble and the stored reply at once, after any push of every order (${tails.length} orders × 7)`, async () => {
    expect(tails).toHaveLength(20);
    let cases = 0;
    for (const tail of tails) {
      for (let pos = 0; pos <= tail.length + 1; pos += 1) {
        const steps = ["running", ...tail, "late"];
        steps.splice(pos, 0, "stray");
        const label = steps.join(" → ");
        const { transport } = await openAgentChat();
        // The service sends the message before `done`: in that order there is never a frame with neither.
        const serviceOrder = tail.indexOf("message") < tail.indexOf("done");
        let streamed = "";
        let started = false;
        for (const step of steps) {
          await STEPS[step](transport);
          if (step === "running") started = true;
          const bubble = bubbleText();
          const stored = storedLi(3) !== null;
          expect(bubble !== null && stored, `${label}: both at ${step}`).toBe(false);
          if (serviceOrder && started) expect(bubble !== null || stored, `${label}: neither at ${step}`).toBe(true);
          const placeholder = bubble !== null && bubble.includes("正在回复…");
          if (bubble !== null && !placeholder) expect("你好呀".startsWith(bubble), `${label}: ${bubble}`).toBe(true);
          expect(bubble ?? "", label).not.toContain("鬼");
          if (bubble !== null && !placeholder) streamed = bubble;
        }
        expect(timeline().querySelectorAll('li[data-msg="m3"]'), label).toHaveLength(1);
        expect(bubbleLi(), label).toBeNull();
        expect(streamed === "" || "你好呀".startsWith(streamed), label).toBe(true);
        cleanup();
        cases += 1;
      }
    }
    expect(cases).toBe(140);
  }, 120000);
});

describe("停止生成", () => {
  it("calls stopRun with the run, stays disabled until the run ends, and the stored reply reads 已停止", async () => {
    const { transport, api } = await openAgentChat();
    await runPush(transport, runOf(R1, "running"));
    await deltaPush(transport, { text: "说到一半" });
    const stop = within(bubbleLi()).getByRole("button", { name: "停止生成" });
    await click(stop);
    expect(api.stopRun).toHaveBeenCalledWith(A1, R1);
    expect(within(bubbleLi()).getByRole("button", { name: "停止生成" }).disabled).toBe(true);
    await click(within(bubbleLi()).getByRole("button", { name: "停止生成" }));
    expect(api.stopRun).toHaveBeenCalledTimes(1);
    await messagePush(transport, wire(A1, 3, AG1, "说到一半", { stopped: true }));
    await runPush(transport, runOf(R1, "stopped"));
    expect(bubbleLi()).toBeNull();
    expect(within(storedLi(3)).getByText("已停止")).toBeTruthy();
    // The next reply's button is usable again.
    await runPush(transport, runOf(R2, "queued"));
    expect(within(bubbleLi()).getByRole("button", { name: "停止生成" }).disabled).toBe(false);
  });

  it("stopping a reply that has already ended says nothing", async () => {
    const { transport } = await openAgentChat({ api: { stopRun: vi.fn(async () => Promise.reject(apiError(404, "not_found"))) } });
    await runPush(transport, runOf(R1, "running"));
    await click(within(bubbleLi()).getByRole("button", { name: "停止生成" }));
    await flush();
    expect(toastText()).toBeNull();
  });

  it("a stop that could not be sent says why and can be pressed again", async () => {
    const { transport, api } = await openAgentChat({ api: { stopRun: vi.fn(async () => Promise.reject(apiError(0, "network_error"))) } });
    await runPush(transport, runOf(R1, "running"));
    await click(within(bubbleLi()).getByRole("button", { name: "停止生成" }));
    expect(toastText()).toBe("连不上服务，请检查网络后重试。");
    expect(within(bubbleLi()).getByRole("button", { name: "停止生成" }).disabled).toBe(false);
    expect(api.stopRun).toHaveBeenCalledTimes(1);
  });

  it("a cut reply reads 已截断", async () => {
    await openAgentChat({ messages: [...BASE, wire(A1, 3, AG1, "很长的回答", { truncated: true })] });
    expect(within(storedLi(3)).getByText("已截断")).toBeTruthy();
    expect(within(storedLi(1)).queryByText("已截断")).toBeNull();
  });
});

describe("the status line of a failed reply", () => {
  const tonight = new Date(2026, 10, 17, 0, 0).toISOString();
  const CASES = [
    ["provider_rejected", false, {}, "供应商拒绝了密钥，这次没有回复。请到设置里检查密钥。"],
    ["provider_unavailable", true, {}, "暂时连不上模型服务，这次没有回复。可以重试。"],
    ["address_not_allowed", false, {}, "模型的接口地址不被允许，这次没有回复。请到设置里检查地址。"],
    ["context_too_small", false, {}, "人格文档太长或模型的上下文太小，放不下你的消息。请缩短人格文档或换一个模型。"],
    ["busy", true, {}, "服务出了点问题，这次没有回复，也没有扣费。可以重试。"],
    ["rate_limited", true, {}, "发得太快了，请稍后重试。"],
    ["no_quota", true, { resetsAt: tonight }, "今天的免费额度和余额都已用完，免费额度将在明天 00:00 重置。"],
    ["no_quota", true, {}, "余额不足：这个模型需要余额才能使用。"],
    ["agent_paused", false, {}, "它已暂停，这次没有回复。"],
    ["agent_deleted", false, {}, "它已删除，这次没有回复。"],
  ];
  for (const [code, retryable, extra, sentence] of CASES) {
    it(`${code}${extra.resetsAt ? " (free model)" : ""}: its sentence, 重试 ${retryable ? "shown" : "hidden"}, a dismiss control`, async () => {
      // (A model of my provider: the sentences that send me to my settings are mine to act on.)
      const { transport } = await openAgentChat({ agent: { model: PROVIDER_MODEL } });
      await runPush(transport, runOf(R1, "failed", { error: code, retryable, ...extra }));
      expect(statusLines()).toHaveLength(1);
      const line = statusLine();
      expect(line.textContent).toContain(sentence);
      expect(within(line).queryByRole("button", { name: "重试" }) !== null).toBe(retryable);
      expect(within(line).getByRole("button", { name: "关闭提示" })).toBeTruthy();
      // Not a message: no seq, no avatar, no time, no 回复.
      expect(line.dataset.msg).toBeUndefined();
      expect(line.querySelector(".avatar, time")).toBeNull();
      expect(within(line).queryByRole("button", { name: /回复/ })).toBeNull();
      // At the end of the list.
      expect(line.nextElementSibling.getAttribute("aria-hidden")).toBe("true");
    });
  }

  it("a site model's key, address or outage is not mine to check: one sentence, 重试 only when retryable", async () => {
    const SITE = "站点提供的这个模型暂时用不了，请稍后重试，或换一个模型。";
    const { transport } = await openAgentChat({ agent: { model: SITE_FREE } });
    for (const [id, code, retryable] of [
      [R1, "provider_rejected", false],
      [R2, "provider_unavailable", true],
      [STRAY, "address_not_allowed", false],
    ]) {
      await runPush(transport, runOf(id, "failed", { error: code, retryable }));
      expect(statusLines(), code).toHaveLength(1);
      expect(statusLine().textContent, code).toContain(SITE);
      expect(statusLine().textContent, code).not.toMatch(/检查密钥|检查地址/);
      expect(within(statusLine()).queryByRole("button", { name: "重试" }) !== null, code).toBe(retryable);
    }
  });

  it("no_quota links to Settings → 用量与余额", async () => {
    const { transport } = await openAgentChat({ api: { getUsage: vi.fn(() => new Promise(() => {})) } });
    await runPush(transport, runOf(R1, "failed", { error: "no_quota", retryable: true }));
    await click(within(statusLine()).getByRole("button", { name: "查看用量与余额" }));
    expect(mainText()).toContain("正在读取用量…");
  });

  it("context_too_small links to the Agent's edit page", async () => {
    const { transport } = await openAgentChat({ api: { getModels: vi.fn(async () => MODELS), getUsage: vi.fn(() => new Promise(() => {})) } });
    await runPush(transport, runOf(R1, "failed", { error: "context_too_small", retryable: false }));
    await click(within(statusLine()).getByRole("button", { name: "修改 Agent" }));
    expect(screen.getByLabelText("人格文档")).toBeTruthy();
  });

  it("a cancelled reply shows nothing", async () => {
    const { transport } = await openAgentChat();
    for (const [id, error] of [
      [R1, "agent_paused"],
      [R2, "agent_deleted"],
      [STRAY, undefined],
    ]) {
      await runPush(transport, runOf(id, "cancelled", error ? { error } : {}));
      expect(statusLines()).toHaveLength(0);
      expect(bubbleLi()).toBeNull();
    }
  });

  it("the same failure from a push and from GET …/run is one line", async () => {
    const failed = runOf(R1, "failed", { error: "busy", retryable: true });
    const { transport } = await openAgentChat({ run: failed });
    expect(statusLines()).toHaveLength(1);
    await runPush(transport, failed);
    expect(statusLines()).toHaveLength(1);
  });

  it("dismissing calls dismissRun and hides the line", async () => {
    const { transport, api } = await openAgentChat();
    await runPush(transport, runOf(R1, "failed", { error: "busy", retryable: true }));
    await click(within(statusLine()).getByRole("button", { name: "关闭提示" }));
    expect(api.dismissRun).toHaveBeenCalledWith(A1);
    expect(statusLines()).toHaveLength(0);
  });

  it("重试 starts the new reply in place of the line", async () => {
    const { transport, api } = await openAgentChat();
    await runPush(transport, runOf(R1, "failed", { error: "busy", retryable: true }));
    await click(within(statusLine()).getByRole("button", { name: "重试" }));
    expect(api.retryRun).toHaveBeenCalledWith(A1);
    expect(statusLines()).toHaveLength(0);
    expect(bubbleText()).toContain("正在回复…");
  });

  it("a retry refused because a reply is already going says nothing (that reply shows as it comes)", async () => {
    const busy = deferred();
    const { transport } = await openAgentChat({ api: { retryRun: vi.fn(() => busy.promise) } });
    await runPush(transport, runOf(R1, "failed", { error: "busy", retryable: true }));
    await click(within(statusLine()).getByRole("button", { name: "重试" }));
    expect(within(statusLine()).getByRole("button", { name: "重试" }).disabled).toBe(true);
    await act(async () => busy.reject(apiError(409, "busy_run")));
    await flush();
    expect(toastText()).toBeNull();
    expect(mainText()).not.toContain("它正在回复");
    await runPush(transport, runOf(R2, "running"));
    expect(statusLines()).toHaveLength(0);
    expect(bubbleText()).toContain("正在回复…");
  });

  it("a retry over the reply limit (429) says why in the line, not in a toast", async () => {
    const { transport } = await openAgentChat({ api: { retryRun: vi.fn(async () => Promise.reject(apiError(429, "rate_limited"))) } });
    await runPush(transport, runOf(R1, "failed", { error: "rate_limited", retryable: true }));
    await click(within(statusLine()).getByRole("button", { name: "重试" }));
    expect(statusLine().textContent).toContain("回复太频繁了，请稍等一分钟再试。");
    expect(within(statusLine()).getByRole("button", { name: "重试" }).disabled).toBe(false);
    expect(toastText()).toBeNull();
  });
});

describe("a paused or deleted Agent", () => {
  it("paused: the pause notice sits above a composer that still sends", async () => {
    const { api } = await openAgentChat({ agent: { paused: true } });
    const pause = screen.getByText(PAUSE_TEXT);
    const composer = document.querySelector(".composer");
    expect(pause.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(pause.compareDocumentPosition(timeline()) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    expect(input().disabled).toBe(false);
    fireEvent.change(input(), { target: { value: "你还在吗" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    await flush();
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("deleted: the frozen style with its sentence; nothing can be sent; the history stays", async () => {
    await openAgentChat({ agent: { deleted: true } });
    expect(document.querySelector(".chat > .notice").textContent).toContain(DELETED_TEXT);
    expect(input().disabled).toBe(true);
    expect(document.querySelector(".composer-hint").textContent).toBe(DELETED_TEXT);
    expect(storedLi(1)).not.toBeNull();
    expect(mainText()).not.toContain(PAUSE_TEXT);
  });
});

describe("a new topic", () => {
  const openDetails = () => click(screen.getByRole("button", { name: "会话资料" }));

  it("the details panel asks first, then the notice shows as a 新话题 divider", async () => {
    const { api } = await openAgentChat();
    await openDetails();
    await click(within(document.querySelector(".side-col")).getByRole("button", { name: "开始新话题" }));
    expect(dialog().textContent).toContain("之前的对话不会再发给它，聊天记录仍然保留。");
    await click(within(dialog()).getByRole("button", { name: "取消" }));
    expect(api.resetTopic).not.toHaveBeenCalled();

    await click(within(document.querySelector(".side-col")).getByRole("button", { name: "开始新话题" }));
    await click(within(dialog()).getByRole("button", { name: "开始新话题" }));
    expect(api.resetTopic).toHaveBeenCalledWith(A1);
    expect(dialog()).toBeNull();
    const divider = storedLi(3);
    expect(divider.classList.contains("msg-divider")).toBe(true);
    expect(divider.textContent).toBe("新话题");
  });

  it("a topic notice from the history is a divider too; a deleted Agent offers no new topic", async () => {
    await openAgentChat({
      agent: { deleted: true },
      messages: [...BASE, notice(A1, 3, "Mei开始了新话题，之前的对话不再发给小助手", { event: "topic_reset", actorId: ME_ID })],
    });
    expect(storedLi(3).classList.contains("msg-divider")).toBe(true);
    expect(storedLi(3).textContent).toBe("新话题");
    await openDetails();
    expect(within(document.querySelector(".side-col")).queryByRole("button", { name: "开始新话题" })).toBeNull();
  });

  it("the details panel shows the Agent and leads to its detail page", async () => {
    await openAgentChat();
    await openDetails();
    const side = document.querySelector(".side-col");
    expect(side.textContent).not.toMatch(/任务|设备|好友|拉黑/);
    await click(within(side).getByRole("button", { name: "管理这个 Agent" }));
    expect(document.querySelector(".main-col .eyebrow").textContent).toBe("我的 Agent");
    expect(document.querySelector(".main-col h2").textContent).toContain("小助手");
  });
});

describe("the proposal card", () => {
  const LONG = Array.from({ length: 12 }, (_, i) => `第${i + 1}行：你是一位耐心的旅行规划师。`).join("\n");
  const proposed = (status, fields = {}) =>
    wire(A1, 3, AG1, "我整理了一份设定，请查看并确认。", {
      proposal: { id: PID, status, persona: "你是一位耐心的旅行规划师。", intro: "帮你规划旅行", field: "旅行", ...fields },
    });
  const card = () => storedLi(3).querySelector(".proposal-card");
  const cardButton = (name) => within(card()).queryByRole("button", { name });

  it("open: the persona, 简介 and 擅长领域, and 确认 / 修改后确认 / 放弃", async () => {
    await openAgentChat({ messages: [...BASE, proposed("open")] });
    expect(card().textContent).toContain("你是一位耐心的旅行规划师。");
    expect(card().textContent).toContain("帮你规划旅行");
    expect(card().textContent).toContain("旅行");
    for (const name of ["确认", "修改后确认", "放弃"]) expect(cardButton(name)).not.toBeNull();
  });

  for (const [status, text] of [
    ["confirmed", "已采用"],
    ["discarded", "已放弃"],
    ["superseded", "已被新的提议取代"],
    ["stale", "配置已变更，请重新生成提议"],
  ]) {
    it(`${status}: reads ${text}, with nothing to press`, async () => {
      await openAgentChat({ messages: [...BASE, proposed(status)] });
      expect(card().textContent).toContain(text);
      for (const name of ["确认", "修改后确认", "放弃"]) expect(cardButton(name)).toBeNull();
    });
  }

  it("a deleted Agent's open proposal can no longer be decided", async () => {
    await openAgentChat({ agent: { deleted: true }, messages: [...BASE, proposed("open")] });
    expect(card().textContent).toContain("未确认");
    expect(card().textContent).not.toContain("待你确认");
    for (const name of ["确认", "修改后确认", "放弃"]) expect(cardButton(name)).toBeNull();
  });

  it("a proposal without 简介 or 擅长领域 shows neither", async () => {
    await openAgentChat({ messages: [...BASE, proposed("open", { intro: undefined, field: undefined })] });
    expect(card().textContent).not.toContain("简介");
    expect(card().textContent).not.toContain("擅长领域");
  });

  it("a long persona is folded beyond a few lines and can be opened", async () => {
    await openAgentChat({ messages: [...BASE, proposed("open", { persona: LONG })] });
    expect(card().textContent).not.toContain("第12行");
    const more = cardButton("展开全部");
    expect(more.getAttribute("aria-expanded")).toBe("false");
    await click(more);
    expect(card().textContent).toContain("第12行");
    expect(cardButton("收起").getAttribute("aria-expanded")).toBe("true");
  });

  it("确认 confirms the proposal as it is, and the card reads 已采用", async () => {
    const { api } = await openAgentChat({ messages: [...BASE, proposed("open")] });
    await click(cardButton("确认"));
    expect(api.confirmProposal).toHaveBeenCalledTimes(1);
    expect(api.confirmProposal.mock.calls[0].slice(0, 2)).toEqual([AG1, PID]);
    expect(api.confirmProposal.mock.calls[0][2]).toBeUndefined();
    expect(card().textContent).toContain("已采用");
    expect(cardButton("确认")).toBeNull();
  });

  it("修改后确认 opens the text in an editor and confirms with the values I changed, only those", async () => {
    const { api } = await openAgentChat({ messages: [...BASE, proposed("open")] });
    await click(cardButton("修改后确认"));
    const editor = within(dialog());
    expect(editor.getByLabelText("人格文档").value).toBe("你是一位耐心的旅行规划师。");
    expect(editor.getByLabelText("擅长领域").value).toBe("旅行");
    fireEvent.change(editor.getByLabelText("人格文档"), { target: { value: "你是一位细心的旅行规划师。" } });
    fireEvent.change(editor.getByLabelText("简介"), { target: { value: "规划你的下一次旅行" } });
    await click(editor.getByRole("button", { name: "确认" }));
    expect(api.confirmProposal).toHaveBeenCalledWith(AG1, PID, { persona: "你是一位细心的旅行规划师。", intro: "规划你的下一次旅行" });
    expect(dialog()).toBeNull();
    expect(card().textContent).toContain("已采用");
  });

  it("an editor confirmed unchanged sends no edits (white space around the persona is no change)", async () => {
    const { api } = await openAgentChat({ messages: [...BASE, proposed("open")] });
    await click(cardButton("修改后确认"));
    fireEvent.change(within(dialog()).getByLabelText("人格文档"), { target: { value: "  你是一位耐心的旅行规划师。\n" } });
    await click(within(dialog()).getByRole("button", { name: "确认" }));
    expect(api.confirmProposal).toHaveBeenCalledWith(AG1, PID, {});
  });

  it("an over-long 简介 the Agent proposed does not block a confirm that changes only the persona", async () => {
    const long = "很".repeat(41);
    const { api } = await openAgentChat({ messages: [...BASE, proposed("open", { intro: long })] });
    await click(cardButton("修改后确认"));
    fireEvent.change(within(dialog()).getByLabelText("人格文档"), { target: { value: "新的人格" } });
    await click(within(dialog()).getByRole("button", { name: "确认" }));
    expect(api.confirmProposal).toHaveBeenCalledWith(AG1, PID, { persona: "新的人格" });
    // Changed, it is checked like any value I write.
    cleanup();
    const again = await openAgentChat({ messages: [...BASE, proposed("open", { intro: long })] });
    await click(cardButton("修改后确认"));
    fireEvent.change(within(dialog()).getByLabelText("简介"), { target: { value: `${long}了` } });
    await click(within(dialog()).getByRole("button", { name: "确认" }));
    expect(again.api.confirmProposal).not.toHaveBeenCalled();
    expect(dialog().textContent).toContain("简介不超过 40 个字");
  });

  it("while the editor's confirm is on its way, the card's 确认 and 放弃 wait too", async () => {
    const answer = deferred();
    const { api } = await openAgentChat({ messages: [...BASE, proposed("open")], api: { confirmProposal: vi.fn(() => answer.promise) } });
    await click(cardButton("修改后确认"));
    fireEvent.change(within(dialog()).getByLabelText("人格文档"), { target: { value: "新的人格" } });
    await click(within(dialog()).getByRole("button", { name: "确认" }));
    const actionsRow = within(card().querySelector(".card-actions"));
    for (const name of ["确认", "修改后确认", "放弃"]) expect(actionsRow.getByRole("button", { name }).disabled, name).toBe(true);
    expect(within(dialog()).getByRole("button", { name: "处理中…" }).disabled).toBe(true);
    await act(async () => answer.resolve(agentOf(AG1, { model: SITE_FREE, persona: "新的人格", personaVersion: 2 })));
    await flush();
    expect(api.confirmProposal).toHaveBeenCalledTimes(1);
    expect(card().textContent).toContain("已采用");
  });

  it("while the card's 确认 is on its way, 修改后确认 and 放弃 wait too", async () => {
    const answer = deferred();
    await openAgentChat({ messages: [...BASE, proposed("open")], api: { confirmProposal: vi.fn(() => answer.promise) } });
    await click(cardButton("确认"));
    for (const name of ["处理中…", "修改后确认", "放弃"]) expect(cardButton(name).disabled, name).toBe(true);
    await act(async () => answer.resolve(agentOf(AG1, { model: SITE_FREE, persona: "x", personaVersion: 2 })));
    await flush();
  });

  it("the editor refuses an empty persona and sends nothing", async () => {
    const { api } = await openAgentChat({ messages: [...BASE, proposed("open", { intro: undefined, field: undefined })] });
    await click(cardButton("修改后确认"));
    expect(within(dialog()).queryByLabelText("简介")).toBeNull();
    fireEvent.change(within(dialog()).getByLabelText("人格文档"), { target: { value: "   " } });
    await click(within(dialog()).getByRole("button", { name: "确认" }));
    expect(api.confirmProposal).not.toHaveBeenCalled();
    expect(dialog().textContent).toContain("人格文档不能为空");
  });

  it("放弃 discards it, and the card reads 已放弃", async () => {
    const { api } = await openAgentChat({ messages: [...BASE, proposed("open")] });
    await click(cardButton("放弃"));
    expect(api.discardProposal).toHaveBeenCalledWith(AG1, PID);
    expect(card().textContent).toContain("已放弃");
  });

  it("a confirm refused as stale fetches the card again and ends in the stale card, with no toast", async () => {
    const { api, transport } = await openAgentChat({
      messages: [...BASE, proposed("open")],
      api: { confirmProposal: vi.fn(async () => Promise.reject(apiError(409, "stale_proposal"))) },
      handlers: { message: () => ({ message: proposed("stale"), principals: [] }) },
    });
    await click(cardButton("确认"));
    await flush();
    expect(api.confirmProposal).toHaveBeenCalledTimes(1);
    expect(transport.agentLog).toContainEqual(["message", A1, 3]);
    expect(card().textContent).toContain("配置已变更，请重新生成提议");
    expect(cardButton("确认")).toBeNull();
    expect(toastText()).toBeNull();
  });

  it("while the card is not fetched again yet, the refusal's sentence is on the card", async () => {
    const hold = deferred();
    await openAgentChat({
      messages: [...BASE, proposed("open")],
      api: { confirmProposal: vi.fn(async () => Promise.reject(apiError(409, "stale_proposal"))) },
      handlers: { message: () => hold.promise },
    });
    await click(cardButton("确认"));
    expect(card().textContent).toContain("这份提议已失效，请让它重新生成提议。");
    await act(async () => hold.resolve({ message: proposed("superseded"), principals: [] }));
    await flush();
    expect(card().textContent).toContain("已被新的提议取代");
    expect(card().textContent).not.toContain("这份提议已失效");
  });
});

describe("the image hint", () => {
  const pick = async (files) => {
    fireEvent.change(screen.getByLabelText("选择图片"), { target: { files } });
    await flush();
  };
  const hint = () => screen.queryByText(IMAGE_HINT);

  it("shows when an image is picked for a model that cannot see images", async () => {
    await openAgentChat({ agent: { model: SITE_FREE } });
    expect(hint()).toBeNull();
    await pick([fakeFile("a.png", 5, "image/png")]);
    expect(hint()).not.toBeNull();
    expect(hint().closest(".composer")).not.toBeNull();
  });

  it("shows for a pasted image too, never for a file that is not an image", async () => {
    await openAgentChat({ agent: { model: SITE_FREE } });
    fireEvent.paste(input(), { clipboardData: { files: [fakeFile("note.txt", 5, "text/plain")], getData: () => "" } });
    await flush();
    expect(hint()).toBeNull();
    fireEvent.paste(input(), { clipboardData: { files: [fakeFile("shot.png", 5, "image/png")], getData: () => "" } });
    await flush();
    expect(hint()).not.toBeNull();
  });

  it("does not show for a model that sees images, or with no model chosen", async () => {
    await openAgentChat({ agent: { model: SITE_PAID } });
    await pick([fakeFile("a.png", 5, "image/png")]);
    expect(hint()).toBeNull();
    cleanup();
    await openAgentChat({ agent: { model: null } });
    await pick([fakeFile("a.png", 5, "image/png")]);
    expect(hint()).toBeNull();
  });

  it("goes once that image's upload settles: sent, or refused", async () => {
    const image = { id: "00000000-0000-4000-8000-00000000f001", name: "a.png", size: 5, inline: true };
    let upload = deferred();
    const sendMessage = vi.fn(async () => ({ message: wire(A1, 3, ME_ID, "", { kind: "file", attachment: image }), duplicate: false }));
    await openAgentChat({ agent: { model: SITE_FREE }, api: { uploadAttachment: vi.fn(() => upload.promise), sendMessage } });
    await pick([fakeFile("a.png", 5, "image/png")]);
    expect(hint()).not.toBeNull();
    await act(async () => upload.resolve(image));
    await flush();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(hint()).toBeNull();

    upload = deferred();
    await pick([fakeFile("b.png", 5, "image/png")]);
    expect(hint()).not.toBeNull();
    await act(async () => upload.reject(apiError(415, "unsupported_media_type")));
    await flush();
    expect(hint()).toBeNull();
  });

  it("goes when another conversation is opened, and does not come back with this one", async () => {
    await openAgentChat({ agent: { model: SITE_FREE }, extra: [direct(D1, ANN)] });
    await pick([fakeFile("a.png", 5, "image/png")]);
    expect(hint()).not.toBeNull();
    await click(screen.getByText("小安", { selector: ".list-col .row-name" }));
    expect(hint()).toBeNull();
    await click(screen.getByText("小助手", { selector: ".list-col .row-name" }));
    expect(hint()).toBeNull();
  });

  it("a provider's model is looked up in my providers", async () => {
    const { api } = await openAgentChat({ agent: { model: { source: "provider", providerId: P1, model: "gpt-x" } }, providers: [providerOf()] });
    await pick([fakeFile("a.png", 5, "image/png")]);
    expect(api.listProviders).toHaveBeenCalled();
    expect(hint()).not.toBeNull();
  });
});

describe("scrolling", () => {
  /** Gives the message list a layout jsdom lacks: 3000 px of content in a 600 px box, scrolled to `scrollTop`. */
  function tallList(scrollTop) {
    const list = timeline();
    let top = scrollTop;
    Object.defineProperty(list, "scrollTop", { configurable: true, get: () => top, set: (v) => (top = v) });
    Object.defineProperty(list, "scrollHeight", { configurable: true, get: () => 3000 });
    Object.defineProperty(list, "clientHeight", { configurable: true, get: () => 600 });
    return list;
  }

  it("follows the streaming bubble only while the list is at the bottom", async () => {
    const { transport } = await openAgentChat();
    const list = tallList(1000);
    fireEvent.scroll(list);
    await runPush(transport, runOf(R1, "running"));
    await deltaPush(transport, { text: "第一段" });
    expect(list.scrollTop).toBe(1000);
    list.scrollTop = 2400;
    fireEvent.scroll(list);
    await deltaPush(transport, { text: "第二段" });
    expect(list.scrollTop).toBe(3000);
    list.scrollTop = 2500;
    await deltaPush(transport, { reasoning: "想" });
    expect(list.scrollTop).toBe(3000);
  });
});

describe("mentions", () => {
  it("@ offers the Agent, and choosing it inserts @ and its name", async () => {
    await openAgentChat({ agent: { replyMode: "mention" } });
    fireEvent.change(input(), { target: { value: "@", selectionStart: 1, selectionEnd: 1 } });
    const option = screen.getByRole("option", { name: /小助手/ });
    expect(option.textContent).toContain("Agent · 主人：你");
    fireEvent.click(option);
    expect(input().value).toBe("@小助手 ");
  });
});
