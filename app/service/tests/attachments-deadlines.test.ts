import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.ts";
import { api, befriend, signUp, type Actor } from "./helpers/actors.ts";
import { useProbeBlobs } from "./helpers/blobs.ts";
import { useApp } from "./helpers/harness.ts";
import { BOUNDARY, CLOSING, MULTIPART, multipart, destroyOpenRequests, openRequest, partHead } from "./helpers/multipart.ts";
import { closeAllSockets, connect, listen } from "./helpers/ws.ts";

const IDLE_MS = 400;
const TOTAL_MS = 2000;
const CONNECTION_IDLE_MS = 800;

const { blobs, probe, files: blobFiles, putStarted } = useProbeBlobs("af-att-deadline-");
const { app, db } = useApp({
  blobs,
  env: {
    UPLOAD_IDLE_TIMEOUT_MS: String(IDLE_MS),
    UPLOAD_TOTAL_TIMEOUT_MS: String(TOTAL_MS),
    HTTP_CONNECTION_TIMEOUT_MS: String(CONNECTION_IDLE_MS),
  },
});
afterEach(async () => {
  destroyOpenRequests();
  await closeAllSockets();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const count = async (sql: string) => Number((await db.query<{ n: string }>(sql)).rows[0]!.n);

async function pair(): Promise<{ a: Actor; dm: string }> {
  const [a, b] = [await signUp(app, "alice"), await signUp(app, "bob")];
  const { conversationId: dm } = await befriend(app, a, b);
  return { a, dm };
}

/** Starts a real upload, writes its part head and `bytes` of file, and waits until the server is storing it. */
async function startUpload(a: Actor, dm: string, bytes: number) {
  const started = putStarted();
  const open = await openRequest(app, { path: `/api/conversations/${dm}/attachments`, cookie: a.cookie });
  await open.write(partHead({ name: "file", filename: "slow.bin", type: "application/octet-stream" }));
  await open.fill(bytes);
  await started;
  return open;
}

/** Waits until the cut-off upload's cleanup is done: nothing on disk, nothing held, no row. */
async function nothingLeft(): Promise<void> {
  await vi.waitFor(
    async () => {
      expect(blobFiles()).toEqual([]);
      expect(await count("select count(*) n from pending_blobs")).toBe(0);
    },
    { timeout: 5000 },
  );
  expect(await count("select count(*) n from attachments")).toBe(0);
}

describe("upload deadlines", () => {
  it("a stalled mid-file upload is cut off after the idle deadline and leaves no blob or .part", async () => {
    const { a, dm } = await pair();
    const open = await startUpload(a, dm, 64 * 1024);
    const stalledAt = Date.now(); // every byte written so far is flushed; the server sees them later still
    await vi.waitFor(() => expect(blobFiles()).toEqual([`${probe.puts[0]!.key}.part`]), { timeout: IDLE_MS / 2, interval: 5 });
    // The client sends nothing more; the server drops the connection.
    await expect(open.response).rejects.toThrow();
    expect(Date.now() - stalledAt).toBeGreaterThanOrEqual(IDLE_MS - 50);
    expect(Date.now() - stalledAt).toBeLessThan(TOTAL_MS);
    await nothingLeft();
    expect(probe.puts[0]!.outcome).toBe("failed");
  });

  it("a stall after the file part's closing boundary is cut off and leaves no blob and no row", async () => {
    const { a, dm } = await pair();
    const open = await startUpload(a, dm, 64 * 1024);
    // The delimiter that ends the file part, then nothing (not even the "--" that would end the body):
    // the file is complete on disk and the server waits for whatever comes next.
    await open.write(`\r\n--${BOUNDARY}`);
    await vi.waitFor(() => expect(probe.puts[0]!.outcome).toBe("stored"));
    expect(blobFiles()).toEqual([probe.puts[0]!.key]);
    await expect(open.response).rejects.toThrow();
    await nothingLeft();
  });

  it("a client that keeps trickling bytes is cut off at the total deadline", async () => {
    const { a, dm } = await pair();
    const startedAt = Date.now();
    const open = await startUpload(a, dm, 1024);
    let cut = false;
    open.response.catch(() => (cut = true));
    while (!cut && Date.now() - startedAt < 4 * TOTAL_MS) {
      await open.write(Buffer.alloc(512, 0x61)).catch(() => {});
      await sleep(IDLE_MS / 3); // never idle long enough for the idle deadline
    }
    expect(cut).toBe(true);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(TOTAL_MS - 50);
    await nothingLeft();
  });

  it("a handler whose client vanished before the body was read settles and lets go of everything", async () => {
    const { a, dm } = await pair();
    const { port } = await listen(app);
    const blocker = await db.pool.connect();
    try {
      // Hold the handler in the pre-check (recording the blob key waits for this lock) while the client leaves.
      await blocker.query("begin");
      await blocker.query("lock table pending_blobs in exclusive mode");
      const socket = net.connect({ port, host: "127.0.0.1" });
      socket.on("error", () => {});
      await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
      const head = [
        `POST /api/conversations/${dm}/attachments HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        `Cookie: ${a.cookie}`,
        `Content-Type: ${MULTIPART}`,
        "Content-Length: 1048576",
      ].join("\r\n");
      socket.write(`${head}\r\n\r\n${partHead({ name: "file", filename: "x.bin", type: "application/octet-stream" })}abc`);
      await vi.waitFor(() => expect(app.deps.uploads.inProgress(a.id)).toBe(1));
      socket.destroy();
      await vi.waitFor(() => expect(app.deps.uploads.inProgress(a.id)).toBe(0));
      await blocker.query("commit");
    } finally {
      blocker.release();
    }
    await nothingLeft();
    expect(probe.puts).toEqual([]); // nothing was ever written
  });

  it("a normal upload still succeeds, also one that pauses for less than the idle deadline", async () => {
    const { a, dm } = await pair();
    const quick = await app.inject({
      method: "POST",
      url: `/api/conversations/${dm}/attachments`,
      headers: { cookie: a.cookie, "content-type": MULTIPART },
      payload: multipart([{ name: "file", filename: "a.txt", type: "text/plain", data: "hello" }]),
    });
    expect(quick.statusCode).toBe(201);

    const open = await startUpload(a, dm, 16 * 1024);
    for (let i = 0; i < 4; i++) {
      await sleep(IDLE_MS / 3);
      await open.fill(16 * 1024);
    }
    await open.write(CLOSING);
    await open.end();
    const res = await open.response;
    expect(res.status).toBe(201);
    expect(JSON.parse(res.body).size).toBe(5 * 16 * 1024);
    expect(await count("select count(*) n from pending_blobs")).toBe(0);
    expect(await count("select count(*) n from attachments")).toBe(2);
  });
});

describe("server-wide timeouts", () => {
  it("leave an idle WebSocket open past the connection idle timeout", async () => {
    const { a } = await pair();
    const socket = await connect(app, a);
    await sleep(CONNECTION_IDLE_MS * 2.5);
    expect(socket.isClosed).toBe(false);
    socket.send(JSON.stringify({ type: "ping" }));
    expect(await socket.next((e) => e.type === "pong")).toEqual({ type: "pong" });
    expect((await api(app, a, "GET", "/api/me")).status).toBe(200);
  });

  it("are configured, and may never cut off an upload before its own deadlines do", () => {
    const base = { DATABASE_URL: "postgres://x", APP_ORIGIN: "http://localhost:5173", AUTH_SECRET: "x".repeat(32) };
    expect(loadConfig(base)).toMatchObject({
      uploadIdleTimeoutMs: 45_000,
      uploadTotalTimeoutMs: 15 * 60_000,
      httpConnectionTimeoutMs: 120_000,
      httpRequestTimeoutMs: 16 * 60_000,
      httpKeepAliveTimeoutMs: 72_000,
    });
    expect(app.server.requestTimeout).toBe(TOTAL_MS + 60_000);
    expect(app.server.keepAliveTimeout).toBe(72_000);
    expect(app.server.timeout).toBe(CONNECTION_IDLE_MS);
    expect(() => loadConfig({ ...base, HTTP_CONNECTION_TIMEOUT_MS: "45000" })).toThrow(/HTTP_CONNECTION_TIMEOUT_MS/);
    expect(() => loadConfig({ ...base, HTTP_REQUEST_TIMEOUT_MS: "900000" })).toThrow(/HTTP_REQUEST_TIMEOUT_MS/);
    expect(loadConfig({ ...base, HTTP_REQUEST_TIMEOUT_MS: "", UPLOAD_TOTAL_TIMEOUT_MS: "1000" }).httpRequestTimeoutMs).toBe(61_000);
  });
});
