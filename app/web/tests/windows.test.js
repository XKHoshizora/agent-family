// The detached window around a search hit: the model's rules, and the actions that load it.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDataLayer } from "../src/data/store.jsx";
import {
  applyGone,
  applyMessage,
  applyNewerInWindow,
  applyOlderInWindow,
  applySync,
  closeWindow,
  initial,
  openWindow,
} from "../src/data/model.js";
import { toView } from "../src/data/viewmodel.js";
import { ANN, BO, G1, apiError, deferred, fakeTimers, fakeTransport, group, range, settle, syncOf, wire } from "./fixtures.js";

const SENDERS = [ANN, BO];
const held = () => applySync(initial(), syncOf([group(G1, { lastSeq: 200, readSeq: 200 })], range(G1, 171, 200, SENDERS)));
const page = (from, to, nextBefore = null) => ({ messages: range(G1, from, to, SENDERS), nextBefore, principals: {} });
const seqs = (list) => list.map((m) => m.seq);

describe("the window in the model", () => {
  it("is kept apart: the held messages, the position and the read marker do not change", () => {
    const before = held();
    const next = openWindow(before, G1, page(25, 74, 25), { focusSeq: 50, n: 1 });
    expect(next.messages[G1]).toBe(before.messages[G1]);
    expect(next.conversations[G1]).toBe(before.conversations[G1]);
    expect(seqs(next.windows[G1].messages)[0]).toBe(25);
    expect(next.windows[G1]).toMatchObject({ n: 1, focusSeq: 50, hasOlder: true });
  });

  it("a push while it is open lands in the held messages only", () => {
    const next = openWindow(held(), G1, page(25, 74, 25), { focusSeq: 50, n: 1 });
    const { state } = applyMessage(next, wire(G1, 201, ANN, "新"));
    expect(state.messages[G1].at(-1).seq).toBe(201);
    expect(state.conversations[G1].position).toBe(201);
    expect(seqs(state.windows[G1].messages)).toEqual(seqs(next.windows[G1].messages));
  });

  it("the view shows the window beside the newest messages, which stay what the list previews", () => {
    const next = openWindow(held(), G1, page(25, 74, 25), { focusSeq: 50, n: 1 });
    const conv = toView(next).convs[G1];
    expect(conv.detached).toBe(true);
    expect(conv.window.messages[0].seq).toBe(25);
    expect(conv.messages.at(-1).seq).toBe(200);
  });

  it("a page that reaches the held messages joins them instead of opening a window", () => {
    const next = openWindow(held(), G1, page(130, 180, 130), { focusSeq: 150, n: 1 });
    expect(next.windows[G1]).toBeUndefined();
    expect(seqs(next.messages[G1])[0]).toBe(130);
    expect(seqs(next.messages[G1]).at(-1)).toBe(200);
    expect(next.conversations[G1].hasOlder).toBe(true);
  });

  it("newer pages extend it until it reaches the held messages, then it is absorbed", () => {
    let state = openWindow(held(), G1, page(25, 74, 25), { focusSeq: 50, n: 1 });
    state = applyNewerInWindow(state, G1, page(75, 124), 1);
    expect(seqs(state.windows[G1].messages).at(-1)).toBe(124);
    state = applyNewerInWindow(state, G1, page(125, 174), 1);
    expect(state.windows[G1]).toBeUndefined();
    expect(state.messages[G1].map((m) => m.seq)).toEqual([...Array(176).keys()].map((i) => i + 25));
  });

  it("a newer page with nothing new (what lies between is not visible) joins the window to the held messages too", () => {
    let state = openWindow(held(), G1, page(25, 74, 25), { focusSeq: 50, n: 1 });
    state = applyNewerInWindow(state, G1, { messages: [], nextBefore: null, principals: {} }, 1);
    expect(state.windows[G1]).toBeUndefined();
    expect(seqs(state.messages[G1]).slice(0, 2)).toEqual([25, 26]);
  });

  it("answers for another window are ignored", () => {
    const state = openWindow(held(), G1, page(25, 74, 25), { focusSeq: 50, n: 2 });
    expect(applyNewerInWindow(state, G1, page(75, 124), 1)).toBe(state);
    expect(applyOlderInWindow(state, G1, page(1, 24), 1)).toBe(state);
    expect(applyOlderInWindow(state, G1, page(1, 24), 2).windows[G1].messages[0].seq).toBe(1);
  });

  it("is dropped when the conversation goes, on a sync that omits it, and on request", () => {
    const state = openWindow(held(), G1, page(25, 74, 25), { focusSeq: 50, n: 1 });
    expect(applyGone(state, G1).windows).toEqual({});
    expect(applySync(state, syncOf([])).windows).toEqual({});
    expect(closeWindow(state, G1).windows).toEqual({});
    expect(closeWindow(initial(), G1)).toEqual(initial());
  });

  it("names the people the page mentions", () => {
    const state = openWindow(held(), G1, { ...page(25, 74, 25), principals: { x: { id: "x", handle: "x", displayName: "离开的人", kind: "human" } } }, { focusSeq: 50, n: 1 });
    expect(state.principals.x.displayName).toBe("离开的人");
  });
});

let layers = [];
afterEach(() => {
  for (const l of layers) l.stop();
  layers = [];
});

async function start(api) {
  const transport = fakeTransport({ sync: () => syncOf([group(G1, { lastSeq: 200, readSeq: 190, unread: 10 })], range(G1, 171, 200, SENDERS)) });
  const layer = createDataLayer({ transport, api, timers: fakeTimers(), now: () => 0, random: () => 0.5, uuid: () => "tx-1" });
  layers.push(layer);
  layer.start();
  await settle();
  return { layer, transport };
}
const fakeApi = (over = {}) => ({
  listMessages: vi.fn(async (_id, { before, limit = 50 }) => {
    const below = range(G1, 1, 200, SENDERS).filter((m) => m.seq < before).slice(-limit);
    return { messages: below, nextBefore: below[0].seq > 1 ? below[0].seq : null, principals: {} };
  }),
  markRead: vi.fn(async (_id, seq) => ({ readSeq: seq })),
  sendMessage: vi.fn(() => new Promise(() => {})),
  ...over,
});

describe("the actions that load a window", () => {
  it("jumpToMessage asks for before = seq + 25, 50 messages, and opens the window", async () => {
    const api = fakeApi();
    const { layer } = await start(api);
    expect(await layer.actions.jumpToMessage(G1, 50)).toEqual({ ok: true });
    expect(api.listMessages).toHaveBeenCalledWith(G1, { before: 75, limit: 50 });
    expect(layer.getSnapshot().model.windows[G1].focusSeq).toBe(50);
  });

  it("a held message needs no request, and closes a window that is open", async () => {
    const api = fakeApi();
    const { layer } = await start(api);
    await layer.actions.jumpToMessage(G1, 50);
    api.listMessages.mockClear();
    expect(await layer.actions.jumpToMessage(G1, 180)).toEqual({ ok: true });
    expect(api.listMessages).not.toHaveBeenCalled();
    expect(layer.getSnapshot().model.windows[G1]).toBeUndefined();
  });

  it("a page without the message, or a 404, is not_found and opens nothing", async () => {
    const api = fakeApi({ listMessages: vi.fn(async () => ({ messages: [wire(G1, 70, ANN)], nextBefore: null, principals: {} })) });
    const { layer } = await start(api);
    expect((await layer.actions.jumpToMessage(G1, 50)).error.code).toBe("not_found");
    api.listMessages.mockImplementation(async () => {
      throw apiError(404, "not_found");
    });
    expect((await layer.actions.jumpToMessage(G1, 50)).error.status).toBe(404);
    expect(layer.getSnapshot().model.windows[G1]).toBeUndefined();
  });

  it("only the latest of two jumps counts, whichever answers first", async () => {
    const first = deferred();
    const second = deferred();
    const api = fakeApi({ listMessages: vi.fn((_id, { before }) => (before === 75 ? first.promise : second.promise)) });
    const { layer } = await start(api);
    const a = layer.actions.jumpToMessage(G1, 50);
    const b = layer.actions.jumpToMessage(G1, 100);
    second.resolve(page(76, 124, 76));
    first.resolve(page(25, 74, 25));
    expect((await a).error.code).toBe("superseded");
    expect(await b).toEqual({ ok: true });
    expect(layer.getSnapshot().model.windows[G1].focusSeq).toBe(100);
  });

  it("loadOlder and loadNewer work from the window; a window replaced meanwhile drops the answer", async () => {
    const api = fakeApi();
    const { layer } = await start(api);
    await layer.actions.jumpToMessage(G1, 50);
    expect(await layer.actions.loadOlder(G1)).toMatchObject({ ok: true, loaded: 24, hasOlder: false });
    expect(api.listMessages).toHaveBeenLastCalledWith(G1, { before: 25, limit: 50 });
    expect(layer.getSnapshot().model.messages[G1].length).toBe(30);
    const slow = deferred();
    api.listMessages.mockImplementationOnce(() => slow.promise);
    const newer = layer.actions.loadNewer(G1);
    await layer.actions.jumpToMessage(G1, 120);
    slow.resolve(page(75, 124));
    expect((await newer).error.code).toBe("stale");
    expect(layer.getSnapshot().model.windows[G1].focusSeq).toBe(120);
  });

  it("markRead sends nothing while a window is open", async () => {
    const api = fakeApi();
    const { layer } = await start(api);
    await layer.actions.jumpToMessage(G1, 50);
    expect(await layer.actions.markRead(G1)).toEqual({ ok: true, readSeq: 190 });
    expect(api.markRead).not.toHaveBeenCalled();
    layer.actions.closeWindow(G1);
    await layer.actions.markRead(G1);
    expect(api.markRead).toHaveBeenCalledWith(G1, 200);
  });

  it("sending closes the window first", async () => {
    const api = fakeApi();
    const { layer } = await start(api);
    await layer.actions.jumpToMessage(G1, 50);
    layer.actions.sendText(G1, "hi");
    expect(layer.getSnapshot().model.windows[G1]).toBeUndefined();
    expect(api.sendMessage).toHaveBeenCalled();
  });
});

describe("the searches", () => {
  it("pass the query, the cursor and the page size, name the people in the model and return the hits", async () => {
    const hits = [wire(G1, 50, "p1", "聚餐")];
    const api = fakeApi({
      searchConversation: vi.fn(async () => ({ messages: hits, nextBefore: 50, principals: { p1: { id: "p1", handle: "p1", displayName: "已离开", kind: "human" } } })),
      searchAll: vi.fn(async () => ({ messages: [], nextBefore: "c", principals: {} })),
    });
    const { layer } = await start(api);
    expect(await layer.actions.searchConversation(G1, { q: "聚", before: 80 })).toEqual({ ok: true, hits, nextBefore: 50 });
    expect(api.searchConversation).toHaveBeenCalledWith(G1, { q: "聚", before: 80, limit: 20 });
    expect(layer.getSnapshot().model.principals.p1.displayName).toBe("已离开");
    expect(await layer.actions.searchAll({ q: "聚" })).toEqual({ ok: true, hits: [], nextBefore: "c" });
    expect(api.searchAll).toHaveBeenCalledWith({ q: "聚", before: undefined, limit: 20 });
  });

  it("report the route's error (a 401 signs out)", async () => {
    const api = fakeApi({
      searchAll: vi.fn(async () => {
        throw apiError(429, "rate_limited");
      }),
    });
    const { layer } = await start(api);
    expect(await layer.actions.searchAll({ q: "x" })).toEqual({ ok: false, error: { code: "rate_limited", reason: null, status: 429 } });
    expect(layer.getSnapshot().connection).not.toBe("signedOut");
    api.searchAll.mockImplementation(async () => {
      throw apiError(401, "unauthenticated");
    });
    await layer.actions.searchAll({ q: "x" });
    expect(layer.getSnapshot().connection).toBe("signedOut");
  });
});
