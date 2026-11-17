/**
 * Reasoning on OpenAI Chat Completions, which the AI SDK's chat model does not read (its chunk schema drops every
 * delta field but `content`, `refusal`, `tool_calls` and `annotations`), in two forms:
 *
 * - `ChatReasoningTap`: a delta's own reasoning field, `reasoning_content` (DeepSeek and most OpenAI-compatible servers
 *   that think) or `reasoning` as a string, read off the event stream as it passes to the SDK unchanged.
 * - `ThinkTags`: an answer that opens with `<think>` (models that write their thinking into the text).
 */

/** One thing the tap saw, in stream order: a piece of reasoning, or a piece of the answer's text (one SDK text delta). */
type Seen = { kind: "reasoning"; text: string } | { kind: "text" };

/**
 * The longest line, and the most data of one event, the tap reads (characters); past it the tap stops reading the
 * stream (it still passes).
 */
const MAX_EVENT_CHARS = 1024 * 1024;
const LF = 10;

/** A delta's reasoning: `reasoning_content`, else `reasoning` when it is a string (as some compatible servers send it). */
function reasoningOf(delta: Record<string, unknown>): string {
  if (typeof delta.reasoning_content === "string") return delta.reasoning_content;
  return typeof delta.reasoning === "string" ? delta.reasoning : "";
}

const nonEmpty = (v: unknown): boolean => typeof v === "string" && v !== "";

/**
 * Reads a Chat Completions event stream as it passes (`transform()`: the bytes go on to the SDK as they came) and
 * queues, in stream order, each piece of reasoning it finds and a mark for each piece of text the SDK will give
 * (a delta's non-empty `content`, then its non-empty `refusal`: the SDK's text deltas, one each). The gateway takes
 * from the queue so that reasoning comes out exactly where it was in the stream relative to the text:
 *
 * - `leading()`: the reasoning at the head of the queue, ahead of every text the SDK has yet to give: due now. This is
 *   what makes a model's reasoning show while it thinks, although the SDK gives nothing until the first text arrives.
 * - `beforeText()`, when the SDK gives a text delta: the reasoning that came before it, and its mark.
 * - `rest()`, at the end: what is left.
 *
 * It looks at choice 0 only, as the SDK does. It reads in time proportional to the bytes, however they are cut into
 * chunks: each chunk is looked through once (`feed`). Bounded: it holds at most `MAX_EVENT_CHARS` of a line or of an
 * event's data, and stops reading (not passing) a stream that goes past it; what it queued is at most what the stream
 * carried, which the address guard bounds.
 */
export class ChatReasoningTap {
  private readonly queue: Seen[] = [];
  /** The unfinished line, as the pieces it came in (joined once, when it ends), and its length so far. */
  private line: string[] = [];
  private lineChars = 0;
  /** The unfinished line ended with a CR last in its piece: whether an LF follows (a CRLF) shows in the next piece. */
  private heldCR = false;
  /** The current event's `data:` values, and their length so far. */
  private data: string[] = [];
  private dataChars = 0;
  private reading = true;
  private wake!: () => void;
  private arrival!: Promise<void>;

  constructor() {
    this.renew();
  }

  private renew(): void {
    this.arrival = new Promise<void>((resolve) => (this.wake = resolve));
  }

  /** Resolves once something is queued after this call (never once the stream has ended). */
  changed(): Promise<void> {
    return this.arrival;
  }

  private push(seen: Seen): void {
    this.queue.push(seen);
    // Each arrival resolves the promise waited on and puts a pending one in its place: a promise left resolved would
    // have the gateway's wait return at once, for ever.
    this.wake();
    this.renew();
  }

  /** The bytes as they came; read on the way. */
  transform(): TransformStream<Uint8Array, Uint8Array> {
    const decoder = new TextDecoder();
    return new TransformStream<Uint8Array, Uint8Array>({
      transform: (chunk, controller) => {
        // Read before it is passed on: what the SDK makes of these bytes always finds their marks queued.
        if (this.reading) this.feed(decoder.decode(chunk, { stream: true }));
        controller.enqueue(chunk);
      },
      flush: () => {
        if (this.reading) this.feed(decoder.decode());
      },
    });
  }

  /** The reasoning at the head of the queue (none when a text's mark is first), taken off it. */
  leading(): string[] {
    const out: string[] = [];
    while (this.queue[0]?.kind === "reasoning") out.push((this.queue.shift() as { text: string }).text);
    return out;
  }

  /** The reasoning before the next text's mark, taken off the queue with that mark. */
  beforeText(): string[] {
    const out = this.leading();
    if (this.queue[0]?.kind === "text") this.queue.shift();
    return out;
  }

  /** All the reasoning still queued, the queue emptied. */
  rest(): string[] {
    const out = this.queue.flatMap((s) => (s.kind === "reasoning" ? [s.text] : []));
    this.queue.length = 0;
    return out;
  }

  /**
   * A piece of text decoded from the stream: split into lines (CRLF, LF or CR), each handled once it is complete.
   * Only the new piece is searched for line ends; the unfinished line is kept as its pieces, counted as it grows, and
   * joined once, when it ends — so a line costs time in proportion to its length however it is cut, and one longer
   * than `MAX_EVENT_CHARS` stops the reading without ever being joined. A CR last in the piece is the end of its line
   * either way, but whether it is a CRLF shows only in the next piece: the line is handled then (`heldCR`), as the
   * SDK's own reader does, so a stream whose last byte is a CR never has that line read.
   */
  private feed(text: string): void {
    if (text === "") return;
    let from = 0;
    if (this.heldCR) {
      this.heldCR = false;
      if (text.charCodeAt(0) === LF) from = 1; // the rest of a CRLF
      this.endLine("");
      if (!this.reading) return;
    }
    const ends = /\r\n?|\n/g;
    ends.lastIndex = from;
    for (let end = ends.exec(text); end !== null; end = ends.exec(text)) {
      const piece = text.slice(from, end.index);
      from = end.index + end[0].length;
      if (from === text.length && end[0] === "\r") {
        if (this.grow(piece)) this.heldCR = true;
        return;
      }
      this.endLine(piece);
      if (!this.reading) return;
    }
    this.grow(text.slice(from));
  }

  /** `piece` added to the unfinished line; false when that makes the line too long, and the reading stopped. */
  private grow(piece: string): boolean {
    if (piece === "") return true;
    this.lineChars += piece.length;
    if (this.lineChars > MAX_EVENT_CHARS) {
      this.stop();
      return false;
    }
    this.line.push(piece);
    return true;
  }

  /** The unfinished line, ending with `piece`, handled; unless it is too long (the reading stops). */
  private endLine(piece: string): void {
    if (!this.grow(piece)) return;
    const line = this.line.join("");
    this.line = [];
    this.lineChars = 0;
    this.handleLine(line);
  }

  private stop(): void {
    this.reading = false;
    this.line = [];
    this.lineChars = 0;
    this.heldCR = false;
    this.data = [];
    this.dataChars = 0;
  }

  /** One server-sent event line: `data:` fields gather until the blank line that ends the event; the rest is ignored. */
  private handleLine(line: string): void {
    if (line === "") {
      const data = this.data.join("\n");
      const any = this.data.length > 0;
      this.data = [];
      this.dataChars = 0;
      if (any) this.event(data);
      return;
    }
    if (!line.startsWith("data:")) return;
    const value = line.startsWith("data: ") ? line.slice(6) : line.slice(5);
    this.dataChars += value.length;
    if (this.dataChars > MAX_EVENT_CHARS) return this.stop();
    this.data.push(value);
  }

  private event(data: string): void {
    if (data === "[DONE]") return;
    let value: unknown;
    try {
      value = JSON.parse(data);
    } catch {
      return; // the SDK fails the stream on it
    }
    const choices = (value as { choices?: unknown } | null)?.choices;
    const delta = Array.isArray(choices) ? (choices[0] as { delta?: unknown } | undefined)?.delta : undefined;
    if (typeof delta !== "object" || delta === null) return;
    const d = delta as Record<string, unknown>;
    const thought = reasoningOf(d);
    if (thought !== "") this.push({ kind: "reasoning", text: thought });
    if (nonEmpty(d.content)) this.push({ kind: "text" });
    if (nonEmpty(d.refusal)) this.push({ kind: "text" });
  }
}

const OPEN = "<think>";
const CLOSE = "</think>";
/** The most leading white space an answer may have and still open with `<think>`: held until that shows. */
const MAX_LEADING = 256;

export type Split = { type: "text" | "reasoning"; delta: string };

/** How many characters at the end of `s` are the start of `tag` (fewer than all of it). */
function partialTagAtEnd(s: string, tag: string): number {
  for (let k = Math.min(tag.length - 1, s.length); k > 0; k--) if (s.endsWith(tag.slice(0, k))) return k;
  return 0;
}

/**
 * An answer's text, split into reasoning and text when it opens (after leading white space) with `<think>`: what
 * comes up to the matching `</think>` is reasoning, the rest the answer (its leading white space dropped); with the tag
 * never closed, all of it is reasoning. Only the opening of the answer counts — a `<think>` later in the text is text,
 * so an answer that mentions the tag is never swallowed; so is one with more than `MAX_LEADING` characters of white
 * space before it. Streaming: it holds back only what may still turn out to be a tag (the leading white space and a
 * partial `<think>`; a partial `</think>`), looks at each piece once, and reads the same however the text is cut.
 */
export class ThinkTags {
  private state: "start" | "inside" | "after" | "answer" = "start";
  /** Before the answer is known to open with `<think>` or not: its leading white space, then as much of the tag as came. */
  private space = "";
  private tag = "";
  /** Inside the block: a partial `</think>` at the end of what came. */
  private held = "";

  /** One piece of the answer's text, as the reasoning and text it is so far. */
  push(piece: string): Split[] {
    switch (this.state) {
      case "answer":
        return [{ type: "text", delta: piece }];
      case "after":
        return this.after(piece);
      case "inside":
        return this.inside(piece);
      case "start":
        return this.start(piece);
    }
  }

  /** What is still held, at the end of the answer: a start that never became a tag is text; an unclosed thought, reasoning. */
  end(): Split[] {
    if (this.state === "start") {
      const text = this.space + this.tag;
      this.space = this.tag = "";
      return text === "" ? [] : [{ type: "text", delta: text }];
    }
    const held = this.held;
    this.held = "";
    return this.state === "inside" && held !== "" ? [{ type: "reasoning", delta: held }] : [];
  }

  /** Still undecided: white space (once no part of the tag came), then the next characters the tag needs. */
  private start(piece: string): Split[] {
    let rest = piece;
    if (this.tag === "") {
      rest = piece.trimStart();
      this.space += piece.slice(0, piece.length - rest.length);
      if (this.space.length > MAX_LEADING) return this.answer(rest);
    }
    const needed = OPEN.length - this.tag.length;
    const tag = this.tag + rest.slice(0, needed);
    if (tag === OPEN) {
      this.state = "inside";
      this.space = this.tag = "";
      return this.inside(rest.slice(needed));
    }
    if (!OPEN.startsWith(tag)) return this.answer(rest);
    this.tag = tag; // all of `rest`, and still the start of the tag
    return [];
  }

  /** Not an answer that opens with `<think>`: what was held and `rest` are text, and so is all that follows. */
  private answer(rest: string): Split[] {
    this.state = "answer";
    const text = this.space + this.tag + rest;
    this.space = this.tag = "";
    return [{ type: "text", delta: text }];
  }

  private inside(piece: string): Split[] {
    const buffer = this.held + piece;
    const close = buffer.indexOf(CLOSE);
    if (close >= 0) {
      this.state = "after";
      this.held = "";
      const thought = buffer.slice(0, close);
      return [...(thought === "" ? [] : [{ type: "reasoning" as const, delta: thought }]), ...this.after(buffer.slice(close + CLOSE.length))];
    }
    const keep = partialTagAtEnd(buffer, CLOSE);
    this.held = buffer.slice(buffer.length - keep);
    const thought = buffer.slice(0, buffer.length - keep);
    return thought === "" ? [] : [{ type: "reasoning", delta: thought }];
  }

  private after(piece: string): Split[] {
    const text = piece.trimStart();
    if (text === "") return [];
    this.state = "answer";
    return [{ type: "text", delta: text }];
  }
}
