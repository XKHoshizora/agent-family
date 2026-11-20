import type http from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PROTOCOLS, type Protocol } from "../src/config.ts";
import {
  createModelGateway,
  ModelError,
  Refusals,
  TOOLS_REFUSAL_TTL_MS,
  type ModelCall,
  type ModelEvent,
  type ToolCall,
  type ToolResult,
  type ToolSpec,
} from "../src/models/gateway.ts";
import { createSlots } from "../src/slots.ts";
import { PNG } from "./helpers/agents.ts";
import {
  answerCanned,
  CANNED_ENCRYPTED_REASONING,
  CANNED_REASONING,
  CANNED_REASONING_DELTAS,
  CANNED_REASONING_USAGE,
  CANNED_SECOND_TOOL,
  CANNED_SECOND_TOOL_ARGS,
  CANNED_SECOND_TOOL_CALL_ID,
  CANNED_SIGNATURE,
  CANNED_TEXT,
  CANNED_THOUGHT_SIGNATURE,
  CANNED_TOOL,
  CANNED_TOOL_ARGS,
  CANNED_TOOL_CALL_ID,
  CANNED_USAGE,
  cannedStream,
  protocolOfPath,
  protocolStub,
  STUB_MODEL,
  type CannedKind,
  type CannedOptions,
  type ProtocolStub,
  type StubRequest,
} from "./helpers/models.ts";

/**
 * The gateway speaking tools: one model round per `stream()` call, carrying tool definitions, reporting the model's
 * tool calls, and taking earlier rounds back (`steps`) — against a local stub of each protocol's streaming endpoint.
 */

const KEY = "sk-stub-0123456789abcdef";
const SYSTEM = "You are a stub's Agent.";
const PDF = Buffer.from("%PDF-1.4\n1 0 obj <<>> endobj\ntrailer <<>>\n%%EOF\n");

let stub: ProtocolStub;
beforeAll(async () => {
  stub = await protocolStub();
});
afterAll(async () => {
  await stub.close();
});
beforeEach(() => stub.reset());

const gateway = createModelGateway({ calls: createSlots(64), allowInsecureLocal: true });

function call(protocol: Protocol, over: Partial<ModelCall> = {}): ModelCall {
  return {
    protocol,
    baseUrl: stub.baseUrl,
    apiKey: KEY,
    model: STUB_MODEL,
    system: SYSTEM,
    messages: [{ role: "user", parts: [{ type: "text", text: "Hi" }] }],
    reasoning: "none",
    maxOutputTokens: 256,
    signal: new AbortController().signal,
    ...over,
  };
}

async function collect(events: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const out: ModelEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

/** A conversation with every kind of part, at a level, with the thinking switch: what a call without tools sends. */
const RICH: Partial<ModelCall> = {
  messages: [
    {
      role: "user",
      parts: [
        { type: "text", text: "Look at these" },
        { type: "image", mime: "image/png", data: PNG },
        { type: "file", mime: "application/pdf", name: "notes.pdf", data: PDF },
      ],
    },
    { role: "assistant", parts: [{ type: "text", text: "An earlier answer" }] },
    { role: "user", parts: [{ type: "text", text: "And now?" }] },
  ],
  reasoning: "high",
  thinkingSwitch: true,
};

/** The raw body of each protocol's request for a plain call and a rich one, keyed `<protocol> <case>`. */
async function bodiesWithout(over: Partial<ModelCall> = {}): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const protocol of PROTOCOLS) {
    for (const [name, extra] of [
      ["plain", {}],
      ["rich", RICH],
    ] as const) {
      stub.reset();
      await collect(gateway.stream(call(protocol, { ...extra, ...over })));
      expect(stub.requests).toHaveLength(1);
      out[`${protocol} ${name}`] = stub.requests[0]!.raw;
    }
  }
  return out;
}

describe("a call without tools", () => {
  // Recorded from the gateway before it knew tools: the request a call without tools sends is that one, byte for byte.
  it("sends exactly the request it sent before tools existed, for every protocol", async () => {
    expect(await bodiesWithout()).toMatchInlineSnapshot(`
      {
        "anthropic plain": "{"model":"stub-model","max_tokens":256,"thinking":{"type":"disabled"},"system":[{"type":"text","text":"You are a stub's Agent."}],"messages":[{"role":"user","content":[{"type":"text","text":"Hi"}]}],"stream":true}",
        "anthropic rich": "{"model":"stub-model","max_tokens":256,"thinking":{"type":"adaptive","display":"summarized"},"output_config":{"effort":"high"},"system":[{"type":"text","text":"You are a stub's Agent."}],"messages":[{"role":"user","content":[{"type":"text","text":"Look at these"},{"type":"image","source":{"type":"base64","media_type":"image/png","data":"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgAAACAAAB4iG8MwAAAABJRU5ErkJggg=="}},{"type":"document","source":{"type":"base64","media_type":"application/pdf","data":"JVBERi0xLjQKMSAwIG9iaiA8PD4+IGVuZG9iagp0cmFpbGVyIDw8Pj4KJSVFT0YK"},"title":"notes.pdf"}]},{"role":"assistant","content":[{"type":"text","text":"An earlier answer"}]},{"role":"user","content":[{"type":"text","text":"And now?"}]}],"stream":true}",
        "gemini plain": "{"generationConfig":{"maxOutputTokens":256},"contents":[{"role":"user","parts":[{"text":"Hi"}]}],"systemInstruction":{"parts":[{"text":"You are a stub's Agent."}]}}",
        "gemini rich": "{"generationConfig":{"maxOutputTokens":256,"thinkingConfig":{"includeThoughts":true,"thinkingLevel":"high"}},"contents":[{"role":"user","parts":[{"text":"Look at these"},{"inlineData":{"mimeType":"image/png","data":"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgAAACAAAB4iG8MwAAAABJRU5ErkJggg=="}},{"inlineData":{"mimeType":"application/pdf","data":"JVBERi0xLjQKMSAwIG9iaiA8PD4+IGVuZG9iagp0cmFpbGVyIDw8Pj4KJSVFT0YK"}}]},{"role":"model","parts":[{"text":"An earlier answer"}]},{"role":"user","parts":[{"text":"And now?"}]}],"systemInstruction":{"parts":[{"text":"You are a stub's Agent."}]}}",
        "openai_chat plain": "{"model":"stub-model","max_tokens":256,"messages":[{"role":"system","content":"You are a stub's Agent."},{"role":"user","content":"Hi"}],"stream":true,"stream_options":{"include_usage":true}}",
        "openai_chat rich": "{"model":"stub-model","max_completion_tokens":256,"reasoning_effort":"high","messages":[{"role":"developer","content":"You are a stub's Agent."},{"role":"user","content":[{"type":"text","text":"Look at these"},{"type":"image_url","image_url":{"url":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgAAACAAAB4iG8MwAAAABJRU5ErkJggg=="}},{"type":"file","file":{"filename":"notes.pdf","file_data":"data:application/pdf;base64,JVBERi0xLjQKMSAwIG9iaiA8PD4+IGVuZG9iagp0cmFpbGVyIDw8Pj4KJSVFT0YK"}}]},{"role":"assistant","content":"An earlier answer"},{"role":"user","content":"And now?"}],"stream":true,"stream_options":{"include_usage":true},"thinking":{"type":"enabled"}}",
        "openai_responses plain": "{"model":"stub-model","input":[{"role":"system","content":"You are a stub's Agent."},{"role":"user","content":[{"type":"input_text","text":"Hi"}]}],"max_output_tokens":256,"store":false,"stream":true}",
        "openai_responses rich": "{"model":"stub-model","input":[{"role":"developer","content":"You are a stub's Agent."},{"role":"user","content":[{"type":"input_text","text":"Look at these"},{"type":"input_image","image_url":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgAAACAAAB4iG8MwAAAABJRU5ErkJggg=="},{"type":"input_file","filename":"notes.pdf","file_data":"data:application/pdf;base64,JVBERi0xLjQKMSAwIG9iaiA8PD4+IGVuZG9iagp0cmFpbGVyIDw8Pj4KJSVFT0YK"}]},{"role":"assistant","content":"An earlier answer"},{"role":"user","content":[{"type":"input_text","text":"And now?"}]}],"max_output_tokens":256,"store":false,"include":["reasoning.encrypted_content"],"reasoning":{"effort":"high","summary":"auto"},"stream":true}",
      }
    `);
  });

  it("with tools: [] and steps: [] it is the same request", async () => {
    expect(await bodiesWithout({ tools: [], steps: [] })).toEqual(await bodiesWithout());
  });

  it.each(PROTOCOLS)("%s: the finish names no tool call, carries the round's assistant turn and no toolsRefused", async (protocol) => {
    const finish = finishOf(await collect(gateway.stream(call(protocol))));
    expect(finish).toMatchObject({ usage: CANNED_USAGE, truncated: false, toolCalls: [] });
    expect(finish.assistant).toBeDefined();
    expect(finish).not.toHaveProperty("toolsRefused");
  });
});

// --- with tools ----------------------------------------------------------------------------------------------------

const SEARCH: ToolSpec = {
  name: CANNED_TOOL.name,
  description: "Search this conversation's messages.",
  parameters: {
    type: "object",
    properties: { query: { type: "string", description: "Words to look for." }, limit: { type: "integer" } },
    required: ["query"],
    additionalProperties: false,
  },
};
const READ: ToolSpec = {
  name: "read_file",
  description: "Read a file shared here.",
  parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
};
const TOOLS = [SEARCH, READ];
const RESULT_OUTPUT = { hits: [{ seq: 3, text: "去吃川菜" }] };

type Finish = Extract<ModelEvent, { type: "finish" }>;
function finishOf(events: ModelEvent[]): Finish {
  const finishes = events.filter((e): e is Finish => e.type === "finish");
  expect(finishes).toHaveLength(1);
  expect(events.at(-1)).toBe(finishes[0]);
  return finishes[0]!;
}
const toolCallsIn = (events: ModelEvent[]): ToolCall[] => events.flatMap((e) => (e.type === "tool_call" ? [e.call] : []));
const deltas = (events: ModelEvent[], type: "text" | "reasoning") => events.flatMap((e) => (e.type === type ? [e.delta] : [])).join("");

/** Answers every request with the canned stream of `kind` for its protocol (`options`: a tool call's input as streamed). */
const answering = (kind: CannedKind, options?: CannedOptions) => (req: StubRequest, res: http.ServerResponse) => {
  if (options === undefined) return answerCanned(req, res, kind);
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(cannedStream(protocolOfPath(req.path)!, kind, options));
};

/** A tool round (`kind`) at `level`, then the same conversation again with its step: the events of both and both requests. */
async function twoRounds(protocol: Protocol, kind: CannedKind, over: Partial<ModelCall> = {}) {
  stub.answer(answering(kind));
  const first = await collect(gateway.stream(call(protocol, { tools: TOOLS, ...over })));
  const finish = finishOf(first);
  const [called] = finish.toolCalls;
  const results: ToolResult[] = [{ id: called!.id, name: called!.name, output: RESULT_OUTPUT }];
  stub.answer(answering("text"));
  const second = await collect(gateway.stream(call(protocol, { tools: TOOLS, ...over, steps: [{ assistant: finish.assistant, results }] })));
  expect(stub.requests).toHaveLength(2);
  return { first, finish, second, results, requests: stub.requests.slice() };
}

/** Each protocol's tool fields of a request body: the tools and how the model may choose among them. */
function toolFields(protocol: Protocol, body: any): Record<string, unknown> {
  const pick = (keys: string[]) => Object.fromEntries(keys.filter((k) => body?.[k] !== undefined).map((k) => [k, body[k]]));
  return protocol === "gemini" ? pick(["tools", "toolConfig"]) : pick(["tools", "tool_choice"]);
}

/** Each protocol's turns of a request body (the system text taken out where it is one of them). */
function turns(protocol: Protocol, body: any): any[] {
  switch (protocol) {
    case "openai_chat":
      return body.messages.filter((m: any) => m.role !== "system" && m.role !== "developer");
    case "openai_responses":
      return body.input.filter((m: any) => m.role !== "system" && m.role !== "developer");
    case "anthropic":
      return body.messages;
    case "gemini":
      return body.contents;
  }
}

const SEARCH_ARGS = CANNED_TOOL_ARGS.join("");
const READ_ARGS = CANNED_SECOND_TOOL_ARGS.join("");

/** Answers every request with `body` as an event stream. */
const sending = (body: string) => (_req: StubRequest, res: http.ServerResponse) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(body);
};

/** How each protocol's upstream says it takes no tools. */
const REFUSAL: Record<Protocol, string> = {
  openai_chat: JSON.stringify({ error: { message: "This model does not support tools.", type: "invalid_request_error", param: "tools", code: null } }),
  openai_responses: JSON.stringify({ error: { message: "Tools are not supported with this model.", type: "invalid_request_error", param: "tools", code: null } }),
  anthropic: JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "tools: Extra inputs are not permitted" } }),
  gemini: JSON.stringify({ error: { code: 400, message: "Function calling is not enabled for models/stub-model", status: "INVALID_ARGUMENT" } }),
};
/** `status` with `body` to a request that carries tools (all of them, with `always`), else the canned answer. */
const refusing = (status: number, body: string, always = false) => (req: StubRequest, res: http.ServerResponse) => {
  if (!always && !("tools" in req.body)) return answerCanned(req, res);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body);
};
/** The error the call failed with, or null. */
const failure = (events: AsyncIterable<ModelEvent>) =>
  collect(events).then(
    () => null,
    (e: unknown) => e,
  );
const toolsSent = () => stub.requests.map((r) => "tools" in r.body);
/** A step as the caller makes it: a round's turn, each of its calls answered. */
const answered = (finish: Finish, output: unknown = RESULT_OUTPUT) => ({
  assistant: finish.assistant,
  results: finish.toolCalls.map((c): ToolResult => ({ id: c.id, name: c.name, output })),
});
/** A real step: one tool round against the stub, answered. */
async function aStep(protocol: Protocol) {
  stub.answer(answering("tool"));
  return answered(finishOf(await collect(gateway.stream(call(protocol, { tools: TOOLS })))));
}

describe.each(PROTOCOLS)("%s", (protocol) => {
  it("a request with tools carries them in the protocol's wire shape, the model left to choose", async () => {
    await collect(gateway.stream(call(protocol, { tools: TOOLS })));
    const { body } = stub.requests[0]!;
    const schema = (spec: ToolSpec) => spec.parameters;
    switch (protocol) {
      case "openai_chat":
        expect(toolFields(protocol, body)).toEqual({
          tools: TOOLS.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: schema(t) } })),
          tool_choice: "auto",
        });
        break;
      case "openai_responses":
        expect(toolFields(protocol, body)).toEqual({
          tools: TOOLS.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: schema(t), strict: false })),
          tool_choice: "auto",
        });
        break;
      case "anthropic":
        // Each input asked for whole: no `eager_input_streaming` (the SDK's default), which compatible upstreams may not know.
        expect(toolFields(protocol, body)).toEqual({
          tools: TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: schema(t) })),
          tool_choice: { type: "auto" },
        });
        expect(stub.requests[0]!.headers["anthropic-beta"]).toBeUndefined();
        break;
      case "gemini":
        expect(toolFields(protocol, body)).toEqual({
          tools: [{ functionDeclarations: TOOLS.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: schema(t) })) }],
          toolConfig: { functionCallingConfig: { mode: "AUTO" } },
        });
        break;
    }
  });

  it("a round that ends in a tool call yields one tool_call event, and the finish names it", async () => {
    stub.answer(answering("tool"));
    const events = await collect(gateway.stream(call(protocol, { tools: TOOLS })));
    expect(deltas(events, "text")).toBe("");
    const calls = toolCallsIn(events);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ id: protocol === "gemini" ? expect.any(String) : CANNED_TOOL_CALL_ID, name: CANNED_TOOL.name, input: CANNED_TOOL.input });
    expect(calls[0]!.id).not.toBe("");
    const finish = finishOf(events);
    expect(finish).toMatchObject({ usage: CANNED_USAGE, truncated: false });
    expect(finish.toolCalls).toEqual(calls);
    expect(finish).not.toHaveProperty("toolsRefused");
    expect(events.findIndex((e) => e.type === "tool_call")).toBeLessThan(events.length - 1);
  });

  it("a second call with the step sends the assistant's tool call and its result in the protocol's wire shape", async () => {
    const { finish, second, requests } = await twoRounds(protocol, "tool");
    expect(deltas(second, "text")).toBe(CANNED_TEXT);
    const id = finish.toolCalls[0]!.id;
    const output = JSON.stringify(RESULT_OUTPUT);
    const sent = turns(protocol, requests[1]!.body);
    switch (protocol) {
      case "openai_chat":
        expect(sent).toEqual([
          { role: "user", content: "Hi" },
          { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name: CANNED_TOOL.name, arguments: SEARCH_ARGS } }] },
          { role: "tool", tool_call_id: id, content: output },
        ]);
        break;
      case "openai_responses":
        // Nothing is kept at OpenAI (`store: false`): the call is sent whole, not referred to by its item id.
        expect(sent).toEqual([
          { role: "user", content: [{ type: "input_text", text: "Hi" }] },
          { type: "function_call", call_id: id, name: CANNED_TOOL.name, arguments: SEARCH_ARGS },
          { type: "function_call_output", call_id: id, output },
        ]);
        break;
      case "anthropic":
        expect(sent).toEqual([
          { role: "user", content: [{ type: "text", text: "Hi" }] },
          { role: "assistant", content: [{ type: "tool_use", id, name: CANNED_TOOL.name, input: CANNED_TOOL.input }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: output }] },
        ]);
        break;
      case "gemini":
        // The id the SDK made up for the call pairs it with its response.
        expect(sent).toEqual([
          { role: "user", parts: [{ text: "Hi" }] },
          { role: "model", parts: [{ functionCall: { id, name: CANNED_TOOL.name, args: CANNED_TOOL.input } }] },
          { role: "user", parts: [{ functionResponse: { id, name: CANNED_TOOL.name, response: { name: CANNED_TOOL.name, content: RESULT_OUTPUT } } }] },
        ]);
        break;
    }
    // The tools still go with it; nothing else changes from the first request but the turns.
    expect(toolFields(protocol, requests[1]!.body)).toEqual(toolFields(protocol, requests[0]!.body));
  });

  it("the step survives a JSON round trip: the same request, byte for byte", async () => {
    const { finish, results, requests } = await twoRounds(protocol, "reasoning_tool", { reasoning: "high" });
    stub.reset();
    stub.answer(answering("text"));
    const steps = JSON.parse(JSON.stringify([{ assistant: finish.assistant, results }]));
    await collect(gateway.stream(call(protocol, { tools: TOOLS, reasoning: "high", steps })));
    expect(stub.requests[0]!.raw).toBe(requests[1]!.raw);
  });

  it("a round that thought before its tool call: the reasoning first, and the next request sends back what the protocol needs", async () => {
    const { first, finish, requests } = await twoRounds(protocol, "reasoning_tool", { reasoning: "high" });
    expect(deltas(first, "reasoning")).toBe(CANNED_REASONING);
    expect(first.findLastIndex((e) => e.type === "reasoning")).toBeLessThan(first.findIndex((e) => e.type === "tool_call"));
    expect(finish.usage).toEqual(CANNED_REASONING_USAGE);
    const id = finish.toolCalls[0]!.id;
    const assistant = turns(protocol, requests[1]!.body).slice(1, -1);
    switch (protocol) {
      case "openai_chat":
        // reasoning_content, which the SDK neither reads nor sends, goes back with the tool call it came before.
        expect(assistant).toEqual([
          {
            role: "assistant",
            content: null,
            tool_calls: [{ id, type: "function", function: { name: CANNED_TOOL.name, arguments: SEARCH_ARGS } }],
            reasoning_content: CANNED_REASONING,
          },
        ]);
        break;
      case "openai_responses":
        expect(assistant).toEqual([
          { type: "reasoning", id: "rs_stub", encrypted_content: CANNED_ENCRYPTED_REASONING, summary: [{ type: "summary_text", text: CANNED_REASONING }] },
          { type: "function_call", call_id: id, name: CANNED_TOOL.name, arguments: SEARCH_ARGS },
        ]);
        break;
      case "anthropic":
        expect(assistant).toEqual([
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: CANNED_REASONING, signature: CANNED_SIGNATURE },
              { type: "tool_use", id, name: CANNED_TOOL.name, input: CANNED_TOOL.input },
            ],
          },
        ]);
        break;
      case "gemini":
        expect(assistant).toHaveLength(1);
        expect(assistant[0].role).toBe("model");
        expect(assistant[0].parts.at(-1)).toEqual({ functionCall: { id, name: CANNED_TOOL.name, args: CANNED_TOOL.input }, thoughtSignature: CANNED_THOUGHT_SIGNATURE });
        break;
    }
  });

  it("a tool call whose input is broken JSON, or that names no tool it was given, is a tool_call with input null", async () => {
    if (protocol !== "gemini") {
      // Gemini sends a call's arguments parsed: they cannot be broken JSON.
      stub.answer(answering("tool", { toolArgs: ['{"query":', '"川'] }));
      const events = await collect(gateway.stream(call(protocol, { tools: TOOLS })));
      expect(toolCallsIn(events)).toEqual([{ id: CANNED_TOOL_CALL_ID, name: CANNED_TOOL.name, input: null }]);
      expect(finishOf(events).toolCalls).toEqual(toolCallsIn(events));
    }
    stub.reset();
    stub.answer(answering("tool"));
    const events = await collect(gateway.stream(call(protocol, { tools: [READ] })));
    expect(toolCallsIn(events)).toEqual([{ id: expect.any(String), name: CANNED_TOOL.name, input: null }]);
    expect(finishOf(events).toolCalls).toEqual(toolCallsIn(events));
  });

  it("two calls in one round: two tool_call events in order, the finish names both, and the next request answers both", async () => {
    stub.answer(answering("two_tools"));
    const first = await collect(gateway.stream(call(protocol, { tools: TOOLS })));
    expect(deltas(first, "text")).toBe("");
    const calls = toolCallsIn(first);
    expect(calls.map((c) => [c.name, c.input])).toEqual([
      [CANNED_TOOL.name, CANNED_TOOL.input],
      [CANNED_SECOND_TOOL.name, CANNED_SECOND_TOOL.input],
    ]);
    if (protocol !== "gemini") expect(calls.map((c) => c.id)).toEqual([CANNED_TOOL_CALL_ID, CANNED_SECOND_TOOL_CALL_ID]);
    const finish = finishOf(first);
    expect(finish.toolCalls).toEqual(calls);
    const [one, two] = calls as [ToolCall, ToolCall];
    const results: ToolResult[] = [
      { id: one.id, name: one.name, output: RESULT_OUTPUT },
      { id: two.id, name: two.name, output: "第一页" },
    ];
    stub.answer(answering("text"));
    await collect(gateway.stream(call(protocol, { tools: TOOLS, steps: [{ assistant: JSON.parse(JSON.stringify(finish.assistant)), results }] })));
    const output = JSON.stringify(RESULT_OUTPUT);
    const sent = turns(protocol, stub.requests[1]!.body).slice(1);
    switch (protocol) {
      case "openai_chat":
        expect(sent).toEqual([
          {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: one.id, type: "function", function: { name: one.name, arguments: SEARCH_ARGS } },
              { id: two.id, type: "function", function: { name: two.name, arguments: READ_ARGS } },
            ],
          },
          { role: "tool", tool_call_id: one.id, content: output },
          { role: "tool", tool_call_id: two.id, content: "第一页" },
        ]);
        break;
      case "openai_responses":
        expect(sent).toEqual([
          { type: "function_call", call_id: one.id, name: one.name, arguments: SEARCH_ARGS },
          { type: "function_call", call_id: two.id, name: two.name, arguments: READ_ARGS },
          { type: "function_call_output", call_id: one.id, output },
          { type: "function_call_output", call_id: two.id, output: "第一页" },
        ]);
        break;
      case "anthropic":
        expect(sent).toEqual([
          {
            role: "assistant",
            content: [
              { type: "tool_use", id: one.id, name: one.name, input: CANNED_TOOL.input },
              { type: "tool_use", id: two.id, name: two.name, input: CANNED_SECOND_TOOL.input },
            ],
          },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: one.id, content: output },
              { type: "tool_result", tool_use_id: two.id, content: "第一页" },
            ],
          },
        ]);
        break;
      case "gemini":
        expect(sent).toEqual([
          {
            role: "model",
            parts: [{ functionCall: { id: one.id, name: one.name, args: CANNED_TOOL.input } }, { functionCall: { id: two.id, name: two.name, args: CANNED_SECOND_TOOL.input } }],
          },
          {
            role: "user",
            parts: [
              { functionResponse: { id: one.id, name: one.name, response: { name: one.name, content: RESULT_OUTPUT } } },
              { functionResponse: { id: two.id, name: two.name, response: { name: two.name, content: "第一页" } } },
            ],
          },
        ]);
        break;
    }
  });

  it("text and a call in one round: the text streams before the call, and the next request carries both", async () => {
    stub.answer(answering("text_tool"));
    const first = await collect(gateway.stream(call(protocol, { tools: TOOLS })));
    expect(deltas(first, "text")).toBe(CANNED_TEXT);
    expect(first.findLastIndex((e) => e.type === "text")).toBeLessThan(first.findIndex((e) => e.type === "tool_call"));
    const finish = finishOf(first);
    expect(finish.toolCalls.map((c) => [c.name, c.input])).toEqual([[CANNED_TOOL.name, CANNED_TOOL.input]]);
    const id = finish.toolCalls[0]!.id;
    stub.answer(answering("text"));
    await collect(gateway.stream(call(protocol, { tools: TOOLS, steps: [JSON.parse(JSON.stringify(answered(finish)))] })));
    const output = JSON.stringify(RESULT_OUTPUT);
    const sent = turns(protocol, stub.requests[1]!.body).slice(1);
    switch (protocol) {
      case "openai_chat":
        expect(sent).toEqual([
          { role: "assistant", content: CANNED_TEXT, tool_calls: [{ id, type: "function", function: { name: CANNED_TOOL.name, arguments: SEARCH_ARGS } }] },
          { role: "tool", tool_call_id: id, content: output },
        ]);
        break;
      case "openai_responses":
        expect(sent).toEqual([
          { role: "assistant", content: CANNED_TEXT },
          { type: "function_call", call_id: id, name: CANNED_TOOL.name, arguments: SEARCH_ARGS },
          { type: "function_call_output", call_id: id, output },
        ]);
        break;
      case "anthropic":
        expect(sent).toEqual([
          { role: "assistant", content: [{ type: "text", text: CANNED_TEXT }, { type: "tool_use", id, name: CANNED_TOOL.name, input: CANNED_TOOL.input }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: output }] },
        ]);
        break;
      case "gemini":
        expect(sent).toEqual([
          { role: "model", parts: [{ text: CANNED_TEXT }, { functionCall: { id, name: CANNED_TOOL.name, args: CANNED_TOOL.input } }] },
          { role: "user", parts: [{ functionResponse: { id, name: CANNED_TOOL.name, response: { name: CANNED_TOOL.name, content: RESULT_OUTPUT } } }] },
        ]);
        break;
    }
  });

  it("an abort during a tool-call stream ends it at once with the signal's reason, closes the upstream, and leaves no unhandled rejection", async () => {
    const body = cannedStream(protocol, "reasoning_tool");
    // Held just after the call's first piece of input (Gemini sends a call whole: just before it).
    const at =
      protocol === "gemini"
        ? body.lastIndexOf("data: ", body.indexOf("functionCall"))
        : body.indexOf("\n\n", body.indexOf(JSON.stringify(CANNED_TOOL_ARGS[0]).slice(1, -1))) + 2;
    const upstream = { closed: false };
    stub.answer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(body.slice(0, at));
      res.on("close", () => (upstream.closed = true));
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => void unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const controller = new AbortController();
      const seen: ModelEvent[] = [];
      const error = await (async () => {
        try {
          for await (const e of gateway.stream(call(protocol, { tools: TOOLS, reasoning: "high", signal: controller.signal }))) {
            seen.push(e);
            if (seen.length === 1) setTimeout(() => controller.abort(), 30);
          }
          return null;
        } catch (e) {
          return e;
        }
      })();
      expect(error).toBe(controller.signal.reason);
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every((e) => e.type === "reasoning")).toBe(true);
      for (let i = 0; i < 100 && !upstream.closed; i++) await new Promise((r) => setTimeout(r, 10));
      expect(upstream.closed).toBe(true);
      await new Promise((r) => setTimeout(r, 50));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  describe("toolChoice", () => {
    /** How each protocol's request says the model may call no tool. */
    const NONE: Record<Protocol, Record<string, unknown>> = {
      openai_chat: { tool_choice: "none" },
      openai_responses: { tool_choice: "none" },
      anthropic: { tool_choice: { type: "none" } },
      gemini: { toolConfig: { functionCallingConfig: { mode: "NONE" } } },
    };

    it("none, on a last round: the same tools and the same steps, and the protocol's way of saying no tool may be called", async () => {
      const step = await aStep(protocol);
      stub.reset();
      stub.answer(answering("text"));
      await collect(gateway.stream(call(protocol, { tools: TOOLS, steps: [step] })));
      const auto = stub.requests[0]!.body;
      stub.reset();
      stub.answer(answering("text"));
      const events = await collect(gateway.stream(call(protocol, { tools: TOOLS, steps: [step], toolChoice: "none" })));
      expect(deltas(events, "text")).toBe(CANNED_TEXT);
      const none = stub.requests[0]!.body;
      expect(toolFields(protocol, none)).toEqual({ ...toolFields(protocol, auto), ...NONE[protocol] });
      expect(toolFields(protocol, none).tools).toEqual(toolFields(protocol, auto).tools);
      expect(turns(protocol, none)).toEqual(turns(protocol, auto));
      const { tools: _a, tool_choice: _b, toolConfig: _c, ...rest } = none;
      const { tools: _d, tool_choice: _e, toolConfig: _f, ...restAuto } = auto;
      expect(rest).toEqual(restAuto); // nothing else differs
    });

    it("none on a first round sends the tools with it too", async () => {
      await collect(gateway.stream(call(protocol, { tools: TOOLS, toolChoice: "none" })));
      expect(toolFields(protocol, stub.requests[0]!.body)).toMatchObject(NONE[protocol]);
      expect(toolFields(protocol, stub.requests[0]!.body).tools).toBeDefined();
    });

    it("auto, or absent, is the request as it was, byte for byte; without tools, a choice changes nothing", async () => {
      await collect(gateway.stream(call(protocol, { tools: TOOLS })));
      await collect(gateway.stream(call(protocol, { tools: TOOLS, toolChoice: "auto" })));
      expect(stub.requests[1]!.raw).toBe(stub.requests[0]!.raw);
      stub.reset();
      await collect(gateway.stream(call(protocol)));
      await collect(gateway.stream(call(protocol, { toolChoice: "none" })));
      await collect(gateway.stream(call(protocol, { tools: [], toolChoice: "none" })));
      expect(stub.requests.map((r) => r.raw)).toEqual([stub.requests[0]!.raw, stub.requests[0]!.raw, stub.requests[0]!.raw]);
    });
  });

  describe("an upstream that refuses tools", () => {
    const withoutTools = (body: any) => {
      const { tools: _tools, tool_choice: _choice, toolConfig: _config, ...rest } = body;
      return rest;
    };

    it("a 400 naming them: asked once more without them, toolsRefused; that upstream's next call goes without them at once", async () => {
      stub.answer(refusing(400, REFUSAL[protocol]));
      const upstreamId = `provider:no-tools-${protocol}`;
      const events = await collect(gateway.stream(call(protocol, { tools: TOOLS, upstreamId })));
      expect(deltas(events, "text")).toBe(CANNED_TEXT);
      expect(finishOf(events)).toMatchObject({ toolCalls: [], toolsRefused: true, usage: CANNED_USAGE });
      expect(stub.requests.map((r) => "tools" in r.body)).toEqual([true, false]);
      expect(withoutTools(stub.requests[0]!.body)).toEqual(stub.requests[1]!.body); // otherwise the same request

      stub.requests.length = 0;
      const again = await collect(gateway.stream(call(protocol, { tools: TOOLS, upstreamId })));
      expect(finishOf(again)).toMatchObject({ toolCalls: [], toolsRefused: true });
      expect(stub.requests.map((r) => "tools" in r.body)).toEqual([false]);

      // Another upstream is still sent them.
      stub.requests.length = 0;
      await collect(gateway.stream(call(protocol, { tools: TOOLS, upstreamId: `provider:other-${protocol}` })));
      expect(stub.requests.map((r) => "tools" in r.body)).toEqual([true, false]);
    });

    it("a call that gives its system text for going without them: every request that sends no tools carries that text, every one that sends them its own", async () => {
      const PLAIN = "No tools here, stub.";
      const has = (text: string) => stub.requests.map((r) => r.raw.includes(text));
      stub.answer(refusing(400, REFUSAL[protocol]));
      const upstreamId = `provider:plain-text-${protocol}`;
      const events = await collect(gateway.stream(call(protocol, { tools: TOOLS, upstreamId, systemWithoutTools: PLAIN })));
      expect(finishOf(events)).toMatchObject({ toolsRefused: true });
      // Refused with the tools and their own text; asked again without them, with the text for going without.
      expect([has(SYSTEM), has(PLAIN)]).toEqual([
        [true, false],
        [false, true],
      ]);
      // Left without them at once next time: that text at once.
      stub.requests.length = 0;
      await collect(gateway.stream(call(protocol, { tools: TOOLS, upstreamId, systemWithoutTools: PLAIN })));
      expect([has(SYSTEM), has(PLAIN)]).toEqual([[false], [true]]);
      // A call that offers no tools sends its own text, whatever else it gives.
      stub.requests.length = 0;
      await collect(gateway.stream(call(protocol, { systemWithoutTools: PLAIN })));
      expect([has(SYSTEM), has(PLAIN)]).toEqual([[true], [false]]);
    });

    it("a 422 naming them is taken as a 400 is", async () => {
      stub.answer(refusing(422, JSON.stringify({ detail: [{ loc: ["body", "tools"], msg: "Extra inputs are not permitted", type: "extra_forbidden" }] })));
      const events = await collect(gateway.stream(call(protocol, { tools: TOOLS, upstreamId: `provider:strict-${protocol}` })));
      expect(finishOf(events)).toMatchObject({ toolsRefused: true });
      expect(stub.requests.map((r) => "tools" in r.body)).toEqual([true, false]);
    });

    it("a 400 that does not name them: the call's failure as it came, not retried, nothing remembered", async () => {
      stub.answer(refusing(400, JSON.stringify({ error: { message: "max_tokens is too large" } }), true));
      const upstreamId = `provider:too-large-${protocol}`;
      expect(await failure(gateway.stream(call(protocol, { tools: TOOLS, upstreamId })))).toMatchObject({ code: "provider_unavailable", upstreamStatus: 400 });
      expect(stub.requests).toHaveLength(1);
      stub.reset();
      await collect(gateway.stream(call(protocol, { tools: TOOLS, upstreamId })));
      expect(stub.requests.map((r) => "tools" in r.body)).toEqual([true]);
    });

    it("a 400 naming them that the request without them gets too: that 400 is the call's failure, and tools are not marked refused", async () => {
      stub.answer(refusing(400, REFUSAL[protocol], true));
      const upstreamId = `provider:refuses-all-${protocol}`;
      const error = await failure(gateway.stream(call(protocol, { tools: TOOLS, upstreamId })));
      expect(error).toBeInstanceOf(ModelError);
      expect(error).toMatchObject({ code: "provider_unavailable", upstreamStatus: 400 });
      expect(stub.requests.map((r) => "tools" in r.body)).toEqual([true, false]);
      stub.reset();
      await collect(gateway.stream(call(protocol, { tools: TOOLS, upstreamId })));
      expect(stub.requests.map((r) => "tools" in r.body)).toEqual([true]);
    });

    it("a context-length 400, even one naming the tools: the call's failure as it came, not retried, nothing remembered", async () => {
      const tooLong = [
        // OpenAI's wording counts the tool definitions as "functions": leaving them out may only have made it fit.
        JSON.stringify({
          error: {
            message:
              "This model's maximum context length is 8192 tokens. However, your messages resulted in 9001 tokens (8780 in the messages, 221 in the functions). Please reduce the length of the messages or functions.",
            type: "invalid_request_error",
            param: "messages",
            code: "context_length_exceeded",
          },
        }),
        JSON.stringify({ error: { message: "Prompt is too long: the messages and tools exceed the model's context window." } }),
      ];
      for (const [i, body] of tooLong.entries()) {
        stub.reset();
        stub.answer(refusing(400, body));
        const upstreamId = `provider:too-long-${protocol}-${i}`;
        expect(await failure(gateway.stream(call(protocol, { tools: TOOLS, upstreamId })))).toMatchObject({ code: "provider_unavailable", upstreamStatus: 400 });
        expect(toolsSent()).toEqual([true]);
        stub.reset();
        await collect(gateway.stream(call(protocol, { tools: TOOLS, upstreamId })));
        expect(toolsSent()).toEqual([true]);
      }
    });

    it("on a call with steps a 400 naming them is the call's failure: not retried, nothing remembered, tools sent on the next call", async () => {
      const step = await aStep(protocol);
      stub.reset();
      stub.answer(refusing(400, REFUSAL[protocol]));
      const upstreamId = `provider:mid-loop-${protocol}`;
      expect(await failure(gateway.stream(call(protocol, { tools: TOOLS, upstreamId, steps: [step] })))).toMatchObject({
        code: "provider_unavailable",
        upstreamStatus: 400,
      });
      expect(toolsSent()).toEqual([true]);
      stub.reset();
      await collect(gateway.stream(call(protocol, { tools: TOOLS, upstreamId })));
      expect(toolsSent()).toEqual([true]);
    });

    it("an upstream remembered as refusing them is still sent them on a call with steps, and that round is not toolsRefused", async () => {
      const step = await aStep(protocol);
      const upstreamId = `provider:remembered-${protocol}`;
      stub.reset();
      stub.answer(refusing(400, REFUSAL[protocol]));
      await collect(gateway.stream(call(protocol, { tools: TOOLS, upstreamId })));
      expect(toolsSent()).toEqual([true, false]); // remembered from now on
      stub.reset();
      const events = await collect(gateway.stream(call(protocol, { tools: TOOLS, upstreamId, steps: [step] })));
      expect(toolsSent()).toEqual([true]);
      expect(finishOf(events)).not.toHaveProperty("toolsRefused");
    });
  });
});

describe("which error bodies are taken for a refusal of tools (a call without steps)", () => {
  /** [what it is, status, body, whether the call is asked once more without tools]. */
  const BODIES: Array<[string, number, boolean, string]> = [
    // Real refusals of tools: asked again without them.
    ["OpenAI: tools unsupported", 400, true, `{"error":{"message":"'tools' is not supported with this model.","type":"invalid_request_error","param":"tools"}}`],
    ["OpenAI: tool_choice unsupported", 400, true, `{"error":{"message":"Unsupported parameter: 'tool_choice' is not supported with this model."}}`],
    ["OpenAI: invalid tools parameter", 400, true, `{"error":{"message":"Invalid parameter: 'tools' is not allowed for this model."}}`],
    ["OpenAI: our tool's name (a refusal of these tools)", 400, true, `{"error":{"message":"Invalid 'tools[0].function.name': string does not match pattern."}}`],
    ["Anthropic: extra input", 400, true, `{"type":"error","error":{"type":"invalid_request_error","message":"tools: Extra inputs are not permitted"}}`],
    ["Anthropic: model without tools", 400, true, `{"type":"error","error":{"type":"invalid_request_error","message":"claude-x does not support tools"}}`],
    ["Gemini: function calling off", 400, true, `{"error":{"code":400,"message":"Function calling is not enabled for models/gemini-x","status":"INVALID_ARGUMENT"}}`],
    ["Gemini: tool use unsupported", 400, true, `{"error":{"code":400,"message":"Tool use with function calling is unsupported","status":"INVALID_ARGUMENT"}}`],
    ["Gemini: search tools only", 400, true, `{"error":{"code":400,"message":"Multiple tools are supported only when they are all search tools.","status":"INVALID_ARGUMENT"}}`],
    ["Gemini proxy: unknown toolConfig", 400, true, `{"error":{"code":400,"message":"Invalid JSON payload received. Unknown name \\"toolConfig\\": Cannot find field.","status":"INVALID_ARGUMENT"}}`],
    ["Gemini proxy: unknown functionDeclarations", 400, true, `{"error":{"code":400,"message":"Invalid JSON payload received. Unknown name \\"functionDeclarations\\": Cannot find field."}}`],
    ["DeepSeek: reasoner without function calling", 400, true, `{"error":{"message":"deepseek-reasoner does not support Function Calling","type":"invalid_request_error"}}`],
    ["Ollama: model without tools", 400, true, `{"error":"registry.ollama.ai/library/gemma:2b does not support tools"}`],
    ["vLLM: auto tool choice off", 400, true, `{"object":"error","message":"\\"auto\\" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set","type":"BadRequestError","code":400}`],
    ["Groq / Qwen-compatible: tool use unsupported", 400, true, `{"error":{"message":"tool use is not supported for this model"}}`],
    ["a relay: tool calls in stream mode", 400, true, `{"error":{"message":"Tool calls are not supported in stream mode"}}`],
    ["Mistral-style 422", 422, true, `{"detail":[{"loc":["body","tools"],"msg":"Extra inputs are not permitted","type":"extra_forbidden"}]}`],
    ["a relay in Chinese: no function calling", 400, true, `{"error":{"message":"该模型不支持函数调用"}}`],
    ["a relay in Chinese: no tools", 400, true, `{"error":{"message":"当前模型不支持工具调用"}}`],
    ["a relay in traditional Chinese", 400, true, `{"error":{"message":"此模型不支援函數調用"}}`],
    ["a refusal that merely says context", 400, true, `{"error":{"message":"tools are not supported","request":{"messages":[{"content":"keep the conversation context in mind"}]}}}`],
    // Not refusals of tools: the call's failure as it came.
    ["OpenAI: context length, counting the functions", 400, false, `{"error":{"message":"This model's maximum context length is 8192 tokens. However, your messages resulted in 9001 tokens (8780 in the messages, 221 in the functions). Please reduce the length of the messages or functions.","code":"context_length_exceeded"}}`],
    ["OpenAI: context window", 400, false, `{"error":{"message":"Your input exceeds the context window of this model. Please adjust your input and try again."}}`],
    ["Anthropic: prompt too long", 400, false, `{"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 210000 tokens > 200000 maximum"}}`],
    ["Gemini: over the token maximum", 400, false, `{"error":{"code":400,"message":"The input token count (1200000) exceeds the maximum number of tokens allowed (1048576)."}}`],
    ["Kimi: token limit", 400, false, `{"error":{"message":"Invalid request: Your request exceeded model token limit: 262144","type":"invalid_request_error"}}`],
    ["DeepSeek: context length", 400, false, `{"error":{"message":"This model's maximum context length is 131072 tokens. However, you requested 140000 tokens (139000 in the messages, 1000 in the completion)."}}`],
    ["a length error naming the tools", 400, false, `{"error":{"message":"Prompt is too long: the messages and tools exceed the model's context window."}}`],
    ["a length error in Chinese naming the tools", 400, false, `{"error":{"message":"请求超出模型上下文长度限制，工具定义过多"}}`],
    ["not about tools", 400, false, `{"error":{"message":"max_tokens is too large"}}`],
    ["OpenRouter: another status", 404, false, `{"error":{"message":"No endpoints found that support tool use."}}`],
  ];

  it.each(BODIES)("%s (%i): asked once more without tools: %s", async (what, status, retried, body) => {
    stub.answer(refusing(status, body));
    const outcome = await failure(gateway.stream(call("openai_chat", { tools: TOOLS, upstreamId: `provider:body-${what}` })));
    expect(toolsSent()).toEqual(retried ? [true, false] : [true]);
    if (retried) expect(outcome).toBeNull();
    else expect(outcome).toMatchObject({ upstreamStatus: status });
  });
});

describe("a remembered refusal of tools", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is forgotten after TOOLS_REFUSAL_TTL_MS: that upstream is offered them again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-20T00:00:00Z"));
    stub.answer(refusing(400, REFUSAL.openai_chat));
    const ask = () => collect(gateway.stream(call("openai_chat", { tools: TOOLS, upstreamId: "provider:ttl" })));
    expect(finishOf(await ask())).toMatchObject({ toolsRefused: true });
    expect(toolsSent()).toEqual([true, false]);
    stub.requests.length = 0;
    vi.setSystemTime(Date.now() + TOOLS_REFUSAL_TTL_MS - 1);
    expect(finishOf(await ask())).toMatchObject({ toolsRefused: true });
    expect(toolsSent()).toEqual([false]);
    stub.requests.length = 0;
    vi.setSystemTime(Date.now() + 1);
    expect(finishOf(await ask())).toMatchObject({ toolsRefused: true });
    expect(toolsSent()).toEqual([true, false]); // asked with them again: refused again, so remembered again
    stub.requests.length = 0;
    await ask();
    expect(toolsSent()).toEqual([false]);
  });

  it("Refusals forgets tools after the TTL, and nothing else", () => {
    let now = 0;
    const refusals = new Refusals(() => now);
    refusals.add("provider:a", "tools");
    refusals.add("provider:a", "thinking");
    now = TOOLS_REFUSAL_TTL_MS - 1;
    expect([...refusals.of("provider:a")].sort()).toEqual(["thinking", "tools"]);
    now = TOOLS_REFUSAL_TTL_MS;
    expect([...refusals.of("provider:a")]).toEqual(["thinking"]);
    now = 10 * TOOLS_REFUSAL_TTL_MS;
    expect([...refusals.of("provider:a")]).toEqual(["thinking"]);
    expect(TOOLS_REFUSAL_TTL_MS).toBe(6 * 60 * 60 * 1000);
  });
});

describe("Chat Completions", () => {
  it("reasoning_content and tool_calls in one stream yield both: the reasoning, then the tool call", async () => {
    stub.answer(answering("reasoning_tool"));
    const events = await collect(gateway.stream(call("openai_chat", { tools: TOOLS, reasoning: "high" })));
    expect(events.filter((e) => e.type !== "finish").map((e) => e.type)).toEqual([...CANNED_REASONING_DELTAS.map(() => "reasoning"), "tool_call"]);
    expect(deltas(events, "reasoning")).toBe(CANNED_REASONING);
    expect(toolCallsIn(events)).toEqual([{ id: CANNED_TOOL_CALL_ID, name: CANNED_TOOL.name, input: CANNED_TOOL.input }]);
    expect(finishOf(events)).toMatchObject({ usage: CANNED_REASONING_USAGE, truncated: false, toolCalls: toolCallsIn(events) });
  });

  it("a tool result that is a string is sent as it is; any other value as its JSON", async () => {
    stub.answer(answering("tool"));
    const finish = finishOf(await collect(gateway.stream(call("openai_chat", { tools: TOOLS }))));
    stub.answer(answering("text"));
    const id = finish.toolCalls[0]!.id;
    await collect(
      gateway.stream(
        call("openai_chat", {
          tools: TOOLS,
          steps: [
            { assistant: finish.assistant, results: [{ id, name: CANNED_TOOL.name, output: "资料：\n去吃川菜" }] },
            { assistant: finish.assistant, results: [{ id, name: CANNED_TOOL.name, output: [1, null] }] },
          ],
        }),
      ),
    );
    const tool = stub.requests[1]!.body.messages.filter((m: any) => m.role === "tool").map((m: any) => m.content);
    expect(tool).toEqual(["资料：\n去吃川菜", "[1,null]"]);
  });

  it("each round's reasoning goes back on that round's assistant message, even when the upstream reuses call ids", async () => {
    // Both rounds call `call_stub_1`, as upstreams that number calls per response do.
    const later = CANNED_REASONING.replace("Let me think", "Then again");
    stub.answer(answering("reasoning_tool"));
    const one = finishOf(await collect(gateway.stream(call("openai_chat", { tools: TOOLS, reasoning: "high" }))));
    stub.answer(sending(cannedStream("openai_chat", "reasoning_tool").replaceAll("Let me think", "Then again")));
    const two = finishOf(await collect(gateway.stream(call("openai_chat", { tools: TOOLS, reasoning: "high", steps: [answered(one)] }))));
    expect(two.toolCalls[0]!.id).toBe(one.toolCalls[0]!.id);
    stub.answer(answering("text"));
    await collect(gateway.stream(call("openai_chat", { tools: TOOLS, reasoning: "high", steps: [answered(one), answered(two)] })));
    const assistants = stub.requests[2]!.body.messages.filter((m: any) => m.role === "assistant");
    expect(assistants.map((m: any) => m.reasoning_content)).toEqual([CANNED_REASONING, later]);
  });

  it("a tool-call stream cut in two at any byte gives the same single tool_call", async () => {
    const bytes = Buffer.from(cannedStream("openai_chat", "reasoning_tool"));
    for (let cut = 1; cut < bytes.length; cut++) {
      stub.reset();
      stub.answer(async (_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(bytes.subarray(0, cut));
        await new Promise((r) => setImmediate(r));
        res.end(bytes.subarray(cut));
      });
      const events = await collect(gateway.stream(call("openai_chat", { tools: TOOLS, reasoning: "high" })));
      expect(toolCallsIn(events), `cut at byte ${cut}`).toEqual([{ id: CANNED_TOOL_CALL_ID, name: CANNED_TOOL.name, input: CANNED_TOOL.input }]);
      expect(deltas(events, "reasoning"), `cut at byte ${cut}`).toBe(CANNED_REASONING);
    }
  }, 120_000);
});

describe("thinking_exhausted", () => {
  it("a round cut off at its limit after thinking whose only call has input null is thinking_exhausted, as before tools", async () => {
    stub.answer(sending(cannedStream("anthropic", "reasoning_tool", { toolArgs: ['{"query":', '"川'] }).replace('"stop_reason":"tool_use"', '"stop_reason":"max_tokens"')));
    const error = await failure(gateway.stream(call("anthropic", { tools: TOOLS, reasoning: "high" })));
    expect(error).toBeInstanceOf(ModelError);
    expect(error).toMatchObject({ code: "thinking_exhausted", usage: CANNED_REASONING_USAGE });
  });

  it("a round cut off at its limit after thinking that made a tool call is a truncated finish naming the call, not thinking_exhausted", async () => {
    stub.answer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(cannedStream("anthropic", "reasoning_tool").replace('"stop_reason":"tool_use"', '"stop_reason":"max_tokens"'));
    });
    const events = await collect(gateway.stream(call("anthropic", { tools: TOOLS, reasoning: "high" })));
    expect(finishOf(events)).toMatchObject({ truncated: true, toolCalls: [{ id: CANNED_TOOL_CALL_ID, name: CANNED_TOOL.name, input: CANNED_TOOL.input }] });
  });
});
