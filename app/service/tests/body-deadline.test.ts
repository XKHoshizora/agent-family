import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import { api, befriend, signUp } from "./helpers/actors.ts";
import { useProbeBlobs } from "./helpers/blobs.ts";
import { useApp } from "./helpers/harness.ts";
import { CLOSING, MULTIPART, destroyOpenRequests, openRequest, partHead } from "./helpers/multipart.ts";
import { closeAllSockets, connect, listen } from "./helpers/ws.ts";

// A request must arrive whole within the body deadline; an upload that has been let in keeps its own deadlines.
const BODY_MS = 600;
const UPLOAD_IDLE_MS = 1000;
const UPLOAD_TOTAL_MS = 5000;
const CONNECTION_IDLE_MS = 2000;

const { blobs } = useProbeBlobs("af-body-deadline-");
const { app } = useApp({
  blobs,
  env: {
    HTTP_BODY_TIMEOUT_MS: String(BODY_MS),
    UPLOAD_IDLE_TIMEOUT_MS: String(UPLOAD_IDLE_MS),
    UPLOAD_TOTAL_TIMEOUT_MS: String(UPLOAD_TOTAL_MS),
    HTTP_CONNECTION_TIMEOUT_MS: String(CONNECTION_IDLE_MS),
  },
});

const sockets = new Set<net.Socket>();
afterEach(async () => {
  for (const s of sockets) s.destroy();
  sockets.clear();
  destroyOpenRequests();
  await closeAllSockets();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const PNG = Buffer.concat([
  Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"),
  Buffer.from("00000001000000010806000000", "hex"),
  Buffer.from("1f15c4890000000d49444154789c6360000002000001e221bc330000000049454e44ae426082", "hex"),
]);

/** A raw connection on the app's port; resolves `closed` with the time the server closed it. */
async function rawConnection() {
  const { port } = await listen(app);
  const socket = net.connect({ port, host: "127.0.0.1" });
  sockets.add(socket);
  socket.on("error", () => {});
  let received = "";
  socket.on("data", (d) => (received += d.toString("latin1")));
  const closed = new Promise<number>((resolve) => socket.once("close", () => resolve(performance.now())));
  await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
  return { socket, port, closed, received: () => received };
}

/**
 * Sends a request head promising a 100 000-byte body, then one byte of it every 150 ms (never idle long enough
 * for an idle timeout). Resolves with how long after the head the server closed the connection, or with
 * `Infinity` if it still had not after `giveUpMs`.
 */
async function trickle(
  method: string,
  path: string,
  {
    contentType = "application/json",
    cookie,
    headers = [],
    giveUpMs = 5000,
  }: { contentType?: string; cookie?: string; headers?: string[]; giveUpMs?: number } = {},
): Promise<{ heldMs: number; answer: string }> {
  const c = await rawConnection();
  const head = [`${method} ${path} HTTP/1.1`, `Host: 127.0.0.1:${c.port}`, `Content-Type: ${contentType}`, "Content-Length: 100000", ...headers];
  if (cookie) head.push(`Cookie: ${cookie}`);
  c.socket.write(`${head.join("\r\n")}\r\n\r\n{`);
  const start = performance.now();
  const timer = setInterval(() => c.socket.write(" "), 150);
  try {
    const closedAt = await Promise.race([c.closed, sleep(giveUpMs).then(() => Infinity)]);
    return { heldMs: closedAt - start, answer: c.received().split("\r\n")[0] ?? "" };
  } finally {
    clearInterval(timer);
  }
}

describe("body deadline", () => {
  it("a body that trickles in is cut off at the deadline, signed in or not, on a known route or not", async () => {
    const a = await signUp(app, "alice");
    for (const [method, path] of [
      ["POST", "/api/sync/catchup"],
      ["POST", "/api/auth/sign-in/email"],
      ["POST", "/api/register"],
      ["POST", "/api/no-such-route"],
      ["PATCH", `/api/conversations/${a.id}`],
    ] as const) {
      const { heldMs } = await trickle(method, path);
      expect([method, path, heldMs >= BODY_MS - 50]).toEqual([method, path, true]);
      expect([method, path, heldMs < BODY_MS + 2000]).toEqual([method, path, true]);
    }
    expect((await api(app, a, "GET", "/api/me")).status).toBe(200);
  });

  it("also when the request was refused before any route or hook ran: foreign Origin, undecodable path, over-long parameter", async () => {
    const evil = ["Origin: http://evil.example"];
    const cases: Array<[string, string, string[], string]> = [
      ["POST", "/api/sync/catchup", evil, "HTTP/1.1 403"],
      ["POST", "/api/register", evil, "HTTP/1.1 403"],
      ["POST", "/api/%zz", [], "HTTP/1.1 400"],
      ["POST", `/api/conversations/${"a".repeat(150)}`, [], "HTTP/1.1 414"],
      ["PUT", "/api/health", [], ""], // no such method on that path: the not-found handler waits for the body first
    ];
    for (const [method, path, headers, refusal] of cases) {
      const { heldMs, answer } = await trickle(method, path, { headers });
      const label = `${method} ${path.slice(0, 40)} ${headers.join(" ")}`;
      expect([label, answer.startsWith(refusal), heldMs >= BODY_MS - 50, heldMs < BODY_MS + 2000]).toEqual([label, true, true, true]);
    }
  });

  it("applies to the upload routes too until an upload is let in: not signed in, or refused before the body is read", async () => {
    const [a, b, c] = [await signUp(app, "alice"), await signUp(app, "bob"), await signUp(app, "carol")];
    const { conversationId: dm } = await befriend(app, a, b);
    const cases: Array<[string, string, string, string | undefined]> = [
      ["PUT", "/api/me/avatar", "image/png", undefined], // not signed in
      ["POST", `/api/conversations/${dm}/attachments`, MULTIPART, undefined], // not signed in
      ["POST", `/api/conversations/${dm}/attachments`, MULTIPART, c.cookie], // not a member: 404 before the body
    ];
    for (const [method, path, contentType, cookie] of cases) {
      const { heldMs } = await trickle(method, path, { contentType, ...(cookie ? { cookie } : {}) });
      const label = `${method} ${path} ${cookie ? "signed in" : "signed out"}`;
      expect([label, heldMs >= BODY_MS - 50, heldMs < BODY_MS + 2000]).toEqual([label, true, true]);
    }
  });

  it("does not touch a request whose body arrives in time, nor the connection it leaves open afterwards", async () => {
    const c = await rawConnection();
    const body = JSON.stringify({ email: "nobody@example.test", password: "not the password" });
    const request = [
      "POST /api/auth/sign-in/email HTTP/1.1",
      `Host: 127.0.0.1:${c.port}`,
      "Content-Type: application/json",
      `Content-Length: ${Buffer.byteLength(body)}`,
      "",
      body,
    ].join("\r\n");
    c.socket.write(request);
    await expect.poll(() => c.received(), { timeout: 3000 }).toMatch(/^HTTP\/1\.1 401/);
    // Kept alive and quiet for longer than the body deadline (but not the connection's idle timeout): still usable.
    await sleep(BODY_MS * 1.5);
    c.socket.write(request);
    await expect.poll(() => c.received().match(/HTTP\/1\.1 401/g)?.length ?? 0, { timeout: 3000 }).toBe(2);
  });

  it("a slow attachment upload is governed by the upload deadlines, not the body deadline", async () => {
    const [a, b] = [await signUp(app, "alice"), await signUp(app, "bob")];
    const { conversationId: dm } = await befriend(app, a, b);
    const open = await openRequest(app, { path: `/api/conversations/${dm}/attachments`, cookie: a.cookie });
    await open.write(partHead({ name: "file", filename: "slow.txt", type: "text/plain" }));
    const started = performance.now();
    while (performance.now() - started < BODY_MS * 2.5) {
      await open.write("slow but steady\n");
      await sleep(UPLOAD_IDLE_MS / 4);
    }
    await open.write(CLOSING);
    await open.end();
    expect((await open.response).status).toBe(201);
  });

  it("a slow avatar upload is not cut off by the body deadline either", async () => {
    const a = await signUp(app, "alice");
    const open = await openRequest(app, { path: "/api/me/avatar", cookie: a.cookie, contentType: "image/png", method: "PUT" });
    const started = performance.now();
    let at = 0;
    while (at < PNG.length) {
      await open.write(PNG.subarray(at, at + 8));
      at += 8;
      if (performance.now() - started < BODY_MS * 2) await sleep(BODY_MS / 4);
    }
    expect(performance.now() - started).toBeGreaterThan(BODY_MS * 1.5);
    await open.end();
    expect((await open.response).status).toBe(200);
  });

  it("a WebSocket stays open past the body deadline", async () => {
    const a = await signUp(app, "alice");
    const socket = await connect(app, a);
    await sleep(BODY_MS * 2);
    expect(socket.isClosed).toBe(false);
    socket.send(JSON.stringify({ type: "ping" }));
    expect(await socket.next((e) => e.type === "pong")).toEqual({ type: "pong" });
  });

  it("is HTTP_BODY_TIMEOUT_MS, 30 seconds unless set", () => {
    const base = { DATABASE_URL: "postgres://x", APP_ORIGIN: "http://localhost:5173", AUTH_SECRET: "x".repeat(32) };
    expect(loadConfig(base).httpBodyTimeoutMs).toBe(30_000);
    expect(loadConfig({ ...base, HTTP_BODY_TIMEOUT_MS: "1500" }).httpBodyTimeoutMs).toBe(1500);
    for (const bad of ["0", "-1", "soon"]) expect(() => loadConfig({ ...base, HTTP_BODY_TIMEOUT_MS: bad })).toThrow(/HTTP_BODY_TIMEOUT_MS/);
  });
});
