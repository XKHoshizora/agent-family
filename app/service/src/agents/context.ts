import type { FastifyBaseLogger } from "fastify";
import type { Readable } from "node:stream";
import { isMissingBlob, type BlobStore } from "../attachments/blob.ts";
import { findDownloadable, type Downloadable } from "../attachments/store.ts";
import { VISIBLE_JOIN } from "../conversations/store.ts";
import type { Queryable } from "../db.ts";
import { estimateTokens, IMAGE_TOKENS, pdfTokens } from "../metering/prices.ts";
import type { AttachmentRef } from "../messages/model.ts";
import type { ModelCall } from "../models/gateway.ts";
import type { Resolved } from "../models/resolve.ts";
import {
  attachmentLabel,
  ContextPlan,
  contextBudget,
  entryText,
  FILE_MAX_CHARS,
  fileText,
  IMAGE_MAX_BYTES,
  MODEL_IMAGE_MIMES,
  pastBudget,
  PDF_MAX_BYTES,
  startsLikeText,
  UTF8_MAX_BYTES_PER_CHAR,
  type ContextAttachment,
  type ContextEntry,
} from "./runtime/context.ts";

/**
 * The database and blob side of what the model is shown (README "Agents and runs"), in two steps that `begin` keeps
 * apart: `loadContext` reads the messages and the attachments' records (SQL only, inside `begin`'s first short
 * transaction); `buildContext` reads the attachments' bytes and assembles the call with no transaction open, so no
 * write to the conversation ever waits for a file. The choosing is the pure plan in `runtime/context.ts`.
 */

/** Messages read per query, newest first, until the budget is passed. */
const PAGE = 200;
/** The first bytes of a file looked at before the rest is read as text (`startsLikeText`). */
const PROBE_BYTES = 4096;
/** A blob that has not been read after this long is given up on: it is shown by its name, like one that failed. */
export const BLOB_READ_TIMEOUT_MS = 15_000;

/** The blob store failed on two attachments in a row: it is down, and the reply fails as the service's trouble (`busy`). */
export class BlobStoreDown extends Error {
  constructor(cause: unknown) {
    super("the blob store failed on two attachments in a row", { cause });
    this.name = "BlobStoreDown";
  }
}

/** The run a context is built for: it answers the owner up to `coversSeq`. */
export interface ContextRun {
  agentId: string;
  ownerId: string;
  conversationId: string;
  coversSeq: number;
}

/** What `loadContext` read: everything `buildContext` needs but the attachments' bytes. */
export interface LoadedContext {
  system: string;
  /** Tokens the conversation may take (`contextBudget`). */
  budget: number;
  /** The messages that may be shown, in the order they were answered, oldest first. */
  entries: ContextEntry[];
  /** The records of the attachments that may be shown, by id, as the download's permission gave them to the Agent. */
  attachments: Map<string, Downloadable>;
  /** The seq of the latest `topic_reset` notice the Agent can see; 0 when there is none. */
  topicStart: number;
}

export interface BuiltContext {
  /** Never empty when `loadContext` found an owner's message (`hasOwnerTurn`). */
  messages: ModelCall["messages"];
  /** Tokens of the system text and the turns, images and PDFs at their estimate: what admission holds for. */
  inputTokensEstimate: number;
  /**
   * What settlement falls back on when the upstream reports no usage: characters, attachments at their token
   * estimate. Settlement counts a token per character (`estimateTokens`' rule), so it is the estimate itself.
   */
  inputChars: number;
}

/**
 * At most `max` bytes of a blob, read as a stream and stopped there (`complete`: the blob had no more), or null when
 * the blob is missing. With `probe`, the first `PROBE_BYTES` are shown to it and the read stops when it says no.
 * Rejects when the blob has not been read within `timeoutMs`, with `signal`'s reason as soon as it aborts (the read is
 * abandoned), and for any other failure of the store.
 */
export async function readPrefix(
  blobs: BlobStore,
  key: string,
  max: number,
  {
    probe,
    timeoutMs = BLOB_READ_TIMEOUT_MS,
    signal,
  }: { probe?: (head: Uint8Array) => boolean; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<{ data: Buffer; complete: boolean } | null> {
  const held: { stream?: Readable; late?: boolean } = {};
  const reading = (async (): Promise<{ data: Buffer; complete: boolean } | null> => {
    let stream: Readable;
    try {
      stream = await blobs.get(key);
    } catch (err) {
      if (isMissingBlob(err)) return null;
      throw err;
    }
    held.stream = stream;
    if (held.late) {
      stream.destroy();
      return null;
    }
    const chunks: Buffer[] = [];
    let n = 0;
    let probed = probe === undefined;
    // One byte past `max` says whether there is more; leaving the loop early destroys the stream.
    for await (const chunk of stream) {
      const piece = (chunk as Buffer).subarray(0, max + 1 - n);
      chunks.push(piece);
      n += piece.length;
      if (!probed && n >= PROBE_BYTES) {
        probed = true;
        const head = Buffer.concat(chunks);
        if (!probe!(head)) return { data: head, complete: false };
      }
      if (n > max) break;
    }
    const data = Buffer.concat(chunks);
    return n > max ? { data: data.subarray(0, max), complete: false } : { data, complete: true };
  })();
  reading.catch(() => {}); // it may fail after the deadline has answered
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`the blob ${key} did not arrive within ${timeoutMs} ms`)), timeoutMs);
    if (!signal) return;
    onAbort = () => reject(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([reading, deadline]);
  } catch (err) {
    held.late = true;
    held.stream?.destroy();
    throw err;
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}

/** The seq of the latest `topic_reset` notice the Agent can see in its conversation; 0 when there is none. */
async function topicStart(q: Queryable, agentId: string, conversationId: string): Promise<number> {
  const { rows } = await q.query<{ seq: string | null }>(
    `select max(m.seq)::text as seq from messages m ${VISIBLE_JOIN}
      where m.conversation_id = $2 and m.kind = 'system' and m.body ->> 'event' = 'topic_reset'`,
    [agentId, conversationId],
  );
  return Number(rows[0]?.seq ?? 0);
}

/** A message as loaded: its entry, its seq, and where it belongs (`answers`). */
interface Loaded {
  entry: ContextEntry;
  seq: number;
  /** The owner's message: its seq. The Agent's reply: the seq its run had covered when it began. */
  answers: number;
  /** An Agent's reply posted by a run (it goes after the owner's message it answers). */
  reply: boolean;
}

interface MessageRow {
  seq: string;
  sender_id: string;
  text: string | null;
  attachment: AttachmentRef | null;
  reply_to: unknown;
  answers: string | null;
}

const toAttachment = (a: AttachmentRef): ContextAttachment => ({ id: a.id, name: a.name, image: a.inline === true });

/**
 * Up to `PAGE` messages the Agent can see with seq before `before`, newest first: text and file messages (not notices,
 * not the fixed greeting) that belong after the topic start `from` — the owner's, and the Agent's replies to what is
 * covered up to `coversSeq`. A reply belongs where it was answered: right after the owner's message its run covered
 * when it began (the run is the one named by the message's `client_txn`). Only the text, the attachment and the quote
 * are read of a message — never its stored reasoning. A quote shows what the Agent can see of the quoted message: its
 * text, or its attachment's name.
 */
async function loadPage(
  q: Queryable,
  run: ContextRun,
  from: number,
  before: number | null,
): Promise<{ loaded: Loaded[]; oldest: number | null; more: boolean }> {
  const { rows } = await q.query<MessageRow>(
    `select m.seq::text as seq, m.sender_id, m.body ->> 'text' as text, m.body -> 'attachment' as attachment,
            m.body -> 'replyToSeq' as reply_to, r.covers_seq::text as answers
       from messages m ${VISIBLE_JOIN}
       left join agent_runs r
         on r.agent_id = $1
        and r.id = (case when m.sender_id = $1 and m.client_txn ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' then m.client_txn end)::uuid
      where m.conversation_id = $2 and m.seq > $3 and ($4::bigint is null or m.seq < $4::bigint)
        and m.kind in ('text', 'file') and (m.body -> 'fixed') is distinct from 'true'::jsonb
        and coalesce(r.covers_seq, m.seq) > $3
        and (m.sender_id = $6 or coalesce(r.covers_seq, m.seq) <= $5)
      order by m.seq desc
      limit $7`,
    [run.agentId, run.conversationId, from, before, run.coversSeq, run.ownerId, PAGE],
  );
  const quotedSeqs = [...new Set(rows.flatMap((r) => (typeof r.reply_to === "number" && Number.isSafeInteger(r.reply_to) ? [r.reply_to] : [])))];
  const quotes = new Map<number, string>();
  if (quotedSeqs.length > 0) {
    const quoted = await q.query<{ seq: string; text: string | null; attachment: AttachmentRef | null }>(
      `select m.seq::text as seq, m.body ->> 'text' as text, m.body -> 'attachment' as attachment
         from messages m ${VISIBLE_JOIN}
        where m.conversation_id = $2 and m.seq = any($3::bigint[])`,
      [run.agentId, run.conversationId, quotedSeqs],
    );
    for (const r of quoted.rows) {
      const shown = r.text ? r.text : r.attachment ? attachmentLabel(toAttachment(r.attachment)) : "";
      if (shown !== "") quotes.set(Number(r.seq), shown);
    }
  }
  const loaded = rows.flatMap((r): Loaded[] => {
    const role = r.sender_id === run.ownerId ? "user" : r.sender_id === run.agentId ? "assistant" : null;
    if (role === null) return [];
    const quoted = typeof r.reply_to === "number" ? (quotes.get(r.reply_to) ?? null) : null;
    const seq = Number(r.seq);
    const entry: ContextEntry = { role, text: entryText(r.text ?? "", quoted), attachment: r.attachment ? toAttachment(r.attachment) : null };
    return [{ entry, seq, answers: r.answers === null ? seq : Number(r.answers), reply: r.answers !== null }];
  });
  return { loaded, oldest: rows.length > 0 ? Number(rows[rows.length - 1]!.seq) : null, more: rows.length === PAGE };
}

/** In the order things were answered: by `answers`, a reply after the owner's message it answers, then by seq. */
const answeredOrder = (list: readonly Loaded[]): ContextEntry[] =>
  [...list].sort((a, b) => a.answers - b.answers || Number(a.reply) - Number(b.reply) || a.seq - b.seq).map((l) => l.entry);

/**
 * Step one of what the model is shown for `run` (spec 6.5 "发给模型的内容"; README "Agents and runs"), database only:
 * the messages after the latest new topic in the order they were answered, read newest first until they are more than
 * the budget (the model's context less its output limit and `system`) can hold, and the records of the attachments the
 * plan could show — looked up only through `findDownloadable` with the Agent as reader (the download's own
 * permission); an image is not looked up when the model cannot see images.
 */
export async function loadContext(
  q: Queryable,
  run: ContextRun,
  resolved: Pick<Resolved, "contextTokens" | "vision" | "call">,
  system: string,
): Promise<LoadedContext> {
  const budget = contextBudget(resolved.contextTokens, resolved.call.maxOutputTokens, system);
  const from = await topicStart(q, run.agentId, run.conversationId);
  const loaded: Loaded[] = [];
  // Read by seq, but shown in answered order: everything that belongs at or after the oldest seq read is known, and
  // only that is used while more is left unread (a reply may belong before messages not read yet).
  let oldest = Number.POSITIVE_INFINITY;
  let more = true;
  let before: number | null = null;
  while (more) {
    const page = await loadPage(q, run, from, before);
    loaded.push(...page.loaded);
    more = page.more;
    if (page.oldest !== null) oldest = page.oldest;
    if (more && pastBudget(answeredOrder(loaded.filter((l) => l.answers >= oldest)).reverse(), budget)) break;
    before = page.oldest;
  }
  const entries = answeredOrder(more ? loaded.filter((l) => l.answers >= oldest) : loaded);

  // The attachments of every message the plan could keep (those it keeps with no attachment contents at all).
  const could = new ContextPlan(entries, budget);
  could.keepOlder();
  const attachments = new Map<string, Downloadable>();
  for (const [, a] of [...could.attachments(false), ...could.attachments(true)]) {
    if (a.image && !resolved.vision) continue;
    const found = await findDownloadable(q, run.agentId, a.id);
    if (found) attachments.set(a.id, found);
  }
  return { system, budget, entries, attachments, topicStart: from };
}

/** Whether there is anything to answer: an owner's message among what may be shown. */
export const hasOwnerTurn = (loaded: LoadedContext): boolean => loaded.entries.some((e) => e.role === "user");

/**
 * Step two, with no transaction open: the call's turns, chosen by `ContextPlan` from `loaded`, with the contents of
 * attachments when the model can take them and they fit — checked on their stored size before a byte is read: a PNG,
 * JPEG or WebP image (a GIF is named) up to 5 MB when the model sees images; a PDF up to 10 MB when it reads PDFs; any
 * other file as text when its bytes are text (`fileText`), read at most 4 bytes per character it may still show; never
 * more than the call's `bytesLeft`. A missing blob is shown by name (and logged). So is one whose read fails or takes
 * longer than `BLOB_READ_TIMEOUT_MS` (logged once), unless the read before it failed too: two in a row, and the store
 * is down (`BlobStoreDown` is thrown). Once `stop()` says so, no further blob is read (what is left is shown by name,
 * and the caller ends the run). When `signal` aborts, the read under way is abandoned and its reason thrown.
 */
export async function buildContext(
  blobs: BlobStore,
  loaded: LoadedContext,
  resolved: Pick<Resolved, "vision" | "pdf">,
  log: Pick<FastifyBaseLogger, "error">,
  { signal, stop = () => false }: { signal?: AbortSignal; stop?: () => boolean } = {},
): Promise<BuiltContext> {
  const plan = new ContextPlan(loaded.entries, loaded.budget);
  let lastFailed = false;

  async function read(attachment: ContextAttachment, key: string, max: number, probe?: (head: Uint8Array) => boolean) {
    let got: { data: Buffer; complete: boolean } | null;
    try {
      got = await readPrefix(blobs, key, max, { ...(probe ? { probe } : {}), ...(signal ? { signal } : {}) });
    } catch (err) {
      if (signal?.aborted) throw signal.reason;
      if (lastFailed) throw new BlobStoreDown(err);
      lastFailed = true;
      log.error({ err, attachmentId: attachment.id }, "a sent attachment could not be read: it is shown by its name");
      return null;
    }
    lastFailed = false;
    if (!got) log.error({ attachmentId: attachment.id }, "the blob of a sent attachment is missing");
    return got;
  }
  async function show(slot: number, attachment: ContextAttachment): Promise<void> {
    if (stop()) return;
    const room = plan.room(slot);
    // Nothing could take its name's place: the budget is used up.
    if (room <= estimateTokens(attachmentLabel(attachment))) return;
    const found = loaded.attachments.get(attachment.id);
    if (!found) return;
    if (found.inline) {
      if (!MODEL_IMAGE_MIMES.has(found.mime) || !resolved.vision || !plan.canShowImage()) return;
      if (found.size > Math.min(IMAGE_MAX_BYTES, plan.bytesLeft) || room < IMAGE_TOKENS) return;
      const got = await read(attachment, found.blobKey, found.size);
      if (got?.complete) plan.offer(slot, { type: "image", mime: found.mime, data: got.data });
    } else if (found.mime === "application/pdf") {
      if (!resolved.pdf || found.size > Math.min(PDF_MAX_BYTES, plan.bytesLeft) || room < pdfTokens(found.size)) return;
      const got = await read(attachment, found.blobKey, found.size);
      if (got?.complete) plan.offer(slot, { type: "pdf", data: got.data });
    } else {
      const maxChars = Math.min(FILE_MAX_CHARS, plan.fileCharsLeft);
      // A text costs at least its name, a line break and one character.
      if (maxChars === 0 || plan.bytesLeft === 0 || room < estimateTokens(attachmentLabel(attachment)) + 2) return;
      const max = Math.min(found.size, maxChars * UTF8_MAX_BYTES_PER_CHAR, plan.bytesLeft);
      const got = await read(attachment, found.blobKey, max, startsLikeText);
      const text = got ? fileText(got.data, got.complete, maxChars) : null;
      if (text) plan.offer(slot, { type: "text", ...text });
    }
  }

  for (const [slot, attachment] of plan.attachments(false)) await show(slot, attachment);
  plan.keepOlder();
  for (const [slot, attachment] of plan.attachments(true)) await show(slot, attachment);
  const { messages, tokens } = plan.build();
  const inputTokensEstimate = estimateTokens(loaded.system) + tokens;
  return { messages, inputTokensEstimate, inputChars: inputTokensEstimate };
}
