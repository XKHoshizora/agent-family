import { describe, expect, it } from "vitest";
import { ModelError, type ModelCall, type ModelEvent } from "../src/models/gateway.ts";
import { scriptedGateway } from "./helpers/models.ts";

/** The scripted gateway rule tests inject: it must behave like the real one where they can tell. */

function call(over: Partial<ModelCall> = {}): ModelCall {
  return {
    protocol: "openai_chat",
    baseUrl: "https://unused.example/v1",
    apiKey: "unused-key",
    model: "m",
    system: "s",
    messages: [{ role: "user", parts: [{ type: "text", text: "hi" }] }],
    reasoning: "none",
    maxOutputTokens: 100,
    signal: new AbortController().signal,
    ...over,
  };
}

async function run(events: AsyncIterable<ModelEvent>) {
  const seen: ModelEvent[] = [];
  try {
    for await (const e of events) seen.push(e);
    return { events: seen, error: null as unknown };
  } catch (error) {
    return { events: seen, error };
  }
}

const text = (events: ModelEvent[], type: "text" | "reasoning" = "text") => events.flatMap((e) => (e.type === type ? [e.delta] : [])).join("");

describe("scriptedGateway", () => {
  it("answers the queued steps in order and records every call as given", async () => {
    const g = scriptedGateway().reply("first answer, long enough for several chunks", { reasoning: "hmm", usage: { inputTokens: 3, outputTokens: 4 } });
    g.fail("provider_rejected").empty().reply("last", { truncated: true });
    const calls = [call({ model: "a" }), call({ model: "b" }), call({ model: "c" }), call({ model: "d" })];

    const one = await run(g.stream(calls[0]!));
    expect(text(one.events, "reasoning")).toBe("hmm");
    expect(text(one.events)).toBe("first answer, long enough for several chunks");
    expect(one.events.filter((e) => e.type === "text").length).toBeGreaterThan(1);
    expect(one.events.at(-1)).toEqual({ type: "finish", usage: { inputTokens: 3, outputTokens: 4 }, truncated: false, toolCalls: [], assistant: expect.anything() });

    const two = await run(g.stream(calls[1]!));
    expect(two.error).toBeInstanceOf(ModelError);
    expect(two.error).toMatchObject({ code: "provider_rejected" });

    expect((await run(g.stream(calls[2]!))).events).toEqual([{ type: "finish", usage: null, truncated: false, toolCalls: [], assistant: expect.anything() }]);
    expect((await run(g.stream(calls[3]!))).events.at(-1)).toEqual({ type: "finish", usage: null, truncated: true, toolCalls: [], assistant: expect.anything() });

    expect(g.calls).toEqual(calls);
    expect(g.calls[1]).toBe(calls[1]);
    expect(g.pending()).toBe(0);
    const extra = await run(g.stream(call()));
    expect(String(extra.error)).toContain("call #5 was not scripted");
  });

  it("fail can come after some text", async () => {
    const g = scriptedGateway().fail("provider_unavailable", { afterText: "partial" });
    const { events, error } = await run(g.stream(call()));
    expect(text(events)).toBe("partial");
    expect(error).toMatchObject({ code: "provider_unavailable" });
  });

  it("cut streams its text and ends with neither a finish nor an error", async () => {
    const { events, error } = await run(scriptedGateway().cut("half an answer").stream(call()));
    expect(text(events)).toBe("half an answer");
    expect(events.some((e) => e.type === "finish")).toBe(false);
    expect(error).toBeNull();
  });

  it("hang holds a call until released, then it answers; the signal ends it at once instead", async () => {
    const g = scriptedGateway();
    const held = g.hang();
    const running = run(g.stream(call()));
    expect(await held.reached).toBe(g.calls[0]);
    held.release("after the wait");
    expect(text((await running).events)).toBe("after the wait");

    const stopped = g.hang();
    const controller = new AbortController();
    const pending = run(g.stream(call({ signal: controller.signal })));
    await stopped.reached;
    controller.abort();
    const { events, error } = await pending;
    expect(events).toEqual([]);
    expect(error).toBe(controller.signal.reason);
    expect(g.calls[1]!.signal.aborted).toBe(true);
  });

  it("an abort between delayed chunks ends the stream with the signal's reason", async () => {
    const g = scriptedGateway().reply("abcdefgh".repeat(10), { delayMsPerChunk: 20 });
    const controller = new AbortController();
    const seen: ModelEvent[] = [];
    let error: unknown = null;
    try {
      for await (const e of g.stream(call({ signal: controller.signal }))) {
        seen.push(e);
        if (seen.length === 2) controller.abort();
      }
    } catch (e) {
      error = e;
    }
    expect(seen).toHaveLength(2);
    expect(error).toBe(controller.signal.reason);
  });
});

describe("scriptedGateway with tools", () => {
  const SEARCH = { name: "search_messages", description: "Search.", parameters: { type: "object", properties: { query: { type: "string" } } } };

  it("callTools: one round that streams its text, then one tool_call per call, then a finish naming them with an opaque assistant turn", async () => {
    const g = scriptedGateway().callTools(
      [
        { name: "search_messages", input: { query: "川菜" } },
        { name: "read_file", input: { id: "f1" } },
      ],
      { text: "Let me look.", usage: { inputTokens: 5, outputTokens: 6 } },
    );
    const { events, error } = await run(g.stream(call({ tools: [SEARCH] })));
    expect(error).toBeNull();
    expect(text(events)).toBe("Let me look.");
    const calls = events.flatMap((e) => (e.type === "tool_call" ? [e.call] : []));
    expect(calls).toEqual([
      { id: expect.any(String), name: "search_messages", input: { query: "川菜" } },
      { id: expect.any(String), name: "read_file", input: { id: "f1" } },
    ]);
    expect(new Set(calls.map((c) => c.id)).size).toBe(2);
    const finish = events.at(-1);
    expect(finish).toEqual({ type: "finish", usage: { inputTokens: 5, outputTokens: 6 }, truncated: false, toolCalls: calls, assistant: expect.anything() });
    // The opaque turn survives a JSON round trip, as the real one does.
    const assistant = (finish as { assistant: unknown }).assistant;
    expect(JSON.parse(JSON.stringify(assistant))).toEqual(assistant);

    // Ids are not reused by a later round.
    g.callTools([{ name: "search_messages", input: { query: "火锅" } }]);
    const again = await run(g.stream(call({ tools: [SEARCH] })));
    const [later] = again.events.flatMap((e) => (e.type === "tool_call" ? [e.call] : []));
    expect(calls.map((c) => c.id)).not.toContain(later!.id);
    expect(again.events.at(-1)).toMatchObject({ usage: null, toolCalls: [later] });
  });

  it("refuseTools: the round answers with text and reports toolsRefused", async () => {
    const g = scriptedGateway().refuseTools("answered without tools", { usage: { inputTokens: 1, outputTokens: 2 } }).refuseTools();
    const { events } = await run(g.stream(call({ tools: [SEARCH] })));
    expect(text(events)).toBe("answered without tools");
    expect(events.at(-1)).toEqual({
      type: "finish",
      usage: { inputTokens: 1, outputTokens: 2 },
      truncated: false,
      toolCalls: [],
      assistant: expect.anything(),
      toolsRefused: true,
    });
    const second = await run(g.stream(call({ tools: [SEARCH] })));
    expect(text(second.events)).not.toBe("");
    expect(second.events.at(-1)).toMatchObject({ toolCalls: [], toolsRefused: true });
    // A plain reply reports nothing of the kind.
    g.reply("plain");
    expect((await run(g.stream(call()))).events.at(-1)).not.toHaveProperty("toolsRefused");
  });

  it("records each call's tools and steps as they were when it was made", async () => {
    const g = scriptedGateway().callTools([{ name: "search_messages", input: { query: "a" } }]).reply("done");
    const steps: NonNullable<ModelCall["steps"]> = [];
    const first = await run(g.stream(call({ tools: [SEARCH], steps })));
    const finish = first.events.at(-1) as Extract<ModelEvent, { type: "finish" }>;
    steps.push({ assistant: finish.assistant, results: [{ id: finish.toolCalls[0]!.id, name: "search_messages", output: { hits: [] } }] });
    await run(g.stream(call({ tools: [SEARCH], steps })));
    expect(g.calls.map((c) => c.steps?.length)).toEqual([0, 1]);
    expect(g.calls[1]!.steps![0]!.results).toEqual([{ id: finish.toolCalls[0]!.id, name: "search_messages", output: { hits: [] } }]);
    expect(g.calls.map((c) => c.tools)).toEqual([[SEARCH], [SEARCH]]);
  });
});
