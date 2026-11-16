import http from "node:http";
import type net from "node:net";
import type { Protocol } from "../../src/config.ts";
import { ModelError, type ModelCall, type ModelErrorCode, type ModelEvent, type ModelGateway } from "../../src/models/gateway.ts";

// --- a scripted gateway: what rule tests inject as `Deps.models` -----------------------------------------------------

export interface ReplyOptions {
  /** Streamed as `reasoning` deltas before the text. */
  reasoning?: string;
  /** The `finish` usage; default null (the upstream reported none). */
  usage?: { inputTokens: number; outputTokens: number } | null;
  /** A pause before every delta (the signal still ends it at once). */
  delayMsPerChunk?: number;
  /** The `finish` says the model stopped for length. */
  truncated?: boolean;
}

/** A call held by `hang()`. */
export interface Hold {
  /** Resolves with the call once it has started and is hanging. */
  readonly reached: Promise<ModelCall>;
  /** Lets the call go on: as `reply(text, options)` when there is text, else as `empty()`. */
  release(text?: string, options?: ReplyOptions): void;
}

/** How a call that streams ends up answering. */
type Answer = { kind: "reply"; text: string; options: ReplyOptions } | { kind: "empty" };
type Step =
  | Answer
  | { kind: "fail"; code: ModelErrorCode; afterText: string }
  | { kind: "cut"; text: string }
  | { kind: "hang"; before: string; gate: Promise<Answer>; reached: (call: ModelCall) => void };

export interface ScriptedGateway extends ModelGateway {
  /** Every call received, in order, as given (the signal included: `calls[i].signal.aborted`). */
  readonly calls: ModelCall[];
  /** What `listModels` answers. */
  models: string[];
  /** The next call streams `text` (and `options.reasoning` first), then `finish`. */
  reply(text: string, options?: ReplyOptions): ScriptedGateway;
  /** The next call throws `ModelError(code)`, after streaming `afterText` if given. */
  fail(code: ModelErrorCode, options?: { afterText?: string }): ScriptedGateway;
  /** The next call streams `text`, then simply ends: no `finish`, no error (an upstream that cut the stream short). */
  cut(text: string): ScriptedGateway;
  /** The next call hangs until released (or until its signal aborts). */
  hang(): Hold;
  /**
   * The next call streams `text`, then hangs until released (or until its signal aborts). `reached` resolves once the
   * caller has taken all of `text` and asked for more; `release(rest, options)` then streams `rest` and finishes.
   */
  hangAfter(text: string): Hold;
  /** The next call finishes at once with no text and no usage. */
  empty(): ScriptedGateway;
  /** Steps queued and not yet taken by a call. */
  pending(): number;
}

/** Chunks of at most 8 code points (a surrogate pair is never split). */
function chunks(text: string): string[] {
  const points = Array.from(text);
  const out: string[] = [];
  for (let i = 0; i < points.length; i += 8) out.push(points.slice(i, i + 8).join(""));
  return out;
}

/** `promise`, or the signal's reason as soon as it aborts. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (v) => (signal.removeEventListener("abort", onAbort), resolve(v)),
      (e: unknown) => (signal.removeEventListener("abort", onAbort), reject(e)),
    );
  });
}

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/**
 * A `ModelGateway` that answers from a script, in the order the steps were queued, and records every call. It behaves
 * like the real one where rule tests can tell: events come as `text` / `reasoning` deltas then one `finish`; a failure
 * is a thrown `ModelError`; when the call's signal aborts the iterator stops at once by throwing the signal's reason.
 * A call with nothing scripted throws a plain Error naming it.
 */
export function scriptedGateway(): ScriptedGateway {
  const queue: Step[] = [];
  const calls: ModelCall[] = [];

  async function* run(call: ModelCall, scripted: Step | undefined, n: number): AsyncGenerator<ModelEvent> {
    const { signal } = call;
    if (!scripted) throw new Error(`scriptedGateway: call #${n} was not scripted`);
    signal.throwIfAborted();
    let delay = 0;
    const emit = async function* (type: "text" | "reasoning", text: string): AsyncGenerator<ModelEvent> {
      for (const delta of chunks(text)) {
        if (delay > 0) await abortable(sleep(delay), signal);
        signal.throwIfAborted();
        yield { type, delta };
      }
    };
    if (scripted.kind === "cut") {
      yield* emit("text", scripted.text);
      return;
    }
    let step: Exclude<Step, { kind: "hang" } | { kind: "cut" }>;
    if (scripted.kind === "hang") {
      yield* emit("text", scripted.before);
      scripted.reached(call);
      step = await abortable(scripted.gate, signal);
    } else {
      step = scripted;
    }
    if (step.kind === "empty") {
      yield { type: "finish", usage: null, truncated: false };
      return;
    }
    delay = step.kind === "reply" ? (step.options.delayMsPerChunk ?? 0) : 0;
    if (step.kind === "fail") {
      yield* emit("text", step.afterText);
      throw new ModelError(step.code);
    }
    yield* emit("reasoning", step.options.reasoning ?? "");
    yield* emit("text", step.text);
    signal.throwIfAborted();
    yield { type: "finish", usage: step.options.usage ?? null, truncated: step.options.truncated ?? false };
  }

  const gateway: ScriptedGateway = {
    calls,
    models: [],
    stream(call) {
      calls.push(call);
      return run(call, queue.shift(), calls.length);
    },
    async listModels() {
      return [...gateway.models];
    },
    reply(text, options = {}) {
      queue.push({ kind: "reply", text, options });
      return gateway;
    },
    fail(code, options = {}) {
      queue.push({ kind: "fail", code, afterText: options.afterText ?? "" });
      return gateway;
    },
    cut(text) {
      queue.push({ kind: "cut", text });
      return gateway;
    },
    hang() {
      return gateway.hangAfter("");
    },
    hangAfter(before) {
      let open!: (answer: Answer) => void;
      let reached!: (call: ModelCall) => void;
      const gate = new Promise<Answer>((resolve) => (open = resolve));
      const reachedPromise = new Promise<ModelCall>((resolve) => (reached = resolve));
      queue.push({ kind: "hang", before, gate, reached });
      return {
        reached: reachedPromise,
        release(text, options = {}) {
          open(text === undefined ? { kind: "empty" } : { kind: "reply", text, options });
        },
      };
    },
    empty() {
      queue.push({ kind: "empty" });
      return gateway;
    },
    pending: () => queue.length,
  };
  return gateway;
}

// --- a local stand-in for the four protocols' streaming endpoints ---------------------------------------------------

/** The model name protocol tests call (no SDK recognises it, so it applies no model-specific rules). */
export const STUB_MODEL = "stub-model";

/** The canned answer, as the deltas every protocol streams it in. */
export const CANNED_TEXT_DELTAS = ["Hello", ", world", "! 你好。"] as const;
export const CANNED_TEXT = CANNED_TEXT_DELTAS.join("");
export const CANNED_REASONING_DELTAS = ["Let me think", " it over."] as const;
export const CANNED_REASONING = CANNED_REASONING_DELTAS.join("");
/** The usage every canned answer reports; with reasoning, 12 reasoning tokens are part of the 19 output tokens. */
export const CANNED_USAGE = { inputTokens: 11, outputTokens: 7 } as const;
export const CANNED_REASONING_USAGE = { inputTokens: 11, outputTokens: 19 } as const;

/** What a canned stream is: a plain answer, one that reasons first, or one that stops for length. */
export type CannedKind = "text" | "reasoning" | "length";

/** One server-sent event per entry: an `event:` line when named, then the JSON (or a literal) as `data:`. */
function sse(events: Array<{ event?: string; data: unknown }>): string {
  return events.map((e) => `${e.event ? `event: ${e.event}\n` : ""}data: ${typeof e.data === "string" ? e.data : JSON.stringify(e.data)}\n\n`).join("");
}

function openaiChatStream(kind: CannedKind): string {
  const chunk = (delta: object, finish: string | null = null) => ({
    data: { id: "chatcmpl-stub", object: "chat.completion.chunk", created: 1_700_000_000, model: STUB_MODEL, choices: [{ index: 0, delta, finish_reason: finish }] },
  });
  const reasoning = kind === "reasoning";
  return sse([
    chunk({ role: "assistant", content: "" }),
    // The OpenAI-compatible way some servers stream reasoning; the SDK's Chat Completions model does not read it.
    ...(reasoning ? CANNED_REASONING_DELTAS.map((d) => chunk({ reasoning_content: d })) : []),
    ...CANNED_TEXT_DELTAS.map((d) => chunk({ content: d })),
    chunk({}, kind === "length" ? "length" : "stop"),
    {
      data: {
        id: "chatcmpl-stub",
        object: "chat.completion.chunk",
        created: 1_700_000_000,
        model: STUB_MODEL,
        choices: [],
        usage: reasoning
          ? { prompt_tokens: 11, completion_tokens: 19, total_tokens: 30, completion_tokens_details: { reasoning_tokens: 12 } }
          : { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
      },
    },
    { data: "[DONE]" },
  ]);
}

function openaiResponsesStream(kind: CannedKind): string {
  let seq = 0;
  const ev = (type: string, fields: object) => ({ event: type, data: { type, sequence_number: seq++, ...fields } });
  const reasoning = kind === "reasoning";
  const msgIndex = reasoning ? 1 : 0;
  const message = (status: string, text: string | null) => ({
    type: "message",
    id: "msg_stub",
    status,
    role: "assistant",
    content: text === null ? [] : [{ type: "output_text", text, annotations: [] }],
  });
  const reasoningItem = (summary: string | null) => ({
    type: "reasoning",
    id: "rs_stub",
    summary: summary === null ? [] : [{ type: "summary_text", text: summary }],
  });
  const head = { id: "resp_stub", object: "response", created_at: 1_700_000_000, model: STUB_MODEL };
  const usage = reasoning
    ? { input_tokens: 11, input_tokens_details: { cached_tokens: 0 }, output_tokens: 19, output_tokens_details: { reasoning_tokens: 12 }, total_tokens: 30 }
    : { input_tokens: 11, input_tokens_details: { cached_tokens: 0 }, output_tokens: 7, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 18 };
  return sse([
    ev("response.created", { response: { ...head, status: "in_progress", output: [] } }),
    ev("response.in_progress", { response: { ...head, status: "in_progress", output: [] } }),
    ...(reasoning
      ? [
          ev("response.output_item.added", { output_index: 0, item: reasoningItem(null) }),
          ev("response.reasoning_summary_part.added", { item_id: "rs_stub", output_index: 0, summary_index: 0, part: { type: "summary_text", text: "" } }),
          ...CANNED_REASONING_DELTAS.map((delta) =>
            ev("response.reasoning_summary_text.delta", { item_id: "rs_stub", output_index: 0, summary_index: 0, delta }),
          ),
          ev("response.reasoning_summary_text.done", { item_id: "rs_stub", output_index: 0, summary_index: 0, text: CANNED_REASONING }),
          ev("response.reasoning_summary_part.done", {
            item_id: "rs_stub",
            output_index: 0,
            summary_index: 0,
            part: { type: "summary_text", text: CANNED_REASONING },
          }),
          ev("response.output_item.done", { output_index: 0, item: reasoningItem(CANNED_REASONING) }),
        ]
      : []),
    ev("response.output_item.added", { output_index: msgIndex, item: message("in_progress", null) }),
    ev("response.content_part.added", { item_id: "msg_stub", output_index: msgIndex, content_index: 0, part: { type: "output_text", text: "", annotations: [] } }),
    ...CANNED_TEXT_DELTAS.map((delta) =>
      ev("response.output_text.delta", { item_id: "msg_stub", output_index: msgIndex, content_index: 0, delta, logprobs: [] }),
    ),
    ev("response.output_text.done", { item_id: "msg_stub", output_index: msgIndex, content_index: 0, text: CANNED_TEXT }),
    ev("response.output_item.done", { output_index: msgIndex, item: message("completed", CANNED_TEXT) }),
    kind === "length"
      ? ev("response.incomplete", { response: { ...head, status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, usage } })
      : ev("response.completed", { response: { ...head, status: "completed", usage } }),
  ]);
}

function anthropicStream(kind: CannedKind): string {
  const reasoning = kind === "reasoning";
  const textIndex = reasoning ? 1 : 0;
  const ev = (type: string, fields: object = {}) => ({ event: type, data: { type, ...fields } });
  return sse([
    ev("message_start", {
      message: {
        id: "msg_stub",
        type: "message",
        role: "assistant",
        model: STUB_MODEL,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 11, output_tokens: 1 },
      },
    }),
    ...(reasoning
      ? [
          ev("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }),
          ...CANNED_REASONING_DELTAS.map((thinking) => ev("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking } })),
          ev("content_block_delta", { index: 0, delta: { type: "signature_delta", signature: "c2lnbmF0dXJl" } }),
          ev("content_block_stop", { index: 0 }),
        ]
      : []),
    ev("content_block_start", { index: textIndex, content_block: { type: "text", text: "" } }),
    ev("ping"),
    ...CANNED_TEXT_DELTAS.map((text) => ev("content_block_delta", { index: textIndex, delta: { type: "text_delta", text } })),
    ev("content_block_stop", { index: textIndex }),
    ev("message_delta", {
      delta: { stop_reason: kind === "length" ? "max_tokens" : "end_turn", stop_sequence: null },
      usage: { output_tokens: reasoning ? 19 : 7 },
    }),
    ev("message_stop"),
  ]);
}

function geminiStream(kind: CannedKind): string {
  const reasoning = kind === "reasoning";
  const chunk = (parts: object[], extra: object = {}) => ({
    data: { candidates: [{ content: { parts, role: "model" }, index: 0, ...extra }], modelVersion: STUB_MODEL },
  });
  const last = CANNED_TEXT_DELTAS.length - 1;
  return sse([
    ...(reasoning ? CANNED_REASONING_DELTAS.map((text) => chunk([{ text, thought: true }])) : []),
    ...CANNED_TEXT_DELTAS.map((text, i) =>
      i < last
        ? chunk([{ text }])
        : {
            data: {
              ...chunk([{ text }], { finishReason: kind === "length" ? "MAX_TOKENS" : "STOP" }).data,
              usageMetadata: reasoning
                ? { promptTokenCount: 11, candidatesTokenCount: 7, thoughtsTokenCount: 12, totalTokenCount: 30 }
                : { promptTokenCount: 11, candidatesTokenCount: 7, totalTokenCount: 18 },
            },
          },
    ),
  ]);
}

/** The canned event stream a protocol's streaming endpoint answers with. */
export function cannedStream(protocol: Protocol, kind: CannedKind): string {
  switch (protocol) {
    case "openai_chat":
      return openaiChatStream(kind);
    case "openai_responses":
      return openaiResponsesStream(kind);
    case "anthropic":
      return anthropicStream(kind);
    case "gemini":
      return geminiStream(kind);
  }
}

/** The protocol's own "your key is wrong" answer, echoing the key as some upstreams do. */
export function cannedKeyError(protocol: Protocol, key: string): { status: number; body: string } {
  switch (protocol) {
    case "openai_chat":
    case "openai_responses":
      return {
        status: 401,
        body: JSON.stringify({ error: { message: `Incorrect API key provided: ${key}.`, type: "invalid_request_error", param: null, code: "invalid_api_key" } }),
      };
    case "anthropic":
      return { status: 401, body: JSON.stringify({ type: "error", error: { type: "authentication_error", message: `invalid x-api-key ${key}` } }) };
    case "gemini":
      return { status: 403, body: JSON.stringify({ error: { code: 403, message: `API key ${key} is not allowed to call this method.`, status: "PERMISSION_DENIED" } }) };
  }
}

/** Which protocol's streaming endpoint `path` (below the stub's `/v1`) is, or null. */
export function protocolOfPath(path: string): Protocol | null {
  const p = path.split("?")[0]!;
  if (p.endsWith("/chat/completions")) return "openai_chat";
  if (p.endsWith("/responses")) return "openai_responses";
  if (p.endsWith("/messages")) return "anthropic";
  if (p.endsWith(":streamGenerateContent")) return "gemini";
  return null;
}

/** Writes the canned stream of the protocol `path` belongs to as an SSE response. */
export function answerCanned(req: StubRequest, res: http.ServerResponse, kind: CannedKind = "text"): void {
  const protocol = protocolOfPath(req.path);
  if (!protocol) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end('{"error":"no such endpoint"}');
    return;
  }
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  res.end(cannedStream(protocol, kind));
}

export interface StubRequest {
  method: string;
  /** Path and query, as sent (`/v1/chat/completions`). */
  path: string;
  headers: http.IncomingHttpHeaders;
  /** The JSON body, parsed (null when there was none). */
  body: any;
}

export type StubHandler = (req: StubRequest, res: http.ServerResponse) => void;

export interface ProtocolStub {
  /** `http://127.0.0.1:<port>/v1`: what a ModelCall's baseUrl is (reach it through a guard with `allowInsecureLocal`). */
  readonly baseUrl: string;
  /** Every request, in order: path, headers and parsed JSON body. */
  readonly requests: StubRequest[];
  /** Answers every request from now on with `handler` (default: `answerCanned`, the protocol's plain text stream). */
  answer(handler: StubHandler): void;
  /** Forgets the requests and goes back to the default answer. */
  reset(): void;
  close(): Promise<void>;
}

/**
 * A local HTTP server (127.0.0.1, plain HTTP) standing in for the four protocols' streaming endpoints. Each request is
 * read whole, recorded, then answered by the current handler.
 */
export async function protocolStub(): Promise<ProtocolStub> {
  const requests: StubRequest[] = [];
  let handler: StubHandler = (req, res) => answerCanned(req, res);
  const server = http.createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on("data", (c: Buffer) => parts.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(parts).toString("utf8");
      let body: unknown = null;
      try {
        body = raw === "" ? null : JSON.parse(raw);
      } catch {
        body = raw;
      }
      const seen: StubRequest = { method: req.method ?? "", path: req.url ?? "", headers: req.headers, body };
      requests.push(seen);
      handler(seen, res);
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as net.AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    answer(h) {
      handler = h;
    },
    reset() {
      requests.length = 0;
      handler = (req, res) => answerCanned(req, res);
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}
