// Shared builders for the data-layer tests: service-shaped payloads, a fake transport, fake timers.
import { vi } from "vitest";
import { ApiError } from "../src/api/http.js";

export const ME_ID = "00000000-0000-4000-8000-0000000000a1";
export const ANN = "00000000-0000-4000-8000-0000000000a2";
export const BO = "00000000-0000-4000-8000-0000000000a3";
export const D1 = "00000000-0000-4000-8000-0000000000c1"; // direct chat with ANN
export const G1 = "00000000-0000-4000-8000-0000000000c2"; // group: me, ANN, BO

/** A local-time timestamp on 2026-11-16, `minute` minutes after 09:00. */
export function at(minute) {
  return new Date(2026, 10, 16, 9, minute).toISOString();
}

export function wire(conversationId, seq, senderId, text = `m${seq}`, extra = {}) {
  return { conversationId, seq, senderId, kind: "text", text, createdAt: at(seq), ...extra };
}

export function notice(conversationId, seq, text, system) {
  return { conversationId, seq, senderId: null, kind: "system", text, system, createdAt: at(seq) };
}

export const principal = (id, handle, displayName) => ({ id, handle, displayName, kind: "human" });

export const PRINCIPALS = [principal(ME_ID, "me_one", "Mei"), principal(ANN, "ann", "小安"), principal(BO, "bo", "阿波")];

export function direct(id = D1, peerId = ANN, fields = {}) {
  return {
    id,
    type: "direct",
    title: null,
    myRole: "speaker",
    closed: false,
    peerId,
    canSend: { ok: true },
    members: [
      { id: ME_ID, role: "speaker", isCreator: false },
      { id: peerId, role: "speaker", isCreator: false },
    ],
    lastSeq: 0,
    readSeq: 0,
    unread: 0,
    peerReadSeq: 0,
    ...fields,
  };
}

export function group(id = G1, fields = {}) {
  return {
    id,
    type: "group",
    title: "周末小组",
    creatorId: ME_ID,
    myRole: "speaker",
    closed: false,
    canSend: { ok: true },
    members: [
      { id: ME_ID, role: "speaker", isCreator: true },
      { id: ANN, role: "speaker", isCreator: false },
      { id: BO, role: "speaker", isCreator: false },
    ],
    lastSeq: 0,
    readSeq: 0,
    unread: 0,
    ...fields,
  };
}

export const ME = { id: ME_ID, handle: "me_one", displayName: "Mei", email: "me@example.test" };

export function syncOf(conversations, messages = [], principals = PRINCIPALS) {
  return { me: ME, conversations, principals, messages };
}

/** Messages seq from..to (inclusive) in one conversation, alternating senders. */
export function range(conversationId, from, to, senders = [ANN]) {
  const out = [];
  for (let seq = from; seq <= to; seq += 1) out.push(wire(conversationId, seq, senders[seq % senders.length]));
  return out;
}

export const emptySocial = () => ({ friends: [], incoming: [], outgoing: [], blocked: [], blockedBy: [] });

export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets every pending promise continuation run. */
export const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

export const apiError = (status, code, reason = null) => new ApiError(status, code, reason);

/** Deterministic timers: nothing runs until `advance(ms)`. */
export function fakeTimers() {
  let now = 0;
  let nextId = 1;
  const tasks = new Map();
  const timers = {
    now: () => now,
    setTimeout(fn, ms) {
      const id = nextId++;
      tasks.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout(id) {
      tasks.delete(id);
    },
    setInterval(fn, ms) {
      const id = nextId++;
      tasks.set(id, { at: now + ms, fn, every: ms });
      return id;
    },
    clearInterval(id) {
      tasks.delete(id);
    },
    /** Number of scheduled timeouts and intervals. */
    pending: () => tasks.size,
    /** Delays (ms from now) of the scheduled tasks. */
    delays: () => [...tasks.values()].map((t) => t.at - now),
    advance(ms) {
      const end = now + ms;
      for (;;) {
        let id = null;
        let task = null;
        for (const [k, t] of tasks) if (t.at <= end && (!task || t.at < task.at)) [id, task] = [k, t];
        if (!task) break;
        now = task.at;
        if (task.every) task.at += task.every;
        else tasks.delete(id);
        task.fn();
      }
      now = end;
    },
  };
  return timers;
}

/**
 * A transport whose answers come from `handlers` (each may return a value, a promise, or throw).
 * `log` records every call in order; `sockets` every socket opened.
 */
export function fakeTransport(handlers = {}) {
  const t = {
    log: [],
    sockets: [],
    /** When false, `connect` waits until the test calls `socket.open()` (or `socket.fail(err)`). */
    autoOpen: true,
    handlers: {
      sync: () => syncOf([]),
      catchUp: () => ({ messages: [], gone: [], more: false }),
      conversation: () => {
        throw apiError(404, "not_found");
      },
      social: () => emptySocial(),
      ticket: () => undefined,
      ...handlers,
    },
    get socket() {
      return t.sockets[t.sockets.length - 1];
    },
    connect(callbacks) {
      t.log.push("connect");
      const opening = deferred();
      const socket = {
        callbacks,
        closed: false,
        close() {
          socket.closed = true;
        },
        emit(event) {
          callbacks.onEvent(event);
        },
        /** The server (or the network) closes the socket. */
        drop(code) {
          socket.closed = true;
          callbacks.onClose(code);
        },
        open: () => opening.resolve(socket),
        fail: (err) => opening.reject(err),
      };
      t.sockets.push(socket);
      try {
        t.handlers.ticket();
      } catch (err) {
        return Promise.reject(err);
      }
      if (t.autoOpen) socket.open();
      return opening.promise;
    },
    getSync() {
      t.log.push("sync");
      return Promise.resolve().then(() => t.handlers.sync());
    },
    catchUp(positions) {
      t.log.push(["catchup", { ...positions }]);
      return Promise.resolve().then(() => t.handlers.catchUp(positions));
    },
    getConversation(id) {
      t.log.push(["conversation", id]);
      return Promise.resolve().then(() => t.handlers.conversation(id));
    },
    getSocial() {
      t.log.push("social");
      return Promise.resolve().then(() => t.handlers.social());
    },
  };
  return t;
}

/** A File of `size` bytes without allocating them (a File's size is read-only, so the property is redefined). */
export function fakeFile(name, size = 10, type = "application/octet-stream") {
  const file = new File(["x"], name, { type });
  Object.defineProperty(file, "size", { value: size });
  return file;
}

export const ATT = (n, fields = {}) => ({ id: `00000000-0000-4000-8000-00000000f${String(n).padStart(3, "0")}`, name: `f${n}.bin`, size: 10, inline: false, ...fields });

/**
 * A controllable `uploadAttachment` for the data layer's api: every call is recorded in `calls` and stays open until
 * the test calls `finish(i, attachment)`, `fail(i, error)` or `progress(i, fraction)`; aborting rejects like the real one.
 */
export function fakeUploads() {
  const calls = [];
  const uploadAttachment = vi.fn((conversationId, file, { onProgress, signal } = {}) => {
    const d = deferred();
    const call = { conversationId, file, onProgress, signal, ...d, settled: false };
    signal?.addEventListener("abort", () => d.reject(new ApiError(0, "aborted")));
    calls.push(call);
    return d.promise;
  });
  return {
    uploadAttachment,
    calls,
    progress: (i, fraction) => calls[i].onProgress?.(fraction),
    finish: (i, attachment) => calls[i].resolve(attachment ?? ATT(i + 1, { name: calls[i].file.name, size: calls[i].file.size })),
    fail: (i, error) => calls[i].reject(error),
  };
}
