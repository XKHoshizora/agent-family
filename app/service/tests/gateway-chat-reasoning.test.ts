import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChatReasoningTap, ThinkTags, type Split } from "../src/models/chat-reasoning.ts";
import { createModelGateway, type ModelEvent } from "../src/models/gateway.ts";
import { createSlots } from "../src/slots.ts";
import { protocolStub, STUB_MODEL, type ProtocolStub } from "./helpers/models.ts";

/**
 * The Chat Completions stream reader (src/models/chat-reasoning.ts) on bytes nobody vouches for: a provider's address
 * is its owner's own server. However the bytes are cut into chunks it reads the same events, and reading them costs
 * time in proportion to their length (each chunk is looked through once), up to its limit on one line or event, past
 * which it stops reading while the bytes still pass to the SDK whole. The `<think>` reader likewise gives the same
 * answer however the text is cut.
 */

/** The tap's limit on one unfinished line, and on one event's data (chat-reasoning.ts `MAX_EVENT_CHARS`). */
const MAX = 1024 * 1024;
/**
 * A bound no linear reading comes near (each test below takes about 0.1 s) and quadratic reading is far beyond: the
 * reader that re-read the whole unfinished line on every chunk took two minutes on the first of them.
 */
const BOUND_MS = 4000;
const SLOW = 60_000;

const encoder = new TextEncoder();
const bytes = (s: string) => encoder.encode(s);

/** `b` in pieces of `size` bytes (the last one shorter). */
function every(b: Uint8Array, size: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < b.length; i += size) out.push(b.subarray(i, i + size));
  return out;
}
/** `b` cut at `offsets` (ascending, inside it). */
function cutAt(b: Uint8Array, offsets: number[]): Uint8Array[] {
  const out: Uint8Array[] = [];
  let from = 0;
  for (const at of [...offsets, b.length]) {
    out.push(b.subarray(from, at));
    from = at;
  }
  return out;
}
/** A seeded generator of numbers in [0, 1) (mulberry32): the same cuts on every run. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** `length` cut at `count` distinct random offsets. */
function randomOffsets(next: () => number, length: number, count: number): number[] {
  const set = new Set<number>();
  while (set.size < Math.min(count, length - 1)) set.add(1 + Math.floor(next() * (length - 1)));
  return [...set].sort((a, b) => a - b);
}

/** `chunks` through a new tap's transform, as the gateway pipes a response body; the tap, and the bytes that came out. */
async function through(chunks: readonly Uint8Array[]): Promise<{ tap: ChatReasoningTap; out: Uint8Array }> {
  const tap = new ChatReasoningTap();
  let i = 0;
  const source = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(chunks[i++]!);
      else controller.close();
    },
  });
  const out = new Uint8Array(await new Response(source.pipeThrough(tap.transform())).arrayBuffer());
  return { tap, out };
}
/** What the tap queued: the reasoning before each of the first `marks` texts, then the reasoning left. */
const seen = (tap: ChatReasoningTap, marks: number): string[][] => [...Array.from({ length: marks }, () => tap.beforeText()), tap.rest()];
/** The same, read from `chunks`, with a check that the bytes passed unchanged. */
async function seenIn(chunks: readonly Uint8Array[], marks: number, whole: Uint8Array): Promise<string[][]> {
  const { tap, out } = await through(chunks);
  expect(Buffer.from(out).equals(Buffer.from(whole))).toBe(true);
  return seen(tap, marks);
}
/** How long `f` took, in ms. */
async function timed<T>(f: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const t0 = performance.now();
  const value = await f();
  return { value, ms: performance.now() - t0 };
}

/** One Chat Completions chunk carrying `delta`, as JSON. */
const chunk = (delta: object) => JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta, finish_reason: null }] });

/**
 * A valid stream using every line end (LF, CRLF, CR, and a mix within one event), a comment, other fields, a
 * multi-line `data:`, `data:` with and without its space, a delta with reasoning and text, a refusal, and text that is
 * more than one byte a character (cut inside a character by some chunkings).
 */
const STREAM = [
  ": keep-alive\n\n",
  `data: ${chunk({ role: "assistant", content: "" })}\r\n\r\n`,
  `data: ${chunk({ reasoning_content: "先想" })}\r\r`,
  `data: ${chunk({ reasoning_content: "一想，" })}\n\n`,
  `data: ${chunk({ content: "答" })}\r\n\r\n`,
  "event: ignored\nid: 7\n",
  `data: {"id":"c","choices":[{"index":0,"delta":\ndata: {"reasoning":"多行的"}}]}\r\n\n`,
  `data: ${chunk({ reasoning_content: "再想", content: "案" })}\r\n\r\n`,
  `data:${chunk({ refusal: "不" })}\n\n`,
  `data: ${chunk({ content: "。🙂" })}\r\r`,
  "data: [DONE]\n\n",
].join("");
/** Its four texts (答, 案, the refusal, 。🙂), the reasoning before each, and none after. */
const STREAM_MARKS = 4;
const STREAM_SEEN = [["先想", "一想，"], ["多行的", "再想"], [], [], []];

describe("the Chat Completions reader: the same events however the bytes are cut", () => {
  const whole = bytes(STREAM);

  it("in one chunk: every line end, multi-line data, reasoning and refusals read as the SDK reads them", async () => {
    expect(await seenIn([whole], STREAM_MARKS, whole)).toEqual(STREAM_SEEN);
  });

  it("cut once at every byte, so every line end (a CRLF too) and every character is cut somewhere", async () => {
    for (let at = 1; at < whole.length; at++) expect(await seenIn(cutAt(whole, [at]), STREAM_MARKS, whole), `cut at ${at}`).toEqual(STREAM_SEEN);
  });

  it("one byte at a time, and 300 random cuttings", async () => {
    expect(await seenIn(every(whole, 1), STREAM_MARKS, whole)).toEqual(STREAM_SEEN);
    const next = random(20261118);
    for (let trial = 0; trial < 300; trial++) {
      const offsets = randomOffsets(next, whole.length, 1 + Math.floor(next() * 60));
      expect(await seenIn(cutAt(whole, offsets), STREAM_MARKS, whole), `cut at ${offsets.join(",")}`).toEqual(STREAM_SEEN);
    }
  });

  it("a CR last in a chunk waits for the next to show whether an LF follows; a lone CR ends the line", async () => {
    const cut = [
      bytes(`data: ${chunk({ reasoning_content: "A" })}\r`),
      bytes(`\n\r\ndata: ${chunk({ reasoning_content: "B" })}\r`),
      bytes("\r"),
      bytes("data: [DONE]\n\n"),
    ];
    expect(seen((await through(cut)).tap, 0)).toEqual([["A", "B"]]);
    // A stream whose last byte is a CR: the line it would end is never read (as the SDK reads it).
    expect(seen((await through([bytes(`data: ${chunk({ reasoning_content: "A" })}\n\r`)])).tap, 0)).toEqual([[]]);
  });
});

describe("the Chat Completions reader: time in proportion to the bytes, however they are cut", () => {
  /** A `data:` line carrying `reasoning` (of `size` characters in all, line end not counted). */
  const reasoningLine = (size: number) => {
    const head = `data: {"choices":[{"index":0,"delta":{"reasoning_content":"`;
    const tail = `"}}]}`;
    const text = "x".repeat(size - head.length - tail.length);
    return { line: head + text + tail, text };
  };
  const after = `data: ${chunk({ content: "Done." })}\n\ndata: [DONE]\n\n`;

  it(
    "one line of 1 MiB in 64-byte chunks: read at once, and the same as in one chunk",
    async () => {
      const { line, text } = reasoningLine(MAX - 64);
      const whole = bytes(`${line}\n\n${after}`);
      const { value, ms } = await timed(() => seenIn(every(whole, 64), 1, whole));
      expect(value).toEqual([[text], []]);
      expect(await seenIn([whole], 1, whole)).toEqual(value);
      expect(ms, `took ${Math.round(ms)} ms`).toBeLessThan(BOUND_MS);
    },
    SLOW,
  );

  it(
    "one event of 1 MiB over sixteen data: lines, in 64-byte chunks",
    async () => {
      // A JSON value whose line breaks fall between its tokens: a padding array of sixteen 64 KiB strings, one a line.
      const pad = Array.from({ length: 16 }, () => `"${"p".repeat(64 * 1024 - 16)}",`);
      const data = [`{"pad":[`, ...pad, `""],"choices":[{"index":0,"delta":{"reasoning_content":"R"}}]}`];
      const whole = bytes(`${data.map((d) => `data: ${d}`).join("\r\n")}\r\n\r\n${after}`);
      const { value, ms } = await timed(() => seenIn(every(whole, 64), 1, whole));
      expect(value).toEqual([["R"], []]);
      expect(await seenIn([whole], 1, whole)).toEqual(value);
      expect(ms, `took ${Math.round(ms)} ms`).toBeLessThan(BOUND_MS);
    },
    SLOW,
  );

  it(
    "one line of 64 kB a byte at a time",
    async () => {
      const { line, text } = reasoningLine(64 * 1024);
      const whole = bytes(`${line}\r\n\r\n${after}`);
      const { value, ms } = await timed(() => seenIn(every(whole, 1), 1, whole));
      expect(value).toEqual([[text], []]);
      expect(ms, `took ${Math.round(ms)} ms`).toBeLessThan(BOUND_MS);
    },
    SLOW,
  );

  it(
    "the limit: a line of exactly MAX characters is read; one longer, or an event whose data is longer, stops the reading (the bytes still pass)",
    async () => {
      const exact = reasoningLine(MAX);
      expect(exact.line.length).toBe(MAX);
      const atLimit = bytes(`${exact.line}\n\n${after}`);
      expect(await seenIn(every(atLimit, 64), 1, atLimit)).toEqual([[exact.text], []]);

      // One character more: nothing of it is queued, nor of anything after it (a later reasoning included).
      const over = bytes(`${reasoningLine(MAX + 1).line}\n\ndata: ${chunk({ reasoning_content: "later" })}\n\n${after}`);
      const { value, ms } = await timed(() => seenIn(every(over, 64), 0, over));
      expect(value).toEqual([[]]);
      expect(ms, `took ${Math.round(ms)} ms`).toBeLessThan(BOUND_MS);
      // The same in one chunk: the limit does not depend on how the bytes came.
      expect(await seenIn([over], 0, over)).toEqual([[]]);

      // An event of two lines, each under the limit, whose data together is over it.
      const half = `data: "${"q".repeat(MAX / 2)}"`;
      const twoLines = bytes(`data: ${chunk({ reasoning_content: "before" })}\n\n${half}\n${half}\n\ndata: ${chunk({ reasoning_content: "later" })}\n\n${after}`);
      expect(await seenIn(every(twoLines, 64), 0, twoLines)).toEqual([["before"]]);
    },
    SLOW,
  );
});

describe("the gateway past the reader's limit", () => {
  let stub: ProtocolStub;
  beforeAll(async () => {
    stub = await protocolStub();
  });
  afterAll(async () => {
    await stub.close();
  });

  it("the reasoning before it is shown; the answer's text still arrives whole", async () => {
    const event = (delta: object, finish: string | null = null) =>
      `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: STUB_MODEL, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    const usage = `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: STUB_MODEL, choices: [], usage: { prompt_tokens: 3, completion_tokens: 5 } })}\n\n`;
    const body = [
      event({ role: "assistant", content: "" }),
      event({ reasoning_content: "first" }),
      event({ reasoning_content: "y".repeat(MAX + 1) }),
      event({ content: "The whole " }),
      event({ reasoning_content: "unread" }),
      event({ content: "answer." }),
      event({}, "stop"),
      usage,
      "data: [DONE]\n\n",
    ].join("");
    stub.answer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(body);
    });
    const gateway = createModelGateway({ calls: createSlots(4), allowInsecureLocal: true });
    const events: ModelEvent[] = [];
    for await (const e of gateway.stream({
      protocol: "openai_chat",
      baseUrl: stub.baseUrl,
      apiKey: "sk-stub",
      model: STUB_MODEL,
      system: "",
      messages: [{ role: "user", parts: [{ type: "text", text: "Hi" }] }],
      reasoning: "high",
      maxOutputTokens: 256,
      signal: new AbortController().signal,
    })) {
      events.push(e);
    }
    expect(events.filter((e) => e.type === "reasoning")).toEqual([{ type: "reasoning", delta: "first" }]);
    expect(events.flatMap((e) => (e.type === "text" ? [e.delta] : [])).join("")).toBe("The whole answer.");
    expect(events.at(-1)).toEqual({ type: "finish", usage: { inputTokens: 3, outputTokens: 5 }, truncated: false });
  });
});

describe("the <think> reader: the same answer however the text is cut", () => {
  /** Consecutive pieces of one kind joined. */
  const joined = (splits: Split[]): Array<[string, string]> => {
    const out: Array<[string, string]> = [];
    for (const s of splits) {
      const last = out.at(-1);
      if (last && last[0] === s.type) last[1] += s.delta;
      else out.push([s.type, s.delta]);
    }
    return out;
  };
  const read = (pieces: string[]) => {
    const tags = new ThinkTags();
    return joined([...pieces.flatMap((p) => tags.push(p)), ...tags.end()]);
  };
  /** `s` cut at `offsets` (pieces never empty: the gateway gives the reader no empty text). */
  const piecesOf = (s: string, offsets: number[]) => {
    const out: string[] = [];
    let from = 0;
    for (const at of [...offsets, s.length]) {
      out.push(s.slice(from, at));
      from = at;
    }
    return out;
  };

  const CASES: Array<{ name: string; answer: string; expected: Array<[string, string]> }> = [
    { name: "a block, then the answer", answer: "  <think>Pondering deeply</think>\n\nThe answer is 42.", expected: [["reasoning", "Pondering deeply"], ["text", "The answer is 42."]] },
    { name: "a look-alike close inside", answer: "<think>a</thinking about it</think>ok", expected: [["reasoning", "a</thinking about it"], ["text", "ok"]] },
    { name: "unclosed", answer: "<think>still going </thi", expected: [["reasoning", "still going </thi"]] },
    { name: "an empty block", answer: "<think></think>Answer", expected: [["text", "Answer"]] },
    { name: "only white space after the block", answer: "<think>\n</think>\n \n", expected: [["reasoning", "\n"]] },
    { name: "a tag not at the start", answer: "Use <think>tags</think> like this", expected: [["text", "Use <think>tags</think> like this"]] },
    { name: "a look-alike start", answer: "<this is text", expected: [["text", "<this is text"]] },
    { name: "a space inside the tag", answer: "< think>no", expected: [["text", "< think>no"]] },
    { name: "white space, then text", answer: "\nHello", expected: [["text", "\nHello"]] },
    { name: "a partial tag, then the end", answer: "<thi", expected: [["text", "<thi"]] },
    // At most 256 characters of white space before the tag, wherever the text is cut.
    { name: "256 spaces before the tag", answer: `${" ".repeat(256)}<think>x</think>y`, expected: [["reasoning", "x"], ["text", "y"]] },
    { name: "257 spaces before the tag", answer: `${" ".repeat(257)}<think>x</think>y`, expected: [["text", `${" ".repeat(257)}<think>x</think>y`]] },
  ];

  it.each(CASES)("$name: whole, cut once anywhere, a character at a time, and cut at random", ({ answer, expected }) => {
    expect(read([answer])).toEqual(expected);
    for (let at = 1; at < answer.length; at++) expect(read(piecesOf(answer, [at])), `cut at ${at}`).toEqual(expected);
    expect(read([...answer])).toEqual(expected);
    const next = random(answer.length);
    for (let trial = 0; trial < 50; trial++) {
      const offsets = [...new Set(Array.from({ length: 1 + Math.floor(next() * 8) }, () => 1 + Math.floor(next() * (answer.length - 1))))].sort((a, b) => a - b);
      expect(read(piecesOf(answer, offsets)), `cut at ${offsets.join(",")}`).toEqual(expected);
    }
  });

  it(
    "a long answer in one-character pieces is read at once, holding back only what may still be a tag",
    () => {
      const thought = "t".repeat(200_000);
      const answer = "a".repeat(200_000);
      const tags = new ThinkTags();
      const t0 = performance.now();
      const out = joined([...[..."<think>", ...thought, ..."</think>", ...answer].flatMap((c) => tags.push(c)), ...tags.end()]);
      const ms = performance.now() - t0;
      expect(out).toEqual([["reasoning", thought], ["text", answer]]);
      expect(ms, `took ${Math.round(ms)} ms`).toBeLessThan(BOUND_MS);
    },
    SLOW,
  );
});
