import type { FastifyBaseLogger } from "fastify";
import type { Readable } from "node:stream";
import { isMissingBlob, type BlobStore } from "../attachments/blob.ts";
import { findDownloadable } from "../attachments/store.ts";
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
  pastBudget,
  PDF_MAX_BYTES,
  startsLikeText,
  UTF8_MAX_BYTES_PER_CHAR,
  type ContextAttachment,
  type ContextEntry,
} from "./runtime/context.ts";

/**
 * `buildContext`: the database and blob side of what the model is shown (README "Agents and runs"). It reads the
 * messages and attachments the Agent may see and feeds them to the pure plan in `runtime/context.ts`.
 */

/** Messages read per query, newest first, until the budget is passed. */
const PAGE = 200;
/** The first bytes of a file looked at before the rest is read as text (`startsLikeText`). */
const PROBE_BYTES = 4096;
/** A blob that has not been read after this long is given up on: the reply fails as the service's trouble (`busy`). */
export const BLOB_READ_TIMEOUT_MS = 15_000;

/** The run a context is built for: it answers the owner up to `coversSeq`. */
export interface ContextRun {
  agentId: string;
  ownerId: string;
  conversationId: string;
  coversSeq: number;
}

export interface BuiltContext {
  /** Never empty unless there is nothing to answer (the caller must not call a model then). */
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
 * Rejects when the blob has not been read within `timeoutMs`, and for any other failure of the store.
 */
export async function readPrefix(
  blobs: BlobStore,
  key: string,
  max: number,
  { probe, timeoutMs = BLOB_READ_TIMEOUT_MS }: { probe?: (head: Uint8Array) => boolean; timeoutMs?: number } = {},
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
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`the blob ${key} did not arrive within ${timeoutMs} ms`)), timeoutMs);
  });
  try {
    return await Promise.race([reading, deadline]);
  } catch (err) {
    held.late = true;
    held.stream?.destroy();
    throw err;
  } finally {
    clearTimeout(timer);
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

interface MessageRow {
  seq: string;
  sender_id: string;
  text: string | null;
  attachment: AttachmentRef | null;
  reply_to: unknown;
}

/**
 * Up to `PAGE` messages the Agent can see after `from` and before `before`, newest first, as context entries: text and
 * file messages (not notices, not the fixed greeting) up to `coversSeq`, and the owner's after it. Only the text, the
 * attachment and the quote are read of a message — never its stored reasoning. A quote shows what the Agent can see of
 * the quoted message: its text, or its attachment's name.
 */
async function loadPage(
  q: Queryable,
  run: ContextRun,
  from: number,
  before: number | null,
): Promise<{ entries: ContextEntry[]; oldest: number | null; more: boolean }> {
  const { rows } = await q.query<MessageRow>(
    `select m.seq::text as seq, m.sender_id, m.body ->> 'text' as text, m.body -> 'attachment' as attachment,
            m.body -> 'replyToSeq' as reply_to
       from messages m ${VISIBLE_JOIN}
      where m.conversation_id = $2 and m.seq > $3 and ($4::bigint is null or m.seq < $4::bigint)
        and m.kind in ('text', 'file') and (m.body -> 'fixed') is distinct from 'true'::jsonb
        and (m.seq <= $5 or m.sender_id = $6)
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
  const entries = rows.flatMap((r): ContextEntry[] => {
    const role = r.sender_id === run.ownerId ? "user" : r.sender_id === run.agentId ? "assistant" : null;
    if (role === null) return [];
    const quoted = typeof r.reply_to === "number" ? (quotes.get(r.reply_to) ?? null) : null;
    return [{ role, text: entryText(r.text ?? "", quoted), attachment: r.attachment ? toAttachment(r.attachment) : null }];
  });
  return { entries, oldest: rows.length > 0 ? Number(rows[rows.length - 1]!.seq) : null, more: rows.length === PAGE };
}

const toAttachment = (a: AttachmentRef): ContextAttachment => ({ id: a.id, name: a.name, image: a.inline === true });

/**
 * What the model is shown for `run` (spec 6.5 "发给模型的内容"; README "Agents and runs"): the messages after the
 * latest new topic, chosen by `ContextPlan` within the model's context less its output limit and `system`, with the
 * contents of attachments when the model can take them. An attachment is read only through `findDownloadable` with the
 * Agent as the reader — the download's own permission — and only after its stored size passed the limit: an image
 * (PNG, JPEG, WebP, GIF) up to 5 MB when the model sees images; a PDF up to 10 MB when it reads PDFs; any other file
 * as text when its bytes are text (`fileText`), at most 4 bytes per character it may still show. A missing blob is
 * shown by name (and logged); any other failure to read one throws.
 */
export async function buildContext(
  q: Queryable,
  blobs: BlobStore,
  run: ContextRun,
  resolved: Pick<Resolved, "contextTokens" | "vision" | "pdf" | "call">,
  system: string,
  log: Pick<FastifyBaseLogger, "error">,
): Promise<BuiltContext> {
  const budget = contextBudget(resolved.contextTokens, resolved.call.maxOutputTokens, system);
  const from = await topicStart(q, run.agentId, run.conversationId);
  const newestFirst: ContextEntry[] = [];
  let before: number | null = null;
  for (;;) {
    const page = await loadPage(q, run, from, before);
    newestFirst.push(...page.entries);
    if (!page.more || pastBudget(newestFirst, budget)) break;
    before = page.oldest;
  }
  const plan = new ContextPlan(newestFirst.reverse(), budget);

  async function read(attachment: ContextAttachment, key: string, max: number, probe?: (head: Uint8Array) => boolean) {
    const got = await readPrefix(blobs, key, max, probe ? { probe } : {});
    if (!got) log.error({ attachmentId: attachment.id }, "the blob of a sent attachment is missing");
    return got;
  }
  async function show(slot: number, attachment: ContextAttachment): Promise<void> {
    // Not even looked up when nothing could take its name's place: the budget is used up, or it is an image that
    // cannot be shown.
    const room = plan.room(slot);
    if (room <= estimateTokens(attachmentLabel(attachment))) return;
    if (attachment.image && (!resolved.vision || !plan.canShowImage())) return;
    const found = await findDownloadable(q, run.agentId, attachment.id);
    if (!found) return;
    if (found.inline) {
      if (!resolved.vision || !plan.canShowImage() || found.size > IMAGE_MAX_BYTES || room < IMAGE_TOKENS) return;
      const got = await read(attachment, found.blobKey, found.size);
      if (got?.complete) plan.offer(slot, { type: "image", mime: found.mime, data: got.data });
    } else if (found.mime === "application/pdf") {
      if (!resolved.pdf || found.size > PDF_MAX_BYTES || room < pdfTokens(found.size)) return;
      const got = await read(attachment, found.blobKey, found.size);
      if (got?.complete) plan.offer(slot, { type: "pdf", data: got.data });
    } else {
      const maxChars = Math.min(FILE_MAX_CHARS, plan.fileCharsLeft);
      // A text costs at least its name, a line break and one character.
      if (maxChars === 0 || room < estimateTokens(attachmentLabel(attachment)) + 2) return;
      const got = await read(attachment, found.blobKey, Math.min(found.size, maxChars * UTF8_MAX_BYTES_PER_CHAR), startsLikeText);
      const text = got ? fileText(got.data, got.complete, maxChars) : null;
      if (text) plan.offer(slot, { type: "text", ...text });
    }
  }

  for (const [slot, attachment] of plan.attachments(false)) await show(slot, attachment);
  plan.keepOlder();
  for (const [slot, attachment] of plan.attachments(true)) await show(slot, attachment);
  const { messages, tokens } = plan.build();
  const inputTokensEstimate = estimateTokens(system) + tokens;
  return { messages, inputTokensEstimate, inputChars: inputTokensEstimate };
}
