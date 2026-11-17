import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { VISIBLE_JOIN, visibleJoin, type ConversationType } from "../conversations/store.ts";
import type { Queryable } from "../db.ts";
import { MESSAGE_COLUMNS, toStored, type MessageRow, type StoredMessage, type WireMessage } from "./model.ts";
import { principalsOf, type SyncPrincipal } from "./principals.ts";

export const QUOTE_MAX_CHARS = 200;

function truncate(text: string, max: number): string {
  let out = "";
  let n = 0;
  for (const ch of text) {
    if (n++ === max) break;
    out += ch;
  }
  return out;
}

const wireText = (m: StoredMessage): string => (typeof m.body.text === "string" ? m.body.text : "");

type WireProposal = NonNullable<WireMessage["proposal"]>;

/** A persona proposal as `toWireForReaders` reads it: whose Agent's it is decides who is shown it. */
interface ProposalRow {
  id: string;
  message_id: string;
  owner_id: string;
  status: WireProposal["status"];
  persona: string;
  intro: string | null;
  field: string | null;
  /** Open, but the Agent's persona has moved past the version it was made against. */
  stale: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The proposal a message's body names (`postAsAgent` writes `proposalId`; nobody can send one), or null. */
const proposalIdOf = (m: StoredMessage): string | null =>
  m.kind === "text" && typeof m.body.proposalId === "string" && UUID.test(m.body.proposalId) ? m.body.proposalId : null;

/**
 * The proposals `msgs` name, by id, in one query: each with its Agent's owner and whether it is stale now (open, but
 * the persona version moved: computed at read time, the stored status changes only when a confirmation hits it).
 */
async function proposalsOf(q: Queryable, msgs: StoredMessage[]): Promise<Map<string, ProposalRow>> {
  const ids = [...new Set(msgs.map(proposalIdOf).filter((id): id is string => id !== null))];
  if (ids.length === 0) return new Map();
  const { rows } = await q.query<ProposalRow>(
    `select pp.id, pp.message_id::text, p.owner_id, pp.status, pp.persona, pp.intro, pp.field,
            (pp.status = 'open' and pp.base_persona_version <> a.persona_version) as stale
       from persona_proposals pp
       join agents a on a.principal_id = pp.agent_id
       join principals p on p.id = pp.agent_id
      where pp.id = any($1::uuid[])`,
    [ids],
  );
  return new Map(rows.map((r) => [r.id, r]));
}

function toWireProposal(r: ProposalRow): WireProposal {
  return {
    id: r.id,
    status: r.stale ? "stale" : r.status,
    persona: r.persona,
    ...(r.intro === null ? {} : { intro: r.intro }),
    ...(r.field === null ? {} : { field: r.field }),
  };
}

/**
 * Module-private on purpose: it renders whatever quote and proposal it is handed. Every exported path decides per
 * reader, through VISIBLE_JOIN, both whether `msg` is shown at all and whether `visibleQuote` is, and shows a proposal
 * to the Agent's owner only. `ownChat`: `msg` is in an Agent's own conversation with its owner (`type = 'agent'`), the
 * only place an Agent's reasoning is ever sent — whatever is stored on a message anywhere else (a group's members all
 * read it), it is not.
 */
function toWire(msg: StoredMessage, visibleQuote: StoredMessage | null, proposal: ProposalRow | null, ownChat: boolean): WireMessage {
  const wire: WireMessage = {
    conversationId: msg.conversationId,
    seq: msg.seq,
    senderId: msg.kind === "system" ? null : msg.senderId,
    kind: msg.kind,
    text: wireText(msg),
    createdAt: msg.createdAt.toISOString(),
  };
  const attachment = msg.body.attachment;
  if (msg.kind === "file" && attachment) {
    wire.attachment = { id: attachment.id, name: attachment.name, size: attachment.size, inline: attachment.inline };
  }
  const replyToSeq = msg.body.replyToSeq;
  if (typeof replyToSeq === "number") {
    const q = visibleQuote;
    if (q && q.conversationId === msg.conversationId && q.seq === replyToSeq) {
      const quote: Extract<NonNullable<WireMessage["replyTo"]>, { visible: true }> = {
        seq: replyToSeq,
        visible: true,
        senderId: q.kind === "system" ? null : q.senderId,
        text: truncate(wireText(q), QUOTE_MAX_CHARS),
        kind: q.kind === "file" ? "file" : "text",
      };
      if (q.kind === "file" && q.body.attachment) quote.attachmentName = q.body.attachment.name;
      wire.replyTo = quote;
    } else {
      wire.replyTo = { seq: replyToSeq, visible: false };
    }
  }
  if (msg.kind === "system" && typeof msg.body.event === "string") {
    const { text: _text, ...event } = msg.body;
    wire.system = { ...event, event: msg.body.event };
  }
  if (msg.kind === "text") {
    // Only an Agent's reply carries these (postAsAgent); nobody can send them. Its reasoning only in its own conversation.
    if (ownChat && typeof msg.body.reasoning === "string" && msg.body.reasoning !== "") wire.reasoning = msg.body.reasoning;
    if (msg.body.stopped === true) wire.stopped = true;
    if (msg.body.truncated === true) wire.truncated = true;
    if (proposal) wire.proposal = toWireProposal(proposal);
  }
  return wire;
}

/**
 * For fan-out: what each reader may see of `msgs`. Per reader (keyed by lower-case id; every reader is a
 * key) the messages that reader can see now, in the given order, each with its quote resolved for that
 * reader — `{visible: true, senderId, text}` only if the quoted message is visible to them, else
 * `{seq, visible: false}` — and, on an Agent's reply that proposed a persona, its `proposal` when the reader is that
 * Agent's owner; an Agent's reasoning only in its own conversation (`toWire`). Both visibility decisions go through
 * VISIBLE_JOIN; at most three queries however many readers and messages there are.
 */
export async function toWireForReaders(
  q: Queryable,
  readerIds: string[],
  msgs: StoredMessage[],
): Promise<Map<string, WireMessage[]>> {
  const readers = [...new Set(readerIds.map((id) => id.toLowerCase()))];
  const out = new Map<string, WireMessage[]>(readers.map((r) => [r, []]));
  if (readers.length === 0 || msgs.length === 0) return out;

  const shown = await q.query<{ reader_id: string; id: string; own_chat: boolean }>(
    `select r.reader_id, m.id, c.type = 'agent' as own_chat
       from unnest($1::uuid[]) as r (reader_id)
       cross join messages m ${visibleJoin("r.reader_id")}
       join conversations c on c.id = m.conversation_id
      where m.id = any($2::bigint[])`,
    [readers, msgs.map((m) => m.id)],
  );
  const visible = new Set(shown.rows.map((r) => `${r.reader_id}|${r.id}`));
  const shownToAnyone = new Set(shown.rows.map((r) => r.id));
  /** The messages in an Agent's own conversation: the only ones whose reasoning is sent. */
  const inOwnChat = new Set(shown.rows.filter((r) => r.own_chat).map((r) => r.id));

  const quoting = msgs.filter((m) => typeof m.body.replyToSeq === "number" && shownToAnyone.has(m.id));
  const quotes = new Map<string, StoredMessage>();
  if (quoting.length > 0) {
    const { rows } = await q.query<MessageRow & { reader_id: string }>(
      `select r.reader_id, ${MESSAGE_COLUMNS}
         from unnest($1::uuid[]) as r (reader_id)
         cross join unnest($2::uuid[], $3::bigint[]) as wanted (conversation_id, seq)
         join messages m on m.conversation_id = wanted.conversation_id and m.seq = wanted.seq
         ${visibleJoin("r.reader_id")}`,
      [readers, quoting.map((m) => m.conversationId), quoting.map((m) => m.body.replyToSeq)],
    );
    for (const r of rows) quotes.set(`${r.reader_id}|${r.conversation_id}|${r.seq}`, toStored(r));
  }

  const proposals = await proposalsOf(q, msgs.filter((m) => shownToAnyone.has(m.id)));
  /** The proposal `m` made, when `reader` owns the Agent that made it. */
  const proposalFor = (reader: string, m: StoredMessage): ProposalRow | null => {
    const id = proposalIdOf(m);
    const p = id === null ? undefined : proposals.get(id);
    return p && p.message_id === m.id && p.owner_id === reader ? p : null;
  };

  for (const reader of readers) {
    const list = out.get(reader)!;
    for (const m of msgs) {
      if (!visible.has(`${reader}|${m.id}`)) continue;
      list.push(toWire(m, quotes.get(`${reader}|${m.conversationId}|${m.body.replyToSeq}`) ?? null, proposalFor(reader, m), inOwnChat.has(m.id)));
    }
  }
  return out;
}

/** `toWireForReaders` for one reader: the subset of `msgs` they can see, quotes resolved for them. */
export async function toWireFor(q: Queryable, readerId: string, msgs: StoredMessage[]): Promise<WireMessage[]> {
  return (await toWireForReaders(q, [readerId], msgs)).get(readerId.toLowerCase())!;
}

export interface MessagePage {
  /** Ascending by seq. */
  messages: WireMessage[];
  /** Pass as `before` for the next older page; null when no older visible message exists. */
  nextBefore: number | null;
  /** Everyone these messages name (senders, visible quotes, notices), by id. */
  principals: Record<string, SyncPrincipal>;
}

/**
 * Up to `limit` visible messages with seq < `before`, newest page first. Null when not a current member.
 * Membership and messages come from one statement; rendering re-checks visibility, so a concurrent
 * removal can only hide messages, never reveal them.
 */
export async function listMessages(
  q: Queryable,
  readerId: string,
  conversationId: string,
  { before, limit }: { before?: number; limit: number },
): Promise<MessagePage | null> {
  const { rows } = await q.query<MessageRow | { [K in keyof MessageRow]: null }>(
    `select ${MESSAGE_COLUMNS}
       from memberships me
       left join lateral (
         select m.* from messages m ${VISIBLE_JOIN}
          where m.conversation_id = me.conversation_id and ($3::bigint is null or m.seq < $3::bigint)
          order by m.seq desc limit $4
       ) m on true
      where me.conversation_id = $2 and me.principal_id = $1 and me.left_seq is null
      order by m.seq desc`,
    [readerId, conversationId, before ?? null, limit + 1],
  );
  if (rows.length === 0) return null; // not a current member
  const found = rows.filter((r): r is MessageRow => r.id !== null);
  const page = found.slice(0, limit).reverse().map(toStored);
  const messages = await toWireFor(q, readerId, page);
  return {
    messages,
    nextBefore: found.length > limit ? page[0]!.seq : null,
    principals: await principalsOf(q, messages),
  };
}

/** One visible message, or null (not a member, not visible, or not there — indistinguishable). */
export async function getMessage(q: Queryable, readerId: string, conversationId: string, seq: number): Promise<WireMessage | null> {
  const { rows } = await q.query<MessageRow>(
    `select ${MESSAGE_COLUMNS} from messages m ${VISIBLE_JOIN} where m.conversation_id = $2 and m.seq = $3`,
    [readerId, conversationId, seq],
  );
  if (!rows[0]) return null;
  const [wire] = await toWireFor(q, readerId, [toStored(rows[0])]);
  return wire ?? null;
}

export interface ReadResult {
  readSeq: number;
  /** The marker before this call; equal to `readSeq` when nothing moved. */
  previous: number;
  type: ConversationType;
}

/**
 * Moves the reader's read marker to `seq`, clamped to [current read_seq, conversations.seq]: never
 * backwards, never beyond the last message. It is only a number and proves nothing about visibility.
 * Null when not a current member. The row is locked first, so `previous` is exact under concurrency.
 */
export async function markRead(q: Queryable, readerId: string, conversationId: string, seq: number): Promise<ReadResult | null> {
  const { rows } = await q.query<{ read_seq: string; previous: string; type: ConversationType }>(
    `with prev as (
       select ms.id, ms.read_seq from memberships ms
        where ms.conversation_id = $1 and ms.principal_id = $2 and ms.left_seq is null
        for update
     )
     update memberships ms set read_seq = greatest(prev.read_seq, least($3::bigint, c.seq))
       from prev, conversations c
      where ms.id = prev.id and c.id = ms.conversation_id
      returning ms.read_seq, prev.read_seq as previous, c.type`,
    [conversationId, readerId, seq],
  );
  const r = rows[0];
  return r ? { readSeq: Number(r.read_seq), previous: Number(r.previous), type: r.type } : null;
}

// --- read-marker events ---------------------------------------------------------------------

/** A principal's read marker moved forward to `seq`: someone's in a direct conversation, or an Agent's in its conversation. */
export interface ReadMarker {
  conversationId: string;
  principalId: string;
  seq: number;
}

export type ReadListener = (marker: ReadMarker) => void | Promise<void>;

/** Per-app registry (on `Deps`) of read-marker listeners, in the style of `ConversationEvents`. */
export interface ReadEvents {
  onRead(fn: ReadListener): () => void;
  /** Call only after the marker was stored (a direct chat's, or an Agent's in its conversation). Never throws; failures are logged. */
  publish(marker: ReadMarker, log: Pick<FastifyBaseLogger, "error">): void;
}

export function createReadEvents(): ReadEvents {
  const listeners = new Set<ReadListener>();
  return {
    onRead(fn) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    publish(marker, log) {
      for (const fn of [...listeners]) {
        try {
          Promise.resolve(fn({ ...marker })).catch((err) => log.error({ err }, "read listener failed"));
        } catch (err) {
          log.error({ err }, "read listener failed");
        }
      }
    },
  };
}

/** Subscribe to read-marker moves (direct chats; an Agent's in its conversation). Returns unsubscribe. */
export function onRead(app: FastifyInstance, fn: ReadListener): () => void {
  return app.deps.reads.onRead(fn);
}
