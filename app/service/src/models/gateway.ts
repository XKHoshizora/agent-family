import { createAnthropic, type AnthropicLanguageModelOptions } from "@ai-sdk/anthropic";
import { createGoogle, type GoogleLanguageModelOptions } from "@ai-sdk/google";
import { createOpenAI, type OpenAILanguageModelChatOptions, type OpenAILanguageModelResponsesOptions } from "@ai-sdk/openai";
import { APICallError, streamText, type LanguageModel, type LanguageModelUsage, type ModelMessage, type TextStreamPart, type ToolSet } from "ai";
import type { Protocol, ReasoningLevel } from "../config.ts";
import { AppError } from "../errors.ts";
import { hasVisibleText } from "../schemas.ts";
import { guardedFetch } from "../providers/guard.ts";
import { createProviderProbe, PROBE_GUARD, ProviderCallError, type ProviderCallCode } from "../providers/probe.ts";
import type { Slots } from "../slots.ts";
import { ChatReasoningTap, ThinkTags } from "./chat-reasoning.ts";

/**
 * The model gateway: the one place the service talks to a language model. Every call goes out through the address
 * guard (`guardedFetch`), whoever's model it is (a site model or a person's provider), over one of four protocols,
 * through the Vercel AI SDK's provider packages (`streamText`; no hosted gateway, no telemetry).
 */

export type { ReasoningLevel } from "../config.ts";

export type Part =
  | { type: "text"; text: string }
  | { type: "image"; mime: string; data: Uint8Array }
  | { type: "file"; mime: "application/pdf"; name: string; data: Uint8Array };

export interface ModelCall {
  protocol: Protocol;
  /** Used as the SDK provider's `baseURL` as it is: each protocol appends its own path (README, "Calling a model"). */
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Empty: no system text is sent. */
  system: string;
  messages: Array<{ role: "user" | "assistant"; parts: Part[] }>;
  reasoning: ReasoningLevel;
  /** Sent as it is: the reply's limit and, at a level, its thinking allowance (src/models/resolve.ts `outputLimit`). */
  maxOutputTokens: number;
  /**
   * Chat Completions only: the upstream thinks unless told not to and takes the common switch for it, `thinking:
   * {type: "disabled"}` at `none`, `{type: "enabled"}` at any other level. Absent or false: not sent.
   */
  thinkingSwitch?: boolean;
  /**
   * Who the upstream is (`site:<id>`, `provider:<id>@<baseUrl>`: a provider whose address changed is another): an
   * optional field it refused is remembered under it, in this process, and left out of its later calls. Absent:
   * nothing is remembered.
   */
  upstreamId?: string;
  /** Bounds the call: aborting it ends the stream at once and closes the upstream connection. */
  signal: AbortSignal;
}

export type ModelEvent =
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "finish"; usage: { inputTokens: number; outputTokens: number } | null; truncated: boolean };

export interface ModelGateway {
  /**
   * The answer as `text` / `reasoning` deltas, then exactly one `finish` (reasoning tokens are part of `outputTokens`;
   * `usage` is null when the upstream reported none; `truncated` when the model stopped for length). A failure is a
   * thrown `ModelError` — also an answer cut off at the output limit before any text, having only thought
   * (`thinking_exhausted`, carrying the reported usage). When `call.signal` aborts, the iterator stops at once by
   * throwing `call.signal.reason`.
   */
  stream(call: ModelCall): AsyncIterable<ModelEvent>;
  /** The provider's model list (the provider probe's `GET {baseUrl}/models`); a failure is a thrown `ModelError`. */
  listModels(p: Pick<ModelCall, "protocol" | "baseUrl" | "apiKey">): Promise<string[]>;
}

/**
 * The codes a model call fails with: those of a provider call (the address guard's, the provider's refusal, the rest),
 * and `thinking_exhausted`: the model stopped at its output limit having only thought — no answer, though reasoning
 * came or reasoning tokens were reported.
 */
export type ModelErrorCode = ProviderCallCode | "thinking_exhausted";

/** One fixed sentence per code: nothing the upstream said is ever kept. */
const MESSAGES: Readonly<Record<ModelErrorCode, string>> = {
  provider_rejected: "The model provider refused the API key.",
  provider_unavailable: "The model provider could not be reached or did not answer properly.",
  address_not_allowed: "The model provider's address is not allowed.",
  thinking_exhausted: "The model used its whole output limit thinking and gave no answer.",
};

/**
 * A failed model call: the code, for the log only the upstream's HTTP status (when it answered with an error status),
 * and the usage the upstream reported for it, when it did (`thinking_exhausted`: what the call is charged). It never
 * carries the upstream's body, headers or a cause. As an `AppError` it answers 502 (400 for `address_not_allowed`) if it
 * reaches a route.
 */
export class ModelError extends AppError {
  declare readonly code: ModelErrorCode;

  constructor(
    code: ModelErrorCode,
    readonly upstreamStatus?: number,
    readonly usage?: { inputTokens: number; outputTokens: number },
  ) {
    super(code === "address_not_allowed" ? 400 : 502, code);
    this.name = "ModelError";
    this.message = MESSAGES[code];
  }
}

type ProviderOptions = NonNullable<Parameters<typeof streamText>[0]["providerOptions"]>;
type StreamPart = TextStreamPart<ToolSet>;

const openaiChat = (effort: "low" | "medium" | "high" | "xhigh") => ({
  openai: { reasoningEffort: effort, forceReasoning: true } satisfies OpenAILanguageModelChatOptions,
});
const openaiResponses = (effort: "low" | "medium" | "high" | "xhigh" | "max") => ({
  openai: { reasoningEffort: effort, reasoningSummary: "auto", forceReasoning: true } satisfies OpenAILanguageModelResponsesOptions,
});
const anthropicEffort = (effort: "low" | "medium" | "high" | "xhigh" | "max") => ({
  anthropic: { thinking: { type: "adaptive", display: "summarized" }, effort } satisfies AnthropicLanguageModelOptions,
});
const geminiLevel = (thinkingLevel: "low" | "medium" | "high" | "xhigh") => ({
  google: { thinkingConfig: { thinkingLevel, includeThoughts: true } } satisfies GoogleLanguageModelOptions,
});

/**
 * How each reasoning level is asked for, per protocol: the SDK provider options sent with the call (on the wire:
 * README, "Calling a model"). A level a protocol cannot express is its nearest lower one (Chat Completions has no
 * `max` effort, Gemini no `max` thinking level: both `xhigh`). `none` switches thinking off where the protocol can
 * (Anthropic `thinking: disabled`) and is left out otherwise: Gemini's levels cannot switch it off, and OpenAI refuses
 * `reasoning_effort` from models that do not reason, which are exactly the ones sent `none`. The OpenAI levels also
 * mark the model as one that reasons (`forceReasoning`), so the effort is sent whatever the model is called.
 */
export const REASONING_PARAMS: Readonly<Record<Protocol, Readonly<Record<ReasoningLevel, ProviderOptions>>>> = {
  openai_chat: {
    none: {},
    low: openaiChat("low"),
    medium: openaiChat("medium"),
    high: openaiChat("high"),
    xhigh: openaiChat("xhigh"),
    max: openaiChat("xhigh"),
  },
  openai_responses: {
    none: {},
    low: openaiResponses("low"),
    medium: openaiResponses("medium"),
    high: openaiResponses("high"),
    xhigh: openaiResponses("xhigh"),
    max: openaiResponses("max"),
  },
  anthropic: {
    none: { anthropic: { thinking: { type: "disabled" } } satisfies AnthropicLanguageModelOptions },
    low: anthropicEffort("low"),
    medium: anthropicEffort("medium"),
    high: anthropicEffort("high"),
    xhigh: anthropicEffort("xhigh"),
    max: anthropicEffort("max"),
  },
  gemini: {
    none: {},
    low: geminiLevel("low"),
    medium: geminiLevel("medium"),
    high: geminiLevel("high"),
    xhigh: geminiLevel("xhigh"),
    max: geminiLevel("xhigh"),
  },
};

/**
 * Provider options every call of a protocol carries besides its reasoning: a Responses call asks OpenAI not to keep
 * the response (`store: false`; nothing here ever refers to an earlier response).
 */
const PROTOCOL_OPTIONS: Readonly<Record<Protocol, ProviderOptions>> = {
  openai_chat: {},
  openai_responses: { openai: { store: false } satisfies OpenAILanguageModelResponsesOptions },
  anthropic: {},
  gemini: {},
};

/**
 * What a call may send that an upstream may not know, besides `REASONING_PARAMS`: `thinking`, the thinking switch of
 * a Chat Completions call with `thinkingSwitch` (body field `thinking: {type: "disabled"}` at `none`, `{type:
 * "enabled"}` at any other level, next to the level's `reasoning_effort`); `summary`, the reasoning summary a
 * Responses call asks for at any level but `none` (`reasoning.summary: "auto"`). An upstream that refuses one — a 400
 * or 422 whose body names it — is asked once more without it, and once that is answered its later calls leave it out
 * (`Refusals`).
 */
export type OptionalField = "thinking" | "summary";
/** How a refusal names each field: what a 400's or 422's body is looked through for (its first `REFUSAL_CHARS`). */
const NAMES: Readonly<Record<OptionalField, RegExp>> = { thinking: /thinking/i, summary: /summary/i };
const REFUSAL_CHARS = 4096;
/** Upstreams whose refusals are remembered at most; the one used longest ago is forgotten first. */
export const MAX_REMEMBERED_UPSTREAMS = 1000;

/** The optional fields the call sends, given what its upstream refused (`left`: left out). */
function optionalFields(call: ModelCall, left: ReadonlySet<OptionalField>): OptionalField[] {
  const fields: OptionalField[] = [];
  if (call.protocol === "openai_chat" && call.thinkingSwitch === true && !left.has("thinking")) fields.push("thinking");
  if (call.protocol === "openai_responses" && call.reasoning !== "none" && !left.has("summary")) fields.push("summary");
  return fields;
}

/** What upstreams refused, by `ModelCall.upstreamId`, in this process: at most `MAX_REMEMBERED_UPSTREAMS` of them. */
export class Refusals {
  private readonly byUpstream = new Map<string, Set<OptionalField>>();

  of(upstreamId: string | undefined): Set<OptionalField> {
    const refused = upstreamId === undefined ? undefined : this.byUpstream.get(upstreamId);
    if (upstreamId === undefined || refused === undefined) return new Set();
    this.byUpstream.delete(upstreamId);
    this.byUpstream.set(upstreamId, refused); // used now: forgotten last
    return new Set(refused);
  }

  add(upstreamId: string | undefined, field: OptionalField): void {
    if (upstreamId === undefined) return;
    const refused = this.byUpstream.get(upstreamId) ?? new Set();
    refused.add(field);
    this.byUpstream.delete(upstreamId);
    this.byUpstream.set(upstreamId, refused);
    if (this.byUpstream.size > MAX_REMEMBERED_UPSTREAMS) this.byUpstream.delete(this.byUpstream.keys().next().value!);
  }
}

/** Whether `err` is the upstream refusing `field`: a 400 or 422 whose body names it. Only read here; never kept. */
function refuses(err: unknown, field: OptionalField): boolean {
  const seen = new Set<unknown>();
  for (let e: unknown = err; e != null && !seen.has(e); e = (e as { cause?: unknown }).cause) {
    seen.add(e);
    if (APICallError.isInstance(e)) {
      return (e.statusCode === 400 || e.statusCode === 422) && NAMES[field].test((e.responseBody ?? "").slice(0, REFUSAL_CHARS));
    }
  }
  return false;
}

/**
 * The call's provider options: the protocol's own, with the reasoning level's merged in, per provider namespace; a
 * Responses call whose upstream refused the summary asks for none (`reasoningSummary: null`: left out, where the SDK
 * would otherwise ask for one).
 */
function providerOptionsFor(call: ModelCall, left: ReadonlySet<OptionalField>): ProviderOptions {
  const base = PROTOCOL_OPTIONS[call.protocol];
  const reasoning = REASONING_PARAMS[call.protocol][call.reasoning];
  const merged: ProviderOptions = {};
  for (const name of new Set([...Object.keys(base), ...Object.keys(reasoning)])) merged[name] = { ...base[name], ...reasoning[name] };
  if (call.protocol === "openai_responses" && call.reasoning !== "none" && left.has("summary")) {
    merged.openai = { ...merged.openai, reasoningSummary: null } satisfies OpenAILanguageModelResponsesOptions;
  }
  return merged;
}

/** A model's answer may be long: the guard's size limit for one model stream. */
const MODEL_STREAM_MAX_BYTES = 8 * 1024 * 1024;
/** A model stream silent for this long (before its headers, or between its bytes) is given up on. */
const MODEL_IDLE_TIMEOUT_MS = 60_000;

export interface GatewayOptions {
  /** Where its calls are counted: the app's one count of calls through the guard (`GuardOptions.calls`). */
  calls: Slots;
  /** Tests only (`BuildOptions`): models may be reached at loopback addresses, over `http:` there. */
  allowInsecureLocal?: boolean;
  /** Default 60 s; tests shorten it. */
  idleTimeoutMs?: number;
}

/**
 * The gateway over the AI SDK. Its calls are counted with every other call through the guard (`options.calls`: at
 * most `PROVIDER_MAX_CONCURRENT_CALLS` in flight in the whole service).
 */
export function createModelGateway(options: GatewayOptions): ModelGateway {
  // The SDK reports settings a model ignores through `process.emitWarning`, outside the service's log: not wanted.
  globalThis.AI_SDK_LOG_WARNINGS = false;
  const guard = { calls: options.calls, ...(options.allowInsecureLocal === true ? { allowInsecureLocal: true } : {}) };
  const fetch = guardedFetch({ ...guard, maxResponseBytes: MODEL_STREAM_MAX_BYTES, timeoutMs: options.idleTimeoutMs ?? MODEL_IDLE_TIMEOUT_MS });
  const probe = createProviderProbe(guardedFetch({ ...guard, ...PROBE_GUARD }));
  const refusals = new Refusals();
  return {
    stream: (call) => streamCall(call, fetch, refusals),
    async listModels(p) {
      try {
        return await probe.listModels(p);
      } catch (err) {
        throw toModelError(err);
      }
    },
  };
}

/** The SDK's model for the call's protocol, at `baseUrl` as it is, with the key, every request through the guard. */
function languageModel(call: ModelCall, fetch: typeof globalThis.fetch): LanguageModel {
  const settings = { baseURL: call.baseUrl, apiKey: call.apiKey, fetch };
  switch (call.protocol) {
    case "openai_chat":
      return createOpenAI(settings).chat(call.model);
    case "openai_responses":
      return createOpenAI(settings).responses(call.model);
    case "anthropic":
      return createAnthropic(settings).messages(call.model);
    case "gemini":
      return createGoogle(settings).languageModel(call.model);
  }
}

/**
 * The call's turns as SDK messages. A user turn keeps every part: images as image files, PDFs as files with their
 * name. An assistant turn is text only (the protocols take no files from the model's side): a file in one is sent as
 * `[文件：{name}]`, an image as `[图片]`.
 */
function toModelMessages(messages: ModelCall["messages"]): ModelMessage[] {
  return messages.map((m): ModelMessage => {
    if (m.role === "assistant") {
      return {
        role: "assistant",
        content: m.parts.map((p) => ({ type: "text" as const, text: p.type === "text" ? p.text : p.type === "file" ? `[文件：${p.name}]` : "[图片]" })),
      };
    }
    return {
      role: "user",
      content: m.parts.map((p) =>
        p.type === "text"
          ? { type: "text" as const, text: p.text }
          : p.type === "image"
            ? { type: "file" as const, mediaType: p.mime, data: p.data }
            : { type: "file" as const, mediaType: p.mime, data: p.data, filename: p.name },
      ),
    };
  });
}

/** The reported usage, or null unless the upstream reported both counts. */
function usageOf(usage: LanguageModelUsage): { inputTokens: number; outputTokens: number } | null {
  const { inputTokens, outputTokens } = usage;
  return typeof inputTokens === "number" && typeof outputTokens === "number" ? { inputTokens, outputTokens } : null;
}

/**
 * Any failure as a `ModelError`, looking through causes: the guard's refusal is `address_not_allowed`; an upstream
 * error status is `provider_rejected` for 401/403 and `provider_unavailable` otherwise; everything else (network,
 * timeout, size, a redirect, a stream that is malformed or cut short) is `provider_unavailable`.
 */
function toModelError(err: unknown): ModelError {
  const seen = new Set<unknown>();
  for (let e: unknown = err; e != null && !seen.has(e); e = (e as { cause?: unknown }).cause) {
    seen.add(e);
    if (e instanceof ModelError) return e;
    if (e instanceof ProviderCallError) return new ModelError(e.code as ModelErrorCode, e.upstreamStatus);
    if (e instanceof AppError && e.code === "address_not_allowed") return new ModelError("address_not_allowed");
    if (APICallError.isInstance(e) && e.statusCode !== undefined && e.statusCode >= 300) {
      return new ModelError(e.statusCode === 401 || e.statusCode === 403 ? "provider_rejected" : "provider_unavailable", e.statusCode);
    }
  }
  return new ModelError("provider_unavailable");
}

/**
 * The `fetch` of a Chat Completions call: the request's JSON body gets the thinking switch when it is sent
 * (`thinking`), and every successful response's body is read by `tap` on its way to the SDK. The key stays in the
 * headers the SDK set; nothing here reads them.
 */
function chatFetch(fetch: typeof globalThis.fetch, tap: ChatReasoningTap, thinking: { type: "enabled" | "disabled" } | null): typeof globalThis.fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const body = thinking !== null && typeof init?.body === "string" ? JSON.stringify({ ...JSON.parse(init.body), thinking }) : undefined;
    const res = await fetch(input, body === undefined ? init : { ...init, body });
    if (!res.ok || res.body === null) return res;
    return new Response(res.body.pipeThrough(tap.transform()), { status: res.status, statusText: res.statusText, headers: res.headers });
  }) as typeof globalThis.fetch;
}

/** `attempt`'s events: its finish also says how many reasoning tokens the upstream reported (0: none). */
type AttemptEvent = Exclude<ModelEvent, { type: "finish" }> | (Extract<ModelEvent, { type: "finish" }> & { reasoningTokens: number });

/**
 * The call as events: one attempt (`attempt`), and when the upstream refused an optional field it sent
 * (`OptionalField`) before anything came back, one more without it — the refusal remembered for the call's upstream
 * once that one shows leaving it out helped (its first event came), so a refusal for some other reason, which fails
 * the retry too, is not. A model that stopped for length with no answer (no text that shows anything), having reasoned
 * — reasoning came, or the upstream reported reasoning tokens — ends `thinking_exhausted`, with the usage it reported,
 * instead of finishing.
 */
async function* streamCall(call: ModelCall, fetch: typeof globalThis.fetch, refusals: Refusals): AsyncGenerator<ModelEvent> {
  try {
    call.signal.throwIfAborted();
    const left = refusals.of(call.upstreamId);
    /** The field the first attempt was refused, left out of the retry. */
    let refused: OptionalField | undefined;
    for (let retry = false; ; retry = true) {
      const sent = optionalFields(call, left);
      let started = false;
      let answered = false;
      let thought = false;
      try {
        for await (const event of attempt(call, fetch, left)) {
          if (!started && refused !== undefined) refusals.add(call.upstreamId, refused);
          started = true;
          if (event.type === "finish") {
            const { usage, truncated, reasoningTokens } = event;
            if (truncated && !answered && (thought || reasoningTokens > 0)) throw new ModelError("thinking_exhausted", undefined, usage ?? undefined);
            yield { type: "finish", usage, truncated };
            return;
          }
          if (event.type === "text") answered ||= hasVisibleText(event.delta);
          else thought = true;
          yield event;
        }
        return;
      } catch (err) {
        refused = started || retry || call.signal.aborted ? undefined : sent.find((field) => refuses(err, field));
        if (refused === undefined) throw err;
        left.add(refused);
      }
    }
  } catch (err) {
    call.signal.throwIfAborted();
    throw toModelError(err);
  }
}

/**
 * One request of the call, as events; a failure is thrown as it came (`streamCall` makes it a `ModelError`). On Chat
 * Completions (where the SDK reads no reasoning) a delta's own reasoning field is read off the stream
 * (`ChatReasoningTap`) and comes out in its place among the text, as soon as it arrives; an answer that streamed none
 * of it before its first text and opens with `<think>` has that block taken out as reasoning (`ThinkTags`). Reasoning
 * never becomes text.
 */
async function* attempt(call: ModelCall, fetch: typeof globalThis.fetch, left: ReadonlySet<OptionalField>): AsyncGenerator<AttemptEvent> {
  // Ends the upstream request however this iterator ends: finished, failed, stopped, or left early by its reader.
  const own = new AbortController();
  const tap = call.protocol === "openai_chat" ? new ChatReasoningTap() : null;
  const thinking = optionalFields(call, left).includes("thinking") ? { type: call.reasoning === "none" ? ("disabled" as const) : ("enabled" as const) } : null;
  /** Chat Completions: undecided until the first text, then whether the answer is looked at for `<think>`. */
  let tags: ThinkTags | null | undefined = tap ? undefined : null;
  /** Reasoning arrived in the protocol's own field. */
  let structured = false;
  let parts: AsyncIterator<StreamPart> | undefined;
  try {
    const result = streamText({
      model: languageModel(call, tap ? chatFetch(fetch, tap, thinking) : fetch),
      ...(call.system === "" ? {} : { instructions: call.system }),
      messages: toModelMessages(call.messages),
      maxOutputTokens: call.maxOutputTokens,
      providerOptions: providerOptionsFor(call, left),
      abortSignal: AbortSignal.any([call.signal, own.signal]),
      maxRetries: 0,
      telemetry: { isEnabled: false },
      // Failures arrive below as `error` parts; the default handler would print them, upstream text and all.
      onError: () => {},
    });
    parts = result.stream[Symbol.asyncIterator]();
    let next: Promise<IteratorResult<StreamPart>> | null = null;
    while (true) {
      if (tap) {
        // Reasoning ahead of every text still to come is due now, whatever the SDK is waiting for.
        const due = tap.leading();
        for (const delta of due) {
          structured = true;
          yield { type: "reasoning", delta };
        }
        if (due.length > 0) continue;
      }
      next ??= parts.next();
      const got = tap ? await Promise.race([next, tap.changed().then(() => null)]) : await next;
      call.signal.throwIfAborted();
      if (got === null) continue;
      next = null;
      if (got.done) break;
      const part = got.value;
      switch (part.type) {
        case "text-delta":
          if (part.text === "") break;
          for (const delta of tap?.beforeText() ?? []) {
            structured = true;
            yield { type: "reasoning", delta };
          }
          if (tags === undefined) tags = structured ? null : new ThinkTags();
          if (tags) for (const split of tags.push(part.text)) yield split;
          else yield { type: "text", delta: part.text };
          break;
        case "reasoning-delta":
          if (part.text !== "") yield { type: "reasoning", delta: part.text };
          break;
        case "error":
          throw part.error;
        case "abort":
          throw new ModelError("provider_unavailable");
        case "finish":
          for (const delta of tap?.rest() ?? []) yield { type: "reasoning", delta };
          if (tags) for (const split of tags.end()) yield split;
          // "interrupted": the stream ended without the protocol's completion; "error": the upstream reported one.
          if (part.finishReason === "interrupted" || part.finishReason === "error") throw new ModelError("provider_unavailable");
          yield {
            type: "finish",
            usage: usageOf(part.totalUsage),
            truncated: part.finishReason === "length",
            reasoningTokens: part.totalUsage.outputTokenDetails?.reasoningTokens ?? 0,
          };
          return;
      }
    }
    throw new ModelError("provider_unavailable");
  } finally {
    own.abort();
    // Not awaited: a read still pending ends with the abort.
    void parts?.return?.()?.catch(() => {});
  }
}
