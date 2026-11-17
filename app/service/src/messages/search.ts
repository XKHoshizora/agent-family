import { VISIBLE_JOIN } from "../conversations/store.ts";
import type { Db, Queryable, Tx } from "../db.ts";
import { MESSAGE_COLUMNS, toStored, type MessageRow, type WireMessage } from "./model.ts";
import { principalsOf, type SyncPrincipal } from "./principals.ts";
import { toWireFor, type ReadConfig } from "./read.ts";

/** Searches one principal may have running at once, both routes together; one more is 429 `rate_limited`. */
export const MAX_CONCURRENT_SEARCHES = 2;
/**
 * Searches everyone together may have running at once (each holds one of the pool's 10 connections for up to
 * the search timeout); one more is 503 `busy`, unless its caller is at their own cap (then 429).
 */
export const MAX_SEARCHES_IN_FLIGHT = 4;

/**
 * Runs one search in a read-only transaction of its own whose statements Postgres cancels after
 * `timeoutMs` (`statement_timeout`, local to the transaction): a 1–2 character or CJK term can make the
 * trigram index useless and scan a lot of history. The cancellation is answered 503 `busy` (errors.ts).
 */
export function inSearchBudget<T>(db: Db, timeoutMs: number, search: (t: Tx) => Promise<T>): Promise<T> {
  return db.tx(async (t) => {
    await t.query("set transaction read only");
    await t.query("select set_config('statement_timeout', $1, true)", [String(timeoutMs)]);
    return search(t);
  });
}

/**
 * What is searched: the message text (captions included) and a file message's attachment name; system
 * notices never. These expressions are the ones indexed by migrations/007_search.sql.
 */
export const matchOn = (param: number): string =>
  `(m.kind in ('text', 'file') and ((m.body ->> 'text') ilike $${param} escape '\\' or ((m.body -> 'attachment') ->> 'name') ilike $${param} escape '\\'))`;

/** `%q%` for ILIKE with `%`, `_` and the escape character itself taken literally. */
export function containsPattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, "\\$&")}%`;
}

export interface SearchOptions {
  q: string;
  limit: number;
}

export interface ConversationSearchPage {
  /** Newest first. */
  messages: WireMessage[];
  /** Pass as `before` for the next older page; null when no older hit exists. */
  nextBefore: number | null;
  /** Everyone the hits name (authors, visible quotes), by id. */
  principals: Record<string, SyncPrincipal>;
}

/**
 * Hits in one conversation, newest first. Null when the reader is not currently in it (never, left,
 * removed, no such conversation). Membership, VISIBLE_JOIN and the match are one statement; rendering
 * re-checks visibility per reader, so quotes of messages they cannot see stay hidden.
 */
export async function searchConversation(
  q: Queryable,
  readerId: string,
  conversationId: string,
  { q: term, before, limit }: SearchOptions & { before?: number },
  config: ReadConfig,
): Promise<ConversationSearchPage | null> {
  const { rows } = await q.query<MessageRow | { [K in keyof MessageRow]: null }>(
    `select ${MESSAGE_COLUMNS}
       from memberships me
       left join lateral (
         select m.* from messages m ${VISIBLE_JOIN}
          where m.conversation_id = me.conversation_id
            and ($3::bigint is null or m.seq < $3::bigint)
            and ${matchOn(4)}
          order by m.seq desc limit $5
       ) m on true
      where me.conversation_id = $2 and me.principal_id = $1 and me.left_seq is null
      order by m.seq desc`,
    [readerId, conversationId, before ?? null, containsPattern(term), limit + 1],
  );
  if (rows.length === 0) return null; // not a current member
  const found = rows.filter((r): r is MessageRow => r.id !== null);
  const page = found.slice(0, limit).map(toStored);
  const messages = await toWireFor(q, readerId, page, config);
  return {
    messages,
    nextBefore: found.length > limit ? page[page.length - 1]!.seq : null,
    principals: await principalsOf(q, messages),
  };
}

// --- global search -----------------------------------------------------------------------------

/** created_at at microsecond precision (a JS Date would lose it, and the cursor must resume exactly). */
const CREATED_AT_TEXT = `to_char(m.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const CURSOR_SHAPE =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)\|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\|([1-9][0-9]{0,15})$/;
const CURSOR_TEXT = /^[A-Za-z0-9_-]{1,200}$/;

export interface SearchCursor {
  createdAt: string;
  conversationId: string;
  seq: number;
}

/** Opaque to clients: base64url of `createdAt|conversationId|seq`. Names a position, not a counter. */
export function encodeSearchCursor(c: SearchCursor): string {
  return Buffer.from(`${c.createdAt}|${c.conversationId}|${c.seq}`, "utf8").toString("base64url");
}

/** Strict: null for anything this module could not have minted (including non-canonical spellings). */
export function decodeSearchCursor(text: string): SearchCursor | null {
  if (!CURSOR_TEXT.test(text)) return null;
  const m = CURSOR_SHAPE.exec(Buffer.from(text, "base64url").toString("utf8"));
  if (!m) return null;
  const c: SearchCursor = { createdAt: m[1]!, conversationId: m[2]!, seq: Number(m[3]) };
  if (!Number.isSafeInteger(c.seq) || encodeSearchCursor(c) !== text) return null;
  // A real calendar date Postgres can hold (a Date round trip of the millisecond part rejects 02-31 etc.).
  const ms = c.createdAt.slice(0, 23) + "Z";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime()) || d.toISOString() !== ms || d.getUTCFullYear() < 1970) return null;
  return c;
}

export interface GlobalSearchPage {
  /** Newest first by created_at (ties: conversation id, then seq, both descending). */
  messages: WireMessage[];
  /** Opaque; pass as `before`. Null when no older hit exists. */
  nextBefore: string | null;
  /** Everyone the hits name (authors, visible quotes), by id. */
  principals: Record<string, SyncPrincipal>;
}

/**
 * Hits across every conversation the reader is currently in. VISIBLE_JOIN is applied in the same
 * statement as the match, so a cursor can only ever narrow what a reader sees, never widen it.
 */
export async function searchAll(
  q: Queryable,
  readerId: string,
  { q: term, before, limit }: SearchOptions & { before?: SearchCursor },
  config: ReadConfig,
): Promise<GlobalSearchPage> {
  const { rows } = await q.query<MessageRow & { created_at_text: string }>(
    `select ${MESSAGE_COLUMNS}, ${CREATED_AT_TEXT} as created_at_text
       from messages m ${VISIBLE_JOIN}
      where ${matchOn(2)}
        and ($3::timestamptz is null or (m.created_at, m.conversation_id, m.seq) < ($3::timestamptz, $4::uuid, $5::bigint))
      order by m.created_at desc, m.conversation_id desc, m.seq desc
      limit $6`,
    [readerId, containsPattern(term), before?.createdAt ?? null, before?.conversationId ?? null, before?.seq ?? null, limit + 1],
  );
  const pageRows = rows.slice(0, limit);
  const last = pageRows[pageRows.length - 1];
  const messages = await toWireFor(q, readerId, pageRows.map(toStored), config);
  return {
    messages,
    nextBefore:
      rows.length > limit && last
        ? encodeSearchCursor({ createdAt: last.created_at_text, conversationId: last.conversation_id, seq: Number(last.seq) })
        : null,
    principals: await principalsOf(q, messages),
  };
}
