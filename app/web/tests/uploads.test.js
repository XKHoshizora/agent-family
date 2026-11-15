// File messages in the data layer: upload (3 at a time), then send with one clientTxn; cancel, retry, stay and stop.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDataLayer } from "../src/data/store.jsx";
import { MAX_FILE_BYTES } from "../src/data/actions.js";
import { toView, formatSize } from "../src/data/viewmodel.js";
import { ME } from "../src/data/identities.js";
import { ANN, ATT, D1, G1, ME_ID, apiError, direct, fakeFile, fakeTimers, fakeTransport, fakeUploads, group, notice, range, settle, syncOf, wire } from "./fixtures.js";

const loadedSync = () => syncOf([direct(D1, ANN, { lastSeq: 3 }), group(G1, { lastSeq: 40 })], [...range(D1, 1, 3), ...range(G1, 11, 40)]);

let layers = [];
afterEach(() => {
  for (const l of layers) l.stop();
  layers = [];
});

async function loaded({ sendMessage = vi.fn(() => new Promise(() => {})), transport = fakeTransport({ sync: loadedSync }) } = {}) {
  const up = fakeUploads();
  const api = { uploadAttachment: up.uploadAttachment, sendMessage, markRead: vi.fn(), listMessages: vi.fn() };
  let n = 0;
  const layer = createDataLayer({ transport, api, timers: fakeTimers(), now: () => 1_700_000_000_000, random: () => 0.5, uuid: () => `tx-${++n}` });
  layers.push(layer);
  layer.start();
  await settle();
  const messages = (id) => toView(layer.getSnapshot().model, { now: 1_700_000_000_000 }).convs[id].messages;
  const last = (id) => messages(id).at(-1);
  return { layer, api, up, transport, messages, last, actions: layer.actions };
}

describe("sendFile", () => {
  it("shows the file at once as uploading with progress, then uploads, then sends with the same clientTxn", async () => {
    const sendMessage = vi.fn(async () => ({ message: wire(D1, 4, ME_ID, "", { kind: "file", attachment: ATT(1, { name: "报告.pdf", size: 2048 }) }), duplicate: false }));
    const { actions, up, last, messages } = await loaded({ sendMessage });
    const done = actions.sendFile(D1, fakeFile("报告.pdf", 2048), { text: " 请看 " });
    expect(up.uploadAttachment).toHaveBeenCalledWith(D1, expect.any(File), expect.objectContaining({ onProgress: expect.any(Function), signal: expect.any(AbortSignal) }));
    expect(last(D1)).toMatchObject({ id: "tx:tx-1", kind: "file", status: "sending", text: "报告.pdf", caption: "请看", upload: { phase: "uploading", progress: 0 }, attachment: { name: "报告.pdf", size: 2048, url: null } });
    up.progress(0, 0.456);
    expect(last(D1).upload).toEqual({ phase: "uploading", progress: 0.45 });
    expect(sendMessage).not.toHaveBeenCalled();
    up.finish(0, ATT(1, { name: "报告.pdf", size: 2048 }));
    await expect(done).resolves.toMatchObject({ ok: true, clientTxn: "tx-1" });
    expect(sendMessage).toHaveBeenCalledWith(D1, { clientTxn: "tx-1", attachmentId: ATT(1).id, text: "请看" });
    expect(messages(D1).at(-1)).toMatchObject({ id: "m4", kind: "file", status: "sent", text: "报告.pdf" });
  });

  it("an unsent image is shown as a file card (its bytes are served only once a message carries it)", async () => {
    const { actions, up, last } = await loaded();
    actions.sendFile(D1, fakeFile("a.png", 5, "image/png"));
    up.finish(0, ATT(1, { name: "a.png", inline: true }));
    await settle();
    expect(last(D1)).toMatchObject({ kind: "file", status: "sending", upload: null, attachment: { id: ATT(1).id, url: null } });
    expect(last(D1).src).toBeUndefined();
  });

  it("refuses a file over 50 MB without a request or an entry; exactly 50 MB is accepted", async () => {
    const { actions, up, messages } = await loaded();
    await expect(actions.sendFile(D1, fakeFile("big.bin", MAX_FILE_BYTES + 1))).resolves.toMatchObject({ ok: false, clientTxn: null, error: { code: "too_large" } });
    expect(up.uploadAttachment).not.toHaveBeenCalled();
    expect(messages(D1)).toHaveLength(3);
    actions.sendFile(D1, fakeFile("edge.bin", MAX_FILE_BYTES));
    expect(up.uploadAttachment).toHaveBeenCalledTimes(1);
  });

  it("at most 3 uploads run at once across conversations; the rest start in order as slots free up", async () => {
    const { actions, up, last } = await loaded();
    actions.sendFile(D1, fakeFile("a"));
    actions.sendFile(G1, fakeFile("b"));
    actions.sendFile(D1, fakeFile("c"));
    actions.sendFile(G1, fakeFile("d"));
    actions.sendFile(D1, fakeFile("e"));
    expect(up.calls.map((c) => c.file.name)).toEqual(["a", "b", "c"]);
    expect(last(G1).upload).toMatchObject({ phase: "queued" });
    up.finish(1);
    await settle();
    expect(up.calls.map((c) => c.file.name)).toEqual(["a", "b", "c", "d"]);
    up.fail(0, apiError(0, "network_error"));
    await settle();
    expect(up.calls.map((c) => c.file.name)).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("the slot is free once the file is uploaded, not when the message is sent", async () => {
    const { actions, up } = await loaded(); // sendMessage never answers
    for (const name of ["a", "b", "c", "d"]) actions.sendFile(D1, fakeFile(name));
    up.finish(0);
    await settle();
    expect(up.calls).toHaveLength(4);
  });

  it("cancel aborts a running upload and removes the message; the next one starts", async () => {
    const { actions, up, messages } = await loaded();
    const first = actions.sendFile(D1, fakeFile("a"));
    for (const name of ["b", "c", "d"]) actions.sendFile(D1, fakeFile(name));
    expect(actions.cancelUpload("tx-1")).toEqual({ ok: true });
    expect(up.calls[0].signal.aborted).toBe(true);
    await expect(first).resolves.toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(messages(D1).map((m) => m.id)).toEqual(["m1", "m2", "m3", "tx:tx-2", "tx:tx-3", "tx:tx-4"]);
    expect(up.calls.map((c) => c.file.name)).toEqual(["a", "b", "c", "d"]);
    await settle();
    expect(messages(D1)).toHaveLength(6); // the aborted upload does not turn into a failed message
  });

  it("cancel removes a queued file without ever uploading it", async () => {
    const { actions, up, messages } = await loaded();
    for (const name of ["a", "b", "c", "d"]) actions.sendFile(D1, fakeFile(name));
    actions.cancelUpload("tx-4");
    up.finish(0);
    await settle();
    expect(up.calls).toHaveLength(3);
    expect(messages(D1).some((m) => m.id === "tx:tx-4")).toBe(false);
  });

  it("an uploaded file can no longer be cancelled", async () => {
    const { actions, up } = await loaded();
    actions.sendFile(D1, fakeFile("a"));
    up.finish(0);
    await settle();
    expect(actions.cancelUpload("tx-1")).toMatchObject({ ok: false });
  });

  it("a failed upload keeps its entry; retry uploads again with the same clientTxn; cancel removes a failed one", async () => {
    const { actions, up, last, messages } = await loaded();
    const first = actions.sendFile(D1, fakeFile("a"));
    up.fail(0, apiError(429, "rate_limited"));
    await expect(first).resolves.toMatchObject({ ok: false, error: { code: "rate_limited" } });
    expect(last(D1)).toMatchObject({ id: "tx:tx-1", status: "failed", clientTxn: "tx-1", upload: null, error: { code: "rate_limited" } });
    const again = actions.retrySend("tx-1");
    expect(up.uploadAttachment).toHaveBeenCalledTimes(2);
    expect(last(D1)).toMatchObject({ status: "sending", upload: { phase: "uploading" } });
    up.fail(1, apiError(413, "too_large", "quota"));
    await again;
    expect(last(D1)).toMatchObject({ status: "failed", error: { code: "too_large", reason: "quota" } });
    expect(actions.cancelUpload("tx-1")).toEqual({ ok: true });
    expect(messages(D1)).toHaveLength(3);
  });

  it("upload ok but send failed: retry sends again with the same clientTxn and does not upload again", async () => {
    const sendMessage = vi.fn().mockRejectedValueOnce(apiError(0, "network_error")).mockResolvedValueOnce({ message: wire(D1, 4, ME_ID, "", { kind: "file", attachment: ATT(1) }), duplicate: false });
    const { actions, up, last } = await loaded({ sendMessage });
    const first = actions.sendFile(D1, fakeFile("a"));
    up.finish(0);
    await expect(first).resolves.toMatchObject({ ok: false, error: { code: "network_error" } });
    expect(last(D1)).toMatchObject({ status: "failed", clientTxn: "tx-1", attachment: { id: ATT(1).id } });
    await expect(actions.retrySend("tx-1")).resolves.toMatchObject({ ok: true, clientTxn: "tx-1" });
    expect(up.uploadAttachment).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls[1]).toEqual(sendMessage.mock.calls[0]);
    expect(sendMessage.mock.calls[1][1]).toEqual({ clientTxn: "tx-1", attachmentId: ATT(1).id });
  });

  it("cannot_send on upload fails the file and shows the hold", async () => {
    const { actions, up, last, layer, transport } = await loaded();
    transport.handlers.conversation = (id) => direct(id, ANN, { lastSeq: 3, canSend: { ok: false, reason: "blocked" } });
    actions.sendFile(D1, fakeFile("a"));
    up.fail(0, apiError(403, "cannot_send", "blocked"));
    await settle();
    expect(last(D1)).toMatchObject({ status: "failed", error: { code: "cannot_send", reason: "blocked" } });
    expect(toView(layer.getSnapshot().model).convs[D1].hold).toMatchObject({ reason: "blocked" });
  });

  it("an upload that finishes after I was removed and added again is not posted into the new stay", async () => {
    const sendMessage = vi.fn();
    const { actions, up, transport, messages } = await loaded({ sendMessage });
    const done = actions.sendFile(G1, fakeFile("a"));
    transport.socket.emit({ type: "gone", id: G1 });
    transport.handlers.sync = () => syncOf([direct(D1, ANN, { lastSeq: 3 }), group(G1, { lastSeq: 52 })], [...range(D1, 1, 3), notice(G1, 50, "x", { event: "member_joined", actorId: ANN, principalId: ME_ID }), ...range(G1, 51, 52)]);
    transport.socket.emit({ type: "conversation", id: G1 });
    await settle();
    up.finish(0);
    await expect(done).resolves.toMatchObject({ ok: false, error: { code: "stale" } });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(messages(G1).map((m) => m.seq)).toEqual([50, 51, 52]);
  });

  it("a queued file of an earlier stay is not uploaded", async () => {
    const { actions, up, transport } = await loaded();
    for (const name of ["a", "b", "c"]) actions.sendFile(D1, fakeFile(name));
    const queued = actions.sendFile(G1, fakeFile("d"));
    transport.socket.emit({ type: "gone", id: G1 });
    up.finish(0);
    await expect(queued).resolves.toMatchObject({ ok: false, error: { code: "stale" } });
    expect(up.calls.map((c) => c.file.name)).toEqual(["a", "b", "c"]);
  });

  it("stop() aborts uploads and settles them: failed, retryable after start", async () => {
    const { actions, up, layer, last } = await loaded();
    const running = actions.sendFile(D1, fakeFile("a"));
    const queued = [1, 2, 3].map((n) => actions.sendFile(D1, fakeFile(`q${n}`)));
    layer.stop();
    expect(up.calls[0].signal.aborted).toBe(true);
    await expect(running).resolves.toMatchObject({ ok: false, error: { code: "stopped" } });
    await Promise.all(queued);
    await settle();
    expect(up.calls).toHaveLength(3);
    expect(layer.getSnapshot().model.pending["tx-1"]).toMatchObject({ status: "failed", upload: null, error: { code: "network_error" } });
    layer.start();
    await settle();
    expect(last(D1)).toMatchObject({ status: "failed" });
    actions.retrySend("tx-1");
    expect(up.calls).toHaveLength(4);
    expect(up.calls[3].file.name).toBe("a");
  });

  it("the three slots are free again after stop()", async () => {
    const { actions, up, layer } = await loaded();
    for (const name of ["a", "b", "c"]) actions.sendFile(D1, fakeFile(name));
    layer.stop();
    layer.start();
    await settle();
    actions.sendFile(D1, fakeFile("d"));
    expect(up.calls.map((c) => c.file.name)).toEqual(["a", "b", "c", "d"]);
  });

  it("refuses a conversation I am not in and a non-file", async () => {
    const { actions, up } = await loaded();
    await expect(actions.sendFile("nope", fakeFile("a"))).resolves.toMatchObject({ ok: false, error: { code: "not_found" } });
    await expect(actions.sendFile(D1, null)).resolves.toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(up.uploadAttachment).not.toHaveBeenCalled();
  });

  it("a queued file never merges with a text message of mine that happens to read the same as its caption", async () => {
    const { actions, transport, messages } = await loaded();
    actions.sendFile(D1, fakeFile("a"), { text: "hi" });
    transport.socket.emit({ type: "message", message: wire(D1, 4, ME_ID, "hi") });
    expect(messages(D1).map((m) => m.id)).toEqual(["m1", "m2", "m3", "m4", "tx:tx-1"]);
    expect(messages(D1).at(-1).from).toBe(ME);
  });
});

describe("formatSize", () => {
  it.each([
    [0, "0 B"],
    [932, "932 B"],
    [1024, "1 KB"],
    [1536, "1.5 KB"],
    [12 * 1024 * 1024, "12 MB"],
    [50 * 1024 * 1024, "50 MB"],
    [3.25 * 1024 ** 3, "3.3 GB"],
  ])("%s → %s", (n, text) => expect(formatSize(n)).toBe(text));
});
