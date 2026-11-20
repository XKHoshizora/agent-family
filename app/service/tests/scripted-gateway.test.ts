import { describe, expect, it } from "vitest";
import { ModelError, type ModelCall, type ModelEvent, type ToolCall, type ToolResult } from "../src/models/gateway.ts";
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
  const READ = { name: "read_file", description: "Read.", parameters: { type: "object", properties: { id: { type: "string" } } } };
  type Finish = Extract<ModelEvent, { type: "finish" }>;
  const finishOf = (events: ModelEvent[]) => events.at(-1) as Finish;
  /** The step that answers `finish`'s calls, as the worker makes it. */
  const answer = (finish: Finish, output: unknown = { hits: [] }) => ({
    assistant: finish.assistant,
    results: finish.toolCalls.map((c) => ({ id: c.id, name: c.name, output })),
  });

  it("callTools: one round that streams its text, then one tool_call per call, then a finish naming them with an opaque assistant turn", async () => {
    const g = scriptedGateway().callTools(
      [
        { name: "search_messages", input: { query: "川菜" } },
        { name: "read_file", input: { id: "f1" } },
      ],
      { text: "Let me look.", usage: { inputTokens: 5, outputTokens: 6 } },
    );
    const { events, error } = await run(g.stream(call({ tools: [SEARCH, READ] })));
    expect(error).toBeNull();
    expect(text(events)).toBe("Let me look.");
    const calls = events.flatMap((e) => (e.type === "tool_call" ? [e.call] : []));
    expect(calls).toEqual([
      { id: expect.any(String), name: "search_messages", input: { query: "川菜" } },
      { id: expect.any(String), name: "read_file", input: { id: "f1" } },
    ]);
    expect(new Set(calls.map((c) => c.id)).size).toBe(2);
    const finish = finishOf(events);
    expect(finish).toEqual({ type: "finish", usage: { inputTokens: 5, outputTokens: 6 }, truncated: false, toolCalls: calls, assistant: expect.anything() });
    // The opaque turn survives a JSON round trip, as the real one does.
    expect(JSON.parse(JSON.stringify(finish.assistant))).toEqual(finish.assistant);

    // The next round answers it (passed back through JSON, as a worker may hold it); its ids are new.
    g.callTools([{ name: "search_messages", input: { query: "火锅" } }]);
    const step = JSON.parse(JSON.stringify(answer(finish)));
    const again = await run(g.stream(call({ tools: [SEARCH, READ], steps: [step] })));
    expect(again.error).toBeNull();
    const [later] = again.events.flatMap((e) => (e.type === "tool_call" ? [e.call] : []));
    expect(calls.map((c) => c.id)).not.toContain(later!.id);
    expect(finishOf(again.events)).toMatchObject({ usage: null, toolCalls: [later] });
  });

  it("callTools takes reasoning first and can end truncated", async () => {
    const g = scriptedGateway().callTools([{ name: "search_messages", input: { query: "a" } }], { reasoning: "hmm", truncated: true });
    const { events } = await run(g.stream(call({ tools: [SEARCH] })));
    expect(events.map((e) => e.type)).toEqual(["reasoning", "tool_call", "finish"]);
    expect(finishOf(events)).toMatchObject({ truncated: true });
  });

  it("the round after a callTools round must answer exactly its calls with its turn passed back, or the call throws as an unscripted one does", async () => {
    const offered = { tools: [SEARCH, READ] };
    const twoCalls = [
      { name: "search_messages", input: { query: "a" } },
      { name: "read_file", input: { id: "f1" } },
    ];
    /** A gateway whose first round made two calls, and that round's finish. */
    const afterRound = async () => {
      const g = scriptedGateway().callTools(twoCalls).reply("done");
      return { g, finish: finishOf((await run(g.stream(call(offered)))).events) };
    };
    /** The next call, its steps made from the round's finish, is refused: it throws, and the scripted answer stays queued. */
    const refused = async (stepsFrom: (finish: Finish) => ModelCall["steps"] | undefined) => {
      const { g, finish } = await afterRound();
      const steps = stepsFrom(finish);
      const { error } = await run(g.stream(call({ ...offered, ...(steps ? { steps } : {}) })));
      expect(String(error)).toMatch(/scriptedGateway: call #2/);
      expect(g.pending()).toBe(1);
    };
    const result = (c: ToolCall, over: Partial<ToolResult> = {}): ToolResult => ({ id: c.id, name: c.name, output: 1, ...over });
    await refused(() => undefined); // no steps at all
    await refused((f) => [{ assistant: f.assistant, results: [result(f.toolCalls[0]!)] }]); // a call left unanswered
    await refused((f) => [{ assistant: f.assistant, results: [result(f.toolCalls[0]!), result(f.toolCalls[1]!, { id: "other" })] }]); // a wrong id
    await refused((f) => [{ assistant: f.assistant, results: [result(f.toolCalls[0]!), result(f.toolCalls[1]!, { name: "search_messages" })] }]); // a wrong name
    await refused((f) => [{ assistant: f.assistant, results: [result(f.toolCalls[0]!), result(f.toolCalls[0]!), result(f.toolCalls[1]!)] }]); // answered twice
    await refused((f) => [{ assistant: [{ role: "assistant", content: [] }], results: answer(f).results }]); // the turn rebuilt
    await refused((f) => [answer(f), answer(f)]); // the same turn sent twice
    await refused((f) => [{ assistant: [{ role: "assistant", content: [{ type: "text", text: "made up" }] }], results: [] }, answer(f)]); // an earlier turn this gateway never gave
    // Answered exactly: the next answer comes.
    const ok = await afterRound();
    const done = await run(ok.g.stream(call({ ...offered, steps: [answer(ok.finish)] })));
    expect(done.error).toBeNull();
    expect(text(done.events)).toBe("done");
  });

  it("a turn mutated in place and passed back is not the turn it gave: the call throws", async () => {
    const g = scriptedGateway().callTools([{ name: "search_messages", input: { query: "a" } }]).reply("done");
    const finish = finishOf((await run(g.stream(call({ tools: [SEARCH] })))).events);
    (finish.assistant as Array<{ content: unknown[] }>)[0]!.content.push({ type: "text", text: "added by the loop" });
    const { error } = await run(g.stream(call({ tools: [SEARCH], steps: [answer(finish)] })));
    expect(String(error)).toMatch(/scriptedGateway: call #2/);
    // The calls it handed out are the caller's to change too: what it checks against is its own copy.
    const h = scriptedGateway().callTools([{ name: "search_messages", input: { query: "a" } }]).reply("done");
    const round = finishOf((await run(h.stream(call({ tools: [SEARCH] })))).events);
    const step = answer(round);
    round.toolCalls[0]!.id = "changed";
    expect((await run(h.stream(call({ tools: [SEARCH], steps: [step] })))).error).toBeNull();
  });

  it("a call with no tools and no steps after a callTools round is answered (a new conversation, or a flattened last call), and that round can no longer be answered", async () => {
    const g = scriptedGateway().callTools([{ name: "search_messages", input: { query: "a" } }]).reply("flattened").reply("too late");
    const finish = finishOf((await run(g.stream(call({ tools: [SEARCH] })))).events);
    const flat = await run(g.stream(call()));
    expect(flat.error).toBeNull();
    expect(text(flat.events)).toBe("flattened");
    const late = await run(g.stream(call({ tools: [SEARCH], steps: [answer(finish)] })));
    expect(String(late.error)).toMatch(/scriptedGateway: call #3/);
    expect(g.pending()).toBe(1);
  });

  it("steps must be this run's rounds, all of them, in the order given: reordered, one dropped, or the last left out after a failed call, the call throws", async () => {
    /** Two callTools rounds of one run, then two scripted answers; both rounds' finishes. */
    const twoRounds = async () => {
      const g = scriptedGateway()
        .callTools([{ name: "search_messages", input: { query: "a" } }])
        .callTools([{ name: "search_messages", input: { query: "b" } }])
        .reply("done")
        .reply("again");
      const one = finishOf((await run(g.stream(call({ tools: [SEARCH] })))).events);
      const two = finishOf((await run(g.stream(call({ tools: [SEARCH], steps: [answer(one)] })))).events);
      expect(two.toolCalls).toHaveLength(1);
      return { g, one, two };
    };
    {
      const { g, one, two } = await twoRounds();
      expect(String((await run(g.stream(call({ tools: [SEARCH], steps: [answer(two), answer(one)] })))).error)).toMatch(/call #3/); // reordered
      expect(String((await run(g.stream(call({ tools: [SEARCH], steps: [answer(two)] })))).error)).toMatch(/call #4/); // the first round dropped
      expect(text((await run(g.stream(call({ tools: [SEARCH], steps: [answer(one), answer(two)] })))).events)).toBe("done");
    }
    {
      const { g, one, two } = await twoRounds();
      // A call that fails the check, then a "corrected" one that leaves out the last round: still held to it.
      expect(String((await run(g.stream(call({ tools: [SEARCH], steps: [answer(one), { assistant: two.assistant, results: [] }] })))).error)).toMatch(/call #3/);
      expect(String((await run(g.stream(call({ tools: [SEARCH], steps: [answer(one)] })))).error)).toMatch(/call #4/);
      expect(text((await run(g.stream(call({ tools: [SEARCH], steps: [answer(one), answer(two)] })))).events)).toBe("done");
      // A run that ended is over: a new one starts with no steps, and the old rounds are not its rounds.
      expect((await run(g.stream(call({ tools: [SEARCH] })))).error).toBeNull();
      g.reply("never");
      expect(String((await run(g.stream(call({ tools: [SEARCH], steps: [answer(one), answer(two)] })))).error)).toMatch(/call #7/);
    }
  });

  it("callTools on a call that offered no tools throws; a name it did not offer arrives with input null", async () => {
    const none = scriptedGateway().callTools([{ name: "search_messages", input: { query: "a" } }]);
    expect(String((await run(none.stream(call()))).error)).toMatch(/scriptedGateway: call #1 .*offered no tools/);
    const g = scriptedGateway().callTools([
      { name: "search_messages", input: { query: "a" } },
      { name: "delete_everything", input: { all: true } },
    ]);
    const { events } = await run(g.stream(call({ tools: [SEARCH] })));
    expect(finishOf(events).toolCalls.map((c) => [c.name, c.input])).toEqual([
      ["search_messages", { query: "a" }],
      ["delete_everything", null],
    ]);
  });

  it("refuseTools: the round answers with text and reports toolsRefused when the call offered tools", async () => {
    const g = scriptedGateway().refuseTools("answered without tools", { usage: { inputTokens: 1, outputTokens: 2 } }).refuseTools().refuseTools("no tools here");
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
    // A call that offered none: tools were not refused, they were never there.
    const third = await run(g.stream(call()));
    expect(text(third.events)).toBe("no tools here");
    expect(third.events.at(-1)).not.toHaveProperty("toolsRefused");
    // A plain reply reports nothing of the kind.
    g.reply("plain");
    expect((await run(g.stream(call({ tools: [SEARCH] })))).events.at(-1)).not.toHaveProperty("toolsRefused");
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
