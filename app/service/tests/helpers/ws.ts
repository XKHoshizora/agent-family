import type { FastifyInstance } from "fastify";
import net, { type AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import WebSocket from "ws";
import { api } from "./actors.ts";

/** The APP_ORIGIN `useApp()` configures; a browser on the web client sends exactly this. */
export const APP_ORIGIN = "http://localhost:5173";

/** A push as the client receives it (parsed JSON). */
export type Push = { type: string; [field: string]: any };

const listening = new WeakMap<object, Promise<number>>();

/** Makes the app listen on an ephemeral port on 127.0.0.1 (once per server); returns its base URLs. */
export async function listen(app: FastifyInstance): Promise<{ http: string; ws: string; port: number }> {
  const server = app.server;
  let port = listening.get(server);
  if (!port) {
    port = (async () => {
      if (!server.listening) await app.listen({ port: 0, host: "127.0.0.1" });
      return (server.address() as AddressInfo).port;
    })();
    listening.set(server, port);
  }
  const p = await port;
  return { http: `http://127.0.0.1:${p}`, ws: `ws://127.0.0.1:${p}`, port: p };
}

/** POST /api/ws-ticket as `actor`; throws unless 200. */
export async function issueTicket(app: FastifyInstance, actor: { cookie: string }): Promise<string> {
  const res = await api<{ ticket: string }>(app, actor, "POST", "/api/ws-ticket");
  if (res.status !== 200) throw new Error(`ticket: ${res.status} ${JSON.stringify(res.json)}`);
  return res.json.ticket;
}

const open = new Set<TestSocket>();

/** An open client socket that records every push it receives. */
export class TestSocket {
  readonly events: Push[] = [];
  /** Resolves with the close code and reason once the socket is closed (by either side). */
  readonly closed: Promise<{ code: number; reason: string }>;
  private readonly waiters = new Set<() => void>();
  isClosed = false;

  constructor(readonly ws: WebSocket) {
    open.add(this);
    ws.on("message", (data) => {
      this.events.push(JSON.parse(String(data)) as Push);
      for (const w of [...this.waiters]) w();
    });
    this.closed = new Promise((resolve) => {
      ws.on("close", (code, reason) => {
        this.isClosed = true;
        open.delete(this);
        resolve({ code, reason: reason.toString() });
        for (const w of [...this.waiters]) w();
      });
    });
    ws.on("error", () => {}); // a refused or reset socket reports through `closed`
  }

  /**
   * Index of the first event at or after `from` matching `pred`, waiting up to `timeoutMs` for it.
   * Rejects with every event received so far when it does not come (or the socket closes first).
   */
  waitFor(pred: (e: Push) => boolean, { from = 0, timeoutMs = 5000 }: { from?: number; timeoutMs?: number } = {}): Promise<number> {
    return new Promise((resolve, reject) => {
      const check = (): boolean => {
        const i = this.events.findIndex((e, idx) => idx >= from && pred(e));
        if (i >= 0) {
          done();
          resolve(i);
          return true;
        }
        if (this.isClosed) {
          done();
          reject(new Error(`socket closed before the event came; got ${JSON.stringify(this.events)}`));
          return true;
        }
        return false;
      };
      const timer = setTimeout(() => {
        done();
        reject(new Error(`timed out waiting for an event; got ${JSON.stringify(this.events)}`));
      }, timeoutMs);
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(waiter);
      };
      const waiter = () => void check();
      this.waiters.add(waiter);
      check();
    });
  }

  /** The matching event itself (see `waitFor`). */
  async next(pred: (e: Push) => boolean, opts?: { from?: number; timeoutMs?: number }): Promise<Push> {
    return this.events[await this.waitFor(pred, opts)]!;
  }

  send(data: string | Buffer, opts: { binary?: boolean } = {}): void {
    this.ws.send(data, { binary: opts.binary ?? false });
  }

  close(): void {
    if (!this.isClosed) this.ws.close();
  }
}

export interface UpgradeOptions {
  ticket?: string | null;
  /** `null` sends no Origin header. */
  origin?: string | null;
  headers?: Record<string, string>;
}

/**
 * Tries to open `/api/ws`. Resolves with the socket when the server upgrades, or with the HTTP status
 * it refused the upgrade with.
 */
export async function tryConnect(
  app: FastifyInstance,
  { ticket, origin = APP_ORIGIN, headers = {} }: UpgradeOptions,
): Promise<{ socket: TestSocket } | { status: number }> {
  const { ws: base } = await listen(app);
  const url = ticket === undefined || ticket === null ? `${base}/api/ws` : `${base}/api/ws?ticket=${encodeURIComponent(ticket)}`;
  const ws = new WebSocket(url, { headers, ...(origin === null ? {} : { origin }) });
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve({ socket: new TestSocket(ws) }));
    ws.once("unexpected-response", (_req, res) => {
      resolve({ status: res.statusCode ?? 0 });
      res.resume();
      ws.terminate();
    });
    ws.once("error", (err) => reject(err));
  });
}

/** Opens an authenticated socket for `actor` through the ticket flow. */
export async function connect(app: FastifyInstance, actor: { cookie: string }): Promise<TestSocket> {
  const result = await tryConnect(app, { ticket: await issueTicket(app, actor) });
  if (!("socket" in result)) throw new Error(`connect: upgrade refused with ${result.status}`);
  return result.socket;
}

/** Closes every socket the helpers opened (call from afterEach). */
export async function closeAllSockets(): Promise<void> {
  const sockets = [...open];
  for (const s of sockets) s.close();
  await Promise.all(sockets.map((s) => s.closed));
}

/** A raw TCP connection upgraded to a WebSocket by hand, for sending bytes no client library would. */
export interface RawSocket {
  socket: net.Socket;
  /** Bytes received after the 101 response. */
  received(): Buffer;
  /** Resolves when the server has closed the TCP connection. */
  ended: Promise<void>;
}

export async function rawUpgrade(app: FastifyInstance, ticket: string, origin: string = APP_ORIGIN): Promise<RawSocket> {
  const { port } = await listen(app);
  const socket = net.connect({ port, host: "127.0.0.1" });
  let buffer = Buffer.alloc(0);
  let upgraded = false;
  const ended = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  socket.on("error", () => {});
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => {
      socket.write(
        [
          `GET /api/ws?ticket=${encodeURIComponent(ticket)} HTTP/1.1`,
          `Host: 127.0.0.1:${port}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`,
          "Sec-WebSocket-Version: 13",
          `Origin: ${origin}`,
          "",
          "",
        ].join("\r\n"),
      );
    });
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (upgraded) return;
      const end = buffer.indexOf("\r\n\r\n");
      if (end < 0) return;
      const head = buffer.subarray(0, end).toString();
      buffer = buffer.subarray(end + 4);
      if (!head.startsWith("HTTP/1.1 101")) return reject(new Error(`raw upgrade refused: ${head.split("\r\n")[0]}`));
      upgraded = true;
      resolve();
    });
    socket.once("close", () => {
      if (!upgraded) reject(new Error("raw upgrade: connection closed"));
    });
  });
  return { socket, received: () => buffer, ended };
}
