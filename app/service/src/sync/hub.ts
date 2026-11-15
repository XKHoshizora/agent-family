import type { WebSocket } from "@fastify/websocket";
import type { FastifyBaseLogger } from "fastify";
import type { ConversationEvents } from "../conversations/events.ts";
import { currentMemberIds, peekConversation } from "../conversations/store.ts";
import type { Queryable } from "../db.ts";
import { MESSAGE_COLUMNS, toStored, type MessageRow, type StoredMessage, type WireMessage } from "../messages/model.ts";
import { toWireForReaders, type ReadEvents, type ReadMarker } from "../messages/read.ts";
import { liveSessions } from "../session.ts";
import type { SocialEvents } from "../social/events.ts";
import type { TicketOwner } from "./tickets.ts";

/** A principal's 6th socket closes its oldest. */
export const MAX_SOCKETS_PER_PRINCIPAL = 5;
/** WebSocket-level ping interval; a socket that has not answered the previous ping by the next one is dropped. */
export const HEARTBEAT_MS = 30_000;
/** A socket with this much unsent data cannot keep up; it is closed and its client catches up instead. */
export const MAX_BUFFERED_BYTES = 1024 * 1024;
/** At most this many messages of one conversation go out in one fan-out step; older ones are left to catch-up. */
const FANOUT_MAX_RANGE = 200;
/** How many conversations' "last pushed seq" are remembered (least recently active forgotten first). */
const REMEMBERED_CONVERSATIONS = 10_000;

export const CLOSE_CODES = {
  /** Sign-out, password reset, or the session expired. */
  sessionEnded: 4001,
  /** The principal opened a sixth socket; this was the oldest. */
  replaced: 4002,
  /** The client did not read its pushes fast enough. */
  tooSlow: 4003,
  /** A binary frame (the protocol is JSON text). */
  unsupportedData: 1003,
  /** The server could not confirm the session. */
  internalError: 1011,
} as const;

/** Everything the server ever sends on a socket. */
export type PushEvent =
  | { type: "message"; message: WireMessage }
  | { type: "conversation"; id: string }
  | { type: "gone"; id: string }
  | { type: "social" }
  | { type: "read"; conversationId: string; principalId: string; seq: number }
  | { type: "pong" };

export interface Connection {
  readonly ws: WebSocket;
  readonly principalId: string;
  readonly sessionId: string;
  /** Answered the last WebSocket ping. */
  alive: boolean;
}

/** One unit of delivery work for a conversation; a conversation's tasks run strictly one after another. */
type Task =
  | { kind: "messages"; fromSeq: number; toSeq: number }
  | { kind: "membership"; principalIds: string[] }
  | { kind: "read"; marker: ReadMarker };

interface Queue {
  tasks: Task[];
  running: boolean;
}

export interface HubDeps {
  db: Queryable;
  conversations: ConversationEvents;
  social: SocialEvents;
  reads: ReadEvents;
  log: Pick<FastifyBaseLogger, "error">;
}

/**
 * The in-process registry of open sockets and the delivery of push events to them. Single instance only:
 * a second process would neither see these sockets nor receive these events (see README).
 *
 * Every conversation event is delivered through that conversation's queue, so each socket receives one
 * conversation's events in commit order. Every decision about who receives what is made against the
 * database when the event is delivered, never from a cached member list:
 * - messages: rendered per reader with `toWireForReaders`, which shows a message (and its quote) only to
 *   readers who can see it now;
 * - membership changes: `conversation` to the affected principals who are current members now, `gone`
 *   to those who are not (more than once, when a change announced before they left is delivered after
 *   it) — so after `gone` nothing more of that conversation reaches them until they are added again;
 * - read markers: only in direct chats, to its current members.
 */
export class Hub {
  /** Open connections per principal, oldest first. */
  private readonly byPrincipal = new Map<string, Connection[]>();
  private readonly bySession = new Map<string, Set<Connection>>();
  private readonly queues = new Map<string, Queue>();
  /** The last seq fanned out per conversation. */
  private readonly fanned = new Map<string, number>();
  private readonly unsubscribe: Array<() => void> = [];
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(private readonly deps: HubDeps) {}

  /** Subscribes to the event registries and starts the heartbeat. */
  start(): void {
    const { conversations, social, reads, log } = this.deps;
    this.unsubscribe.push(
      conversations.onMessages((messages) => this.onMessages(messages)),
      conversations.onMembershipChanged((id, principalIds) => this.enqueue(id, { kind: "membership", principalIds })),
      reads.onRead((marker) => this.enqueue(marker.conversationId, { kind: "read", marker })),
      social.on((principalIds) => {
        for (const id of new Set(principalIds)) this.push(id, { type: "social" });
      }),
    );
    this.timer = setInterval(() => void this.tick().catch((err) => log.error({ err }, "realtime heartbeat failed")), HEARTBEAT_MS);
    this.timer.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    for (const off of this.unsubscribe.splice(0)) off();
  }

  /** Registers an upgraded socket; closes the principal's oldest socket if this is one too many. */
  attach(ws: WebSocket, owner: TicketOwner): Connection {
    const principalId = owner.principalId.toLowerCase();
    const conn: Connection = { ws, principalId, sessionId: owner.sessionId, alive: true };
    for (;;) {
      const existing = this.byPrincipal.get(principalId);
      if (!existing || existing.length < MAX_SOCKETS_PER_PRINCIPAL) break;
      this.drop(existing[0]!, CLOSE_CODES.replaced, "replaced");
    }
    const list = this.byPrincipal.get(principalId) ?? [];
    list.push(conn);
    this.byPrincipal.set(principalId, list);
    const sessions = this.bySession.get(conn.sessionId) ?? new Set();
    sessions.add(conn);
    this.bySession.set(conn.sessionId, sessions);

    ws.on("pong", () => {
      conn.alive = true;
    });
    ws.on("close", () => this.forget(conn));
    return conn;
  }

  /**
   * Closes the socket if its session no longer exists. Called right after `attach`: a session that ended
   * before the socket was registered is caught here, one that ends later by `endSession`.
   */
  async confirmSession(conn: Connection): Promise<void> {
    const live = await liveSessions(this.deps.db, [conn.sessionId]);
    if (!live.has(conn.sessionId)) this.drop(conn, CLOSE_CODES.sessionEnded, "session_ended");
  }

  /** Closes every socket opened with this session (sign-out; password reset ends each session in turn). */
  endSession(sessionId: string): void {
    for (const conn of [...(this.bySession.get(sessionId) ?? [])]) this.drop(conn, CLOSE_CODES.sessionEnded, "session_ended");
  }

  /** Stops delivering to the socket at once and starts the closing handshake. */
  drop(conn: Connection, code: number, reason: string): void {
    this.forget(conn);
    if (conn.ws.readyState === conn.ws.OPEN) conn.ws.close(code, reason);
  }

  send(conn: Connection, event: PushEvent): void {
    this.sendRaw(conn, JSON.stringify(event));
  }

  /**
   * One heartbeat: drops sockets that did not answer the previous ping, pings the rest, and closes the
   * sockets of sessions that expired (expiry announces nothing, so it is checked here every 30 s).
   */
  async tick(): Promise<void> {
    for (const conns of [...this.byPrincipal.values()]) {
      for (const conn of [...conns]) {
        if (!conn.alive) {
          this.forget(conn);
          conn.ws.terminate();
          continue;
        }
        conn.alive = false;
        conn.ws.ping();
      }
    }
    const sessions = [...this.bySession.keys()];
    if (sessions.length === 0) return;
    const live = await liveSessions(this.deps.db, sessions);
    for (const id of sessions) if (!live.has(id)) this.endSession(id);
  }

  // --- delivery ---------------------------------------------------------------------------

  private onMessages(messages: StoredMessage[]): void {
    const ranges = new Map<string, { fromSeq: number; toSeq: number }>();
    for (const m of messages) {
      const r = ranges.get(m.conversationId);
      ranges.set(m.conversationId, { fromSeq: Math.min(r?.fromSeq ?? m.seq, m.seq), toSeq: Math.max(r?.toSeq ?? m.seq, m.seq) });
    }
    for (const [conversationId, range] of ranges) this.enqueue(conversationId, { kind: "messages", ...range });
  }

  private enqueue(conversationId: string, task: Task): void {
    if (this.stopped) return;
    const id = conversationId.toLowerCase();
    let queue = this.queues.get(id);
    if (!queue) {
      queue = { tasks: [], running: false };
      this.queues.set(id, queue);
    }
    // Consecutive message announcements merge: one step pushes the whole range in seq order.
    const last = queue.tasks.at(-1);
    if (task.kind === "messages" && last?.kind === "messages") {
      last.fromSeq = Math.min(last.fromSeq, task.fromSeq);
      last.toSeq = Math.max(last.toSeq, task.toSeq);
    } else {
      queue.tasks.push(task);
    }
    if (!queue.running) void this.drain(id, queue);
  }

  private async drain(conversationId: string, queue: Queue): Promise<void> {
    queue.running = true;
    while (!this.stopped && queue.tasks.length > 0) {
      const task = queue.tasks.shift()!;
      try {
        await this.run(conversationId, task);
      } catch (err) {
        this.deps.log.error({ err, conversationId }, "realtime delivery failed");
      }
    }
    queue.running = false;
    if (queue.tasks.length === 0) this.queues.delete(conversationId);
  }

  private run(conversationId: string, task: Task): Promise<void> {
    switch (task.kind) {
      case "messages":
        return this.fanOut(conversationId, task.fromSeq, task.toSeq);
      case "membership":
        return this.announceMembership(conversationId, task.principalIds);
      case "read":
        return this.announceRead(conversationId, task.marker);
    }
  }

  /**
   * Pushes the conversation's messages up to `toSeq` that have not gone out yet, read from the table in
   * seq order (every seq up to `toSeq` is committed: seqs are assigned under the row lock). Transactions
   * can announce out of commit order; reading the range instead of the announced messages keeps each
   * socket's stream ascending. Each reader gets only what they can see now, quotes resolved for them.
   */
  private async fanOut(conversationId: string, fromSeq: number, toSeq: number): Promise<void> {
    const after = Math.max(this.fanned.get(conversationId) ?? fromSeq - 1, toSeq - FANOUT_MAX_RANGE);
    if (toSeq <= after) return;
    const readers = this.connectedAmong(await currentMemberIds(this.deps.db, conversationId));
    if (readers.length > 0) {
      const { rows } = await this.deps.db.query<MessageRow>(
        // Raw rows: they leave this function only through toWireForReaders, which applies the visibility rule.
        `select ${MESSAGE_COLUMNS} from messages m
          where m.conversation_id = $1 and m.seq > $2 and m.seq <= $3 order by m.seq`,
        [conversationId, after, toSeq],
      );
      const perReader = await toWireForReaders(this.deps.db, readers, rows.map(toStored));
      for (const [reader, messages] of perReader) for (const message of messages) this.push(reader, { type: "message", message });
    }
    this.fanned.delete(conversationId);
    this.fanned.set(conversationId, toSeq);
    if (this.fanned.size > REMEMBERED_CONVERSATIONS) this.fanned.delete(this.fanned.keys().next().value!);
  }

  private async announceMembership(conversationId: string, principalIds: string[]): Promise<void> {
    const affected = this.connectedAmong(principalIds);
    if (affected.length === 0) return;
    const current = new Set(await currentMemberIds(this.deps.db, conversationId));
    for (const id of affected) {
      this.push(id, current.has(id) ? { type: "conversation", id: conversationId } : { type: "gone", id: conversationId });
    }
  }

  private async announceRead(conversationId: string, marker: ReadMarker): Promise<void> {
    const peek = await peekConversation(this.deps.db, conversationId);
    if (peek?.type !== "direct" || !peek.pair) return; // read positions are shown in direct chats only
    if (this.connectedAmong(peek.pair).length === 0) return;
    const readers = this.connectedAmong(await currentMemberIds(this.deps.db, conversationId));
    for (const id of readers) {
      this.push(id, { type: "read", conversationId, principalId: marker.principalId.toLowerCase(), seq: marker.seq });
    }
  }

  // --- sockets ----------------------------------------------------------------------------

  /** The distinct (lower-cased) ids among `ids` that have a socket here. */
  private connectedAmong(ids: readonly string[]): string[] {
    return [...new Set(ids.map((id) => id.toLowerCase()))].filter((id) => this.byPrincipal.has(id));
  }

  private push(principalId: string, event: PushEvent): void {
    const conns = this.byPrincipal.get(principalId.toLowerCase());
    if (!conns) return;
    const data = JSON.stringify(event);
    for (const conn of [...conns]) this.sendRaw(conn, data);
  }

  private sendRaw(conn: Connection, data: string): void {
    if (conn.ws.readyState !== conn.ws.OPEN) return;
    if (conn.ws.bufferedAmount > MAX_BUFFERED_BYTES) return this.drop(conn, CLOSE_CODES.tooSlow, "too_slow");
    conn.ws.send(data);
  }

  private forget(conn: Connection): void {
    const list = this.byPrincipal.get(conn.principalId);
    if (list) {
      const i = list.indexOf(conn);
      if (i >= 0) list.splice(i, 1);
      if (list.length === 0) this.byPrincipal.delete(conn.principalId);
    }
    const sessions = this.bySession.get(conn.sessionId);
    if (sessions) {
      sessions.delete(conn);
      if (sessions.size === 0) this.bySession.delete(conn.sessionId);
    }
  }
}
