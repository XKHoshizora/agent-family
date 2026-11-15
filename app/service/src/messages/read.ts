import { currentMembership, VISIBLE_JOIN } from "../conversations/store.ts";
import type { Queryable } from "../db.ts";
import { MESSAGE_COLUMNS, toStored, type MessageRow, type StoredMessage, type WireMessage } from "./model.ts";

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

/**
 * The wire form of `msg` for one reader. `visibleQuote` must be the message `msg` quotes if — and only
 * if — that reader can see it (load it through VISIBLE_JOIN; `toWireFor` does). Otherwise the quote is
 * reported as `{seq, visible: false}` with no text and no sender.
 */
export function toWire(msg: StoredMessage, visibleQuote: StoredMessage | null): WireMessage {
  const wire: WireMessage = {
    conversationId: msg.conversationId,
    seq: msg.seq,
    senderId: msg.kind === "system" ? null : msg.senderId,
    kind: msg.kind,
    text: wireText(msg),
    createdAt: msg.createdAt.toISOString(),
  };
  const replyToSeq = msg.body.replyToSeq;
  if (typeof replyToSeq === "number") {
    const q = visibleQuote;
    wire.replyTo =
      q && q.conversationId === msg.conversationId && q.seq === replyToSeq
        ? {
            seq: replyToSeq,
            visible: true,
            senderId: q.kind === "system" ? null : q.senderId,
            text: truncate(wireText(q), QUOTE_MAX_CHARS),
          }
        : { seq: replyToSeq, visible: false };
  }
  if (msg.kind === "system" && typeof msg.body.event === "string") {
    const { text: _text, ...event } = msg.body;
    wire.system = { ...event, event: msg.body.event };
  }
  return wire;
}

/** Wire forms of `msgs` for `readerId`, resolving every quote through VISIBLE_JOIN in one query. */
export async function toWireFor(q: Queryable, readerId: string, msgs: StoredMessage[]): Promise<WireMessage[]> {
  const quoting = msgs.filter((m) => typeof m.body.replyToSeq === "number");
  const quotes = new Map<string, StoredMessage>();
  if (quoting.length > 0) {
    const { rows } = await q.query<MessageRow>(
      `select ${MESSAGE_COLUMNS} from messages m ${VISIBLE_JOIN}
         join unnest($2::uuid[], $3::bigint[]) as wanted (conversation_id, seq)
           on wanted.conversation_id = m.conversation_id and wanted.seq = m.seq`,
      [readerId, quoting.map((m) => m.conversationId), quoting.map((m) => m.body.replyToSeq)],
    );
    for (const r of rows) quotes.set(`${r.conversation_id}:${r.seq}`, toStored(r));
  }
  return msgs.map((m) => toWire(m, quotes.get(`${m.conversationId}:${m.body.replyToSeq}`) ?? null));
}

export interface MessagePage {
  /** Ascending by seq. */
  messages: WireMessage[];
  /** Pass as `before` for the next older page; null when no older visible message exists. */
  nextBefore: number | null;
}

/** Up to `limit` visible messages with seq < `before`, newest page first. Null when not a current member. */
export async function listMessages(
  q: Queryable,
  readerId: string,
  conversationId: string,
  { before, limit }: { before?: number; limit: number },
): Promise<MessagePage | null> {
  if (!(await currentMembership(q, conversationId, readerId))) return null;
  const { rows } = await q.query<MessageRow>(
    `select ${MESSAGE_COLUMNS} from messages m ${VISIBLE_JOIN}
      where m.conversation_id = $2 and ($3::bigint is null or m.seq < $3::bigint)
      order by m.seq desc limit $4`,
    [readerId, conversationId, before ?? null, limit + 1],
  );
  const page = rows.slice(0, limit).reverse().map(toStored);
  return {
    messages: await toWireFor(q, readerId, page),
    nextBefore: rows.length > limit ? page[0]!.seq : null,
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
  return wire!;
}

/**
 * Moves the reader's read marker to `seq`, clamped to [current read_seq, conversations.seq]: never
 * backwards, never beyond the last message. It is only a number and proves nothing about visibility.
 * Null when not a current member.
 */
export async function markRead(q: Queryable, readerId: string, conversationId: string, seq: number): Promise<number | null> {
  const { rows } = await q.query<{ read_seq: string }>(
    `update memberships ms set read_seq = greatest(ms.read_seq, least($3::bigint, c.seq))
       from conversations c
      where c.id = ms.conversation_id and ms.conversation_id = $1 and ms.principal_id = $2 and ms.left_seq is null
      returning ms.read_seq`,
    [conversationId, readerId, seq],
  );
  return rows[0] ? Number(rows[0].read_seq) : null;
}
