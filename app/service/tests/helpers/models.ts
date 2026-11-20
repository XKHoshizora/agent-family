import http from "node:http";
import type net from "node:net";
import type { Protocol } from "../../src/config.ts";
import { ModelError, type ModelCall, type ModelErrorCode, type ModelEvent, type ModelGateway, type ToolCall } from "../../src/models/gateway.ts";

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
  /** Deltas of at most this many code points (default 8). */
  chunkSize?: number;
}

/** A call held by `hang()`. */
export interface Hold {
  /** Resolves with the call once it has started and is hanging. */
  readonly reached: Promise<ModelCall>;
  /** Lets the call go on: as `reply(text, options)` when there is text, else as `empty()`. */
  release(text?: string, options?: ReplyOptions): void;
}

/** How a call that streams ends up answering (`toolsRefused`: its finish says the tools were refused). */
type Answer = { kind: "reply"; text: string; options: ReplyOptions; toolsRefused?: true } | { kind: "empty" };
type Step =
  | Answer
  | { kind: "tools"; calls: Array<{ name: string; input: unknown }>; text: string; usage: { inputTokens: number; outputTokens: number } | null }
  | { kind: "fail"; code: ModelErrorCode; afterText: string; status?: number; usage?: { inputTokens: number; outputTokens: number } }
  | { kind: "cut"; text: string }
  | { kind: "hang"; before: string; gate: Promise<Answer>; reached: (call: ModelCall) => void };

export interface ScriptedGateway extends ModelGateway {
  /**
   * Every call received, in order, as given (the signal included: `calls[i].signal.aborted`) — except that a call's
   * `tools` and `steps` are copied as they were when it was made, so a caller that goes on adding to its own list of
   * steps does not change what an earlier call is recorded with.
   */
  readonly calls: ModelCall[];
  /** What `listModels` answers. */
  models: string[];
  /** The next call streams `text` (and `options.reasoning` first), then `finish`. */
  reply(text: string, options?: ReplyOptions): ScriptedGateway;
  /**
   * The next call is a round that ends in tool calls: it streams `options.text` (if any), then one `tool_call` per call
   * (each with an id no other call of this gateway has), then a finish naming them, with `options.usage` (default null)
   * and an opaque assistant turn that survives a JSON round trip, as the real gateway's does.
   */
  callTools(calls: Array<{ name: string; input: unknown }>, options?: { text?: string; usage?: { inputTokens: number; outputTokens: number } | null }): ScriptedGateway;
  /**
   * The next call is one whose upstream refused the tools: it answers as `reply(text, options)` does and its finish
   * reports `toolsRefused`.
   */
  refuseTools(text?: string, options?: ReplyOptions): ScriptedGateway;
  /**
   * The next call throws `ModelError(code)` (with `usage`, as `thinking_exhausted` has it, and the upstream's HTTP `status`
   * when given), after streaming `afterText` if given.
   */
  fail(code: ModelErrorCode, options?: { afterText?: string; status?: number; usage?: { inputTokens: number; outputTokens: number } }): ScriptedGateway;
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

/** Chunks of at most `size` code points (a surrogate pair is never split). */
function chunks(text: string, size = 8): string[] {
  const points = Array.from(text);
  const out: string[] = [];
  for (let i = 0; i < points.length; i += size) out.push(points.slice(i, i + size).join(""));
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

/** The scripted round's assistant turn, shaped as the SDK's: its text, then its tool calls (nothing said: no turn). */
function scriptedTurn(text: string, toolCalls: ToolCall[]): unknown {
  const content = [
    ...(text === "" ? [] : [{ type: "text", text }]),
    ...toolCalls.map((c) => ({ type: "tool-call", toolCallId: c.id, toolName: c.name, input: c.input })),
  ];
  return content.length === 0 ? [] : [{ role: "assistant", content }];
}

/** The finish of a scripted round. */
function finished(
  usage: { inputTokens: number; outputTokens: number } | null,
  truncated: boolean,
  text: string,
  toolCalls: ToolCall[] = [],
): Extract<ModelEvent, { type: "finish" }> {
  return { type: "finish", usage, truncated, toolCalls, assistant: scriptedTurn(text, toolCalls) };
}

/**
 * A `ModelGateway` that answers from a script, in the order the steps were queued, and records every call. It behaves
 * like the real one where rule tests can tell: events come as `text` / `reasoning` deltas and `tool_call`s then one
 * `finish`; a failure is a thrown `ModelError`; when the call's signal aborts the iterator stops at once by throwing the
 * signal's reason. A call with nothing scripted throws a plain Error naming it.
 */
export function scriptedGateway(): ScriptedGateway {
  const queue: Step[] = [];
  const calls: ModelCall[] = [];
  /** Tool calls made so far: each gets the next id. */
  let toolCallsMade = 0;

  async function* run(call: ModelCall, scripted: Step | undefined, n: number): AsyncGenerator<ModelEvent> {
    const { signal } = call;
    if (!scripted) throw new Error(`scriptedGateway: call #${n} was not scripted`);
    signal.throwIfAborted();
    let delay = 0;
    let size = 8;
    const emit = async function* (type: "text" | "reasoning", text: string): AsyncGenerator<ModelEvent> {
      for (const delta of chunks(text, size)) {
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
      yield finished(null, false, "");
      return;
    }
    delay = step.kind === "reply" ? (step.options.delayMsPerChunk ?? 0) : 0;
    size = step.kind === "reply" ? (step.options.chunkSize ?? 8) : 8;
    if (step.kind === "fail") {
      yield* emit("text", step.afterText);
      throw new ModelError(step.code, step.status, step.usage);
    }
    if (step.kind === "tools") {
      yield* emit("text", step.text);
      const made: ToolCall[] = [];
      for (const { name, input } of step.calls) {
        signal.throwIfAborted();
        const toolCall = { id: `scripted-call-${++toolCallsMade}`, name, input };
        made.push(toolCall);
        yield { type: "tool_call", call: toolCall };
      }
      signal.throwIfAborted();
      yield finished(step.usage, false, step.text, made);
      return;
    }
    yield* emit("reasoning", step.options.reasoning ?? "");
    yield* emit("text", step.text);
    signal.throwIfAborted();
    const finish = finished(step.options.usage ?? null, step.options.truncated ?? false, step.text);
    yield step.toolsRefused ? { ...finish, toolsRefused: true } : finish;
  }

  const gateway: ScriptedGateway = {
    calls,
    models: [],
    stream(call) {
      const recorded = call.tools || call.steps ? { ...call, ...(call.tools ? { tools: [...call.tools] } : {}), ...(call.steps ? { steps: [...call.steps] } : {}) } : call;
      calls.push(recorded);
      return run(recorded, queue.shift(), calls.length);
    },
    async listModels() {
      return [...gateway.models];
    },
    reply(text, options = {}) {
      queue.push({ kind: "reply", text, options });
      return gateway;
    },
    callTools(toolCalls, options = {}) {
      queue.push({ kind: "tools", calls: toolCalls, text: options.text ?? "", usage: options.usage ?? null });
      return gateway;
    },
    refuseTools(text = "Answered without tools.", options = {}) {
      queue.push({ kind: "reply", text, options, toolsRefused: true });
      return gateway;
    },
    fail(code, options = {}) {
      queue.push({ kind: "fail", code, afterText: options.afterText ?? "", ...(options.status ? { status: options.status } : {}), ...(options.usage ? { usage: options.usage } : {}) });
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

/**
 * What a canned stream is: a plain answer, one that reasons first, one that stops for length; or a round that ends in
 * one tool call (`CANNED_TOOL`, no text), plainly or after reasoning (signed or encrypted where the protocol does that).
 */
export type CannedKind = "text" | "reasoning" | "length" | "tool" | "reasoning_tool";

/** The tool call every canned tool stream makes, and its input's JSON as the protocols that stream it send it. */
export const CANNED_TOOL = { name: "search_messages", input: { query: "川菜", limit: 3 } } as const;
export const CANNED_TOOL_ARGS = ['{"query":"川菜",', '"limit":3}'] as const;
/** The call's id, where the protocol gives one (Gemini gives none: the SDK makes one up). */
export const CANNED_TOOL_CALL_ID = "call_stub_1";
/** What a canned round's reasoning comes with that the next round must send back: Anthropic's signature, OpenAI's encrypted reasoning, Gemini's thought signature. */
export const CANNED_SIGNATURE = "c2lnbmF0dXJl";
export const CANNED_ENCRYPTED_REASONING = "enc-stub-reasoning";
export const CANNED_THOUGHT_SIGNATURE = "dGhvdWdodA==";

export interface CannedOptions {
  /** A tool stream's input JSON, in the pieces it streams (default `CANNED_TOOL_ARGS`); Gemini sends it whole, parsed. */
  toolArgs?: readonly string[];
}

const isTool = (kind: CannedKind) => kind === "tool" || kind === "reasoning_tool";
const reasons = (kind: CannedKind) => kind === "reasoning" || kind === "reasoning_tool";

/** One server-sent event per entry: an `event:` line when named, then the JSON (or a literal) as `data:`. */
function sse(events: Array<{ event?: string; data: unknown }>): string {
  return events.map((e) => `${e.event ? `event: ${e.event}\n` : ""}data: ${typeof e.data === "string" ? e.data : JSON.stringify(e.data)}\n\n`).join("");
}

function openaiChatStream(kind: CannedKind, toolArgs: readonly string[]): string {
  const chunk = (delta: object, finish: string | null = null) => ({
    data: { id: "chatcmpl-stub", object: "chat.completion.chunk", created: 1_700_000_000, model: STUB_MODEL, choices: [{ index: 0, delta, finish_reason: finish }] },
  });
  const reasoning = reasons(kind);
  const tool = isTool(kind);
  return sse([
    chunk({ role: "assistant", content: tool ? null : "" }),
    // The OpenAI-compatible way some servers stream reasoning: the SDK's Chat Completions model does not read it, the
    // gateway does (src/models/chat-reasoning.ts).
    ...(reasoning ? CANNED_REASONING_DELTAS.map((d) => chunk({ reasoning_content: d })) : []),
    ...(tool
      ? [
          chunk({ tool_calls: [{ index: 0, id: CANNED_TOOL_CALL_ID, type: "function", function: { name: CANNED_TOOL.name, arguments: "" } }] }),
          ...toolArgs.map((piece) => chunk({ tool_calls: [{ index: 0, function: { arguments: piece } }] })),
        ]
      : CANNED_TEXT_DELTAS.map((d) => chunk({ content: d }))),
    chunk({}, kind === "length" ? "length" : tool ? "tool_calls" : "stop"),
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

function openaiResponsesStream(kind: CannedKind, toolArgs: readonly string[]): string {
  let seq = 0;
  const ev = (type: string, fields: object) => ({ event: type, data: { type, sequence_number: seq++, ...fields } });
  const reasoning = reasons(kind);
  const tool = isTool(kind);
  const msgIndex = reasoning ? 1 : 0;
  const message = (status: string, text: string | null) => ({
    type: "message",
    id: "msg_stub",
    status,
    role: "assistant",
    content: text === null ? [] : [{ type: "output_text", text, annotations: [] }],
  });
  // A round that ends in a tool call carries its reasoning encrypted (asked for with `store: false`): sent back next round.
  const reasoningItem = (summary: string | null) => ({
    type: "reasoning",
    id: "rs_stub",
    summary: summary === null ? [] : [{ type: "summary_text", text: summary }],
    ...(tool ? { encrypted_content: CANNED_ENCRYPTED_REASONING } : {}),
  });
  const functionCall = (status: string, args: string) => ({
    type: "function_call",
    id: "fc_stub",
    call_id: CANNED_TOOL_CALL_ID,
    name: CANNED_TOOL.name,
    arguments: args,
    status,
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
    ...(tool
      ? [
          ev("response.output_item.added", { output_index: msgIndex, item: functionCall("in_progress", "") }),
          ...toolArgs.map((delta) => ev("response.function_call_arguments.delta", { item_id: "fc_stub", output_index: msgIndex, delta })),
          ev("response.function_call_arguments.done", { item_id: "fc_stub", output_index: msgIndex, arguments: toolArgs.join("") }),
          ev("response.output_item.done", { output_index: msgIndex, item: functionCall("completed", toolArgs.join("")) }),
        ]
      : [
          ev("response.output_item.added", { output_index: msgIndex, item: message("in_progress", null) }),
          ev("response.content_part.added", { item_id: "msg_stub", output_index: msgIndex, content_index: 0, part: { type: "output_text", text: "", annotations: [] } }),
          ...CANNED_TEXT_DELTAS.map((delta) =>
            ev("response.output_text.delta", { item_id: "msg_stub", output_index: msgIndex, content_index: 0, delta, logprobs: [] }),
          ),
          ev("response.output_text.done", { item_id: "msg_stub", output_index: msgIndex, content_index: 0, text: CANNED_TEXT }),
          ev("response.output_item.done", { output_index: msgIndex, item: message("completed", CANNED_TEXT) }),
        ]),
    kind === "length"
      ? ev("response.incomplete", { response: { ...head, status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, usage } })
      : ev("response.completed", { response: { ...head, status: "completed", usage } }),
  ]);
}

function anthropicStream(kind: CannedKind, toolArgs: readonly string[]): string {
  const reasoning = reasons(kind);
  const tool = isTool(kind);
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
          ev("content_block_delta", { index: 0, delta: { type: "signature_delta", signature: CANNED_SIGNATURE } }),
          ev("content_block_stop", { index: 0 }),
        ]
      : []),
    ...(tool
      ? [
          ev("content_block_start", { index: textIndex, content_block: { type: "tool_use", id: CANNED_TOOL_CALL_ID, name: CANNED_TOOL.name, input: {} } }),
          ev("ping"),
          ...toolArgs.map((partial_json) => ev("content_block_delta", { index: textIndex, delta: { type: "input_json_delta", partial_json } })),
        ]
      : [
          ev("content_block_start", { index: textIndex, content_block: { type: "text", text: "" } }),
          ev("ping"),
          ...CANNED_TEXT_DELTAS.map((text) => ev("content_block_delta", { index: textIndex, delta: { type: "text_delta", text } })),
        ]),
    ev("content_block_stop", { index: textIndex }),
    ev("message_delta", {
      delta: { stop_reason: kind === "length" ? "max_tokens" : tool ? "tool_use" : "end_turn", stop_sequence: null },
      usage: { output_tokens: reasoning ? 19 : 7 },
    }),
    ev("message_stop"),
  ]);
}

function geminiStream(kind: CannedKind, toolArgs: readonly string[]): string {
  const reasoning = reasons(kind);
  const chunk = (parts: object[], extra: object = {}) => ({
    data: { candidates: [{ content: { parts, role: "model" }, index: 0, ...extra }], modelVersion: STUB_MODEL },
  });
  const usageMetadata = reasoning
    ? { promptTokenCount: 11, candidatesTokenCount: 7, thoughtsTokenCount: 12, totalTokenCount: 30 }
    : { promptTokenCount: 11, candidatesTokenCount: 7, totalTokenCount: 18 };
  const thoughts = reasoning ? CANNED_REASONING_DELTAS.map((text) => chunk([{ text, thought: true }])) : [];
  if (isTool(kind)) {
    // A function call comes whole, its arguments parsed; after reasoning it carries the thought signature.
    const functionCall = { functionCall: { name: CANNED_TOOL.name, args: JSON.parse(toolArgs.join("")) }, ...(reasoning ? { thoughtSignature: CANNED_THOUGHT_SIGNATURE } : {}) };
    return sse([...thoughts, { data: { ...chunk([functionCall], { finishReason: "STOP" }).data, usageMetadata } }]);
  }
  const last = CANNED_TEXT_DELTAS.length - 1;
  return sse([
    ...thoughts,
    ...CANNED_TEXT_DELTAS.map((text, i) =>
      i < last ? chunk([{ text }]) : { data: { ...chunk([{ text }], { finishReason: kind === "length" ? "MAX_TOKENS" : "STOP" }).data, usageMetadata } },
    ),
  ]);
}

/** The canned event stream a protocol's streaming endpoint answers with. */
export function cannedStream(protocol: Protocol, kind: CannedKind, options: CannedOptions = {}): string {
  const toolArgs = options.toolArgs ?? CANNED_TOOL_ARGS;
  switch (protocol) {
    case "openai_chat":
      return openaiChatStream(kind, toolArgs);
    case "openai_responses":
      return openaiResponsesStream(kind, toolArgs);
    case "anthropic":
      return anthropicStream(kind, toolArgs);
    case "gemini":
      return geminiStream(kind, toolArgs);
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
  /** The body exactly as it arrived (UTF-8). */
  raw: string;
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
      const seen: StubRequest = { method: req.method ?? "", path: req.url ?? "", headers: req.headers, body, raw };
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
