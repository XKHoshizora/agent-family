// @vitest-environment jsdom
// What a reply's tools show (design rules 14, 15), over the real data layer with the fake transport and fake routes:
// while a tool runs, the reply being written says what kind of thing it looks at (正在查聊天记录… / 正在看文件… /
// 正在看时间…) — in my Agent's own conversation and in a group, my Agent's and someone else's alike; under the finished
// reply one quiet line says what it looked up, and opens the messages it found (each loaded as any one message, each
// jumping to its place) and, in my Agent's own conversation only, the words it searched for.
import "./markdown-ready.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, within } from "@testing-library/react";
import { A1, AG1, ANN, BO, ME_ID, MODELS, PRINCIPALS, agentConv, agentOf, agentPrincipal, apiError, at, group, runOf, syncOf, wire } from "./fixtures.js";
import { click, elapse, flush, installBrowser, openApp, push } from "./harness.jsx";
import { forgetRevealed } from "../src/pages/AgentChatBits.jsx";
import { REVEAL_MAX_LAG_MS } from "../src/ui/reveal.js";

const R1 = "00000000-0000-4000-8000-0000000000e7";
const G1 = "00000000-0000-4000-8000-0000000000c2";
const OAG = "00000000-0000-4000-8000-0000000000b9"; // 小安's Agent
const SITE_FREE = { source: "site", id: "free-1" };

beforeEach(() => installBrowser());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  forgetRevealed(R1);
});

/** The greeting (seq 1) and my message (seq 2). */
const BASE = [wire(A1, 1, AG1, "你好，我是小助手"), wire(A1, 2, ME_ID, "在吗")];
const annBot = { ...agentPrincipal(OAG, "annbot", "安的助手"), ownerId: ANN, intro: "", field: "" };
const groupMembers = [ME_ID, ANN, BO, AG1, OAG].map((id, i) => ({ id, role: "speaker", isCreator: i === 0 }));

/** The app with my Agent 小助手, its conversation (`messages`) and the group 周末小组 (`groupMessages`); `open`: which one is open. */
async function openChats({ messages = BASE, groupMessages = [], api = {}, open = "小助手" } = {}) {
  const lastSeq = (list) => list.reduce((max, m) => Math.max(max, m.seq), 0);
  const conversation = agentConv(A1, AG1, { lastSeq: lastSeq(messages), readSeq: lastSeq(messages) });
  const team = group(G1, { members: groupMembers, lastSeq: lastSeq(groupMessages), readSeq: lastSeq(groupMessages) });
  const sync = () => syncOf([conversation, team], [...messages, ...groupMessages], [...PRINCIPALS, { ...agentPrincipal(), ownerId: ME_ID }, annBot]);
  const record = agentOf(AG1, { model: SITE_FREE });
  const app = await openApp({
    sync,
    api: { listProviders: vi.fn(async () => ({ providers: [] })), ...api },
    handlers: { agents: () => ({ agents: [record] }), agent: () => record, run: () => ({ run: null }), groupRuns: () => ({ runs: [] }), models: () => MODELS },
  });
  await click(screen.getByText(open, { selector: ".list-col .row-name" }));
  return app;
}

const timeline = () => document.querySelector("ol.messages");
const bubbleText = () => timeline().querySelector("li.streaming")?.querySelector(".bubble").textContent ?? null;
const storedLi = (seq) => timeline().querySelector(`li[data-msg="m${seq}"]`);
const lookupLine = (seq) => storedLi(seq).querySelector(".msg-lookups");
const runPush = (transport, fields = {}) => push(transport, { type: "run", conversationId: A1, run: runOf(R1, "running"), ...fields });

describe("while a reply's tool runs", () => {
  it("in my Agent's own conversation the bubble says what kind of thing it looks at — 正在查聊天记录… / 正在看文件… / 正在看时间… —, under what it wrote so far, and 正在回复… again once the model writes", async () => {
    const { transport } = await openChats();
    await runPush(transport);
    expect(bubbleText()).toContain("正在回复…");
    await runPush(transport, { activity: "search" });
    expect(bubbleText().trim()).toBe("正在查聊天记录…");
    await runPush(transport, { activity: "file" });
    expect(bubbleText().trim()).toBe("正在看文件…");
    await runPush(transport, { activity: "time" });
    expect(bubbleText().trim()).toBe("正在看时间…");
    await runPush(transport, { activity: null });
    expect(bubbleText().trim()).toBe("正在回复…");
    // Text written before the call: kept, and the line under it while the tool runs.
    await push(transport, { type: "delta", conversationId: A1, runId: R1, text: "我先查一下。" });
    await elapse(REVEAL_MAX_LAG_MS + 100);
    await runPush(transport, { activity: "search" });
    expect(bubbleText()).toContain("我先查一下。");
    expect(bubbleText()).toContain("正在查聊天记录…");
    await runPush(transport, { activity: null });
    expect(bubbleText().trim()).toBe("我先查一下。");
    // A kind this page does not know says nothing of itself.
    await runPush(transport, { activity: "web" });
    expect(bubbleText().trim()).toBe("我先查一下。");
  });

  it("in a group each reply being written says it too, my Agent's and someone else's alike, and 正在回复… again once the model writes", async () => {
    const { transport } = await openChats({ open: "周末小组" });
    const groupRun = (agentId, fields) => push(transport, { type: "run", conversationId: G1, agentId, ...fields });
    const rows = () => [...timeline().querySelectorAll("li.streaming")].map((li) => [li.querySelector(".msg-meta strong").textContent, li.querySelector(".bubble").textContent.trim()]);
    await groupRun(OAG, { state: "replying" });
    await groupRun(AG1, { run: runOf(R1, "running") });
    expect(rows()).toEqual([["小助手", "正在回复…"], ["安的助手", "正在回复…"]]);
    await groupRun(OAG, { state: "replying", activity: "search" });
    await groupRun(AG1, { run: runOf(R1, "running"), activity: "file" });
    expect(rows()).toEqual([["小助手", "正在看文件…"], ["安的助手", "正在查聊天记录…"]]);
    await groupRun(AG1, { run: runOf(R1, "running"), activity: "time" });
    await groupRun(OAG, { state: "replying", activity: null });
    expect(rows()).toEqual([["小助手", "正在看时间…"], ["安的助手", "正在回复…"]]);
    // My stop button stays; nobody else's reply has one.
    expect(within(timeline().querySelectorAll("li.streaming")[0]).getByRole("button", { name: "停止生成" })).toBeTruthy();
  });
});

describe("what a reply looked up", () => {
  const reply = (seq, extra) => wire(A1, seq, AG1, `回答${seq}`, extra);

  it("one quiet line under the reply: 查了 n 次聊天记录 / 看了 n 个文件, both joined with ，; time lookups never in it; a reply that only looked at the time shows none", async () => {
    await openChats({
      messages: [
        ...BASE,
        reply(3, { lookups: { search: 2 } }),
        reply(4, { lookups: { file: 1 } }),
        reply(5, { lookups: { search: 2, file: 1 } }),
        reply(6, { lookups: { time: 1 } }),
        reply(7, { lookups: { search: 1, time: 2 } }),
        reply(8, { lookups: { file: 3, time: 1 } }),
        reply(9, { lookups: { search: 0, file: -1, time: 1.5, web: 4 } }),
        reply(10),
      ],
    });
    expect([3, 4, 5, 6, 7, 8, 9, 10].map((seq) => lookupLine(seq)?.textContent ?? null)).toEqual([
      "查了 2 次聊天记录",
      "看了 1 个文件",
      "查了 2 次聊天记录，看了 1 个文件",
      null,
      "查了 1 次聊天记录",
      "看了 3 个文件",
      null,
      null,
    ]);
    // Under the reply, before the foot.
    const parts = [...storedLi(5).querySelector(".msg-main").children];
    expect(parts.indexOf(lookupLine(5))).toBe(parts.indexOf(storedLi(5).querySelector(".bubble")) + 1);
    // Nothing found and no words: nothing to open.
    expect(within(lookupLine(3)).queryByRole("button")).toBeNull();
  });

  it("a reply that looked nothing up, or only at the time, renders exactly as one carrying none of it", async () => {
    const same = { createdAt: at(3) };
    await openChats({ messages: [...BASE, reply(3, same), reply(4, { ...same, lookups: { time: 2 }, found: [{ conversationId: A1, seq: 2 }], queries: ["几点"] })] });
    const html = (seq) => storedLi(seq).innerHTML.replaceAll(`m${seq}`, "m?").replaceAll(`回答${seq}`, "回答?");
    expect(lookupLine(3)).toBeNull();
    expect([...storedLi(3).querySelector(".msg-main").children].map((el) => el.className)).toEqual(["msg-meta", "bubble", "msg-foot"]);
    expect(html(4)).toBe(html(3));
  });

  it("the line opens what it looked up: in my Agent's own conversation the words first, then each message found — its sender, time and a line of it, loaded as any one message —, and each jumps to its message", async () => {
    const getMessage = vi.fn(async (conversationId, seq) => {
      if (seq === 404) throw apiError(404, "not_found");
      const message = conversationId === A1 ? wire(A1, 2, ME_ID, "在吗") : wire(G1, 7, ANN, "蜀香在春熙路，周一休息");
      return { message, principals: {} };
    });
    const listMessages = vi.fn(async (conversationId) => ({ messages: conversationId === G1 ? [wire(G1, 7, ANN, "蜀香在春熙路，周一休息")] : [], nextBefore: null, principals: {} }));
    const found = [{ conversationId: A1, seq: 2 }, { conversationId: G1, seq: 7 }, { conversationId: A1, seq: 404 }];
    await openChats({
      messages: [...BASE, reply(3, { lookups: { search: 2, file: 1 }, found, queries: ["川菜馆", "蜀香"] })],
      // The group's newest message is held; the one found, older, is not.
      groupMessages: [wire(G1, 8, BO, "最新的一条")],
      api: { getMessage, listMessages },
    });
    const line = within(lookupLine(3)).getByRole("button", { name: "查了 2 次聊天记录，看了 1 个文件" });
    expect(line.getAttribute("aria-expanded")).toBe("false");
    // Nothing is loaded before it is opened.
    expect(getMessage).not.toHaveBeenCalled();
    await click(line);
    expect(line.getAttribute("aria-expanded")).toBe("true");
    expect(getMessage.mock.calls).toEqual([[A1, 2], [G1, 7], [A1, 404]]);
    const box = lookupLine(3);
    const words = box.querySelector(".lookup-words");
    expect(words.textContent).toBe("搜索词：川菜馆、蜀香");
    const rows = [...box.querySelectorAll(".lookup-rows > li")];
    expect(words.compareDocumentPosition(rows[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(rows.map((li) => [li.querySelector(".row-name")?.textContent ?? null, li.querySelector(".row-preview")?.textContent ?? li.textContent])).toEqual([
      ["你", "在吗"],
      ["小安", "蜀香在春熙路，周一休息"],
      [null, "这条消息已经看不到了"],
    ]);
    expect(rows[0].querySelector("time").textContent).not.toBe("");
    expect(within(rows[2]).queryByRole("button")).toBeNull();

    // A message held here: the list scrolls to it and it flashes.
    await click(within(rows[0]).getByRole("button"));
    expect(storedLi(2).classList.contains("flash")).toBe(true);
    // One elsewhere: its conversation opens around it, and it flashes there.
    await click(within([...lookupLine(3).querySelectorAll(".lookup-rows > li")][1]).getByRole("button"));
    expect(listMessages).toHaveBeenCalledWith(G1, { before: 32, limit: 50 });
    expect(document.querySelector(".chat-head").textContent).toContain("周末小组");
    expect(storedLi(7).classList.contains("flash")).toBe(true);
  });

  it("closing the line hides the list again; in a group no words are shown, whatever a message carries", async () => {
    const getMessage = vi.fn(async () => ({ message: wire(G1, 1, ANN, "周六见"), principals: {} }));
    await openChats({
      open: "周末小组",
      groupMessages: [wire(G1, 1, ANN, "周六见"), wire(G1, 2, AG1, "周六见。", { lookups: { search: 1 }, found: [{ conversationId: G1, seq: 1 }], queries: ["不该出现的词"] })],
      api: { getMessage },
    });
    const line = within(lookupLine(2)).getByRole("button", { name: "查了 1 次聊天记录" });
    await click(line);
    expect(lookupLine(2).querySelector(".lookup-words")).toBeNull();
    expect(timeline().textContent).not.toContain("不该出现的词");
    expect([...lookupLine(2).querySelectorAll(".lookup-rows .row-preview")].map((p) => p.textContent)).toEqual(["周六见"]);
    await click(line);
    expect(line.getAttribute("aria-expanded")).toBe("false");
    expect(lookupLine(2).querySelector(".lookup-rows")).toBeNull();
    await flush();
  });
});
