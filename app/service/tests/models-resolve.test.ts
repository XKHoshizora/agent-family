import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readOwnedAgent } from "../src/agents/store.ts";
import { REASONING_LEVELS } from "../src/config.ts";
import type { ModelEvent } from "../src/models/gateway.ts";
import { resolveModel } from "../src/models/resolve.ts";
import { api, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { CANNED_TEXT, protocolStub, STUB_MODEL, type ProtocolStub } from "./helpers/models.ts";
import { providerBody } from "./helpers/providers.ts";

/** resolveModel: an Agent's model choice as a callable model, or null when there is none to call. */

const { app, db } = useApp({ env: SITE_ENV, allowInsecureLocal: true });
const config = () => app.deps.config;

let stub: ProtocolStub;
beforeAll(async () => {
  stub = await protocolStub();
});
afterAll(async () => {
  await stub.close();
});

async function agentWith(owner: Actor, over: Record<string, unknown>) {
  const created = await mustCreateAgent(app, owner, over);
  const row = await readOwnedAgent(db, owner.id, created.id);
  if (!row) throw new Error("agent not found");
  return row;
}

describe("resolveModel", () => {
  it("is null for an Agent without a model", async () => {
    const owner = await signUp(app, "nadia");
    expect(await resolveModel(db, config(), await agentWith(owner, {}))).toBeNull();
  });

  it("a site model: its upstream and limits, its price and tier, the key read from its variable when called", async () => {
    const owner = await signUp(app, "sami");
    const agent = await agentWith(owner, { model: { source: "site", id: "thinker" }, reasoning: "medium" });
    expect(process.env.UPSTREAM_TEST_KEY).toBe(SITE_ENV.UPSTREAM_TEST_KEY); // useApp's env is the process's while the file runs
    expect(await resolveModel(db, config(), agent)).toEqual({
      source: "site",
      call: { protocol: "anthropic", baseUrl: "https://api.example.test/v1", apiKey: SITE_ENV.UPSTREAM_TEST_KEY, model: "think-1", maxOutputTokens: 8192 },
      contextTokens: 200000,
      vision: true,
      pdf: true,
      reasoningAllowed: ["none", "low", "medium"],
      price: { inputMicroPerToken: 3, outputMicroPerToken: 6 },
      tier: "paid",
    });

    const fast = await resolveModel(db, config(), await agentWith(owner, { model: { source: "site", id: "fast" } }));
    expect(fast).toMatchObject({ source: "site", tier: "free", vision: false, pdf: false, reasoningAllowed: ["none"], call: { protocol: "openai_chat", model: "fast-1" } });

    const saved = process.env.UPSTREAM_TEST_KEY;
    try {
      process.env.UPSTREAM_TEST_KEY = "rotated-upstream-key";
      expect((await resolveModel(db, config(), agent))?.call.apiKey).toBe("rotated-upstream-key");
      delete process.env.UPSTREAM_TEST_KEY;
      expect(await resolveModel(db, config(), agent)).toBeNull();
    } finally {
      process.env.UPSTREAM_TEST_KEY = saved;
    }
  });

  it("is null for a site model that is no longer configured", async () => {
    const owner = await signUp(app, "tara");
    const agent = await agentWith(owner, { model: { source: "site", id: "thinker" } });
    const without = { ...config(), siteModels: config().siteModels.filter((m) => m.id !== "thinker") };
    expect(await resolveModel(db, without, agent)).toBeNull();
  });

  it("a provider model: the owner's provider with its key opened, the model's flags, the default output limit, no price", async () => {
    const owner = await signUp(app, "ugo");
    const models = [
      { name: "deep", vision: true, pdf: false, reasoning: true, contextTokens: 50000 },
      { name: "plain", vision: false, pdf: true, reasoning: false, contextTokens: 8000 },
    ];
    const provider = (await api(app, owner, "POST", "/api/providers", providerBody({ protocol: "gemini", apiKey: "gm-key-0123456789", models }))).json;
    const deep = await agentWith(owner, { model: { source: "provider", providerId: provider.id, model: "deep" }, reasoning: "xhigh" });
    expect(await resolveModel(db, config(), deep)).toEqual({
      source: "provider",
      call: { protocol: "gemini", baseUrl: "https://api.example.com/v1", apiKey: "gm-key-0123456789", model: "deep", maxOutputTokens: config().providerDefaultMaxOutputTokens },
      contextTokens: 50000,
      vision: true,
      pdf: false,
      reasoningAllowed: REASONING_LEVELS,
    });
    const plain = await agentWith(owner, { model: { source: "provider", providerId: provider.id, model: "plain" } });
    expect(await resolveModel(db, config(), plain)).toMatchObject({ contextTokens: 8000, vision: false, pdf: true, reasoningAllowed: ["none"] });

    // The model taken off the provider's list: nothing to call.
    await api(app, owner, "PATCH", `/api/providers/${provider.id}`, { models: [models[1]] });
    expect(await resolveModel(db, config(), deep)).toBeNull();
    expect(await resolveModel(db, config(), plain)).not.toBeNull();
  });

  it("what it resolves is what the app's own gateway (Deps.models) calls, through the guard, the opened key on the wire", async () => {
    const owner = await signUp(app, "xena");
    const created = await api(app, owner, "POST", "/api/providers", providerBody({ protocol: "anthropic", baseUrl: stub.baseUrl, models: [{ name: STUB_MODEL }] }));
    const agent = await agentWith(owner, { model: { source: "provider", providerId: created.json.id, model: STUB_MODEL } });
    const resolved = await resolveModel(db, config(), agent);
    expect(resolved?.call.apiKey).toBe(providerBody().apiKey);
    stub.reset();
    const events: ModelEvent[] = [];
    const call = {
      ...resolved!.call,
      system: "",
      messages: [{ role: "user" as const, parts: [{ type: "text" as const, text: "Hi" }] }],
      reasoning: "none" as const,
      signal: new AbortController().signal,
    };
    for await (const e of app.deps.models.stream(call)) events.push(e);
    expect(events.flatMap((e) => (e.type === "text" ? [e.delta] : [])).join("")).toBe(CANNED_TEXT);
    expect(stub.requests.map((r) => [r.path, r.headers["x-api-key"]])).toEqual([["/v1/messages", providerBody().apiKey]]);
  });

  it("is null when the provider is not the Agent owner's (or gone)", async () => {
    const owner = await signUp(app, "vera");
    const provider = (await api(app, owner, "POST", "/api/providers", providerBody({ models: [{ name: "m" }] }))).json;
    const agent = await agentWith(owner, { model: { source: "provider", providerId: provider.id, model: "m" } });
    const other = await signUp(app, "wim");
    expect(await resolveModel(db, config(), { ...agent, ownerId: other.id })).toBeNull();
    expect(await resolveModel(db, config(), { ...agent, model: { ...agent.model!, providerId: "6a0d4c2e-1b3f-4a5e-9c7d-8e9f0a1b2c3d" } as typeof agent.model })).toBeNull();
  });
});
