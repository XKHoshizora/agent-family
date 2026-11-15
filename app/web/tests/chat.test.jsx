// @vitest-environment jsdom
// The chat pages over the real data layer (fake transport and API): list, timeline, composer, details.
import React from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { App } from "../src/App.jsx";
import { createDataLayer } from "../src/data/store.jsx";
import {
  ANN,
  BO,
  D1,
  G1,
  ME,
  ME_ID,
  PRINCIPALS,
  apiError,
  at,
  deferred,
  direct,
  emptySocial,
  fakeTimers,
  fakeTransport,
  group,
  notice,
  range,
  settle,
  syncOf,
  wire,
} from "./fixtures.js";

const NOW = new Date(2026, 10, 16, 12, 0).getTime();
const GONE = "00000000-0000-4000-8000-0000000000a9";
const pub = (id, handle, displayName) => ({ id, handle, displayName });

/** D1: 小安 wrote m1..m3, two unread. G1: 30 messages 11..40 (older ones exist), newest activity. */
const baseSync = () =>
  syncOf(
    [direct(D1, ANN, { lastSeq: 3, readSeq: 1, unread: 2 }), group(G1, { lastSeq: 40, readSeq: 40 })],
    [...range(D1, 1, 3), ...range(G1, 11, 40, [ANN, BO])],
  );

function chatApi(over = {}) {
  return {
    sendMessage: vi.fn(() => new Promise(() => {})),
    markRead: vi.fn(async (_id, seq) => ({ readSeq: seq })),
    listMessages: vi.fn(async () => ({ messages: [], nextBefore: null })),
    ...over,
  };
}

let visibility = "visible";
beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
});
beforeEach(() => {
  visibility = "visible";
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  history.replaceState(null, "", "/");
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const flush = () =>
  act(async () => {
    for (let i = 0; i < 6; i += 1) await settle();
  });

async function openApp({ sync = baseSync, social = emptySocial, api = {} } = {}) {
  const transport = fakeTransport({ sync, social });
  const calls = chatApi(api);
  let n = 0;
  const layer = createDataLayer({ transport, api: calls, timers: fakeTimers(), now: () => NOW, random: () => 0.5, uuid: () => `tx-${++n}` });
  render(<App api={{ getMe: async () => ME }} createLayer={() => layer} />);
  await flush();
  return { layer, transport, api: calls };
}

const rowNames = () => [...document.querySelectorAll(".list-col .row-name")].map((x) => x.textContent);
const openChat = async (name) => {
  fireEvent.click(screen.getByText(name, { selector: ".list-col .row-name" }));
  await flush();
};
const input = () => screen.getByLabelText("消息内容");
const type = (value) => fireEvent.change(input(), { target: { value } });
const press = (key, init = {}) => fireEvent.keyDown(input(), { key, ...init });
const timeline = () => document.querySelector("ol.messages");
const mainText = () => document.querySelector(".main-col").textContent;
const push = (transport, event) => act(() => transport.socket.emit(event));

describe("conversation list", () => {
  it("shows unread and the last message, and moves a conversation up when a message is pushed", async () => {
    const { transport } = await openApp();
    expect(rowNames()).toEqual(["周末小组", "小安"]);
    const row = screen.getByText("小安", { selector: ".row-name" }).closest("button");
    expect(within(row).getByText("m3")).toBeTruthy();
    expect(within(row).getByText("2", { selector: ".badge" })).toBeTruthy();
    expect(within(screen.getByText("周末小组", { selector: ".row-name" }).closest("button")).getByText("小安：m40")).toBeTruthy();

    await push(transport, { type: "message", message: wire(D1, 4, ANN, "到了吗", { createdAt: at(50) }) });
    expect(rowNames()).toEqual(["小安", "周末小组"]);
    const moved = screen.getByText("小安", { selector: ".row-name" }).closest("button");
    expect(within(moved).getByText("到了吗")).toBeTruthy();
    expect(within(moved).getByText("3", { selector: ".badge" })).toBeTruthy();
  });

  it("the search box filters conversations locally by name, handle and last message", async () => {
    await openApp();
    const box = screen.getByLabelText("搜索联系人、群聊");
    fireEvent.change(box, { target: { value: "@ann" } });
    expect(rowNames()).toEqual(["小安"]);
    fireEvent.change(box, { target: { value: "周末" } });
    expect(rowNames()).toEqual(["周末小组"]);
    fireEvent.change(box, { target: { value: "没有这个" } });
    expect(screen.getByText("没有符合条件的会话")).toBeTruthy();
  });

  it("nothing about Agents or owners in the list, its menu, the chat or the details panel", async () => {
    await openApp();
    fireEvent.click(screen.getByRole("button", { name: "新建" }));
    expect(screen.getByRole("button", { name: /添加好友/ })).toBeTruthy();
    await openChat("周末小组");
    fireEvent.click(screen.getByRole("button", { name: "会话资料" }));
    // (the list header's brand name "Agent Family" stays)
    for (const part of [".list-col .menu", ".list-col .search", ".list-col .rows", ".main-col", ".side-col"]) {
      const node = document.querySelector(part);
      expect(node.textContent + (node.querySelector("input,textarea")?.placeholder ?? "")).not.toMatch(/Agent|主人|插话/);
    }
    type("@");
    expect(document.querySelector(".composer").textContent).not.toMatch(/Agent|主人/);
    expect(screen.getByRole("button", { name: "@ 会话成员" })).toBeTruthy();
    const side = document.querySelector(".side-col");
    expect(within(side).getByText("发言成员")).toBeTruthy();
    expect(within(side).getByText("谁能看")).toBeTruthy();
    expect(within(side).getByRole("button", { name: "打开群资料" })).toBeTruthy();
  });
});

describe("reading", () => {
  it("opening a chat marks it read up to the newest seq once the tab is visible and focused", async () => {
    const { api } = await openApp();
    await openChat("小安");
    await waitFor(() => expect(api.markRead).toHaveBeenCalledWith(D1, 3));
    expect(api.markRead).toHaveBeenCalledTimes(1);
    expect(screen.getByText("小安", { selector: ".row-name" }).closest("button").querySelector(".badge")).toBeNull();
  });

  it("does not mark read while the tab is hidden or the window is not focused; does when it comes back", async () => {
    visibility = "hidden";
    const { api } = await openApp();
    await openChat("小安");
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(api.markRead).not.toHaveBeenCalled();

    visibility = "visible";
    document.hasFocus.mockReturnValue(false);
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(api.markRead).not.toHaveBeenCalled();

    document.hasFocus.mockReturnValue(true);
    act(() => window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(api.markRead).toHaveBeenCalledWith(D1, 3));
  });

  it("a failed read is not retried in a loop: once more only when the person looks again", async () => {
    const { api } = await openApp({ api: { markRead: vi.fn(async () => Promise.reject(apiError(0, "network_error"))) } });
    await openChat("小安");
    await waitFor(() => expect(api.markRead).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 1300));
    expect(api.markRead).toHaveBeenCalledTimes(1);
    expect(screen.getByText("小安", { selector: ".row-name" }).closest("button").querySelector(".badge").textContent).toBe("2");
    act(() => window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(api.markRead).toHaveBeenCalledTimes(2));
  });

  it("a message arriving in the open chat is marked read too", async () => {
    const { api, transport } = await openApp();
    await openChat("小安");
    await waitFor(() => expect(api.markRead).toHaveBeenCalledWith(D1, 3));
    await push(transport, { type: "message", message: wire(D1, 4, ANN, "还在吗") });
    await waitFor(() => expect(api.markRead).toHaveBeenLastCalledWith(D1, 4));
  });

  it("已读 in a direct chat from the peer's marker; groups show no read state", async () => {
    const sync = () =>
      syncOf(
        [direct(D1, ANN, { lastSeq: 3, readSeq: 3, peerReadSeq: 2 }), group(G1, { lastSeq: 2, readSeq: 2 })],
        [wire(D1, 1, ANN, "早"), wire(D1, 2, ME_ID, "看到了"), wire(D1, 3, ME_ID, "还没看"), wire(G1, 1, ANN, "大家好"), wire(G1, 2, ME_ID, "群里的我")],
      );
    const { transport } = await openApp({ sync });
    await openChat("小安");
    const receipt = (text) => screen.getByText(text, { selector: ".bubble" }).closest("li").querySelector(".receipt")?.textContent.trim();
    expect(receipt("看到了")).toBe("已读");
    expect(receipt("还没看")).toBe("已发送");
    await push(transport, { type: "read", conversationId: D1, principalId: ANN, seq: 3 });
    expect(receipt("还没看")).toBe("已读");

    await openChat("周末小组");
    expect(receipt("群里的我")).toBeUndefined();
    expect(mainText()).not.toMatch(/已读|已发送/);
  });
});

describe("timeline", () => {
  it("system notices for each event in the system-line style, with names from people", async () => {
    const sync = () =>
      syncOf(
        [group(G1, { lastSeq: 9, readSeq: 9 })],
        [
          notice(G1, 1, "x", { event: "group_created", actorId: ME_ID, title: "周末小组", memberIds: [ANN, BO] }),
          notice(G1, 2, "x", { event: "member_joined", actorId: ANN, principalId: BO }),
          notice(G1, 3, "x", { event: "member_left", actorId: BO, principalId: BO, newCreatorId: null }),
          notice(G1, 4, "x", { event: "member_removed", actorId: ME_ID, principalId: ANN }),
          notice(G1, 5, "x", { event: "group_renamed", actorId: ME_ID, title: "新名字" }),
          notice(G1, 6, "x", { event: "friendship_ended", actorId: ANN, principalId: ME_ID }),
          notice(G1, 7, "x", { event: "friendship_restored", actorId: ME_ID, principalId: ANN }),
          notice(G1, 8, "x", { event: "blocked", actorId: ANN, principalId: ME_ID }),
          notice(G1, 9, "x", { event: "unblocked", actorId: ANN, principalId: ME_ID }),
        ],
      );
    await openApp({ sync });
    await openChat("周末小组");
    const lines = [...document.querySelectorAll("li.msg-system > span")].map((x) => x.textContent);
    expect(lines).toEqual([
      "你创建了群聊「周末小组」，并邀请小安、阿波加入",
      "小安邀请阿波加入了群聊",
      "阿波退出了群聊",
      "你将小安移出了群聊",
      "你将群名改为「新名字」",
      "小安解除了与你的好友关系，双方不能再发送新消息，已有历史不受影响",
      "你和小安重新成为好友，可以继续发送消息",
      "小安拉黑了你，只能由对方解除。双方不能再发送新消息，已有历史不受影响",
      "小安解除了对你的拉黑",
    ]);
  });

  it("quotes: an invisible one says so, a visible file quote shows the file name, names come from people", async () => {
    const sync = () =>
      syncOf(
        [group(G1, { lastSeq: 12, readSeq: 12 })],
        [
          wire(G1, 10, ANN, "看不到原文", { replyTo: { seq: 2, visible: false } }),
          wire(G1, 11, BO, "这个文件", { replyTo: { seq: 5, visible: true, senderId: ANN, text: "", kind: "file", attachmentName: "行程.pdf" } }),
          wire(G1, 12, ME_ID, "好", { replyTo: { seq: 11, visible: true, senderId: BO, text: "这个文件", kind: "text" } }),
        ],
      );
    await openApp({ sync });
    await openChat("周末小组");
    const quotes = [...document.querySelectorAll(".bubble blockquote")].map((x) => x.textContent);
    expect(quotes).toEqual(["引用的消息不在你的可见范围内", "小安行程.pdf", "阿波这个文件"]);
  });

  it("a sender nobody named is 已退出的成员 until an older page names them", async () => {
    const sync = () => syncOf([group(G1, { lastSeq: 40, readSeq: 40 })], [...range(G1, 11, 39, [ANN]), wire(G1, 40, GONE, "我先走了")]);
    const departed = { id: GONE, handle: "gone", displayName: "老周", kind: "human" };
    const { api } = await openApp({ sync, api: { listMessages: vi.fn(async () => ({ messages: [wire(G1, 10, GONE, "最早的一句")], nextBefore: null, principals: { [GONE]: departed } })) } });
    await openChat("周末小组");
    const name = (text) => screen.getByText(text, { selector: ".bubble" }).closest("li").querySelector(".msg-meta strong").textContent;
    expect(name("我先走了")).toBe("已退出的成员");
    expect(screen.getByText("已退出的成员：我先走了")).toBeTruthy();
    fireEvent.scroll(timeline());
    await flush();
    expect(api.listMessages).toHaveBeenCalledTimes(1);
    expect(name("我先走了")).toBe("老周");
    expect(name("最早的一句")).toBe("老周");
  });

  it("user text is never markup", async () => {
    const sync = () => syncOf([direct(D1, ANN, { lastSeq: 1, readSeq: 1 })], [wire(D1, 1, ANN, "<b>粗</b><img src=x onerror=alert(1)>")], [PRINCIPALS[0], { ...PRINCIPALS[1], displayName: "<i>小安</i>" }]);
    await openApp({ sync });
    await openChat("<i>小安</i>");
    expect(screen.getByText("<b>粗</b><img src=x onerror=alert(1)>", { selector: ".bubble" })).toBeTruthy();
    expect(document.querySelector(".main-col b, .main-col i, .main-col img[src=x]")).toBeNull();
  });
});

describe("older history", () => {
  it("scrolling to the top loads the page before the oldest held message, keeps the place, and stops at the start", async () => {
    const page = deferred();
    const { api } = await openApp({ api: { listMessages: vi.fn(() => page.promise) } });
    await openChat("周末小组");
    const list = timeline();
    // a tall list scrolled to the top: m11 is 20 px below the list's top edge
    let scrollTop = 0;
    Object.defineProperty(list, "scrollTop", { configurable: true, get: () => scrollTop, set: (v) => (scrollTop = v) });
    Object.defineProperty(list, "scrollHeight", { configurable: true, get: () => 3000 });
    Object.defineProperty(list, "clientHeight", { configurable: true, get: () => 600 });
    const tops = new Map([["m11", 20]]);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function rect() {
      const top = tops.get(this.dataset?.msg) ?? 0;
      return { top, bottom: top, left: 0, right: 0, width: 0, height: 0, x: 0, y: top, toJSON: () => ({}) };
    });

    fireEvent.scroll(list);
    fireEvent.scroll(list);
    expect(api.listMessages).toHaveBeenCalledTimes(1);
    expect(api.listMessages).toHaveBeenCalledWith(G1, { before: 11, limit: 50 });

    tops.set("m11", 520); // ten older messages of 50 px each now sit above it
    page.resolve({ messages: range(G1, 1, 10, [ANN, BO]), nextBefore: null });
    await flush();
    expect(document.querySelectorAll("ol.messages > li[data-msg]")).toHaveLength(40);
    expect(list.querySelector("li[data-msg]").dataset.msg).toBe("m1");
    expect(scrollTop).toBe(500);

    fireEvent.scroll(list);
    await flush();
    expect(api.listMessages).toHaveBeenCalledTimes(1);
  });

  it("a short history that is all there asks for nothing", async () => {
    const { api } = await openApp();
    await openChat("小安");
    fireEvent.scroll(timeline());
    await flush();
    expect(api.listMessages).not.toHaveBeenCalled();
  });
});

describe("composer", () => {
  it("send: appears at once as sending, then sent; Shift+Enter and IME composition do not send", async () => {
    const answer = deferred();
    const { api } = await openApp({ api: { sendMessage: vi.fn(() => answer.promise) } });
    await openChat("小安");
    type("第一行");
    press("Enter", { shiftKey: true });
    press("Enter", { keyCode: 229 });
    expect(api.sendMessage).not.toHaveBeenCalled();
    type("  你好  ");
    press("Enter");
    expect(api.sendMessage).toHaveBeenCalledWith(D1, { clientTxn: "tx-1", text: "你好" });
    expect(input().value).toBe("");
    await flush();
    const mine = () => screen.getByText("你好", { selector: ".bubble" }).closest("li");
    expect(mine().querySelector(".receipt").textContent.trim()).toBe("发送中…");
    await act(async () => {
      answer.resolve({ message: wire(D1, 4, ME_ID, "你好"), duplicate: false });
      await settle();
    });
    expect(mine().querySelector(".receipt").textContent.trim()).toBe("已发送");
  });

  it("a failed send shows 发送失败，未发布 · 重试, and retry reuses the clientTxn", async () => {
    const sendMessage = vi.fn().mockRejectedValueOnce(apiError(0, "network_error")).mockResolvedValueOnce({ message: wire(D1, 4, ME_ID, "在吗"), duplicate: false });
    const { api } = await openApp({ api: { sendMessage } });
    await openChat("小安");
    type("在吗");
    press("Enter");
    await flush();
    const item = () => screen.getByText("在吗", { selector: ".bubble" }).closest("li");
    expect(within(item()).getByText(/发送失败，未发布/)).toBeTruthy();
    fireEvent.click(within(item()).getByRole("button", { name: /重试/ }));
    await flush();
    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    expect(api.sendMessage.mock.calls[1]).toEqual([D1, { clientTxn: "tx-1", text: "在吗" }]);
    expect(within(item()).queryByText(/发送失败/)).toBeNull();
    expect(item().querySelector(".receipt").textContent.trim()).toBe("已发送");
  });

  it("cannot_send shows the hold notice with the real reason and disables the composer", async () => {
    const { api, transport } = await openApp({ api: { sendMessage: vi.fn(async () => Promise.reject(apiError(403, "cannot_send", "blocked"))) } });
    transport.handlers.conversation = () => direct(D1, ANN, { lastSeq: 3, readSeq: 3, canSend: { ok: false, reason: "blocked" } });
    transport.handlers.social = () => ({ ...emptySocial(), friends: [pub(ANN, "ann", "小安")], blockedBy: [pub(ANN, "ann", "小安")] });
    await openChat("小安");
    type("还能发吗");
    press("Enter");
    await flush();
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    const notice = document.querySelector(".chat > .notice");
    expect(notice.textContent).toContain("小安拉黑了你，只能由对方解除");
    expect(input().disabled).toBe(true);
    expect(document.querySelector(".composer-hint").textContent).toContain("小安拉黑了你，只能由对方解除");
    expect(within(screen.getByText("还能发吗", { selector: ".bubble" }).closest("li")).getByText(/发送失败，未发布/)).toBeTruthy();
  });

  it("not friends any more: the hold says so", async () => {
    const sync = () => syncOf([direct(D1, ANN, { lastSeq: 1, readSeq: 1, canSend: { ok: false, reason: "not_friends" } })], [wire(D1, 1, ANN, "再见")]);
    await openApp({ sync });
    await openChat("小安");
    expect(document.querySelector(".chat > .notice").textContent).toContain("对方已不是你的好友");
    expect(input().disabled).toBe(true);
  });

  it("a reply is sent with replyToSeq and shows the quote meanwhile", async () => {
    const { api } = await openApp();
    await openChat("小安");
    const m2 = screen.getByText("m2", { selector: ".bubble" }).closest("li");
    fireEvent.click(within(m2).getByRole("button", { name: /回复/ }));
    expect(screen.getByText("回复 小安：m2")).toBeTruthy();
    type("收到");
    press("Enter");
    expect(api.sendMessage).toHaveBeenCalledWith(D1, { clientTxn: "tx-1", text: "收到", replyToSeq: 2 });
    await flush();
    expect(screen.queryByText("回复 小安：m2")).toBeNull();
    expect(screen.getByText("收到", { selector: ".bubble" }).querySelector("blockquote").textContent).toBe("小安m2");
  });

  it("@ suggestions list the current members only and insert plain text", async () => {
    await openApp();
    await openChat("周末小组");
    type("@");
    const options = screen.getAllByRole("option").map((o) => o.querySelector("strong").textContent);
    expect(options).toEqual(["小安", "阿波"]);
    fireEvent.click(screen.getAllByRole("option")[1]);
    expect(input().value).toBe("@阿波 ");
  });

  it("text over 8000 characters cannot be sent and says why", async () => {
    const { api } = await openApp();
    await openChat("小安");
    type("字".repeat(8001));
    expect(screen.getByRole("button", { name: "发送" }).disabled).toBe(true);
    expect(document.querySelector(".composer-hint").textContent).toContain("消息最多 8000 字");
    press("Enter");
    expect(api.sendMessage).not.toHaveBeenCalled();
    type("😀".repeat(8000));
    expect(screen.getByRole("button", { name: "发送" }).disabled).toBe(false);
  });

  it("drafts are kept per conversation in the data layer", async () => {
    const { layer } = await openApp();
    await openChat("小安");
    type("写了一半");
    await openChat("周末小组");
    expect(input().value).toBe("");
    expect(layer.getSnapshot().model.drafts[D1]).toBe("写了一半");
    type("群里的草稿");
    await openChat("小安");
    expect(input().value).toBe("写了一半");
    expect(layer.getSnapshot().model.drafts[G1]).toBe("群里的草稿");
  });
});

describe("being removed while viewing (Review Focus 3)", () => {
  it("the conversation leaves the list, the main pane shows the empty state and a toast says why", async () => {
    const { transport, api } = await openApp();
    await openChat("周末小组");
    fireEvent.click(screen.getByRole("button", { name: "会话资料" }));
    expect(document.querySelector(".side-col")).toBeTruthy();
    await push(transport, { type: "gone", id: G1 });
    await flush();
    expect(rowNames()).toEqual(["小安"]);
    expect(mainText()).toBe("选择一个会话开始聊天");
    expect(document.querySelector(".side-col")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("你已不在该会话中");
    // a repeated gone changes nothing and asks for nothing
    await push(transport, { type: "gone", id: G1 });
    await flush();
    expect(api.markRead).not.toHaveBeenCalledWith(G1, expect.anything());
    expect(api.listMessages).not.toHaveBeenCalled();
  });
});
