// The sync engine's Agent pushes (agent, principal, run, delta) and what every connection loads for Agents.
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyOlder, initial } from "../src/data/model.js";
import { start } from "../src/data/sync.js";
import { toView } from "../src/data/viewmodel.js";
import { ME } from "../src/data/identities.js";
import {
  A1,
  A2,
  AG1,
  AG2,
  ANN,
  D1,
  ME_ID,
  PRINCIPALS,
  agentConv,
  agentOf,
  agentPrincipal,
  apiError,
  deferred,
  direct,
  fakeTimers,
  fakeTransport,
  range,
  runOf,
  settle,
  syncOf,
  wire,
} from "./fixtures.js";

const R1 = "00000000-0000-4000-8000-0000000000e1";
const R2 = "00000000-0000-4000-8000-0000000000e2";
const P1 = "00000000-0000-4000-8000-0000000000f7";
const P0 = "00000000-0000-4000-8000-0000000000f6";

let engines = [];
afterEach(() => {
  for (const e of engines) e.stop();
  engines = [];
});

function run(transport) {
  const box = { model: initial() };
  const timers = fakeTimers();
  const onSignedOut = vi.fn();
  const engine = start(transport, {
    getModel: () => box.model,
    setModel: (m) => {
      box.model = m;
    },
    timers,
    now: timers.now,
    random: () => 0.5,
    onSignedOut,
    onStatus: () => {},
  });
  engines.push(engine);
  return { box, timers, engine, onSignedOut };
}

const card = (seq, status, id = P1) => wire(A1, seq, AG1, "我整理了一份设定，请查看并确认。", { proposal: { id, status, persona: "你是小助手。" } });

/** Two Agents of mine (their conversations A1 and A2) and a direct chat with Ann. */
function agentsSync() {
  const principals = [...PRINCIPALS, agentPrincipal(AG1, "helper", "小助手"), agentPrincipal(AG2, "writer", "写作助手")];
  return syncOf(
    [agentConv(A1, AG1, { lastSeq: 3, readSeq: 3 }), agentConv(A2, AG2), direct(D1, ANN, { lastSeq: 1, readSeq: 1 })],
    [wire(A1, 1, ME_ID, "在吗"), card(2, "open"), card(3, "confirmed", P0), wire(D1, 1, ANN)],
    principals,
  );
}

function agentsTransport(handlers = {}) {
  return fakeTransport({
    sync: agentsSync,
    agents: () => ({ agents: [agentOf(AG1), agentOf(AG2, { handle: "writer", name: "写作助手", conversationId: A2 })] }),
    run: (id) => ({ run: id === A1 ? runOf(R1, "running") : null }),
    ...handlers,
  });
}

const runCalls = (t) => t.agentLog.filter((x) => Array.isArray(x) && x[0] === "run").map((x) => x[1]);

describe("every connection", () => {
  it("first load: the Agents, the run of every Agent conversation once, and the site models", async () => {
    const t = agentsTransport({
      models: () => ({ siteModels: [{ id: "free-1", label: "免费模型", tier: "free", vision: false, pdf: false, reasoning: [], contextTokens: 32000 }], providerDefaults: { contextTokens: 16000, maxOutputTokens: 2048 } }),
    });
    const { box } = run(t);
    await settle();
    expect(t.log).toEqual(["connect", "sync", "social"]);
    expect(t.agentLog.filter((x) => x === "agents")).toHaveLength(1);
    expect(runCalls(t).sort()).toEqual([A1, A2].sort());
    expect(t.agentLog.filter((x) => x === "models")).toHaveLength(1);
    expect(Object.keys(box.model.agents)).toEqual([AG1, AG2]);
    expect(box.model.runs).toEqual({ [A1]: runOf(R1, "running"), [A2]: null });
    expect(box.model.siteModels.map((m) => m.id)).toEqual(["free-1"]);
    // Nothing on the first load asks for single messages: everything is fresh.
    expect(t.agentLog.some((x) => Array.isArray(x) && x[0] === "message")).toBe(false);
  });

  it("a reconnect clears every stream and asks for the run of each Agent conversation once more; the site models are not asked again", async () => {
    const t = agentsTransport();
    const { box, timers } = run(t);
    await settle();
    t.socket.emit({ type: "delta", conversationId: A1, runId: R1, text: "你好" });
    expect(box.model.streams).toEqual({ [R1]: { text: "你好", reasoning: "" } });

    t.handlers.run = (id) => ({ run: id === A1 ? runOf(R1, "running") : runOf(R2, "failed", { error: "busy", retryable: true }) });
    const held = deferred();
    t.handlers.sync = () => held.promise;
    t.socket.drop(1006);
    timers.advance(60_000);
    await settle();
    // Cleared as soon as the new socket opens: no text from before the break is shown again.
    expect(box.model.streams).toEqual({});
    held.resolve(agentsSync());
    await settle();
    expect(runCalls(t).filter((id) => id === A1)).toHaveLength(2);
    expect(runCalls(t).filter((id) => id === A2)).toHaveLength(2);
    expect(box.model.runs[A2]).toMatchObject({ id: R2, status: "failed" });
    expect(t.agentLog.filter((x) => x === "agents")).toHaveLength(2);
    expect(t.agentLog.filter((x) => x === "models")).toHaveLength(1);
    // The run is still going: its next pieces show from here on.
    t.socket.emit({ type: "delta", conversationId: A1, runId: R1, text: "呀" });
    expect(box.model.streams).toEqual({ [R1]: { text: "呀", reasoning: "" } });
  });

  it("an Agent conversation that appears in a later sync (an Agent made in another tab) has its run and its Agent loaded", async () => {
    const t = fakeTransport({ sync: () => syncOf([direct(D1, ANN)]) });
    const { box } = run(t);
    await settle();
    expect(runCalls(t)).toEqual([]);
    expect(t.agentLog.filter((x) => x === "agents")).toHaveLength(1);
    t.handlers.sync = agentsSync;
    t.handlers.agents = () => ({ agents: [agentOf(AG1), agentOf(AG2, { conversationId: A2 })] });
    t.socket.emit({ type: "conversation", id: A2 });
    await settle();
    expect(runCalls(t).sort()).toEqual([A1, A2].sort());
    expect(t.agentLog.filter((x) => x === "agents")).toHaveLength(2);
    expect(Object.keys(box.model.agents)).toEqual([AG1, AG2]);
    // A sync that brings nothing new asks for nothing more.
    t.socket.emit({ type: "message", message: wire("00000000-0000-4000-8000-0000000000c9", 1, ANN) });
    await settle();
    expect(runCalls(t)).toHaveLength(2);
    expect(t.agentLog.filter((x) => x === "agents")).toHaveLength(2);
  });

  it("a failed site-model list keeps what was there and does not stop the connection", async () => {
    const t = agentsTransport({
      models: () => {
        throw apiError(404, "not_found");
      },
    });
    const statuses = [];
    const box = { model: initial() };
    engines.push(start(t, { getModel: () => box.model, setModel: (m) => (box.model = m), timers: fakeTimers(), now: () => 0, random: () => 0.5, onStatus: (s) => statuses.push(s) }));
    await settle();
    expect(statuses.at(-1)).toBe("live");
    expect(box.model.siteModels).toEqual([]);
  });
});

describe("run and delta pushes", () => {
  it("a run push sets the conversation's run; a delta is appended only while that run is running", async () => {
    const t = agentsTransport({ run: () => ({ run: null }) });
    const { box } = run(t);
    await settle();
    t.socket.emit({ type: "delta", conversationId: A1, runId: R1, text: "鬼" });
    expect(box.model.streams).toEqual({});
    t.socket.emit({ type: "run", conversationId: A1, run: runOf(R1, "queued") });
    t.socket.emit({ type: "run", conversationId: A1, run: runOf(R1, "running") });
    t.socket.emit({ type: "delta", conversationId: A1, runId: R1, text: "你", reasoning: "想" });
    t.socket.emit({ type: "delta", conversationId: A1, runId: R1, text: "好" });
    expect(box.model.streams).toEqual({ [R1]: { text: "你好", reasoning: "想" } });
    t.socket.emit({ type: "message", message: wire(A1, 4, AG1, "你好") });
    expect(box.model.streams).toEqual({});
    t.socket.emit({ type: "run", conversationId: A1, run: runOf(R1, "done") });
    expect(box.model.runs[A1]).toMatchObject({ id: R1, status: "done" });
    t.socket.emit({ type: "delta", conversationId: A1, runId: R1, text: "！" });
    expect(box.model.streams).toEqual({});
  });

  it("malformed run and delta pushes change nothing", async () => {
    const t = agentsTransport();
    const { box } = run(t);
    await settle();
    const before = box.model;
    t.socket.emit({ type: "run", conversationId: A1 });
    t.socket.emit({ type: "run", conversationId: A1, run: { status: "done" } });
    t.socket.emit({ type: "delta", conversationId: A1 });
    t.socket.emit({ type: "principal", id: ANN, avatarVersion: "3" });
    expect(box.model).toBe(before);
  });

  it("gone clears the run and the stream of that conversation", async () => {
    const t = agentsTransport();
    const { box } = run(t);
    await settle();
    t.socket.emit({ type: "delta", conversationId: A1, runId: R1, text: "你" });
    t.socket.emit({ type: "gone", id: A1 });
    expect(box.model.runs[A1]).toBeUndefined();
    expect(box.model.streams).toEqual({});
  });
});

describe("principal pushes (spec 6.11 item 1)", () => {
  /** Every avatar URL of `id` anywhere in the view model. */
  const urlsOf = (model, id) => JSON.stringify(toView(model, { now: 0 })).match(new RegExp(`/api/principals/${id}/avatar[^"]*`, "g")) ?? [];

  it("changes that principal's avatar URL everywhere the view model shows it: a person, an Agent, me", async () => {
    const t = agentsTransport();
    const { box } = run(t);
    await settle();
    expect(urlsOf(box.model, ANN).length).toBeGreaterThan(0);
    t.socket.emit({ type: "principal", id: ANN, avatarVersion: 3 });
    t.socket.emit({ type: "principal", id: AG1, avatarVersion: 2 });
    t.socket.emit({ type: "principal", id: ME_ID, avatarVersion: 5 });
    expect(urlsOf(box.model, ANN).length).toBeGreaterThan(0);
    expect(new Set(urlsOf(box.model, ANN))).toEqual(new Set([`/api/principals/${ANN}/avatar?v=3`]));
    expect(new Set(urlsOf(box.model, AG1))).toEqual(new Set([`/api/principals/${AG1}/avatar?v=2`]));
    expect(new Set(urlsOf(box.model, ME_ID))).toEqual(new Set([`/api/principals/${ME_ID}/avatar?v=5`]));
    const view = toView(box.model, { now: 0 });
    expect(view.people[ANN].avatar).toBe(`/api/principals/${ANN}/avatar?v=3`);
    expect(view.agents[AG1].avatar).toBe(`/api/principals/${AG1}/avatar?v=2`);
    expect(view.people[ME].avatar).toBe(`/api/principals/${ME_ID}/avatar?v=5`);
    // No refetch is needed for it.
    expect(t.log).toEqual(["connect", "sync", "social"]);
  });
});

describe("agent pushes", () => {
  it("refetch that Agent and the proposal cards still open in its conversation — nothing else", async () => {
    const t = agentsTransport();
    const { box } = run(t);
    await settle();
    const before = [...t.log];
    t.handlers.agent = (id) => agentOf(id, { personaVersion: 3, persona: "你是新的小助手。" });
    t.handlers.message = (conversationId, seq) => ({ message: card(seq, "confirmed"), principals: {} });
    t.agentLog.length = 0;
    t.socket.emit({ type: "agent", id: AG1 });
    await settle();
    // Only the open card (seq 2) is asked for again: a confirmed one (seq 3) cannot change any more.
    expect(t.agentLog).toEqual([["agent", AG1], ["message", A1, 2]]);
    expect(t.log).toEqual(before);
    expect(box.model.agents[AG1]).toMatchObject({ personaVersion: 3, persona: "你是新的小助手。" });
    expect(box.model.messages[A1].find((m) => m.seq === 2).proposal.status).toBe("confirmed");
  });

  it("an Agent that is not found any more is dropped; another failure refetches the list", async () => {
    const t = agentsTransport();
    const { box } = run(t);
    await settle();
    t.socket.emit({ type: "agent", id: AG2 });
    await settle();
    expect(box.model.agents[AG2]).toBeUndefined();
    t.handlers.agent = () => {
      throw apiError(503, "busy");
    };
    const lists = t.agentLog.filter((x) => x === "agents").length;
    t.socket.emit({ type: "agent", id: AG1 });
    await settle();
    expect(t.agentLog.filter((x) => x === "agents")).toHaveLength(lists + 1);
  });

  it("a reconnect refetches the open cards too (agent pushes are not replayed, and /api/sync has only the newest page)", async () => {
    // A1's newest 30 messages are 11–40; the card at seq 2 was loaded with older history.
    const longSync = () => syncOf([agentConv(A1, AG1, { lastSeq: 40, readSeq: 40 }), agentConv(A2, AG2)], range(A1, 11, 40, [ME_ID, AG1]), agentsSync().principals);
    const t = agentsTransport({ sync: longSync, message: (conversationId, seq) => ({ message: card(seq, "superseded"), principals: {} }) });
    const { box, timers } = run(t);
    await settle();
    box.model = applyOlder(box.model, A1, { messages: [wire(A1, 1, ME_ID, "在吗"), card(2, "open")], nextBefore: null });
    expect(t.agentLog.some((x) => Array.isArray(x) && x[0] === "message")).toBe(false);
    t.socket.drop(1006);
    timers.advance(60_000);
    await settle();
    expect(t.agentLog.filter((x) => Array.isArray(x) && x[0] === "message")).toEqual([["message", A1, 2]]);
    expect(box.model.messages[A1].find((m) => m.seq === 2).proposal.status).toBe("superseded");
  });
});
