import type http from "node:http";
import { inspect } from "node:util";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PROTOCOLS, type Protocol } from "../src/config.ts";
import { createModelGateway, ModelError, type ModelCall, type ModelErrorCode, type ModelEvent } from "../src/models/gateway.ts";
import { cannedKeyError, cannedStream, protocolStub, STUB_MODEL, type ProtocolStub } from "./helpers/models.ts";

/**
 * How the gateway fails: every upstream failure becomes a `ModelError` whose code is all that is kept (its message is a
 * fixed sentence, its only other field the upstream's HTTP status); stopping a call ends it at once and closes the
 * upstream connection.
 */

const KEY = "sk-stub-SECRET-0123456789";

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
    system: "",
    messages: [{ role: "user", parts: [{ type: "text", text: "Hi" }] }],
    reasoning: "none",
    maxOutputTokens: 256,
    signal: new AbortController().signal,
    ...over,
  };
}

/** Runs the stream to its end: the events it gave and how it ended (null when it finished normally). */
async function run(events: AsyncIterable<ModelEvent>): Promise<{ events: ModelEvent[]; error: unknown }> {
  const seen: ModelEvent[] = [];
  try {
    for await (const e of events) seen.push(e);
    return { events: seen, error: null };
  } catch (error) {
    return { events: seen, error };
  }
}

/** The fixed sentence of a code. */
const sentence = (code: ModelErrorCode) => new ModelError(code).message;

/** Asserts `error` is the ModelError of `code` and that nothing of the key (or the upstream answer) is anywhere in it. */
function expectModelError(error: unknown, code: ModelErrorCode, upstreamStatus?: number) {
  expect(error).toBeInstanceOf(ModelError);
  const e = error as ModelError;
  expect(e.code).toBe(code);
  expect(e.message).toBe(sentence(code));
  expect(e.upstreamStatus).toBe(upstreamStatus);
  expect(e.cause).toBeUndefined();
  for (const view of [e.message, String(e), e.stack ?? "", inspect(e, { depth: 10 }), JSON.stringify(e)]) expect(view).not.toContain(KEY);
}

const respond = (status: number, body: string, type = "application/json") => (_req: unknown, res: http.ServerResponse) => {
  res.writeHead(status, { "content-type": type });
  res.end(body);
};

describe("upstream refusals and failures become ModelError codes", () => {
  it.each(PROTOCOLS)("%s: the protocol's own key error (which echoes the key) is provider_rejected, and the key is nowhere", async (protocol) => {
    const { status, body } = cannedKeyError(protocol, KEY);
    expect(body).toContain(KEY);
    stub.answer(respond(status, body));
    const { events, error } = await run(gateway.stream(call(protocol)));
    expect(events).toEqual([]);
    expectModelError(error, "provider_rejected", status);
  });

  it("401 and 403 are provider_rejected; 400, 404, 429, 500 and 503 are provider_unavailable", async () => {
    for (const [status, code] of [
      [401, "provider_rejected"],
      [403, "provider_rejected"],
      [400, "provider_unavailable"],
      [404, "provider_unavailable"],
      [429, "provider_unavailable"],
      [500, "provider_unavailable"],
      [503, "provider_unavailable"],
    ] as const) {
      stub.answer(respond(status, JSON.stringify({ error: { message: `failure echoing ${KEY}` } })));
      const { error } = await run(gateway.stream(call("openai_chat")));
      expectModelError(error, code, status);
    }
  });

  it("each status is answered once: nothing is retried", async () => {
    stub.answer(respond(503, JSON.stringify({ error: { message: "overloaded" } })));
    await run(gateway.stream(call("anthropic")));
    expect(stub.requests).toHaveLength(1);
  });

  it("a redirect is not followed: provider_unavailable", async () => {
    stub.answer((_req, res) => {
      res.writeHead(307, { location: `${stub.baseUrl}/elsewhere` });
      res.end();
    });
    const { error } = await run(gateway.stream(call("openai_responses")));
    expectModelError(error, "provider_unavailable");
    expect(stub.requests).toHaveLength(1);
  });

  it.each(PROTOCOLS)("%s: the socket closed in the middle of the stream is provider_unavailable, after the text that arrived", async (protocol) => {
    const body = cannedStream(protocol, "text");
    const cut = body.indexOf(", world");
    expect(cut).toBeGreaterThan(0);
    stub.answer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      // Up to the end of the event before ", world": that event is lost with the socket.
      res.write(body.slice(0, body.lastIndexOf("\n\n", cut) + 2));
      setTimeout(() => res.socket?.destroy(), 50);
    });
    const { events, error } = await run(gateway.stream(call(protocol)));
    expectModelError(error, "provider_unavailable");
    expect(events).toEqual([{ type: "text", delta: "Hello" }]);
  });

  it.each(PROTOCOLS)("%s: a stream that ends cleanly but without the protocol's completion is provider_unavailable", async (protocol) => {
    const body = cannedStream(protocol, "text");
    stub.answer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(body.slice(0, body.lastIndexOf("\n\n", body.indexOf(", world")) + 2));
    });
    const { events, error } = await run(gateway.stream(call(protocol)));
    expectModelError(error, "provider_unavailable");
    expect(events.filter((e) => e.type === "finish")).toEqual([]);
  });

  it.each(PROTOCOLS)("%s: an HTML page instead of an event stream is provider_unavailable (200 and 502)", async (protocol) => {
    const page = `<!doctype html><html><body><h1>Bad gateway</h1><p>key ${KEY}</p></body></html>`;
    for (const status of [200, 502]) {
      stub.answer(respond(status, page, "text/html"));
      const { events, error } = await run(gateway.stream(call(protocol)));
      expect(events.filter((e) => e.type !== "finish")).toEqual([]);
      expectModelError(error, "provider_unavailable", status === 200 ? undefined : status);
    }
  });

  it("an upstream silent for longer than the idle limit is provider_unavailable", async () => {
    const quick = createModelGateway({ allowInsecureLocal: true, idleTimeoutMs: 300 });
    stub.answer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": nothing yet\n\n");
    });
    const started = Date.now();
    const { error } = await run(quick.stream(call("gemini")));
    expectModelError(error, "provider_unavailable");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("the guard's refusal is address_not_allowed, and nothing is sent", async () => {
    const strict = createModelGateway({});
    for (const baseUrl of [stub.baseUrl, "https://10.0.0.7/v1", "https://169.254.169.254/v1", "ftp://example.com/v1"]) {
      const { error } = await run(strict.stream(call("openai_chat", { baseUrl })));
      expectModelError(error, "address_not_allowed");
    }
    expect(stub.requests).toEqual([]);
  });

  it("nothing is printed, failing or not: no upstream text on the console, no SDK warning", async () => {
    const printed: string[] = [];
    const note = (...args: unknown[]) => void printed.push(args.map((a) => inspect(a)).join(" "));
    const spies = [
      vi.spyOn(console, "error").mockImplementation(note),
      vi.spyOn(console, "warn").mockImplementation(note),
      vi.spyOn(console, "log").mockImplementation(note),
      vi.spyOn(console, "info").mockImplementation(note),
      vi.spyOn(process, "emitWarning").mockImplementation(note),
    ];
    try {
      for (const protocol of PROTOCOLS) {
        const { status, body } = cannedKeyError(protocol, KEY);
        stub.answer(respond(status, body));
        expectModelError((await run(gateway.stream(call(protocol, { reasoning: "max" })))).error, "provider_rejected", status);
      }
      stub.reset();
      for (const protocol of PROTOCOLS) expect((await run(gateway.stream(call(protocol, { reasoning: "max" })))).error).toBeNull();
      // A model the SDK knows cannot switch thinking off: it drops `thinking: disabled` and warns (as process warnings).
      expect((await run(gateway.stream(call("anthropic", { model: "claude-opus-5-5", reasoning: "none" })))).error).toBeNull();
      expect(stub.requests.at(-1)!.body.thinking).toBeUndefined();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    expect(printed).toEqual([]);
  });

  it("ModelError's message is one fixed sentence per code", () => {
    const codes: ModelErrorCode[] = ["provider_rejected", "provider_unavailable", "address_not_allowed"];
    const messages = codes.map(sentence);
    expect(new Set(messages).size).toBe(3);
    for (const [i, code] of codes.entries()) expect(new ModelError(code, 418).message).toBe(messages[i]);
  });
});

describe("stopping a call", () => {
  /** The stub sends the first delta of the protocol's stream and then holds the connection open, noting when it closes. */
  function holdAfterFirstDelta(protocol: Protocol) {
    const state = { closed: false, closedAt: 0 };
    const body = cannedStream(protocol, "text");
    stub.answer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(body.slice(0, body.lastIndexOf("\n\n", body.indexOf(", world")) + 2));
      res.on("close", () => {
        state.closed = true;
        state.closedAt = Date.now();
      });
    });
    return state;
  }

  const waitUntil = async (check: () => boolean, ms = 2_000) => {
    const end = Date.now() + ms;
    while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
    return check();
  };

  it.each(PROTOCOLS)("%s: aborting the signal ends the iterator at once with the signal's reason and closes the upstream connection", async (protocol) => {
    const upstream = holdAfterFirstDelta(protocol);
    const controller = new AbortController();
    const seen: ModelEvent[] = [];
    let abortedAt = 0;
    let error: unknown = null;
    try {
      for await (const e of gateway.stream(call(protocol, { signal: controller.signal }))) {
        seen.push(e);
        if (seen.length === 1) {
          setTimeout(() => {
            abortedAt = Date.now();
            controller.abort();
          }, 30);
        }
      }
    } catch (e) {
      error = e;
    }
    const endedAt = Date.now();
    expect(seen).toEqual([{ type: "text", delta: "Hello" }]);
    expect(error).toBe(controller.signal.reason);
    expect(endedAt - abortedAt).toBeLessThan(500);
    expect(await waitUntil(() => upstream.closed)).toBe(true);
    expect(upstream.closedAt - abortedAt).toBeLessThan(1_000);
  });

  it("a consumer that stops reading early closes the upstream connection too", async () => {
    const upstream = holdAfterFirstDelta("anthropic");
    for await (const e of gateway.stream(call("anthropic"))) {
      expect(e).toEqual({ type: "text", delta: "Hello" });
      break;
    }
    expect(await waitUntil(() => upstream.closed)).toBe(true);
  });

  it("a signal aborted before the call starts sends nothing", async () => {
    const controller = new AbortController();
    controller.abort();
    const { events, error } = await run(gateway.stream(call("openai_chat", { signal: controller.signal })));
    expect(events).toEqual([]);
    expect(error).toBe(controller.signal.reason);
    expect(stub.requests).toEqual([]);
  });
});
