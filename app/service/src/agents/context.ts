import type { FastifyBaseLogger } from "fastify";
import type { Readable } from "node:stream";
import { isMissingBlob, type BlobStore } from "../attachments/blob.ts";
import { findDownloadable, type Downloadable } from "../attachments/store.ts";
import { currentMembership, VISIBLE_JOIN } from "../conversations/store.ts";
import type { Queryable } from "../db.ts";
import { estimateTokens, IMAGE_TOKENS, pdfTokens } from "../metering/prices.ts";
import type { AttachmentRef } from "../messages/model.ts";
import type { ModelCall } from "../models/gateway.ts";
import type { Resolved } from "../models/resolve.ts";
import { renderProposalBlock } from "./persona.ts";
import { GROUP_AGENTS_NAMED, type GroupScene } from "./runtime/prompt.ts";
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
/** In a group, the most of its latest messages a reply is shown (with `AGENT_GROUP_CONTEXT_TOKENS`, `ContextRun.group`). */
export const GROUP_CONTEXT_MESSAGES = 80;
/** The first bytes of a file looked at before the rest is read as text (`startsLikeText`). */
const PROBE_BYTES = 4096;
/** A blob that has not been read after this long is given up on: it is shown by its name, like one that failed. */
export const BLOB_READ_TIMEOUT_MS = 15_000;

/**
 * The blob store failed on two attachments of a reply and has served none of them: it is down, and the reply fails as
 * the service's trouble (`busy`).
 */
export class BlobStoreDown extends Error {
  constructor(cause: unknown) {
    super("the blob store failed on two attachments and served none", { cause });
    this.name = "BlobStoreDown";
  }
}

/**
 * The run a context is built for: it answers up to `coversSeq` — its owner, in the Agent's own conversation, or, in a
 * group (`group`), whoever called it there.
 */
export interface ContextRun {
  agentId: string;
  ownerId: string;
  conversationId: string;
  coversSeq: number;
  /**
   * The run's conversation is a group, not the Agent's own conversation with its owner (null): the most of the group's
   * history its model is shown — `maxTokens` tokens, counted as admission counts them (attachments at their estimate;
   * the system text is not in it), when the model's context would hold more, and of the group's latest `maxMessages`
   * messages only. The Agent's own conversation is limited by the model's context alone.
   */
  group: { maxTokens: number; maxMessages: number } | null;
}

/** What `loadContext` read: everything `buildContext` needs but the attachments' bytes. */
export interface LoadedContext {
  system: string;
  /** Tokens the conversation may take (`contextBudget`; in a group at most its `maxTokens`). */
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
  /** The sender's display name and kind (`principals`), for the speaker's label in a group. */
  sender_name: string;
  sender_kind: "human" | "agent";
  text: string | null;
  attachment: AttachmentRef | null;
  reply_to: unknown;
  answers: string | null;
  /** The persona proposal the Agent's reply made, if any (`persona_proposals` by `message_id`). */
  proposal_persona: string | null;
  proposal_intro: string | null;
  proposal_field: string | null;
}

const toAttachment = (a: AttachmentRef): ContextAttachment => ({ id: a.id, name: a.name, image: a.inline === true });

/** Who said a message of someone else's in a group, before its text: `名字：` for a person, `名字（Agent）：` for an Agent. */
export const speakerLabel = (name: string, kind: "human" | "agent"): string => (kind === "agent" ? `${name}（Agent）：` : `${name}：`);

/**
 * Up to `limit` messages the Agent can see with seq before `before`, newest first: text and file messages (not notices,
 * not the fixed greeting) that belong after the topic start `from` — in its own conversation the owner's, in a group
 * everyone's but its own — and the Agent's replies to what is covered up to `coversSeq`. A reply belongs where it was
 * answered: right after the message its run covered when it began (the run is the one named by the message's
 * `client_txn`). Only the text, the attachment and the quote are read of a message — never its stored reasoning. A quote
 * shows what the Agent can see of the quoted message: its text, or its attachment's name. In its own conversation the
 * owner's messages are `user` and anyone else's are left out (there is nobody else); in a group every message of
 * someone else's is `user`, starting with who said it (`speakerLabel`, their current name; a quote goes on the next
 * line). A reply of the Agent's that proposed a persona is its text followed by the proposal as the block it was written
 * in (`renderProposalBlock`): the Agent's own output, so it can revise what it proposed; it counts toward the budget like
 * any text and is never read for a block again. (A reply in a group never proposes: nothing is looked up there.)
 * `read`: how many messages the query returned; `more`: as many as `limit` (there may be older ones).
 */
async function loadPage(
  q: Queryable,
  run: ContextRun,
  from: number,
  before: number | null,
  limit: number,
): Promise<{ loaded: Loaded[]; oldest: number | null; more: boolean; read: number }> {
  const group = run.group !== null;
  const { rows } = await q.query<MessageRow>(
    `select m.seq::text as seq, m.sender_id, sp.display_name as sender_name, sp.kind as sender_kind,
            m.body ->> 'text' as text, m.body -> 'attachment' as attachment,
            m.body -> 'replyToSeq' as reply_to, r.covers_seq::text as answers,
            pp.persona as proposal_persona, pp.intro as proposal_intro, pp.field as proposal_field
       from messages m ${VISIBLE_JOIN}
       join principals sp on sp.id = m.sender_id
       left join agent_runs r
         on r.agent_id = $1
        and r.id = (case when m.sender_id = $1 and m.client_txn ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' then m.client_txn end)::uuid
       left join persona_proposals pp on pp.message_id = m.id and pp.agent_id = $1 and m.sender_id = $1 and not $8::boolean
      where m.conversation_id = $2 and m.seq > $3 and ($4::bigint is null or m.seq < $4::bigint)
        and m.kind in ('text', 'file') and (m.body -> 'fixed') is distinct from 'true'::jsonb
        and coalesce(r.covers_seq, m.seq) > $3
        and (m.sender_id = $6 or ($8::boolean and m.sender_id <> $1) or coalesce(r.covers_seq, m.seq) <= $5)
      order by m.seq desc
      limit $7`,
    [run.agentId, run.conversationId, from, before, run.coversSeq, run.ownerId, limit, group],
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
    const role = r.sender_id === run.agentId ? "assistant" : group || r.sender_id === run.ownerId ? "user" : null;
    if (role === null) return [];
    const quoted = typeof r.reply_to === "number" ? (quotes.get(r.reply_to) ?? null) : null;
    const seq = Number(r.seq);
    let text = entryText(r.text ?? "", quoted);
    if (group && role === "user") text =`${speakerLabel(r.sender_name, r.sender_kind)}${quoted === null ? "" : "\n"}${text}`;
    if (role === "assistant" && r.proposal_persona !== null) {
      const block = renderProposalBlock({ persona: r.proposal_persona, intro: r.proposal_intro, field: r.proposal_field });
      text = text === "" ? block : `${text}\n\n${block}`;
    }
    const entry: ContextEntry = { role, text, attachment: r.attachment ? toAttachment(r.attachment) : null };
    return [{ entry, seq, answers: r.answers === null ? seq : Number(r.answers), reply: r.answers !== null }];
  });
  return { loaded, oldest: rows.length > 0 ? Number(rows[rows.length - 1]!.seq) : null, more: rows.length === limit, read: rows.length };
}

/** In the order things were answered: by `answers`, a reply after the owner's message it answers, then by seq. */
const answeredOrder = (list: readonly Loaded[]): ContextEntry[] =>
  [...list].sort((a, b) => a.answers - b.answers || Number(a.reply) - Number(b.reply) || a.seq - b.seq).map((l) => l.entry);

/**
 * Step one of what the model is shown for `run` (spec 6.5 "发给模型的内容"; README "Agents and runs"), database only:
 * the messages after the latest new topic in the order they were answered, read newest first until they are more than
 * the budget (the model's context less its output limit and `system`; in a group at most `run.group.maxTokens`) can
 * hold — in a group, its latest `run.group.maxMessages` messages at most, as if what is older were left unread — and the
 * records of the attachments the plan could show — looked up only through `findDownloadable` with the Agent as reader
 * (the download's own permission); an image is not looked up when the model cannot see images. Everything that uses
 * the budget after this (`pastBudget` here, the plans here and in `buildContext`, `holdsNewest` in `begin`, and so
 * admission, which holds for what `buildContext` built) uses the capped one.
 */
export async function loadContext(
  q: Queryable,
  run: ContextRun,
  resolved: Pick<Resolved, "contextTokens" | "vision" | "call">,
  system: string,
): Promise<LoadedContext> {
  const whole = contextBudget(resolved.contextTokens, resolved.call.maxOutputTokens, system);
  const budget = run.group === null ? whole : Math.min(whole, run.group.maxTokens);
  const from = await topicStart(q, run.agentId, run.conversationId);
  const loaded: Loaded[] = [];
  // Read by seq, but shown in answered order: everything that belongs at or after the oldest seq read is known, and
  // only that is used while more is left unread (a reply may belong before messages not read yet).
  let oldest = Number.POSITIVE_INFINITY;
  let more = true;
  let before: number | null = null;
  let read = 0;
  while (more) {
    const limit = run.group === null ? PAGE : Math.min(PAGE, run.group.maxMessages - read);
    const page = await loadPage(q, run, from, before, limit);
    loaded.push(...page.loaded);
    read += page.read;
    more = page.more;
    if (page.oldest !== null) oldest = page.oldest;
    // A group's messages before its latest `maxMessages` are not read: they count as more left unread.
    if (more && run.group !== null && read >= run.group.maxMessages) break;
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

/** Whether there is anything to answer: an owner's message among what may be shown (in a group, anyone else's). */
export const hasOwnerTurn = (loaded: LoadedContext): boolean => loaded.entries.some((e) => e.role === "user");

/**
 * The group a run of Agent `agentId` answers in, for its system text (`groupSystemPrompt`): its title and the other
 * Agents that are current members of it now — not deleted (a deleted one is leaving), in the order they joined, at most
 * `GROUP_AGENTS_NAMED` named — or null when `agentId` itself is not a current member there. Plain reads, under the
 * caller's lock on the group's row (which every membership change takes).
 */
export async function loadGroupScene(q: Queryable, agentId: string, conversationId: string): Promise<GroupScene | null> {
  if (!(await currentMembership(q, conversationId, agentId))) return null;
  const title = await q.query<{ title: string | null }>("select title from conversations where id = $1", [conversationId]);
  const { rows } = await q.query<{ name: string; handle: string; intro: string }>(
    `select p.display_name as name, p.handle::text as handle, a.intro
       from memberships m
       join principals p on p.id = m.principal_id
       join agents a on a.principal_id = p.id
      where m.conversation_id = $1 and m.left_seq is null and p.kind = 'agent' and p.id <> $2 and a.deleted_at is null
      order by m.joined_seq, p.id
      limit $3`,
    [conversationId, agentId, GROUP_AGENTS_NAMED + 1],
  );
  return { title: title.rows[0]?.title ?? null, agents: rows.slice(0, GROUP_AGENTS_NAMED), more: rows.length > GROUP_AGENTS_NAMED };
}

/**
 * Step two, with no transaction open: the call's turns, chosen by `ContextPlan` from `loaded`, with the contents of
 * attachments when the model can take them and they fit — checked on their stored size before a byte is read: a PNG,
 * JPEG or WebP image (a GIF is named) up to 5 MB when the model sees images; a PDF up to 10 MB when it reads PDFs; any
 * other file as text when its bytes are text (`fileText`), read at most 4 bytes per character it may still show; never
 * more than the call's `bytesLeft`. A missing blob is shown by name (and logged). So is one whose read fails or takes
 * longer than `BLOB_READ_TIMEOUT_MS` (logged once) — unless no read of this build has succeeded and this is the second
 * that failed: then the store is down (`BlobStoreDown` is thrown). Once one read has succeeded (a missing blob counts:
 * the store answered), every later failure is shown by its name. Once `stop()` says so, no further blob is read (what
 * is left is shown by name, and the caller ends the run). When `signal` aborts, the read under way is abandoned and its
 * reason thrown.
 */
export async function buildContext(
  blobs: BlobStore,
  loaded: LoadedContext,
  resolved: Pick<Resolved, "vision" | "pdf">,
  log: Pick<FastifyBaseLogger, "error">,
  { signal, stop = () => false }: { signal?: AbortSignal; stop?: () => boolean } = {},
): Promise<BuiltContext> {
  const plan = new ContextPlan(loaded.entries, loaded.budget);
  /** Whether a read of this build has succeeded (the store answered), and how many have failed. */
  let served = false;
  let failed = 0;

  async function read(attachment: ContextAttachment, key: string, max: number, probe?: (head: Uint8Array) => boolean) {
    let got: { data: Buffer; complete: boolean } | null;
    try {
      got = await readPrefix(blobs, key, max, { ...(probe ? { probe } : {}), ...(signal ? { signal } : {}) });
    } catch (err) {
      if (signal?.aborted) throw signal.reason;
      failed++;
      if (!served && failed >= 2) throw new BlobStoreDown(err);
      log.error({ err, attachmentId: attachment.id }, "a sent attachment could not be read: it is shown by its name");
      return null;
    }
    served = true;
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
