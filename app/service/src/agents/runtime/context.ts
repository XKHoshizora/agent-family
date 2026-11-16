import { estimateTokens, IMAGE_TOKENS, pdfTokens } from "../../metering/prices.ts";
import type { ModelCall, Part } from "../../models/gateway.ts";
import { stripUnsafeText } from "../../schemas.ts";

/**
 * What the model is shown (spec 6.5 "发给模型的内容"; README "Agents and runs"), as pure functions: the budget, how a
 * message becomes parts, what of a file is text, and which turns and attachment contents fit. The queries and blob
 * reads that feed them are in `src/agents/context.ts`, outside the runtime (they need the database and the blob store).
 */

/** Characters of a quoted message shown before the quoting one. */
export const QUOTE_MAX_CHARS = 200;
/** The largest image shown to a model as an image. */
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
/** Images one call shows at most: the newest. */
export const IMAGES_PER_CALL = 10;
/** The largest PDF handed to a model that reads PDFs. */
export const PDF_MAX_BYTES = 10 * 1024 * 1024;
/** Characters of one file shown as text at most. */
export const FILE_MAX_CHARS = 100_000;
/** Characters of files shown as text in one call at most. */
export const CALL_FILE_MAX_CHARS = 200_000;
/** Bytes of attachments one call holds at most — images, PDFs and files' text together (10 images of 5 MB fill it). */
export const CALL_ATTACHMENT_MAX_BYTES = IMAGES_PER_CALL * IMAGE_MAX_BYTES;
/** UTF-8 takes at most this many bytes per character: reading 4 × n bytes yields at least n characters of a text. */
export const UTF8_MAX_BYTES_PER_CHAR = 4;
/** Ends a file's text that was cut. */
export const CUT_MARK = "…（已截断）";
/** Starts the newest message's text when it alone was over the budget and lost its beginning. */
export const CUT_FRONT = "…";

/** A file message's attachment, as the message names it. `image`: one the site shows as a picture (PNG, JPEG, WebP, GIF). */
export interface ContextAttachment {
  id: string;
  name: string;
  image: boolean;
}

/** One message as it may be shown: the owner's as `user`, the Agent's as `assistant`. */
export interface ContextEntry {
  role: "user" | "assistant";
  /** The quote (`> ` lines) and the message's own text or caption; may be empty when there is an attachment. */
  text: string;
  attachment: ContextAttachment | null;
}

/** What an attachment is shown as instead of its name: an image, a PDF, or the text of a file (cut already). */
export type AttachmentContent =
  | { type: "image"; mime: string; data: Uint8Array }
  | { type: "pdf"; data: Uint8Array }
  | { type: "text"; text: string; chars: number };

/** `[图片：name]` or `[文件：name]`: an attachment shown by its name. */
export const attachmentLabel = (a: Pick<ContextAttachment, "name" | "image">): string => (a.image ? `[图片：${a.name}]` : `[文件：${a.name}]`);

/** Tokens left for the conversation: the model's context less its output limit and the system text. */
export function contextBudget(contextTokens: number, maxOutputTokens: number, system: string): number {
  return contextTokens - maxOutputTokens - estimateTokens(system);
}

/** The first `QUOTE_MAX_CHARS` characters of a quoted message, each line as `> line`. */
export function quoteLines(quoted: string): string {
  return Array.from(quoted)
    .slice(0, QUOTE_MAX_CHARS)
    .join("")
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

/** A message's text as shown: what it quotes (`quoteLines`), if anything, then its own text. */
export function entryText(own: string, quoted: string | null): string {
  if (quoted === null) return own;
  return own === "" ? quoteLines(quoted) : `${quoteLines(quoted)}\n${own}`;
}

/** Tokens a part is counted as (metering/prices.ts): its characters, `IMAGE_TOKENS` for an image, `pdfTokens` for a PDF. */
export function partTokens(p: Part): number {
  return p.type === "text" ? estimateTokens(p.text) : p.type === "image" ? IMAGE_TOKENS : pdfTokens(p.data.length);
}

/** The attachment's part: its content when there is some, else its name. */
function attachmentPart(a: ContextAttachment, content: AttachmentContent | null): Part {
  if (content === null) return { type: "text", text: attachmentLabel(a) };
  switch (content.type) {
    case "image":
      return { type: "image", mime: content.mime, data: content.data };
    case "pdf":
      return { type: "file", mime: "application/pdf", name: a.name, data: content.data };
    case "text":
      return { type: "text", text: `${attachmentLabel(a)}\n${content.text}` };
  }
}

/** Tokens the message takes at least: its text and its attachment's name. */
export function minimalTokens(e: ContextEntry): number {
  return estimateTokens(e.text) + (e.attachment ? estimateTokens(attachmentLabel(e.attachment)) : 0);
}

/**
 * Whether messages loaded newest first already reach past the budget: from the owner's newest message (the Agent's
 * later ones are never shown) their least sizes add up to more than it, so nothing older can be shown.
 */
export function pastBudget(newestFirst: readonly ContextEntry[], budget: number): boolean {
  const from = newestFirst.findIndex((e) => e.role === "user");
  if (from < 0) return false;
  let total = 0;
  for (const e of newestFirst.slice(from)) {
    total += minimalTokens(e);
    if (total > budget) return true;
  }
  return false;
}

// --- files ------------------------------------------------------------------------------------------------------------

/** Control characters other than the white space text files use (tab, line feed, carriage return, form feed). */
const STRAY_CONTROLS = /(?![\t\n\r\f])\p{Cc}/gu;

/** The length of the longest prefix of `b` that does not end inside a UTF-8 sequence (a read cut short may). */
function wholeCharacters(b: Uint8Array): number {
  for (let back = 1; back <= Math.min(3, b.length); back++) {
    const byte = b[b.length - back]!;
    if ((byte & 0xc0) === 0x80) continue; // a continuation byte: its sequence starts further back
    const length = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return length > back ? b.length - back : b.length;
  }
  return b.length;
}

/**
 * A file's bytes as text for the model, decided by the bytes alone (not the name, not the stored type): they must be
 * UTF-8 (a leading byte-order mark is dropped; when `complete` is false the bytes were cut short and a character cut in
 * two at the end is dropped), contain no NUL, and at most 1 in 100 characters may be a control character other than
 * tab, line feed, carriage return and form feed. Otherwise null, as for a file with no characters. The text then
 * loses what message text may not hold (`stripUnsafeText`: bidi controls, control characters, lone surrogates) and is
 * cut to `maxChars` characters, marked `CUT_MARK` when it was cut here or the bytes were. `chars`: the characters of the
 * file shown, without the mark.
 */
export function fileText(bytes: Uint8Array, complete: boolean, maxChars: number): { text: string; chars: number } | null {
  let b = bytes;
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) b = b.subarray(3);
  if (!complete) b = b.subarray(0, wholeCharacters(b));
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(b);
  } catch {
    return null;
  }
  if (decoded === "" || decoded.includes("\u0000")) return null;
  const stray = decoded.match(STRAY_CONTROLS)?.length ?? 0;
  if (stray * 100 > estimateTokens(decoded)) return null;
  const characters = Array.from(stripUnsafeText(decoded));
  const cut = !complete || characters.length > maxChars;
  const shown = characters.slice(0, maxChars);
  if (shown.length === 0) return null;
  return { text: shown.join("") + (cut ? CUT_MARK : ""), chars: shown.length };
}

/** Whether the first bytes of a file could start a text (`fileText`): reading the rest is pointless otherwise. */
export const startsLikeText = (head: Uint8Array): boolean => fileText(head, false, Number.MAX_SAFE_INTEGER) !== null;

// --- the plan ---------------------------------------------------------------------------------------------------------

interface Kept {
  entry: ContextEntry;
  /** What its attachment is shown as; null: its name. */
  content: AttachmentContent | null;
}

/**
 * Which messages a call shows and which attachment contents, within `budget` tokens (`contextBudget`). Built from the
 * messages after the latest new topic in the order they were answered, oldest first; Agent messages after the owner's
 * newest are left out (a call ends on the owner's turn; answered order leaves none there but after a manual retry), and
 * so are messages with nothing to show. What fits, in this order:
 *
 * 1. The current turn — the owner's messages after the Agent's last — by name only, newest first, while they fit.
 *    The owner's newest message is always shown: when it alone is over the budget, it is cut from the front
 *    (`CUT_FRONT`, then its end).
 * 2. Its attachments' contents, newest first, each if it fits (`offer`).
 * 3. Older messages by name only, newest first, while they fit (`keepOlder`): no gaps, nothing older than one that did
 *    not fit.
 * 4. Their attachments' contents, newest first, each if it fits.
 *
 * So when the budget runs short, older messages' attachment contents go (leaving the name) before older messages do,
 * and the newest attachments are the last to go. At most `IMAGES_PER_CALL` images, `CALL_FILE_MAX_CHARS` characters
 * of files and `CALL_ATTACHMENT_MAX_BYTES` bytes of attachments in all are shown in one call, the newest first; the
 * caller reads nothing larger than `bytesLeft`, and files with `fileCharsLeft` as their limit.
 */
export class ContextPlan {
  /** Newest first: the current turn's (`current` of them), then older ones. */
  private readonly kept: Kept[] = [];
  private readonly current: number;
  private readonly older: ContextEntry[];
  private left: number;
  private imagesLeft = IMAGES_PER_CALL;
  /** Characters of files a text may still take in this call. */
  fileCharsLeft = CALL_FILE_MAX_CHARS;
  /** Bytes attachments may still take in this call. */
  bytesLeft = CALL_ATTACHMENT_MAX_BYTES;

  constructor(entries: readonly ContextEntry[], budget: number) {
    this.left = budget;
    const newestFirst = entries.filter((e) => e.text !== "" || e.attachment !== null).reverse();
    const newestOwn = newestFirst.findIndex((e) => e.role === "user");
    const shown = newestOwn < 0 ? [] : newestFirst.slice(newestOwn);
    const agentAt = shown.findIndex((e) => e.role === "assistant");
    const turn = agentAt < 0 ? shown : shown.slice(0, agentAt);
    let fits = true;
    for (const [i, e] of turn.entries()) {
      if (i === 0) this.keepNewest(e);
      else if (!(fits = this.keep(e))) break;
    }
    this.current = this.kept.length;
    this.older = fits ? shown.slice(turn.length) : [];
  }

  /** The owner's newest message: as it is when it fits, else cut from the front to what the budget holds. */
  private keepNewest(e: ContextEntry): void {
    if (this.keep(e)) return;
    const whole = [e.text, e.attachment ? attachmentLabel(e.attachment) : ""].filter((s) => s !== "").join("\n");
    const tail = Math.max(0, this.left - estimateTokens(CUT_FRONT));
    const text = CUT_FRONT + (tail === 0 ? "" : Array.from(whole).slice(-tail).join(""));
    this.kept.push({ entry: { ...e, text, attachment: null }, content: null });
    this.left -= estimateTokens(text);
  }

  /** Keeps `e` by name when it fits. */
  private keep(e: ContextEntry): boolean {
    const cost = minimalTokens(e);
    if (cost > this.left) return false;
    this.kept.push({ entry: e, content: null });
    this.left -= cost;
    return true;
  }

  /** Step 3: older messages by name, newest first, while they fit. */
  keepOlder(): void {
    for (const e of this.older) if (!this.keep(e)) break;
    this.older.length = 0;
  }

  /**
   * The attachments whose contents may still be offered, newest first: the current turn's (`older` false), or those of
   * the older messages kept by `keepOlder` (`older` true). Each is `[slot, attachment]`; pass the slot to `offer`.
   */
  attachments(older: boolean): Array<[number, ContextAttachment]> {
    const out: Array<[number, ContextAttachment]> = [];
    for (const [slot, k] of this.kept.entries()) {
      if ((slot >= this.current) === older && k.entry.attachment) out.push([slot, k.entry.attachment]);
    }
    return out;
  }

  /** Tokens an attachment's content may take at most: what is left, plus its name's, which the content replaces. */
  room(slot: number): number {
    return this.left + estimateTokens(attachmentLabel(this.kept[slot]!.entry.attachment!));
  }

  /** Whether one more image may be shown. */
  canShowImage(): boolean {
    return this.imagesLeft > 0;
  }

  /** Shows `content` instead of the attachment's name when it fits (and is within the per-call limits); true if so. */
  offer(slot: number, content: AttachmentContent): boolean {
    const k = this.kept[slot]!;
    const cost = partTokens(attachmentPart(k.entry.attachment!, content));
    const bytes = content.type === "text" ? Buffer.byteLength(content.text, "utf8") : content.data.length;
    if (cost > this.room(slot) || bytes > this.bytesLeft) return false;
    if (content.type === "image" && this.imagesLeft === 0) return false;
    if (content.type === "text" && content.chars > this.fileCharsLeft) return false;
    this.left = this.room(slot) - cost;
    this.bytesLeft -= bytes;
    k.content = content;
    if (content.type === "image") this.imagesLeft--;
    if (content.type === "text") this.fileCharsLeft -= content.chars;
    return true;
  }

  /**
   * The call's turns, oldest first: a turn of the Agent's first is left out (a call starts with the owner's), and
   * consecutive messages of one side are one turn, their parts in order. `tokens`: what they are counted as.
   */
  build(): { messages: ModelCall["messages"]; tokens: number } {
    const oldestFirst = [...this.kept].reverse();
    while (oldestFirst[0]?.entry.role === "assistant") oldestFirst.shift();
    const messages: ModelCall["messages"] = [];
    let tokens = 0;
    for (const { entry, content } of oldestFirst) {
      const parts: Part[] = [];
      if (entry.text !== "") parts.push({ type: "text", text: entry.text });
      if (entry.attachment) parts.push(attachmentPart(entry.attachment, content));
      for (const p of parts) tokens += partTokens(p);
      const last = messages[messages.length - 1];
      if (last?.role === entry.role) last.parts.push(...parts);
      else messages.push({ role: entry.role, parts });
    }
    return { messages, tokens };
  }
}
