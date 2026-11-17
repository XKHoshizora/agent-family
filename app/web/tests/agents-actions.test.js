// The Agent, proposal, reply, provider, usage and model actions: what they send, what they keep, what they say.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDataLayer } from "../src/data/store.jsx";
import { toView } from "../src/data/viewmodel.js";
import { ME } from "../src/data/identities.js";
import {
  A1,
  AG1,
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
  fakeFile,
  fakeTimers,
  fakeTransport,
  notice,
  runOf,
  settle,
  syncOf,
  wire,
} from "./fixtures.js";

const NOW = new Date(2026, 10, 16, 12, 0).getTime();
const KEY = "sk-live-0123456789abcdefWXYZ";
const PID = "00000000-0000-4000-8000-0000000000aa";
const P1 = "00000000-0000-4000-8000-0000000000f7";
const R1 = "00000000-0000-4000-8000-0000000000e1";
const R2 = "00000000-0000-4000-8000-0000000000e2";

const provider = (fields = {}) => ({
  id: PID,
  name: "我的 OpenAI",
  protocol: "openai_chat",
  baseUrl: "https://api.example.com/v1",
  keyLast4: "WXYZ",
  models: [{ name: "gpt-x", vision: false, pdf: false, reasoning: false, contextTokens: 16000 }],
  ...fields,
});

const card = (status) => wire(A1, 3, AG1, "我整理了一份设定，请查看并确认。", { proposal: { id: P1, status, persona: "你是小助手。" } });

function agentSync() {
  return syncOf(
    [agentConv(A1, AG1, { lastSeq: 3, readSeq: 3 }), direct(D1, ANN)],
    [wire(A1, 1, AG1, "你好，我是小助手"), wire(A1, 2, ME_ID, "在吗"), card("open")],
    [...PRINCIPALS, agentPrincipal()],
  );
}

let layers = [];
afterEach(() => {
  for (const l of layers) l.stop();
  layers = [];
});

const conversationOf = (id) => {
  const found = agentSync().conversations.find((c) => c.id === id);
  if (!found) throw apiError(404, "not_found");
  return found;
};

async function loaded({ api = {}, transport } = {}) {
  const t = transport ?? fakeTransport({ sync: agentSync, agents: () => ({ agents: [agentOf()] }), conversation: conversationOf });
  const layer = createDataLayer({ transport: t, api, timers: fakeTimers(), now: () => NOW, random: () => 0.5, uuid: () => "tx-1" });
  layers.push(layer);
  // Every model the layer ever shows, serialised (a key must never reach any of them).
  const shown = [];
  layer.subscribe(() => shown.push(JSON.stringify(layer.getSnapshot().model)));
  layer.start();
  await settle();
  const model = () => layer.getSnapshot().model;
  const view = () => toView(model(), { now: NOW });
  return { layer, actions: layer.actions, transport: t, model, view, shown };
}

describe("providers: the API key is sent once and kept nowhere", () => {
  it("createProvider sends the key, keeps the provider without it, and resolves without it", async () => {
    const createProvider = vi.fn(async () => provider());
    const { actions, model, shown } = await loaded({ api: { createProvider } });
    const fields = { name: "我的 OpenAI", protocol: "openai_chat", baseUrl: "https://api.example.com/v1", apiKey: KEY };
    const result = await actions.createProvider(fields);
    expect(createProvider).toHaveBeenCalledWith({ name: "我的 OpenAI", protocol: "openai_chat", baseUrl: "https://api.example.com/v1", apiKey: KEY });
    expect(result).toEqual({ ok: true, value: provider() });
    expect(model().providers[PID]).toEqual(provider());
    expect(JSON.stringify(result)).not.toContain(KEY);
    expect(JSON.stringify(model())).not.toContain(KEY);
    expect(shown.length).toBeGreaterThan(0);
    for (const snapshot of shown) expect(snapshot).not.toContain(KEY);
    expect(JSON.stringify(toView(model(), { now: NOW }))).not.toContain(KEY);
  });

  it("an answer that (wrongly) echoed the key is still kept and resolved without it", async () => {
    const { actions, model, shown } = await loaded({ api: { createProvider: vi.fn(async () => ({ ...provider(), apiKey: KEY })) } });
    const result = await actions.createProvider({ name: "x", protocol: "anthropic", baseUrl: "https://a.example", apiKey: KEY });
    expect(JSON.stringify(result)).not.toContain(KEY);
    for (const snapshot of [...shown, JSON.stringify(model())]) expect(snapshot).not.toContain(KEY);
  });

  it("patchProvider with a new key: the same; a refusal resolves to its sentence and holds no key either", async () => {
    const patchProvider = vi.fn(async () => provider({ keyLast4: "9999" }));
    const { actions, model, shown } = await loaded({ api: { patchProvider, createProvider: vi.fn(async () => Promise.reject(apiError(409, "name_taken"))) } });
    const patched = await actions.patchProvider(PID, { apiKey: KEY, baseUrl: "https://other.example.com" });
    expect(patchProvider).toHaveBeenCalledWith(PID, { apiKey: KEY, baseUrl: "https://other.example.com" });
    expect(patched).toEqual({ ok: true, value: provider({ keyLast4: "9999" }) });
    const refused = await actions.createProvider({ name: "我的 OpenAI", protocol: "openai_chat", baseUrl: "https://api.example.com/v1", apiKey: KEY });
    expect(refused).toEqual({ ok: false, error: { code: "name_taken", reason: null, status: 409 }, text: "你已经有一个同名的供应商了，请换个名称。" });
    for (const snapshot of [...shown, JSON.stringify(model()), JSON.stringify(refused), JSON.stringify(patched)]) expect(snapshot).not.toContain(KEY);
  });
});

describe("providers: the other actions", () => {
  it("loadProviders, testProvider, refreshProviderModels and deleteProvider", async () => {
    const api = {
      listProviders: vi.fn(async () => ({ providers: [provider()] })),
      testProvider: vi.fn(async () => ({ ok: false, error: "provider_rejected" })),
      refreshProviderModels: vi.fn(async () => ({ listed: ["gpt-x", "gpt-y"], provider: provider({ models: [] }) })),
      deleteProvider: vi.fn(async () => Promise.reject(apiError(409, "provider_in_use", null, { agents: [{ id: AG1, name: "小助手" }, { id: "x", name: "写作助手" }] }))),
    };
    const { actions, model } = await loaded({ api });
    await expect(actions.loadProviders()).resolves.toMatchObject({ ok: true });
    expect(Object.keys(model().providers)).toEqual([PID]);
    await expect(actions.testProvider(PID)).resolves.toEqual({ ok: false, error: { code: "provider_rejected", reason: null, status: 200 }, text: "供应商拒绝了这个密钥，请检查密钥是否正确。" });
    api.testProvider.mockResolvedValueOnce({ ok: true });
    await expect(actions.testProvider(PID)).resolves.toEqual({ ok: true, value: { ok: true } });
    await expect(actions.refreshProviderModels(PID)).resolves.toEqual({ ok: true, value: { listed: ["gpt-x", "gpt-y"], provider: provider({ models: [] }) } });
    expect(model().providers[PID].models).toEqual([]);
    const inUse = await actions.deleteProvider(PID);
    expect(inUse.text).toBe("还有 Agent 在使用这个供应商：小助手、写作助手。请先给它们换一个模型。");
    expect(model().providers[PID]).toBeDefined();
    api.deleteProvider.mockResolvedValueOnce({ ok: true });
    await expect(actions.deleteProvider(PID)).resolves.toMatchObject({ ok: true });
    expect(model().providers[PID]).toBeUndefined();
  });
});

describe("Agents", () => {
  it("createAgent keeps the new Agent and loads its conversation; a refusal resolves to the sentence for its code", async () => {
    const createAgent = vi.fn(async () => agentOf(AG1, { name: "新助手" }));
    const { actions, model, transport } = await loaded({ api: { createAgent } });
    const syncs = transport.log.filter((x) => x === "sync").length;
    const body = { handle: "helper", name: "新助手", persona: "你是新助手。", model: { source: "site", id: "free-1" } };
    await expect(actions.createAgent(body)).resolves.toEqual({ ok: true, value: agentOf(AG1, { name: "新助手" }) });
    expect(createAgent).toHaveBeenCalledWith(body);
    expect(model().agents[AG1].name).toBe("新助手");
    await settle();
    expect(transport.log.filter((x) => x === "sync")).toHaveLength(syncs + 1);

    createAgent.mockRejectedValueOnce(apiError(409, "handle_taken"));
    await expect(actions.createAgent(body)).resolves.toMatchObject({ ok: false, error: { code: "handle_taken" }, text: "这个账号名已被占用，请换一个。" });
    createAgent.mockRejectedValueOnce(apiError(403, "agent_limit"));
    await expect(actions.createAgent(body)).resolves.toMatchObject({ ok: false, text: "你的 Agent 数量已达到当前档位的上限。" });
    createAgent.mockRejectedValueOnce(apiError(418, "something_new"));
    await expect(actions.createAgent(body)).resolves.toMatchObject({ ok: false, text: "操作没有成功，请稍后再试。" });
  });

  it("patch, pause, resume and delete apply the answer and refresh the conversation", async () => {
    const api = {
      patchAgent: vi.fn(async (id, patch) => agentOf(id, patch)),
      pauseAgent: vi.fn(async (id) => agentOf(id, { paused: true })),
      resumeAgent: vi.fn(async (id) => agentOf(id, { paused: false })),
      deleteAgent: vi.fn(async (id) => agentOf(id, { deleted: true })),
    };
    const { actions, model, transport } = await loaded({ api });
    await actions.patchAgent(AG1, { name: "改名了" });
    expect(api.patchAgent).toHaveBeenCalledWith(AG1, { name: "改名了" });
    expect(model().agents[AG1].name).toBe("改名了");
    expect(model().principals[AG1].displayName).toBe("改名了");
    await actions.pauseAgent(AG1);
    expect(model().agents[AG1].paused).toBe(true);
    await settle();
    expect(transport.log.at(-1)).toEqual(["conversation", A1]);
    await actions.resumeAgent(AG1);
    expect(model().agents[AG1].paused).toBe(false);
    await actions.deleteAgent(AG1);
    expect(model().agents[AG1].deleted).toBe(true);

    api.pauseAgent.mockRejectedValueOnce(apiError(409, "agent_deleted"));
    await expect(actions.pauseAgent(AG1)).resolves.toMatchObject({ ok: false, text: "这个 Agent 已删除。" });
  });

  it("uploadAgentAvatar gives the Agent's avatar URL its next version at once", async () => {
    const uploadAgentAvatar = vi.fn(async () => ({ ok: true }));
    const { actions, view } = await loaded({ api: { uploadAgentAvatar } });
    const file = fakeFile("a.png", 10, "image/png");
    await expect(actions.uploadAgentAvatar(AG1, file)).resolves.toEqual({ ok: true, value: { ok: true } });
    expect(uploadAgentAvatar).toHaveBeenCalledWith(AG1, file);
    expect(view().agents[AG1].avatar).toBe(`/api/principals/${AG1}/avatar?v=1`);
    uploadAgentAvatar.mockRejectedValueOnce(apiError(413, "too_large"));
    await expect(actions.uploadAgentAvatar(AG1, file)).resolves.toMatchObject({ ok: false, text: "头像不能超过 2 MB。" });
  });

  it("draftPersona resolves the persona; no_quota says which allowance ran out and when it comes back", async () => {
    const draftPersona = vi.fn(async () => ({ persona: "你是旅行助手。" }));
    const { actions } = await loaded({ api: { draftPersona } });
    const body = { name: "旅行助手", intro: "规划行程", model: { source: "site", id: "free-1" } };
    await expect(actions.draftPersona(body)).resolves.toEqual({ ok: true, value: { persona: "你是旅行助手。" } });
    expect(draftPersona).toHaveBeenCalledWith(body);
    // The next midnight of the site, shown in local time.
    const resetsAt = new Date(2026, 10, 17, 0, 0).toISOString();
    draftPersona.mockRejectedValueOnce(apiError(402, "no_quota", "free_and_balance", { resetsAt }));
    await expect(actions.draftPersona(body)).resolves.toMatchObject({
      ok: false,
      error: { code: "no_quota", reason: "free_and_balance", resetsAt },
      text: "今天的免费额度和余额都已用完，免费额度将在明天 00:00 重置。",
    });
    draftPersona.mockRejectedValueOnce(apiError(402, "no_quota", "balance"));
    await expect(actions.draftPersona(body)).resolves.toMatchObject({ ok: false, text: "余额不足：这个模型需要余额才能使用。" });
  });

  it("loadAgents replaces the list", async () => {
    const { actions, model } = await loaded({ api: { listAgents: vi.fn(async () => ({ agents: [] })) } });
    await expect(actions.loadAgents()).resolves.toMatchObject({ ok: true });
    expect(model().agents).toEqual({});
  });
});

describe("persona proposals (Review Focus 4)", () => {
  it("confirming applies the Agent and marks the card at once", async () => {
    const confirmProposal = vi.fn(async () => agentOf(AG1, { persona: "你是小助手。", personaVersion: 1 }));
    const { actions, model } = await loaded({ api: { confirmProposal } });
    await expect(actions.confirmProposal(AG1, P1, { persona: "你是小助手。" })).resolves.toMatchObject({ ok: true });
    expect(confirmProposal).toHaveBeenCalledWith(AG1, P1, { persona: "你是小助手。" });
    expect(model().agents[AG1].personaVersion).toBe(1);
    expect(model().messages[A1].find((m) => m.seq === 3).proposal.status).toBe("confirmed");
  });

  it("a stale proposal says so and fetches the Agent and the card again (once, no loop)", async () => {
    const t = fakeTransport({
      sync: agentSync,
      agents: () => ({ agents: [agentOf()] }),
      agent: (id) => agentOf(id, { personaVersion: 2 }),
      message: () => ({ message: card("superseded"), principals: {} }),
    });
    const confirmProposal = vi.fn(async () => Promise.reject(apiError(409, "stale_proposal")));
    const { actions, model } = await loaded({ api: { confirmProposal }, transport: t });
    t.agentLog.length = 0;
    await expect(actions.confirmProposal(AG1, P1)).resolves.toMatchObject({ ok: false, text: "这份提议已失效，请让它重新生成提议。" });
    expect(confirmProposal).toHaveBeenCalledWith(AG1, P1, undefined);
    await settle();
    expect(t.agentLog).toEqual([["agent", AG1], ["message", A1, 3]]);
    expect(model().messages[A1].find((m) => m.seq === 3).proposal.status).toBe("superseded");
    expect(confirmProposal).toHaveBeenCalledTimes(1);
  });

  it("discarding marks the card discarded", async () => {
    const discardProposal = vi.fn(async () => ({ ok: true }));
    const { actions, model } = await loaded({ api: { discardProposal } });
    await expect(actions.discardProposal(AG1, P1)).resolves.toEqual({ ok: true, value: { ok: true } });
    expect(discardProposal).toHaveBeenCalledWith(AG1, P1);
    expect(model().messages[A1].find((m) => m.seq === 3).proposal.status).toBe("discarded");
  });
});

describe("replies", () => {
  async function failedRun(api) {
    const t = fakeTransport({ sync: agentSync, agents: () => ({ agents: [agentOf()] }), run: () => ({ run: runOf(R1, "failed", { error: "provider_unavailable", retryable: true }) }) });
    return loaded({ api, transport: t });
  }

  it("retryRun replaces the failed run with the new one; busy_run says why", async () => {
    const retryRun = vi.fn(async () => ({ run: runOf(R2, "queued") }));
    const { actions, model } = await failedRun({ retryRun });
    await expect(actions.retryRun(A1)).resolves.toMatchObject({ ok: true, value: { run: runOf(R2, "queued") } });
    expect(retryRun).toHaveBeenCalledWith(A1);
    expect(model().runs[A1]).toMatchObject({ id: R2, status: "queued" });
    retryRun.mockRejectedValueOnce(apiError(409, "busy_run"));
    await expect(actions.retryRun(A1)).resolves.toMatchObject({ ok: false, text: "它正在回复，请等这次回复结束。" });
  });

  it("a retry answer that arrives after a newer run was pushed changes nothing", async () => {
    const answer = deferred();
    const { actions, model, transport } = await failedRun({ retryRun: vi.fn(() => answer.promise) });
    const retrying = actions.retryRun(A1);
    transport.socket.emit({ type: "run", conversationId: A1, run: runOf(R2, "running") });
    answer.resolve({ run: runOf(R2, "queued") });
    await retrying;
    expect(model().runs[A1]).toMatchObject({ id: R2, status: "running" });
  });

  it("dismissRun clears the failure; stopRun stops the current run; both say why when refused", async () => {
    const api = { dismissRun: vi.fn(async () => ({ ok: true })), stopRun: vi.fn(async () => ({ ok: true })) };
    const { actions, model, transport } = await failedRun(api);
    await expect(actions.dismissRun(A1)).resolves.toMatchObject({ ok: true });
    expect(api.dismissRun).toHaveBeenCalledWith(A1);
    expect(model().runs[A1]).toBeNull();
    transport.socket.emit({ type: "run", conversationId: A1, run: runOf(R2, "running") });
    await expect(actions.stopRun(A1)).resolves.toMatchObject({ ok: true });
    expect(api.stopRun).toHaveBeenCalledWith(A1, R2);
    // Nothing to stop: no request.
    transport.socket.emit({ type: "run", conversationId: A1, run: runOf(R2, "stopped") });
    await expect(actions.stopRun(A1)).resolves.toMatchObject({ ok: false, error: { code: "no_run" }, text: "现在没有正在进行的回复。" });
    expect(api.stopRun).toHaveBeenCalledTimes(1);
    // A 404 there is not "it has ended": the conversation or the run is not mine to act on.
    transport.socket.emit({ type: "run", conversationId: A1, run: runOf("00000000-0000-4000-8000-0000000000e3", "running") });
    api.stopRun.mockRejectedValueOnce(apiError(404, "not_found"));
    await expect(actions.stopRun(A1)).resolves.toMatchObject({ ok: false, text: "找不到要操作的内容，它可能已经不存在了。" });
  });

  it("a dismissed failure stays dismissed when a GET .../run already on its way answers with it (M3)", async () => {
    const failedR1 = runOf(R1, "failed", { error: "provider_unavailable", retryable: true });
    const t = fakeTransport({ sync: agentSync, agents: () => ({ agents: [agentOf()] }), conversation: conversationOf, run: () => ({ run: failedR1 }) });
    const api = { dismissRun: vi.fn(async () => ({ ok: true })), retryRun: vi.fn(async () => Promise.reject(apiError(409, "busy_run"))) };
    const { actions, model, transport } = await loaded({ api, transport: t });
    expect(model().runs[A1]).toMatchObject({ id: R1, status: "failed" });
    // A refused retry asks for the run again; that answer is held back until after the dismissal.
    const late = deferred();
    transport.handlers.run = () => late.promise;
    await actions.retryRun(A1);
    await settle();
    await expect(actions.dismissRun(A1)).resolves.toMatchObject({ ok: true });
    expect(model().runs[A1]).toBeNull();
    late.resolve({ run: failedR1 });
    await settle();
    expect(model().runs[A1]).toBeNull();
    // A newer run is shown as usual.
    transport.socket.emit({ type: "run", conversationId: A1, run: runOf(R2, "queued") });
    expect(model().runs[A1]).toMatchObject({ id: R2, status: "queued" });
  });

  it("resetTopic shows the notice at once", async () => {
    const topic = notice(A1, 4, "Mei 开始了新话题，之前的对话不再发给 小助手", { event: "topic_reset", actorId: ME_ID });
    const resetTopic = vi.fn(async () => ({ message: topic }));
    const { actions, view } = await loaded({ api: { resetTopic } });
    await expect(actions.resetTopic(A1)).resolves.toMatchObject({ ok: true });
    expect(view().convs[A1].messages.at(-1)).toMatchObject({ seq: 4, kind: "system", text: "你开始了新话题，之前的对话不再发给小助手" });
    resetTopic.mockRejectedValueOnce(apiError(403, "cannot_send", "agent_deleted"));
    await expect(actions.resetTopic(A1)).resolves.toMatchObject({ ok: false, text: "这个 Agent 已删除，不能再开始新话题。" });
  });
});

describe("usage and site models", () => {
  it("loadUsage and loadModels keep the answers", async () => {
    const usage = { tier: "free", agentLimit: 20, agentCount: 1, balance: "0", free: { allowance: "10", used: "0", resetsAt: "2026-11-16T16:00:00.000Z" }, canStartFreeReply: true, recent: [] };
    const models = { siteModels: [{ id: "paid-1", label: "付费模型", tier: "paid", vision: true, pdf: true, reasoning: ["low", "high"], contextTokens: 200000 }], providerDefaults: { contextTokens: 16000, maxOutputTokens: 2048 } };
    const { actions, model } = await loaded({ api: { getUsage: vi.fn(async () => usage), getModels: vi.fn(async () => models) } });
    await expect(actions.loadUsage()).resolves.toEqual({ ok: true, value: usage });
    expect(model().usage).toEqual(usage);
    await expect(actions.loadModels()).resolves.toMatchObject({ ok: true });
    expect(model().siteModels.map((m) => m.id)).toEqual(["paid-1"]);
  });
});

describe("only the request decides ok or failed (M5)", () => {
  it("a success whose answer cannot be kept still resolves ok, and that state is fetched again", async () => {
    const malformed = { id: AG1, handle: "helper", conversationId: A1 };
    Object.defineProperty(malformed, "name", {
      enumerable: true,
      get() {
        throw new Error("a malformed answer");
      },
    });
    const t = fakeTransport({ sync: agentSync, agents: () => ({ agents: [agentOf()] }), conversation: conversationOf });
    const { actions, transport } = await loaded({ api: { createAgent: vi.fn(async () => malformed) }, transport: t });
    const lists = transport.agentLog.filter((x) => x === "agents").length;
    const syncs = transport.log.filter((x) => x === "sync").length;
    const result = await actions.createAgent({ handle: "helper", name: "小助手" });
    expect(result.ok).toBe(true);
    await settle();
    expect(transport.agentLog.filter((x) => x === "agents")).toHaveLength(lists + 1);
    expect(transport.log.filter((x) => x === "sync")).toHaveLength(syncs + 1);
  });

  it("a provider answer that cannot be kept resolves ok without it, and the providers are fetched again", async () => {
    const listProviders = vi.fn(async () => ({ providers: [provider()] }));
    const bad = { ...provider(), models: "not a list" };
    Object.defineProperty(bad, "models", {
      get() {
        throw new Error("a malformed answer");
      },
    });
    const { actions, model } = await loaded({ api: { createProvider: vi.fn(async () => bad), listProviders } });
    const result = await actions.createProvider({ name: "x", protocol: "anthropic", baseUrl: "https://a.example", apiKey: KEY });
    expect(result).toEqual({ ok: true, value: null });
    await settle();
    expect(listProviders).toHaveBeenCalledTimes(1);
    expect(model().providers[PID]).toEqual(provider());
  });
});

describe("any of them", () => {
  it("a 401 signs out; an answer that arrives after stop() changes nothing", async () => {
    const answer = deferred();
    const { actions, layer, model } = await loaded({ api: { getUsage: vi.fn(() => answer.promise), listProviders: vi.fn(async () => Promise.reject(apiError(401, "unauthenticated"))) } });
    const signedOut = vi.fn();
    layer.onSignedOut(signedOut);
    await actions.loadProviders();
    expect(signedOut).toHaveBeenCalledTimes(1);
    const loading = actions.loadUsage();
    layer.stop();
    answer.resolve({ balance: "1" });
    await loading;
    expect(model().usage).toBeNull();
    expect(toView(model(), { now: NOW }).people[ME]).toBeUndefined();
  });
});
