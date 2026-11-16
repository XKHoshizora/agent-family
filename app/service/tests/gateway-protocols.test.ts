import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PROTOCOLS, REASONING_LEVELS, type Protocol } from "../src/config.ts";
import { createModelGateway, ModelError, REASONING_PARAMS, type ModelCall, type ModelEvent } from "../src/models/gateway.ts";
import { PNG } from "./helpers/agents.ts";
import {
  answerCanned,
  CANNED_REASONING,
  CANNED_REASONING_USAGE,
  CANNED_TEXT,
  CANNED_USAGE,
  protocolStub,
  STUB_MODEL,
  type ProtocolStub,
} from "./helpers/models.ts";

/**
 * The model gateway against a local stub of each protocol's streaming endpoint (real wire formats, parsed by the AI
 * SDK), reached through the address guard with `allowInsecureLocal`.
 */

const KEY = "sk-stub-0123456789abcdef";
const SYSTEM = "You are a stub's Agent.";
const PDF = Buffer.from("%PDF-1.4\n1 0 obj <<>> endobj\ntrailer <<>>\n%%EOF\n");
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

let stub: ProtocolStub;
beforeAll(async () => {
  stub = await protocolStub();
});
afterAll(async () => {
  await stub.close();
});
beforeEach(() => stub.reset());

const gateway = createModelGateway({ allowInsecureLocal: true });

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

const deltas = (events: ModelEvent[], type: "text" | "reasoning") =>
  events.flatMap((e) => (e.type === type ? [e.delta] : []));

/** The one request the stub received. */
function onlyRequest() {
  expect(stub.requests).toHaveLength(1);
  return stub.requests[0]!;
}

/** Where each protocol's streaming request goes, below the baseUrl `http://127.0.0.1:<port>/v1`. */
const PATH: Record<Protocol, string> = {
  openai_chat: "/v1/chat/completions",
  openai_responses: "/v1/responses",
  anthropic: "/v1/messages",
  gemini: `/v1/models/${STUB_MODEL}:streamGenerateContent?alt=sse`,
};

/** How each protocol presents the key. */
const KEY_HEADERS: Record<Protocol, Record<string, string>> = {
  openai_chat: { authorization: `Bearer ${KEY}` },
  openai_responses: { authorization: `Bearer ${KEY}` },
  anthropic: { "x-api-key": KEY, "anthropic-version": "2023-06-01" },
  gemini: { "x-goog-api-key": KEY },
};

describe.each(PROTOCOLS)("%s", (protocol) => {
  it("streams the canned answer as text deltas, then one finish with the canned usage", async () => {
    const events = await collect(gateway.stream(call(protocol)));
    expect(deltas(events, "text").join("")).toBe(CANNED_TEXT);
    expect(deltas(events, "text").length).toBeGreaterThan(1);
    expect(deltas(events, "reasoning")).toEqual([]);
    expect(events.at(-1)).toEqual({ type: "finish", usage: CANNED_USAGE, truncated: false });
    expect(events.filter((e) => e.type === "finish")).toHaveLength(1);
  });

  it("sends to the protocol's path, with the key in the protocol's header and nowhere in the URL", async () => {
    await collect(gateway.stream(call(protocol)));
    const req = onlyRequest();
    expect(req.method).toBe("POST");
    expect(req.path).toBe(PATH[protocol]);
    expect(req.headers).toMatchObject(KEY_HEADERS[protocol]);
    expect(req.path).not.toContain(KEY);
  });

  it("carries the system text, an earlier assistant turn, an image, a PDF and the output limit in the protocol's shape", async () => {
    await collect(
      gateway.stream(
        call(protocol, {
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
        }),
      ),
    );
    const { body } = onlyRequest();
    const image = `data:image/png;base64,${b64(PNG)}`;
    const pdf = `data:application/pdf;base64,${b64(PDF)}`;
    switch (protocol) {
      case "openai_chat":
        expect(body).toMatchObject({ model: STUB_MODEL, stream: true, max_tokens: 256 });
        expect(body.messages).toEqual([
          { role: "system", content: SYSTEM },
          {
            role: "user",
            content: [
              { type: "text", text: "Look at these" },
              { type: "image_url", image_url: { url: image } },
              { type: "file", file: { filename: "notes.pdf", file_data: pdf } },
            ],
          },
          { role: "assistant", content: "An earlier answer" },
          { role: "user", content: "And now?" },
        ]);
        break;
      case "openai_responses":
        expect(body).toMatchObject({ model: STUB_MODEL, stream: true, max_output_tokens: 256 });
        expect(body.input).toEqual([
          { role: "system", content: SYSTEM },
          {
            role: "user",
            content: [
              { type: "input_text", text: "Look at these" },
              { type: "input_image", image_url: image },
              { type: "input_file", filename: "notes.pdf", file_data: pdf },
            ],
          },
          { role: "assistant", content: "An earlier answer" }, // an "easy input message": text as a plain string
          { role: "user", content: [{ type: "input_text", text: "And now?" }] },
        ]);
        break;
      case "anthropic":
        expect(body).toMatchObject({ model: STUB_MODEL, stream: true, max_tokens: 256 });
        expect(body.system).toEqual([{ type: "text", text: SYSTEM }]);
        expect(body.messages).toEqual([
          {
            role: "user",
            content: [
              { type: "text", text: "Look at these" },
              { type: "image", source: { type: "base64", media_type: "image/png", data: b64(PNG) } },
              { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64(PDF) }, title: "notes.pdf" },
            ],
          },
          { role: "assistant", content: [{ type: "text", text: "An earlier answer" }] },
          { role: "user", content: [{ type: "text", text: "And now?" }] },
        ]);
        break;
      case "gemini":
        expect(body.generationConfig).toMatchObject({ maxOutputTokens: 256 });
        expect(body.systemInstruction).toEqual({ parts: [{ text: SYSTEM }] });
        expect(body.contents).toEqual([
          {
            role: "user",
            parts: [
              { text: "Look at these" },
              { inlineData: { mimeType: "image/png", data: b64(PNG) } },
              { inlineData: { mimeType: "application/pdf", data: b64(PDF) } },
            ],
          },
          { role: "model", parts: [{ text: "An earlier answer" }] },
          { role: "user", parts: [{ text: "And now?" }] },
        ]);
        break;
    }
  });

  it.each(REASONING_LEVELS)("reasoning %s: the request carries exactly REASONING_PARAMS for it", async (level) => {
    await collect(gateway.stream(call(protocol, { reasoning: level })));
    expect(reasoningFields(protocol, onlyRequest().body)).toEqual(onTheWire(protocol, REASONING_PARAMS[protocol][level]));
  });

  it("a model that stops for length finishes truncated, after the text it gave", async () => {
    stub.answer((req, res) => answerCanned(req, res, "length"));
    const events = await collect(gateway.stream(call(protocol)));
    expect(deltas(events, "text").join("")).toBe(CANNED_TEXT);
    expect(events.at(-1)).toEqual({ type: "finish", usage: CANNED_USAGE, truncated: true });
  });

  if (protocol === "openai_chat") {
    it("fallback: Chat Completions has no reasoning stream the SDK reads; its reasoning is dropped but counted as output", async () => {
      stub.answer((req, res) => answerCanned(req, res, "reasoning"));
      const events = await collect(gateway.stream(call(protocol, { reasoning: "high" })));
      expect(deltas(events, "reasoning")).toEqual([]);
      expect(deltas(events, "text").join("")).toBe(CANNED_TEXT);
      expect(events.at(-1)).toEqual({ type: "finish", usage: CANNED_REASONING_USAGE, truncated: false });
    });
  } else {
    it("a reasoning stream arrives as reasoning deltas before the text; reasoning tokens count as output", async () => {
      stub.answer((req, res) => answerCanned(req, res, "reasoning"));
      const events = await collect(gateway.stream(call(protocol, { reasoning: "high" })));
      expect(deltas(events, "reasoning").join("")).toBe(CANNED_REASONING);
      expect(deltas(events, "text").join("")).toBe(CANNED_TEXT);
      const firstText = events.findIndex((e) => e.type === "text");
      const lastReasoning = events.findLastIndex((e) => e.type === "reasoning");
      expect(lastReasoning).toBeLessThan(firstText);
      expect(events.at(-1)).toEqual({ type: "finish", usage: CANNED_REASONING_USAGE, truncated: false });
    });
  }
});

describe("fallback: an assistant turn is text only", () => {
  it("a file in it is sent as [文件：{name}], an image as [图片]", async () => {
    await collect(
      gateway.stream(
        call("anthropic", {
          messages: [
            { role: "user", parts: [{ type: "text", text: "Send me the notes" }] },
            {
              role: "assistant",
              parts: [
                { type: "text", text: "Here:" },
                { type: "file", mime: "application/pdf", name: "notes.pdf", data: PDF },
                { type: "image", mime: "image/png", data: PNG },
              ],
            },
            { role: "user", parts: [{ type: "text", text: "Thanks" }] },
          ],
        }),
      ),
    );
    expect(onlyRequest().body.messages[1]).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "Here:" },
        { type: "text", text: "[文件：notes.pdf]" },
        { type: "text", text: "[图片]" },
      ],
    });
  });
});

describe("REASONING_PARAMS (one table: provider options per protocol and level)", () => {
  it("covers every level of every protocol; a level a protocol cannot express is its nearest lower one; none disables or is omitted", () => {
    const openai = (effort: string, summary?: string) => ({ openai: { reasoningEffort: effort, ...(summary ? { reasoningSummary: summary } : {}), forceReasoning: true } });
    const anthropic = (effort: string) => ({ anthropic: { thinking: { type: "adaptive", display: "summarized" }, effort } });
    const gemini = (level: string) => ({ google: { thinkingConfig: { thinkingLevel: level, includeThoughts: true } } });
    expect(REASONING_PARAMS).toEqual({
      // `reasoning_effort` is refused by OpenAI models that do not reason, and those are sent `none`: it is left out.
      openai_chat: { none: {}, low: openai("low"), medium: openai("medium"), high: openai("high"), xhigh: openai("xhigh"), max: openai("xhigh") },
      openai_responses: {
        none: {},
        low: openai("low", "auto"),
        medium: openai("medium", "auto"),
        high: openai("high", "auto"),
        xhigh: openai("xhigh", "auto"),
        max: openai("max", "auto"),
      },
      anthropic: {
        none: { anthropic: { thinking: { type: "disabled" } } },
        low: anthropic("low"),
        medium: anthropic("medium"),
        high: anthropic("high"),
        xhigh: anthropic("xhigh"),
        max: anthropic("max"),
      },
      // Gemini's thinking levels cannot switch thinking off: none leaves the option out.
      gemini: { none: {}, low: gemini("low"), medium: gemini("medium"), high: gemini("high"), xhigh: gemini("xhigh"), max: gemini("xhigh") },
    });
  });
});

describe("listModels", () => {
  it("is the provider probe's model list: one GET {baseUrl}/models with the protocol's key header", async () => {
    stub.answer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "alpha" }, { id: "beta" }] }));
    });
    expect(await gateway.listModels({ protocol: "openai_chat", baseUrl: stub.baseUrl, apiKey: KEY })).toEqual(["alpha", "beta"]);
    const req = onlyRequest();
    expect([req.method, req.path, req.headers.authorization]).toEqual(["GET", "/v1/models", `Bearer ${KEY}`]);
  });

  it("fails with a ModelError: 401 is provider_rejected", async () => {
    stub.answer((_req, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `bad key ${KEY}` } }));
    });
    const error = await gateway.listModels({ protocol: "anthropic", baseUrl: stub.baseUrl, apiKey: KEY }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ModelError);
    expect(error).toMatchObject({ code: "provider_rejected", upstreamStatus: 401 });
    expect(String((error as Error).message)).not.toContain(KEY);
  });
});

// --- what each protocol's reasoning settings look like on the wire --------------------------------------------------

/** The fields of a request body that carry reasoning settings, as sent. */
function reasoningFields(protocol: Protocol, body: any): Record<string, unknown> {
  const pick = (from: any, keys: string[]) => Object.fromEntries(keys.filter((k) => from?.[k] !== undefined).map((k) => [k, from[k]]));
  switch (protocol) {
    case "openai_chat":
      return pick(body, ["reasoning_effort"]);
    case "openai_responses":
      return pick(body, ["reasoning"]);
    case "anthropic":
      return pick(body, ["thinking", "output_config"]);
    case "gemini":
      return pick(body.generationConfig, ["thinkingConfig"]);
  }
}

/** What provider options become on the wire, as the provider packages document it. */
function onTheWire(protocol: Protocol, params: any): Record<string, unknown> {
  switch (protocol) {
    case "openai_chat":
      return params.openai?.reasoningEffort === undefined ? {} : { reasoning_effort: params.openai.reasoningEffort };
    case "openai_responses":
      return params.openai?.reasoningEffort === undefined
        ? {}
        : { reasoning: { effort: params.openai.reasoningEffort, summary: params.openai.reasoningSummary } };
    case "anthropic":
      return {
        ...(params.anthropic?.thinking ? { thinking: params.anthropic.thinking } : {}),
        ...(params.anthropic?.effort ? { output_config: { effort: params.anthropic.effort } } : {}),
      };
    case "gemini":
      return params.google?.thinkingConfig ? { thinkingConfig: params.google.thinkingConfig } : {};
  }
}
