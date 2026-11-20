// @vitest-environment jsdom
// Whispers (悄悄话): a small note in a conversation only I see, about my Agent there, with the buttons it offers (告诉他们,
// 不用). It sits after the message it follows (`afterSeq`; several there by when they were made), says 只有你能看到 with a
// lock, and once answered stays as a quiet line (已告诉他们 / 已忽略 / 已过期). One decision at a time. The chat list marks
// a conversation with open ones. Contract: app/service/README.md "Whispers".
import "./markdown-ready.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { A1, AG1, ANN, BO, G1, ME_ID, MODELS, PRINCIPALS, agentConv, agentOf, agentPrincipal, apiError, at, deferred, group, range, syncOf, wire } from "./fixtures.js";
import { click, flush, installBrowser, openApp, push } from "./harness.jsx";
import { applyCatchup, applyGone, applySync, applyWhisper, initial } from "../src/data/model.js";
import { placeWhispers } from "../src/data/viewmodel.js";

beforeEach(() => installBrowser());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const SITE_FREE = { source: "site", id: "free-1" };
/** A whisper of mine about AG1, after `afterSeq` in `conversationId`. */
const whisper = (id, conversationId, afterSeq, fields = {}) => ({
  id,
  conversationId,
  agentId: AG1,
  afterSeq,
  kind: "found_elsewhere",
  text: `悄悄话 ${id}`,
  actions: ["tell", "dismiss"],
  status: "open",
  createdAt: at(afterSeq),
  ...fields,
});
const MEMBERS = [...group().members, { id: AG1, role: "speaker", isCreator: false }];

/** My group (with my Agent in it) and my Agent's own conversation; the group is opened. */
async function openGroup({ messages = range(G1, 1, 3, [ANN, BO]), whispers, api = {}, open = "周末小组" } = {}) {
  const lastSeq = messages.reduce((max, m) => Math.max(max, m.seq), 0);
  const record = agentOf(AG1, { model: SITE_FREE });
  const conversations = [group(G1, { lastSeq, readSeq: lastSeq, members: MEMBERS }), agentConv(A1, AG1)];
  const app = await openApp({
    sync: () => ({ ...syncOf(conversations, messages, [...PRINCIPALS, { ...agentPrincipal(), ownerId: ME_ID }]), ...(whispers ? { whispers } : {}) }),
    api: {
      acceptWhisper: vi.fn(async (id) => ({ ...whispers.find((w) => w.id === id), status: "accepted" })),
      declineWhisper: vi.fn(async (id) => ({ ...whispers.find((w) => w.id === id), status: "declined" })),
      listWhispers: vi.fn(async () => ({ whispers: [], nextBefore: null })),
      listProviders: vi.fn(async () => ({ providers: [] })),
      ...api,
    },
    handlers: { agents: () => ({ agents: [record] }), agent: () => record, run: () => ({ run: null }), models: () => MODELS },
  });
  if (open) await click(screen.getByText(open, { selector: ".list-col .row-name" }));
  return app;
}

const timeline = () => document.querySelector("ol.messages");
/** The list's rows as `m<seq>` (a message) or `w:<id>` (a whisper), in order. */
const rows = () => [...timeline().children].filter((li) => li.dataset.msg || li.dataset.whisper).map((li) => (li.dataset.msg ? li.dataset.msg : `w:${li.dataset.whisper}`));
const whisperLi = (id) => timeline().querySelector(`li[data-whisper="${id}"]`);
const inWhisper = (id) => within(whisperLi(id));
const listRow = (name) => screen.getByText(name, { selector: ".list-col .row-name" }).closest("button");
const DOT = "有只给你的悄悄话";

describe("a whisper in the conversation", () => {
  it("shows after the message it follows (several there by when they were made), with a lock and 只有你能看到", async () => {
    await openGroup({
      whispers: [whisper("w2", G1, 2, { createdAt: at(30), text: "后来的" }), whisper("w1", G1, 2, { createdAt: at(20), text: "先来的" }), whisper("w3", G1, 3)],
    });
    expect(rows()).toEqual(["m1", "m2", "w:w1", "w:w2", "m3", "w:w3"]);
    expect(whisperLi("w1").textContent).toContain("只有你能看到");
    expect(whisperLi("w1").textContent).toContain("先来的");
    expect(whisperLi("w1").querySelector("svg")).toBeTruthy();
    expect(inWhisper("w1").getByRole("button", { name: "告诉他们" })).toBeTruthy();
    expect(inWhisper("w1").getByRole("button", { name: "不用" })).toBeTruthy();
    // Not a message: nothing to quote, no sender, no time.
    expect(whisperLi("w1").querySelector(".msg-action, .msg-meta, time")).toBeNull();
  });

  it("offers only the buttons it has", async () => {
    await openGroup({ whispers: [whisper("w1", G1, 1, { actions: ["dismiss"] }), whisper("w2", G1, 2, { actions: [] })] });
    expect(inWhisper("w1").queryByRole("button", { name: "告诉他们" })).toBeNull();
    expect(inWhisper("w1").getByRole("button", { name: "不用" })).toBeTruthy();
    expect(inWhisper("w2").queryAllByRole("button")).toEqual([]);
  });

  it("answered ones stay as a quiet line: 已告诉他们, 已忽略, 已过期", async () => {
    await openGroup({
      whispers: [whisper("w1", G1, 1, { status: "accepted" }), whisper("w2", G1, 2, { status: "declined" }), whisper("w3", G1, 3, { status: "expired" })],
    });
    expect(rows()).toEqual(["m1", "w:w1", "m2", "w:w2", "m3", "w:w3"]);
    expect(whisperLi("w1").textContent).toBe("已告诉他们");
    expect(whisperLi("w2").textContent).toBe("已忽略");
    expect(whisperLi("w3").textContent).toBe("已过期");
    expect(timeline().querySelectorAll(".msg-whisper button")).toHaveLength(0);
  });

  it("告诉他们 calls accept once; while it waits neither button does anything; then it reads 已告诉他们", async () => {
    const answer = deferred();
    const w1 = whisper("w1", G1, 2);
    const { api } = await openGroup({ whispers: [w1], api: { acceptWhisper: vi.fn(() => answer.promise) } });
    await click(inWhisper("w1").getByRole("button", { name: "告诉他们" }));
    expect(api.acceptWhisper).toHaveBeenCalledTimes(1);
    expect(api.acceptWhisper).toHaveBeenCalledWith("w1");
    expect(inWhisper("w1").getByRole("button", { name: "处理中…" }).disabled).toBe(true);
    const no = inWhisper("w1").getByRole("button", { name: "不用" });
    expect(no.disabled).toBe(true);
    fireEvent.click(no);
    fireEvent.click(inWhisper("w1").getByRole("button", { name: "处理中…" }));
    await flush();
    expect(api.declineWhisper).not.toHaveBeenCalled();
    expect(api.acceptWhisper).toHaveBeenCalledTimes(1);
    answer.resolve({ ...w1, status: "accepted" });
    await flush();
    expect(whisperLi("w1").textContent).toBe("已告诉他们");
  });

  it("不用 calls decline once and it reads 已忽略", async () => {
    const { api } = await openGroup({ whispers: [whisper("w1", G1, 2)] });
    await click(inWhisper("w1").getByRole("button", { name: "不用" }));
    expect(api.declineWhisper).toHaveBeenCalledTimes(1);
    expect(api.declineWhisper).toHaveBeenCalledWith("w1");
    expect(api.acceptWhisper).not.toHaveBeenCalled();
    expect(whisperLi("w1").textContent).toBe("已忽略");
  });

  it("a refusal (answered or expired meanwhile) says so, offers nothing more, and the whisper is fetched again", async () => {
    const w1 = whisper("w1", G1, 2);
    const later = deferred();
    const { api } = await openGroup({
      whispers: [w1],
      api: {
        acceptWhisper: vi.fn(async () => {
          throw apiError(409, "stale_whisper");
        }),
        listWhispers: vi.fn(() => later.promise),
      },
    });
    await click(inWhisper("w1").getByRole("button", { name: "告诉他们" }));
    expect(inWhisper("w1").getByRole("alert").textContent).toBe("这条悄悄话已经处理过了。");
    expect(inWhisper("w1").queryAllByRole("button")).toEqual([]);
    expect(api.listWhispers).toHaveBeenCalledWith(G1, { before: 3, limit: 100 });
    later.resolve({ whispers: [{ ...w1, status: "expired" }], nextBefore: null });
    await flush();
    expect(whisperLi("w1").textContent).toBe("已过期");
  });

  it("a push makes one, answers one, or expires one; a whisper of a conversation not held is ignored", async () => {
    const { transport } = await openGroup();
    await push(transport, { type: "whisper", whisper: whisper("w1", G1, 3) });
    expect(rows()).toEqual(["m1", "m2", "m3", "w:w1"]);
    await push(transport, { type: "whisper", whisper: whisper("w1", G1, 3, { status: "expired" }) });
    expect(whisperLi("w1").textContent).toBe("已过期");
    // An answer is final: an older copy that says open does not bring the buttons back.
    await push(transport, { type: "whisper", whisper: whisper("w1", G1, 3) });
    expect(whisperLi("w1").textContent).toBe("已过期");
    await push(transport, { type: "whisper", whisper: whisper("w9", "00000000-0000-4000-8000-0000000000ff", 1) });
    expect(document.querySelectorAll(".msg-whisper")).toHaveLength(1);
  });
});

describe("with older history", () => {
  it("one following a message not loaded is not shown; the page of older messages brings the whispers before it (the list route's `before`)", async () => {
    const older = whisper("w5", G1, 5);
    const answered = whisper("w7", G1, 7, { status: "declined" });
    const { api } = await openGroup({
      messages: range(G1, 11, 40, [ANN, BO]),
      whispers: [older],
      api: {
        listMessages: vi.fn(async () => ({ messages: range(G1, 1, 10, [ANN, BO]), nextBefore: null })),
        listWhispers: vi.fn(async () => ({ whispers: [answered, older], nextBefore: null })),
      },
    });
    expect(rows().filter((r) => r.startsWith("w:"))).toEqual([]);
    fireEvent.scroll(timeline());
    await flush();
    expect(api.listMessages).toHaveBeenCalledWith(G1, { before: 11, limit: 50 });
    expect(api.listWhispers).toHaveBeenCalledTimes(1);
    expect(api.listWhispers).toHaveBeenCalledWith(G1, { before: 11, limit: 100 });
    const shown = rows();
    expect(shown.slice(4, 9)).toEqual(["m5", "w:w5", "m6", "m7", "w:w7"]);
    expect(whisperLi("w7").textContent).toBe("已忽略");
  });

  it("a conversation where I have no Agent and no whisper asks the list route for nothing", async () => {
    const { api } = await openApp({
      sync: () => syncOf([group(G1, { lastSeq: 40, readSeq: 40 })], range(G1, 11, 40, [ANN, BO])),
      api: { listMessages: vi.fn(async () => ({ messages: range(G1, 1, 10, [ANN, BO]), nextBefore: null })), listWhispers: vi.fn(async () => ({ whispers: [], nextBefore: null })) },
    });
    await click(screen.getByText("周末小组", { selector: ".list-col .row-name" }));
    fireEvent.scroll(timeline());
    await flush();
    expect(api.listMessages).toHaveBeenCalledTimes(1);
    expect(api.listWhispers).not.toHaveBeenCalled();
  });
});

describe("the chat list", () => {
  it("marks a conversation with open whispers (有只给你的悄悄话), and clears it when none is open", async () => {
    const { transport } = await openGroup({ whispers: [whisper("w1", G1, 2)] });
    expect(within(listRow("周末小组")).getByLabelText(DOT)).toBeTruthy();
    expect(within(listRow("小助手")).queryByLabelText(DOT)).toBeNull();
    await click(inWhisper("w1").getByRole("button", { name: "不用" }));
    expect(within(listRow("周末小组")).queryByLabelText(DOT)).toBeNull();
    // One in my Agent's own conversation, pushed; it expires.
    await push(transport, { type: "whisper", whisper: whisper("w2", A1, 0, { kind: "tools_off", actions: ["dismiss"] }) });
    expect(within(listRow("小助手")).getByLabelText(DOT)).toBeTruthy();
    await push(transport, { type: "whisper", whisper: whisper("w2", A1, 0, { status: "expired" }) });
    expect(within(listRow("小助手")).queryByLabelText(DOT)).toBeNull();
  });

  it("an answered whisper alone marks nothing", async () => {
    await openGroup({ whispers: [whisper("w1", G1, 2, { status: "accepted" })], open: null });
    expect(within(listRow("周末小组")).queryByLabelText(DOT)).toBeNull();
  });
});

describe("the held whispers (model.js)", () => {
  const synced = (whispers, conversations = [group(G1, { lastSeq: 3, readSeq: 3, members: MEMBERS })]) =>
    applySync(initial(), { ...syncOf(conversations, range(G1, 1, 3)), ...(whispers ? { whispers } : {}) });

  it("a sync's open ones replace the open ones held; answered ones held stay; a conversation it does not list takes its whispers with it", () => {
    let state = synced([whisper("w1", G1, 1), whisper("w2", G1, 2)]);
    state = applyWhisper(state, whisper("w3", G1, 3, { status: "declined" }));
    state = applySync(state, { ...syncOf([group(G1, { lastSeq: 3, readSeq: 3, members: MEMBERS })], range(G1, 1, 3)), whispers: [whisper("w2", G1, 2)] });
    expect(Object.keys(state.whispers[G1]).sort()).toEqual(["w2", "w3"]);
    state = applySync(state, syncOf([], []));
    expect(state.whispers[G1]).toBeUndefined();
  });

  it("catch-up adds its whispers; gone drops a conversation's; a whisper that is not one is ignored", () => {
    let state = synced();
    state = applyCatchup(state, { messages: [], gone: [], more: false, whispers: [whisper("w1", G1, 3)] }).state;
    expect(state.whispers[G1].w1.status).toBe("open");
    for (const bad of [null, { id: "x" }, { ...whisper("w2", G1, 1), afterSeq: "1" }, { ...whisper("w3", G1, 1), status: "maybe" }]) {
      expect(applyWhisper(state, bad)).toBe(state);
    }
    state = applyGone(state, G1);
    expect(state.whispers[G1]).toBeUndefined();
  });

  it("placeWhispers: after the message it follows, before what I am still sending; before the first held message only when it is all there", () => {
    const m = (seq) => ({ id: `m${seq}`, seq });
    const pending = { id: "p1", seq: null };
    const w = (id, afterSeq) => ({ id, afterSeq });
    const ids = (out) => out.map((r) => (r.whisper ? `w:${r.whisper.id}` : r.msg.id));
    expect(ids(placeWhispers([m(4), m(6), pending], [w("a", 2), w("b", 4), w("c", 5), w("d", 9)], { complete: false, toEnd: true }))).toEqual(["m4", "w:b", "w:c", "m6", "w:d", "p1"]);
    expect(ids(placeWhispers([m(4), m(6)], [w("a", 2), w("b", 4)], { complete: true, toEnd: true }))).toEqual(["w:a", "m4", "w:b", "m6"]);
    // A detached window (not reaching the newest message): only those within it.
    expect(ids(placeWhispers([m(4), m(6)], [w("b", 4), w("d", 9)], { complete: false, toEnd: false }))).toEqual(["m4", "w:b", "m6"]);
    expect(ids(placeWhispers([], [w("a", 0)], { complete: true, toEnd: true }))).toEqual(["w:a"]);
  });
});

describe("a message is still a message", () => {
  it("a whisper takes no seq: the next message applies by the seq rule as before", async () => {
    const { transport } = await openGroup({ whispers: [whisper("w1", G1, 3)] });
    await push(transport, { type: "message", message: wire(G1, 4, ANN, "下一句") });
    expect(rows()).toEqual(["m1", "m2", "m3", "w:w1", "m4"]);
    expect(transport.log.filter((x) => Array.isArray(x) && x[0] === "catchup")).toEqual([]);
  });
});
