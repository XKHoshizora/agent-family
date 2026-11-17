// The model's Agent slices: runs and their transient streams, Agents, providers, usage, site models, avatar versions.
import { describe, expect, it } from "vitest";
import * as M from "../src/data/model.js";
import { toView } from "../src/data/viewmodel.js";
import { lastPreview } from "../src/state/selectors.js";
import { A1, A2, AG1, AG2, ANN, D1, ME_ID, PRINCIPALS, agentConv, agentOf, agentPrincipal, direct, notice, runOf, syncOf, wire } from "./fixtures.js";

const NOW = new Date(2026, 10, 16, 12, 0).getTime();
const R1 = "00000000-0000-4000-8000-0000000000e1";
const R2 = "00000000-0000-4000-8000-0000000000e2";
const STRAY = "00000000-0000-4000-8000-0000000000e9";

/** A1 holds the Agent's greeting (seq 1) and my message (seq 2); D1 is a direct chat. */
function loaded({ agents = [agentOf()], extra = [] } = {}) {
  const sync = syncOf(
    [agentConv(A1, AG1, { lastSeq: 2, readSeq: 2 }), direct(D1, ANN), ...extra],
    [wire(A1, 1, AG1, "你好，我是小助手"), wire(A1, 2, ME_ID, "在吗")],
    [...PRINCIPALS, agentPrincipal()],
  );
  return M.applyAgents(M.applySync(M.initial(), sync), agents);
}

const view = (state) => toView(state, { now: NOW });

// The service's pushes of one reply: `running`, three text deltas (the second with reasoning), the stored message, `done`.
const STEPS = {
  running: (s) => M.applyRun(s, A1, runOf(R1, "running")),
  d1: (s) => M.applyDelta(s, { conversationId: A1, runId: R1, text: "你" }),
  d2: (s) => M.applyDelta(s, { conversationId: A1, runId: R1, text: "好", reasoning: "想一想" }),
  d3: (s) => M.applyDelta(s, { conversationId: A1, runId: R1, text: "呀" }),
  message: (s) => M.applyMessage(s, wire(A1, 3, AG1, "你好呀")).state,
  done: (s) => M.applyRun(s, A1, runOf(R1, "done")),
  late: (s) => M.applyDelta(s, { conversationId: A1, runId: R1, text: "！" }),
  stray: (s) => M.applyDelta(s, { conversationId: A1, runId: STRAY, text: "鬼" }),
};

/** Every order of `items` that keeps the deltas (d1, d2, d3) in their own order (the service sends them in order). */
function orders(items) {
  if (items.length === 0) return [[]];
  const isDelta = (step) => /^d\d$/.test(step);
  const out = [];
  items.forEach((item, i) => {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    if (isDelta(item) && rest.some((r) => isDelta(r) && r < item)) return;
    for (const tail of orders(rest)) out.push([item, ...tail]);
  });
  return out;
}

/** The reply's stored message (seq 3) and the stream bubble are never both shown. */
function checkAtMostOne(state, label) {
  const conv = view(state).convs[A1];
  const stored = conv.messages.filter((m) => m.seq === 3).length;
  if (conv.stream) expect(stored, `${label}: bubble and message at once`).toBe(0);
  expect(conv.stream?.text ?? "", label).not.toContain("鬼");
}

describe("a reply's stream (Review Focus 1 and 2)", () => {
  it("shows the stream as one bubble while the run is running", () => {
    let s = loaded();
    for (const step of ["running", "d1", "d2"]) s = STEPS[step](s);
    expect(s.streams).toEqual({ [R1]: { text: "你好", reasoning: "想一想" } });
    expect(view(s).convs[A1].stream).toEqual({ runId: R1, text: "你好", reasoning: "想一想" });
    expect(view(s).convs[A1].run).toMatchObject({ id: R1, status: "running" });
  });

  const tails = orders(["d1", "d2", "d3", "message", "done"]);
  it(`covers every order the service can produce (${tails.length} orders, each with a stray delta anywhere and a late one)`, () => {
    expect(tails).toHaveLength(20);
    let cases = 0;
    for (const tail of tails) {
      for (let at = 0; at <= tail.length + 1; at += 1) {
        const steps = ["running", ...tail, "late"];
        steps.splice(at, 0, "stray");
        let s = loaded();
        for (const step of steps) {
          s = STEPS[step](s);
          checkAtMostOne(s, steps.join(" → "));
        }
        const conv = view(s).convs[A1];
        expect(conv.messages.filter((m) => m.seq === 3), steps.join(" → ")).toHaveLength(1);
        expect(s.streams, steps.join(" → ")).toEqual({});
        expect(conv.stream, steps.join(" → ")).toBeNull();
        expect(conv.run, steps.join(" → ")).toMatchObject({ id: R1, status: "done" });
        cases += 1;
      }
    }
    expect(cases).toBe(20 * 7);
  });

  it("the streamed text never enters the messages, the unread count, the preview or the position", () => {
    let s = loaded();
    const before = view(s).convs[A1];
    for (const step of ["running", "d1", "d2", "d3"]) s = STEPS[step](s);
    const conv = view(s).convs[A1];
    expect(conv.messages.map((m) => m.id)).toEqual(before.messages.map((m) => m.id));
    expect(conv.unread).toBe(before.unread);
    expect(lastPreview(view(s), conv)).toBe("在吗");
    expect(s.conversations[A1].position).toBe(2);
  });

  it("a delta for a queued run, another conversation's run, or a conversation not held is ignored", () => {
    let s = M.applyRun(loaded({ extra: [agentConv(A2, AG2)] }), A1, runOf(R1, "queued"));
    expect(M.applyDelta(s, { conversationId: A1, runId: R1, text: "x" })).toBe(s);
    s = M.applyRun(s, A1, runOf(R1, "running"));
    expect(M.applyDelta(s, { conversationId: A2, runId: R1, text: "x" })).toBe(s);
    expect(M.applyDelta(s, { conversationId: "00000000-0000-4000-8000-0000000000ff", runId: R1, text: "x" })).toBe(s);
    expect(M.applyDelta(s, { conversationId: A1, runId: R1 })).toBe(s);
  });

  it("every terminal status drops the stream; a newer run drops the older run's stream", () => {
    for (const status of ["done", "failed", "stopped", "cancelled"]) {
      let s = STEPS.d1(STEPS.running(loaded()));
      s = M.applyRun(s, A1, runOf(R1, status));
      expect(s.streams, status).toEqual({});
    }
    let s = STEPS.d1(STEPS.running(loaded()));
    s = M.applyRun(s, A1, runOf(R2, "queued"));
    expect(s.streams).toEqual({});
    expect(s.runs[A1]).toMatchObject({ id: R2, status: "queued" });
  });

  it("a run's status never goes back (an HTTP answer that overtook the push), and null means no run to show", () => {
    let s = M.applyRun(loaded(), A1, runOf(R1, "running"));
    expect(M.applyRun(s, A1, runOf(R1, "queued"))).toBe(s);
    s = M.applyRun(s, A1, runOf(R1, "failed", { error: "provider_unavailable", retryable: true }));
    expect(M.applyRun(s, A1, runOf(R1, "running"))).toBe(s);
    expect(M.applyRun(s, A1, null).runs[A1]).toBeNull();
    expect(M.applyRun(s, "00000000-0000-4000-8000-0000000000ff", runOf(R2, "queued"))).toBe(s);
  });

  it("clearStreams forgets every stream (a reconnect) and keeps the runs", () => {
    const s = M.clearStreams(STEPS.d1(STEPS.running(loaded())));
    expect(s.streams).toEqual({});
    expect(s.runs[A1]).toMatchObject({ id: R1, status: "running" });
    expect(M.clearStreams(s)).toBe(s);
  });

  it("gone, or a sync that no longer lists the conversation, clears its run and stream", () => {
    const streaming = STEPS.d1(STEPS.running(loaded()));
    const gone = M.applyGone(streaming, A1);
    expect(gone.runs).toEqual({});
    expect(gone.streams).toEqual({});
    const resynced = M.applySync(streaming, syncOf([direct(D1, ANN)], [], PRINCIPALS));
    expect(resynced.runs).toEqual({});
    expect(resynced.streams).toEqual({});
  });
});

describe("Agents", () => {
  it("applyAgents replaces the list (deleted ones included) and names the Agent's principal as the Agent is named now", () => {
    let s = loaded();
    s = M.applyAgents(s, [agentOf(AG1, { name: "新名字", avatarVersion: 2 }), agentOf(AG2, { deleted: true, conversationId: A2 })]);
    expect(Object.keys(s.agents)).toEqual([AG1, AG2]);
    expect(s.agents[AG2].deleted).toBe(true);
    expect(s.principals[AG1]).toMatchObject({ displayName: "新名字", kind: "agent" });
    expect(s.avatarVersions[AG1]).toBe(2);
    s = M.applyAgents(s, [agentOf(AG1)]);
    expect(Object.keys(s.agents)).toEqual([AG1]);
  });

  it("applyAgent adds or replaces one Agent; its avatar version only goes up; dropAgent forgets it", () => {
    let s = M.applyAgent(loaded(), agentOf(AG1, { avatarVersion: 3, paused: true }));
    expect(s.agents[AG1].paused).toBe(true);
    s = M.applyAgent(s, agentOf(AG1, { avatarVersion: 2 }));
    expect(s.avatarVersions[AG1]).toBe(3);
    s = M.applyAgent(s, agentOf(AG2, { conversationId: A2 }));
    expect(Object.keys(s.agents)).toEqual([AG1, AG2]);
    expect(s.principals[AG2]).toMatchObject({ id: AG2, handle: "helper", displayName: "小助手", kind: "agent" });
    expect(M.dropAgent(s, AG2).agents[AG2]).toBeUndefined();
  });

  it("keeps the conversation's Agent and its paused and deleted flags", () => {
    const s = loaded({ extra: [agentConv(A2, AG2, { agent: { paused: true, deleted: true }, canSend: { ok: false, reason: "agent_deleted" } })] });
    expect(s.conversations[A2]).toMatchObject({ type: "agent", agentId: AG2, agent: { paused: true, deleted: true }, peerId: null });
    expect(s.conversations[D1]).toMatchObject({ agentId: null, agent: null });
  });
});

describe("persona proposal cards", () => {
  const P1 = "00000000-0000-4000-8000-0000000000f7";
  const proposed = (status) => wire(A1, 3, AG1, "我整理了一份设定，请查看并确认。", { proposal: { id: P1, status, persona: "你是小助手。" } });

  it("applyMessageUpdate replaces a held message, never adds one", () => {
    let s = M.applyMessage(loaded(), proposed("open")).state;
    s = M.applyMessageUpdate(s, proposed("superseded"));
    expect(s.messages[A1].find((m) => m.seq === 3).proposal.status).toBe("superseded");
    expect(M.applyMessageUpdate(s, wire(A1, 9, AG1, "x"))).toBe(s);
  });

  /** A1 holds seqs 31–40 (the newest page); a detached window around the old proposal at seq 3 is open. */
  function withWindow() {
    const later = Array.from({ length: 10 }, (_, i) => wire(A1, 31 + i, i % 2 ? AG1 : ME_ID));
    let s = M.applyAgents(M.applySync(M.initial(), syncOf([agentConv(A1, AG1, { lastSeq: 40, readSeq: 40 })], later, [...PRINCIPALS, agentPrincipal()])), [agentOf()]);
    s = M.applyMessage(s, wire(A1, 41, AG1, "新的", { proposal: { id: "p2", status: "open", persona: "y" } })).state;
    return M.openWindow(s, A1, { messages: [wire(A1, 2, ME_ID), proposed("open")], nextBefore: null }, { focusSeq: 3, n: 1 });
  }

  it("applyMessageUpdate also replaces the copy shown in a detached window", () => {
    const s = M.applyMessageUpdate(withWindow(), proposed("stale"));
    expect(s.windows[A1].messages.find((m) => m.seq === 3).proposal.status).toBe("stale");
    expect(s.messages[A1].some((m) => m.seq === 3)).toBe(false);
  });

  it("openProposals lists an Agent's cards still open, held and in a window; other statuses cannot change any more", () => {
    let s = withWindow();
    s = M.applyMessage(s, wire(A1, 42, AG1, "旧的", { proposal: { id: "p0", status: "confirmed", persona: "x" } })).state;
    expect(M.openProposals(s, AG1)).toEqual({ conversationId: A1, seqs: [3, 41] });
    expect(M.openProposals(s, AG2)).toEqual({ conversationId: null, seqs: [] });
  });

  it("setProposalStatus marks one proposal's card", () => {
    const s = M.setProposalStatus(M.applyMessage(loaded(), proposed("open")).state, A1, P1, "confirmed");
    expect(s.messages[A1].find((m) => m.seq === 3).proposal).toEqual({ id: P1, status: "confirmed", persona: "你是小助手。" });
  });
});

describe("a message I made over HTTP (the new-topic notice)", () => {
  it("applyPosted adds it and advances when it is next, and keeps it beyond a gap", () => {
    const topic = notice(A1, 3, "Mei 开始了新话题", { event: "topic_reset", actorId: ME_ID });
    const s = M.applyPosted(loaded(), topic);
    expect(s.messages[A1].map((m) => m.seq)).toEqual([1, 2, 3]);
    expect(s.conversations[A1].position).toBe(3);
    const far = M.applyPosted(loaded(), { ...topic, seq: 5 });
    expect(far.messages[A1].map((m) => m.seq)).toEqual([1, 2, 5]);
    expect(far.conversations[A1].position).toBe(2);
  });
});

describe("providers, usage and site models", () => {
  const provider = (fields = {}) => ({
    id: "00000000-0000-4000-8000-0000000000aa",
    name: "我的 OpenAI",
    protocol: "openai_chat",
    baseUrl: "https://api.example.com/v1",
    keyLast4: "wxyz",
    models: [{ name: "gpt-x", vision: true, pdf: false, reasoning: false, contextTokens: 16000 }],
    ...fields,
  });

  it("keeps only a provider's public fields (never a key, whatever an answer carries)", () => {
    const s = M.applyProvider(M.initial(), provider({ apiKey: "sk-secret-abcdefgh", key: "sk-secret-abcdefgh" }));
    expect(JSON.stringify(s)).not.toContain("sk-secret");
    expect(s.providers["00000000-0000-4000-8000-0000000000aa"]).toEqual(provider());
  });

  it("applyProviders replaces the list in order; removeProvider drops one", () => {
    const B = "00000000-0000-4000-8000-0000000000ab";
    let s = M.applyProviders(M.initial(), [provider(), provider({ id: B, name: "第二个" })]);
    expect(Object.keys(s.providers)).toEqual(["00000000-0000-4000-8000-0000000000aa", B]);
    s = M.removeProvider(s, B);
    expect(Object.keys(s.providers)).toEqual(["00000000-0000-4000-8000-0000000000aa"]);
  });

  it("applyUsage keeps the answer (points stay strings); applyModels keeps the site models and the provider defaults", () => {
    const usage = { tier: "free", agentLimit: 20, agentCount: 1, balance: "12.5", free: { allowance: "10", used: "2.25", resetsAt: "2026-11-16T16:00:00.000Z" }, canStartFreeReply: true, recent: [] };
    expect(M.applyUsage(M.initial(), usage).usage).toEqual(usage);
    const s = M.applyModels(M.initial(), {
      siteModels: [{ id: "free-1", label: "免费模型", tier: "free", vision: false, pdf: false, reasoning: ["low"], contextTokens: 32000, upstream: "secret" }],
      providerDefaults: { contextTokens: 16000, maxOutputTokens: 2048 },
    });
    expect(s.siteModels).toEqual([{ id: "free-1", label: "免费模型", tier: "free", vision: false, pdf: false, reasoning: ["low"], contextTokens: 32000 }]);
    expect(s.providerDefaults).toEqual({ contextTokens: 16000, maxOutputTokens: 2048 });
  });
});

describe("avatar versions", () => {
  it("come from /api/sync (me and every principal) and from principal pushes", () => {
    const sync = syncOf([direct(D1, ANN)], [], [{ ...PRINCIPALS[1], avatarVersion: 4 }, agentPrincipal(AG1)]);
    let s = M.applySync(M.initial(), { ...sync, me: { ...sync.me, avatarVersion: 2 } });
    expect(s.avatarVersions).toMatchObject({ [ME_ID]: 2, [ANN]: 4, [AG1]: 0 });
    s = M.setAvatarVersion(s, ANN, 5);
    expect(s.avatarVersions[ANN]).toBe(5);
  });

  it("bumpAvatar gives my own avatar a new version at once (batch 1), or the next one for an Agent of mine", () => {
    let s = loaded();
    s = M.bumpAvatar(s, NOW);
    expect(s.avatarVersions[ME_ID]).toBe(NOW);
    s = M.bumpAvatar(s, 0, AG1);
    expect(s.avatarVersions[AG1]).toBe(1);
  });
});
