import { afterEach, describe, expect, it, vi } from "vitest";
import { createDataLayer } from "../src/data/store.jsx";
import { toView } from "../src/data/viewmodel.js";
import { ME } from "../src/data/identities.js";
import {
  ANN,
  D1,
  G1,
  ME_ID,
  apiError,
  deferred,
  direct,
  fakeTimers,
  fakeTransport,
  group,
  notice,
  range,
  settle,
  syncOf,
  wire,
} from "./fixtures.js";

const loadedSync = () =>
  syncOf([direct(D1, ANN, { lastSeq: 3, readSeq: 1, unread: 2 }), group(G1, { lastSeq: 40, readSeq: 40 })], [...range(D1, 1, 3), ...range(G1, 11, 40)]);

let layers = [];
afterEach(() => {
  for (const l of layers) l.stop();
  layers = [];
});

function fakeApi(overrides = {}) {
  const ok = () => vi.fn(async () => ({ ok: true }));
  return {
    sendMessage: vi.fn(),
    markRead: vi.fn(async (_id, seq) => ({ readSeq: seq })),
    listMessages: vi.fn(),
    lookupPrincipal: vi.fn(async () => ({ id: ANN })),
    sendFriendRequest: vi.fn(async () => ({ id: "r1" })),
    acceptFriendRequest: vi.fn(async () => ({ ok: true, conversationId: D1 })),
    rejectFriendRequest: vi.fn(async () => ({ ok: true, conversationId: null })),
    withdrawFriendRequest: vi.fn(async () => ({ ok: true, conversationId: null })),
    removeFriend: ok(),
    blockPrincipal: ok(),
    unblockPrincipal: ok(),
    createGroup: vi.fn(async () => ({ id: G1 })),
    renameGroup: vi.fn(async (id, title) => ({ id, title })),
    addMember: ok(),
    removeMember: ok(),
    ...overrides,
  };
}

async function loaded({ api = fakeApi(), transport = fakeTransport({ sync: loadedSync }) } = {}) {
  const timers = fakeTimers();
  let n = 0;
  const layer = createDataLayer({ transport, api, timers, now: () => 1_700_000_000_000 + timers.now(), random: () => 0.5, uuid: () => `tx-${++n}` });
  layers.push(layer);
  layer.start();
  await settle();
  const view = () => toView(layer.getSnapshot().model, { now: 1_700_000_000_000 });
  const messages = (id) => view().convs[id].messages;
  return { layer, api, transport, timers, view, messages, actions: layer.actions };
}

describe("sending (Review Focus 2)", () => {
  it("appears at once as sending, then becomes the server message", async () => {
    const api = fakeApi();
    const answer = deferred();
    api.sendMessage.mockReturnValue(answer.promise);
    const { actions, messages } = await loaded({ api });
    const sending = actions.sendText(D1, "你好", { replyToSeq: 3 });
    expect(api.sendMessage).toHaveBeenCalledWith(D1, { clientTxn: "tx-1", text: "你好", replyToSeq: 3 });
    expect(messages(D1).at(-1)).toMatchObject({ id: "tx:tx-1", status: "sending", from: ME, text: "你好" });
    answer.resolve({ message: wire(D1, 4, ME_ID, "你好"), duplicate: false });
    await expect(sending).resolves.toMatchObject({ ok: true, clientTxn: "tx-1" });
    expect(messages(D1).map((m) => m.id)).toEqual(["m1", "m2", "m3", "m4"]);
    expect(messages(D1).at(-1)).toMatchObject({ status: "sent", text: "你好" });
  });

  it("no duplicate when the push arrives before the HTTP response", async () => {
    const api = fakeApi();
    const answer = deferred();
    api.sendMessage.mockReturnValue(answer.promise);
    const { actions, messages, transport } = await loaded({ api });
    const sending = actions.sendText(D1, "hi");
    transport.socket.emit({ type: "message", message: wire(D1, 4, ME_ID, "hi") });
    expect(messages(D1).map((m) => m.id)).toEqual(["m1", "m2", "m3", "m4"]);
    answer.resolve({ message: wire(D1, 4, ME_ID, "hi"), duplicate: false });
    await sending;
    expect(messages(D1).map((m) => m.id)).toEqual(["m1", "m2", "m3", "m4"]);
  });

  it("a lost response marks it failed with its clientTxn; retry reuses the clientTxn and duplicate:true resolves it to one message", async () => {
    const api = fakeApi();
    api.sendMessage.mockRejectedValueOnce(apiError(0, "network_error"));
    const { actions, messages, transport } = await loaded({ api });
    await expect(actions.sendText(D1, "hi")).resolves.toMatchObject({ ok: false, clientTxn: "tx-1", error: { code: "network_error" } });
    expect(messages(D1).at(-1)).toMatchObject({ id: "tx:tx-1", status: "failed", clientTxn: "tx-1" });
    // the message was in fact stored and pushed
    transport.socket.emit({ type: "message", message: wire(D1, 4, ME_ID, "hi") });
    api.sendMessage.mockResolvedValueOnce({ message: wire(D1, 4, ME_ID, "hi"), duplicate: true });
    await expect(actions.retrySend("tx-1")).resolves.toMatchObject({ ok: true, clientTxn: "tx-1" });
    expect(api.sendMessage).toHaveBeenLastCalledWith(D1, { clientTxn: "tx-1", text: "hi" });
    expect(messages(D1).map((m) => m.id)).toEqual(["m1", "m2", "m3", "m4"]);
  });

  it("cannot_send fails the message and shows the hold at once, then refreshes social and the conversation", async () => {
    const api = fakeApi({ sendMessage: vi.fn(async () => Promise.reject(apiError(403, "cannot_send", "not_friends"))) });
    const { actions, view, transport } = await loaded({ api });
    transport.handlers.conversation = (id) => direct(id, ANN, { lastSeq: 3, canSend: { ok: false, reason: "not_friends" } });
    await actions.sendText(D1, "hi");
    expect(view().convs[D1].hold).toMatchObject({ kind: "relation", reason: "not_friends" });
    await settle();
    expect(transport.log.slice(-2)).toEqual([["conversation", D1], "social"]);
  });

  it("files are sent with their attachment id and shown as file or image meanwhile", async () => {
    const api = fakeApi();
    api.sendMessage.mockReturnValue(new Promise(() => {}));
    const { actions, messages } = await loaded({ api });
    const attachment = { id: "00000000-0000-4000-8000-0000000000f1", name: "a.png", size: 9, inline: true };
    actions.sendFile(D1, attachment, { text: "图" });
    expect(api.sendMessage).toHaveBeenCalledWith(D1, { clientTxn: "tx-1", attachmentId: attachment.id, text: "图" });
    expect(messages(D1).at(-1)).toMatchObject({ kind: "image", status: "sending", text: "a.png", caption: "图" });
  });

  it("refuses empty text and unknown conversations without a request", async () => {
    const { actions, api } = await loaded();
    await expect(actions.sendText(D1, "   ")).resolves.toMatchObject({ ok: false });
    await expect(actions.sendText("00000000-0000-4000-8000-0000000000ff", "hi")).resolves.toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(api.sendMessage).not.toHaveBeenCalled();
  });
});

describe("reading and history", () => {
  it("markRead marks up to the newest held message at once and posts it once", async () => {
    const { actions, api, view } = await loaded();
    await actions.markRead(D1);
    expect(api.markRead).toHaveBeenCalledWith(D1, 3);
    expect(view().convs[D1]).toMatchObject({ unread: 0, readSeq: 3 });
    await actions.markRead(D1);
    expect(api.markRead).toHaveBeenCalledTimes(1);
  });

  it("a failed markRead goes back to the service's marker, stays there across a reconnect, and is sent again next time", async () => {
    const api = fakeApi();
    api.markRead.mockRejectedValueOnce(apiError(0, "network_error"));
    const { actions, view, transport, timers } = await loaded({ api });
    await expect(actions.markRead(D1)).resolves.toMatchObject({ ok: false });
    expect(view().convs[D1]).toMatchObject({ readSeq: 1, unread: 2 });
    transport.socket.drop(1006);
    timers.advance(timers.delays()[0]);
    await settle();
    expect(transport.log.filter((x) => x === "sync")).toHaveLength(2);
    expect(view().convs[D1]).toMatchObject({ readSeq: 1, unread: 2 });
    await actions.markRead(D1);
    expect(api.markRead).toHaveBeenCalledTimes(2);
    expect(api.markRead).toHaveBeenLastCalledWith(D1, 3);
    expect(view().convs[D1]).toMatchObject({ readSeq: 3, unread: 0 });
  });

  it("an older page or a send answered after I was removed and added again is not shown in the new stay", async () => {
    const api = fakeApi();
    const page = deferred();
    const sent = deferred();
    api.listMessages.mockReturnValueOnce(page.promise);
    api.sendMessage.mockReturnValueOnce(sent.promise);
    const { actions, transport, messages } = await loaded({ api });
    const older = actions.loadOlder(G1);
    const sending = actions.sendText(G1, "上一次的");
    transport.socket.emit({ type: "gone", id: G1 });
    transport.handlers.sync = () =>
      syncOf(
        [direct(D1, ANN, { lastSeq: 3 }), group(G1, { lastSeq: 52 })],
        [...range(D1, 1, 3), notice(G1, 50, "小安邀请Mei加入了群聊", { event: "member_joined", actorId: ANN, principalId: ME_ID }), ...range(G1, 51, 52)],
      );
    transport.socket.emit({ type: "conversation", id: G1 });
    await settle();
    expect(messages(G1).map((m) => m.seq)).toEqual([50, 51, 52]);
    page.resolve({ messages: range(G1, 1, 10), nextBefore: null });
    sent.resolve({ message: wire(G1, 41, ME_ID, "上一次的"), duplicate: false });
    await expect(older).resolves.toMatchObject({ ok: false, error: { code: "stale" } });
    await expect(sending).resolves.toMatchObject({ ok: false, error: { code: "stale" } });
    expect(messages(G1).map((m) => m.seq)).toEqual([50, 51, 52]);
  });

  it("a read and a send in flight when a reconnect finds me in a later stay are settled: the marker follows the server, the message is failed and can be retried", async () => {
    const api = fakeApi();
    const read = deferred();
    const sent = deferred();
    api.markRead.mockReturnValueOnce(read.promise).mockRejectedValueOnce(apiError(0, "network_error"));
    api.sendMessage.mockReturnValueOnce(sent.promise);
    const transport = fakeTransport({ sync: () => syncOf([group(G1, { lastSeq: 40, readSeq: 30, unread: 10 })], range(G1, 11, 40)) });
    const { actions, timers, layer, messages, view } = await loaded({ api, transport });
    actions.markRead(G1);
    actions.sendText(G1, "hi");
    expect(view().convs[G1]).toMatchObject({ readSeq: 40, unread: 0 });

    // removed and added again while the socket was down
    transport.socket.drop(1006);
    transport.handlers.catchUp = () => ({ messages: [notice(G1, 60, "小安邀请Mei加入了群聊", { event: "member_joined", actorId: ANN, principalId: ME_ID }), wire(G1, 61, ANN)], gone: [], more: false });
    transport.handlers.sync = () => syncOf([group(G1, { lastSeq: 61, readSeq: 59, unread: 1 })], [notice(G1, 60, "小安邀请Mei加入了群聊", { event: "member_joined", actorId: ANN, principalId: ME_ID }), wire(G1, 61, ANN)]);
    timers.advance(timers.delays()[0]);
    await settle();
    expect(view().convs[G1]).toMatchObject({ readSeq: 59, unread: 1 });
    expect(messages(G1).at(-1)).toMatchObject({ id: "tx:tx-1", status: "failed", clientTxn: "tx-1" });

    // the earlier stay's answers arrive late and change nothing
    read.resolve({ readSeq: 40 });
    sent.resolve({ message: wire(G1, 41, ME_ID, "hi"), duplicate: false });
    await settle();
    expect(layer.getSnapshot().model.conversations[G1].readsInFlight).toBe(0);
    expect(messages(G1).map((m) => m.id)).toEqual(["m60", "m61", "tx:tx-1"]);

    // a read in the new stay that fails still goes back to the service's marker
    await actions.markRead(G1);
    expect(api.markRead).toHaveBeenLastCalledWith(G1, 61);
    expect(view().convs[G1]).toMatchObject({ readSeq: 59, unread: 1 });

    api.sendMessage.mockResolvedValueOnce({ message: wire(G1, 62, ME_ID, "hi"), duplicate: false });
    await expect(actions.retrySend("tx-1")).resolves.toMatchObject({ ok: true, clientTxn: "tx-1" });
    expect(api.sendMessage).toHaveBeenLastCalledWith(G1, { clientTxn: "tx-1", text: "hi" });
  });

  it("stop() forgets an older-history request in flight: after start() it is asked again", async () => {
    const api = fakeApi();
    api.listMessages.mockReturnValue(new Promise(() => {}));
    const { layer, actions } = await loaded({ api });
    actions.loadOlder(G1);
    layer.stop();
    layer.start();
    await settle();
    actions.loadOlder(G1);
    expect(api.listMessages).toHaveBeenCalledTimes(2);
  });

  it("loadOlder pages backwards from the oldest held message, once at a time, and stops at the start", async () => {
    const api = fakeApi();
    const page = deferred();
    api.listMessages.mockReturnValueOnce(page.promise);
    const { actions, messages, view } = await loaded({ api });
    const first = actions.loadOlder(G1);
    const second = actions.loadOlder(G1);
    expect(api.listMessages).toHaveBeenCalledTimes(1);
    expect(api.listMessages).toHaveBeenCalledWith(G1, { before: 11, limit: 50 });
    page.resolve({ messages: range(G1, 1, 10), nextBefore: null });
    await first;
    await second;
    expect(messages(G1)).toHaveLength(40);
    expect(view().convs[G1].hasOlder).toBe(false);
    await actions.loadOlder(G1);
    expect(api.listMessages).toHaveBeenCalledTimes(1);
  });
});

describe("social and group wrappers", () => {
  it("call the route with real ids and ask for fresh state", async () => {
    const { actions, api, transport, layer } = await loaded();
    transport.handlers.conversation = (id) => (id === D1 ? direct(D1, ANN, { lastSeq: 3 }) : group(G1, { lastSeq: 40, title: "改了" }));
    const count = (entry) => transport.log.filter((x) => JSON.stringify(x) === JSON.stringify(entry)).length;

    await actions.removeFriend(ANN);
    expect(api.removeFriend).toHaveBeenCalledWith(ANN);
    await settle();
    expect(count(["conversation", D1])).toBe(1);
    expect(count("social")).toBe(2);

    await actions.renameGroup(G1, "改了");
    expect(api.renameGroup).toHaveBeenCalledWith(G1, "改了");
    await settle();
    expect(count(["conversation", G1])).toBe(1);

    await actions.createGroup("新群", [ANN, ME]);
    expect(api.createGroup).toHaveBeenCalledWith({ title: "新群", memberIds: [ANN, ME_ID] });
    await settle();
    expect(count("sync")).toBe(2);

    await actions.removeMember(G1, ME);
    expect(api.removeMember).toHaveBeenLastCalledWith(G1, ME_ID);
    expect(layer.getSnapshot().model.conversations[G1]).toBeUndefined();
  });

  it("leaveGroup removes me and drops the conversation at once", async () => {
    const { actions, api, layer } = await loaded();
    await actions.leaveGroup(G1);
    expect(api.removeMember).toHaveBeenCalledWith(G1, ME_ID);
    expect(layer.getSnapshot().model.conversations[G1]).toBeUndefined();
  });

  it("errors reach the caller unchanged", async () => {
    const { actions } = await loaded({ api: fakeApi({ sendFriendRequest: vi.fn(async () => Promise.reject(apiError(409, "request_pending"))) }) });
    await expect(actions.sendFriendRequest("ann")).rejects.toMatchObject({ code: "request_pending" });
  });
});

describe("lifecycle", () => {
  it("stop() keeps drafts and unsent messages, clears the rest; start() loads again", async () => {
    const api = fakeApi();
    api.sendMessage.mockReturnValue(new Promise(() => {}));
    const { layer, actions, transport } = await loaded({ api });
    actions.setDraft(D1, "写了一半");
    actions.sendText(D1, "hi");
    layer.stop();
    const stopped = layer.getSnapshot();
    expect(stopped.connection).toBe("idle");
    expect(stopped.model.conversations).toEqual({});
    expect(stopped.model.drafts).toEqual({ [D1]: "写了一半" });
    expect(stopped.model.pending["tx-1"].status).toBe("failed");
    expect(transport.socket.closed).toBe(true);
    layer.start();
    await settle();
    expect(layer.getSnapshot().model.conversations[D1]).toBeDefined();
    expect(toView(layer.getSnapshot().model, { now: 0 }).convs[D1].messages.at(-1)).toMatchObject({ status: "failed", clientTxn: "tx-1" });
  });

  it("a late answer to a request made before stop() is ignored", async () => {
    const api = fakeApi();
    const answer = deferred();
    api.sendMessage.mockReturnValue(answer.promise);
    const { layer, actions } = await loaded({ api });
    const sending = actions.sendText(D1, "hi");
    layer.stop();
    answer.resolve({ message: wire(D1, 4, ME_ID, "hi"), duplicate: false });
    await sending;
    expect(layer.getSnapshot().model.pending["tx-1"].status).toBe("failed");
    expect(layer.getSnapshot().model.messages).toEqual({});
  });

  it("onSignedOut fires once for 4001 and for a 401 answer, and the layer stops reconnecting", async () => {
    const a = await loaded();
    const seen = vi.fn();
    a.layer.onSignedOut(seen);
    a.transport.socket.drop(4001);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(a.layer.getSnapshot().connection).toBe("signedOut");
    expect(a.timers.pending()).toBe(0);

    const unauthenticated = () => vi.fn(async () => Promise.reject(apiError(401, "unauthenticated")));
    const b = await loaded({ api: fakeApi({ markRead: unauthenticated(), removeFriend: unauthenticated() }) });
    const seenB = vi.fn();
    b.layer.onSignedOut(seenB);
    await b.actions.markRead(D1);
    await expect(b.actions.removeFriend(ANN)).rejects.toMatchObject({ status: 401 });
    expect(seenB).toHaveBeenCalledTimes(1);
    expect(b.transport.socket.closed).toBe(true);
    expect(b.layer.getSnapshot().connection).toBe("signedOut");
  });
});
