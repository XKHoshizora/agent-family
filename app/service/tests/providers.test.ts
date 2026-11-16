import type { InjectOptions } from "fastify";
import { describe, expect, it } from "vitest";
import { loadProviderForCall } from "../src/providers/store.ts";
import { api, signUp, type Actor } from "./helpers/actors.ts";
import { createAgent, mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { providerBody, useProviderStub } from "./helpers/providers.ts";

const stub = useProviderStub();
const { app, db } = useApp({ env: SITE_ENV, allowInsecureLocal: true });

const RANDOM = "6a0d4c2e-1b3f-4a5e-9c7d-8e9f0a1b2c3d";
const secret = () => app.deps.config.providerKeySecret;

const create = (who: Actor, over: Record<string, unknown> = {}) => api(app, who, "POST", "/api/providers", providerBody(over));
async function mustCreate(who: Actor, over: Record<string, unknown> = {}) {
  const res = await create(who, over);
  if (res.status !== 201) throw new Error(`create provider: ${res.status} ${JSON.stringify(res.json)}`);
  return res.json;
}
const model = (name: string, over: Record<string, unknown> = {}) => ({ name, vision: false, pdf: false, reasoning: false, contextTokens: 16000, ...over });
const useModel = (providerId: string, name: string) => ({ source: "provider", providerId, model: name });

describe("creating and reading providers", () => {
  it("answers the Provider: the baseUrl normalised, the key's last four, models with conservative defaults", async () => {
    const owner = await signUp(app, "olga");
    const res = await create(owner, {
      name: " Home lab ",
      baseUrl: "https://API.Example.com:443/v1/?x=1#frag",
      apiKey: "  sk-live-abcdef-WXYZ1234\n",
      models: [{ name: "gpt-x" }, { name: "deep", vision: true, pdf: true, reasoning: true, contextTokens: 200000 }],
    });
    expect(res.status).toBe(201);
    expect(res.json).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      name: "Home lab",
      protocol: "openai_chat",
      baseUrl: "https://api.example.com/v1",
      keyLast4: "1234",
      models: [model("gpt-x"), model("deep", { vision: true, pdf: true, reasoning: true, contextTokens: 200000 })],
    });
    expect(await api(app, owner, "GET", "/api/providers")).toEqual({ status: 200, json: { providers: [res.json] } });

    expect(await loadProviderForCall(db, owner.id, res.json.id, secret())).toEqual({
      protocol: "openai_chat",
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-live-abcdef-WXYZ1234",
      models: res.json.models,
    });
    const other = await signUp(app, "otto");
    expect(await loadProviderForCall(db, other.id, res.json.id, secret())).toBeNull();
    expect(await loadProviderForCall(db, owner.id, RANDOM, secret())).toBeNull();
  });

  it("lists only the caller's providers, oldest first", async () => {
    const [a, b] = [await signUp(app, "ann"), await signUp(app, "ben")];
    const first = await mustCreate(a, { name: "first" });
    await mustCreate(b, { name: "theirs" });
    const second = await mustCreate(a, { name: "second", protocol: "gemini" });
    expect((await api(app, a, "GET", "/api/providers")).json.providers.map((p: any) => p.id)).toEqual([first.id, second.id]);
  });

  it("refuses what does not fit (400) and accepts the boundaries", async () => {
    const owner = await signUp(app, "vlad");
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `m${i}` }));
    const bad: Array<Record<string, unknown>> = [
      { name: "" },
      { name: "x".repeat(41) },
      { name: "two\nlines" },
      { protocol: "openai" },
      { protocol: undefined },
      { baseUrl: "ftp://api.example.com/v1" },
      { baseUrl: "https://user:pw@api.example.com/v1" },
      { baseUrl: "https://exa_mple.com/v1" },
      { baseUrl: "not a url" },
      { baseUrl: `https://api.example.com/${"p".repeat(1000)}` },
      { baseUrl: undefined },
      { apiKey: undefined },
      { apiKey: "short" },
      { apiKey: "has a space in it" },
      { apiKey: "ключ-не-ascii-1234" },
      { apiKey: "x".repeat(1001) },
      { models: many(101) },
      { models: [{ name: "x".repeat(101) }] },
      { models: [{ name: "" }] },
      { models: [{ name: "a\u0000b" }] },
      { models: [{ name: "same" }, { name: "same" }] },
      { models: [{ name: "m", contextTokens: 999 }] },
      { models: [{ name: "m", contextTokens: 2_000_001 }] },
      { models: [{ name: "m", contextTokens: 1500.5 }] },
      { models: [{ name: "m", vision: "yes" }] },
      { models: [{ name: "m", extra: 1 }] },
      { models: "m1,m2" },
      { keyLast4: "1234" },
      { ownerId: owner.id },
    ];
    for (const over of bad) expect([over, (await create(owner, over)).status]).toEqual([over, 400]);
    expect((await api(app, owner, "GET", "/api/providers")).json.providers).toEqual([]);

    const edge = await create(owner, {
      name: "x".repeat(40),
      apiKey: "12345678",
      models: [
        { name: "y".repeat(100), contextTokens: 1000 },
        { name: "z", contextTokens: 2_000_000 },
        ...many(98),
      ],
    });
    expect(edge.status).toBe(201);
    expect(edge.json.models).toHaveLength(100);
    expect(edge.json.keyLast4).toBe("5678");
  });

  it("allows 10 providers per user; the 11th is 400 provider_limit; others are unaffected", async () => {
    const [a, b] = [await signUp(app, "max"), await signUp(app, "mia")];
    for (let i = 1; i <= 10; i++) await mustCreate(a, { name: `p${i}` });
    expect(await create(a, { name: "p11" })).toEqual({ status: 400, json: { error: "provider_limit" } });
    expect((await create(b, { name: "p1" })).status).toBe(201);
    // Deleting one makes room again.
    const list = (await api(app, a, "GET", "/api/providers")).json.providers;
    expect(list).toHaveLength(10);
    expect((await api(app, a, "DELETE", `/api/providers/${list[0].id}`)).status).toBe(200);
    expect((await create(a, { name: "p11" })).status).toBe(201);
  });

  it("ten concurrent creates at nine providers yield exactly one 201", async () => {
    const owner = await signUp(app, "rush");
    for (let i = 1; i <= 9; i++) await mustCreate(owner, { name: `p${i}` });
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => create(owner, { name: `late${i}` })));
    expect(results.map((r) => r.status).sort()).toEqual([201, 400, 400, 400, 400, 400, 400, 400, 400, 400]);
    expect((await api(app, owner, "GET", "/api/providers")).json.providers).toHaveLength(10);
  });

  it("a name is unique per owner: 409 name_taken, on creation and on rename", async () => {
    const [a, b] = [await signUp(app, "nina"), await signUp(app, "noah")];
    const one = await mustCreate(a, { name: "Same" });
    const two = await mustCreate(a, { name: "Other" });
    expect(await create(a, { name: "Same" })).toEqual({ status: 409, json: { error: "name_taken" } });
    expect(await api(app, a, "PATCH", `/api/providers/${two.id}`, { name: "Same" })).toEqual({ status: 409, json: { error: "name_taken" } });
    expect((await api(app, a, "PATCH", `/api/providers/${one.id}`, { name: "Same" })).status).toBe(200);
    expect((await create(b, { name: "Same" })).status).toBe(201);
  });
});

describe("editing", () => {
  it("PATCH changes name, baseUrl and models; a new apiKey is sealed again; without one the stored key stays", async () => {
    const owner = await signUp(app, "edda");
    const p = await mustCreate(owner, { apiKey: "sk-first-key-0000AAAA", models: [{ name: "a" }] });
    const keyOf = async () => (await loadProviderForCall(db, owner.id, p.id, secret()))!.apiKey;
    const cipherOf = async () => (await db.query("select key_cipher from providers where id = $1", [p.id])).rows[0].key_cipher as Buffer;
    const before = await cipherOf();

    const renamed = await api(app, owner, "PATCH", `/api/providers/${p.id}`, { name: "Renamed", baseUrl: "https://other.example/v2/" });
    expect(renamed).toEqual({ status: 200, json: { ...p, name: "Renamed", baseUrl: "https://other.example/v2" } });
    expect(await keyOf()).toBe("sk-first-key-0000AAAA");
    expect((await cipherOf()).equals(before)).toBe(true);

    const rekeyed = await api(app, owner, "PATCH", `/api/providers/${p.id}`, { apiKey: "sk-second-key-0000BBBB" });
    expect(rekeyed.json.keyLast4).toBe("BBBB");
    expect(await keyOf()).toBe("sk-second-key-0000BBBB");
    expect((await cipherOf()).equals(before)).toBe(false);

    const remodelled = await api(app, owner, "PATCH", `/api/providers/${p.id}`, { models: [{ name: "b", reasoning: true }, { name: "c" }] });
    expect(remodelled.json.models).toEqual([model("b", { reasoning: true }), model("c")]);
    expect(await api(app, owner, "PATCH", `/api/providers/${p.id}`, {})).toEqual({ status: 200, json: remodelled.json });
    expect((await api(app, owner, "GET", "/api/providers")).json.providers).toEqual([remodelled.json]);
  });

  it("the protocol cannot change, and other keys are refused (400)", async () => {
    const owner = await signUp(app, "pete");
    const p = await mustCreate(owner);
    for (const body of [{ protocol: "anthropic" }, { keyLast4: "0000" }, { id: RANDOM }, { ownerId: owner.id }, { apiKey: "short" }, { baseUrl: "ftp://api.example.com" }]) {
      expect([body, (await api(app, owner, "PATCH", `/api/providers/${p.id}`, body)).status]).toEqual([body, 400]);
    }
    expect((await api(app, owner, "GET", "/api/providers")).json.providers).toEqual([p]);
  });
});

describe("deleting", () => {
  it("is 409 provider_in_use naming the Agents that use it and are not deleted; once none do, it is deleted", async () => {
    const owner = await signUp(app, "dora");
    const p = await mustCreate(owner, { models: [{ name: "m" }] });
    const user = await mustCreateAgent(app, owner, { name: "User", model: useModel(p.id, "m") });
    const gone = await mustCreateAgent(app, owner, { name: "Gone", model: useModel(p.id, "m") });
    await mustCreateAgent(app, owner, { name: "Elsewhere", model: { source: "site", id: "fast" } });
    expect((await api(app, owner, "DELETE", `/api/agents/${gone.id}`)).status).toBe(200);

    expect(await api(app, owner, "DELETE", `/api/providers/${p.id}`)).toEqual({
      status: 409,
      json: { error: "provider_in_use", agents: [{ id: user.id, name: "User" }] },
    });
    expect((await api(app, owner, "PATCH", `/api/agents/${user.id}`, { model: null })).status).toBe(200);
    expect(await api(app, owner, "DELETE", `/api/providers/${p.id}`)).toEqual({ status: 200, json: { ok: true } });
    expect((await api(app, owner, "GET", "/api/providers")).json.providers).toEqual([]);
    // The deleted Agent no longer points at it.
    expect((await api(app, owner, "GET", `/api/agents/${gone.id}`)).json).toMatchObject({ deleted: true, model: null });
    expect((await api(app, owner, "DELETE", `/api/providers/${p.id}`)).status).toBe(404);
  });

  it("racing an Agent that takes the provider: never a 5xx, and never an Agent left on a deleted provider", async () => {
    const owner = await signUp(app, "race");
    for (let round = 0; round < 6; round++) {
      const p = await mustCreate(owner, { name: `r${round}`, models: [{ name: "m" }] });
      const agent = await mustCreateAgent(app, owner);
      const [patch, del] = await Promise.all([
        api(app, owner, "PATCH", `/api/agents/${agent.id}`, { model: useModel(p.id, "m") }),
        api(app, owner, "DELETE", `/api/providers/${p.id}`),
      ]);
      const outcome = `${patch.status}/${del.status}`;
      expect(["200/409", "400/200"]).toContain(outcome);
      if (del.status === 409) {
        // Free the provider for the next round's count.
        await api(app, owner, "PATCH", `/api/agents/${agent.id}`, { model: null });
        expect((await api(app, owner, "DELETE", `/api/providers/${p.id}`)).status).toBe(200);
      }
    }
  });
});

describe("another person's provider", () => {
  it("is 404 on every route, exactly like an id that does not exist; their list does not show it; an Agent cannot use it", async () => {
    const [alice, eve] = [await signUp(app, "alice"), await signUp(app, "eve")];
    const theirs = await mustCreate(alice, { models: [{ name: "m" }], baseUrl: stub.baseUrl() });
    const requests = (id: string): InjectOptions[] => [
      { method: "PATCH", url: `/api/providers/${id}`, payload: { name: "mine now" } },
      { method: "PATCH", url: `/api/providers/${id}`, payload: { apiKey: "sk-attacker-key-0001" } },
      { method: "DELETE", url: `/api/providers/${id}` },
      { method: "POST", url: `/api/providers/${id}/test` },
      { method: "POST", url: `/api/providers/${id}/models/refresh` },
    ];
    const observe = async (req: InjectOptions) => {
      const res = await app.inject({ ...req, headers: { cookie: eve.cookie } });
      return { status: res.statusCode, type: String(res.headers["content-type"]), body: res.body };
    };
    const reference = await Promise.all(requests(RANDOM).map(observe));
    for (const r of reference) expect([r.status, r.body]).toEqual([404, '{"error":"not_found"}']);
    const got = await Promise.all(requests(theirs.id).map(observe));
    expect(got).toEqual(reference);
    expect(stub.requests).toEqual([]); // nothing was called on their behalf

    expect((await api(app, eve, "GET", "/api/providers")).json.providers).toEqual([]);
    expect((await createAgent(app, eve, { model: useModel(theirs.id, "m") })).status).toBe(400);
    const agent = await mustCreateAgent(app, eve);
    expect((await api(app, eve, "PATCH", `/api/agents/${agent.id}`, { model: useModel(theirs.id, "m") })).status).toBe(400);
    expect((await api(app, alice, "GET", "/api/providers")).json.providers).toEqual([theirs]);
    expect((await loadProviderForCall(db, alice.id, theirs.id, secret()))!.apiKey).toBe(providerBody().apiKey);
  });
});

describe("testing the connection", () => {
  it("is one authenticated GET of {baseUrl}/models, with each protocol's own key header", async () => {
    const owner = await signUp(app, "tess");
    const KEY = "sk-protocol-key-1234";
    const expected: Record<string, Record<string, string | undefined>> = {
      openai_chat: { authorization: `Bearer ${KEY}`, "x-api-key": undefined, "x-goog-api-key": undefined },
      openai_responses: { authorization: `Bearer ${KEY}`, "x-api-key": undefined, "x-goog-api-key": undefined },
      anthropic: { authorization: undefined, "x-api-key": KEY, "anthropic-version": "2023-06-01", "x-goog-api-key": undefined },
      gemini: { authorization: undefined, "x-api-key": undefined, "x-goog-api-key": KEY },
    };
    for (const [protocol, headers] of Object.entries(expected)) {
      const p = await mustCreate(owner, { name: protocol, protocol, baseUrl: `${stub.baseUrl()}/`, apiKey: KEY });
      stub.requests.length = 0;
      expect(await api(app, owner, "POST", `/api/providers/${p.id}/test`)).toEqual({ status: 200, json: { ok: true } });
      expect(stub.requests).toHaveLength(1);
      const [req] = stub.requests;
      expect([protocol, req!.method, req!.path]).toEqual([protocol, "GET", "/v1/models"]);
      for (const [name, value] of Object.entries(headers)) expect([protocol, name, req!.headers[name]]).toEqual([protocol, name, value]);
    }
  });

  it("401 and 403 are provider_rejected; anything but a 200 with JSON is provider_unavailable; a private address is address_not_allowed", async () => {
    const owner = await signUp(app, "tom");
    const p = await mustCreate(owner, { baseUrl: stub.baseUrl() });
    const test = () => api(app, owner, "POST", `/api/providers/${p.id}/test`);
    const cases: Array<[number, string, Record<string, string>, string]> = [
      [401, '{"error":"bad key"}', {}, "provider_rejected"],
      [403, '{"error":"forbidden"}', {}, "provider_rejected"],
      [500, '{"error":"oops"}', {}, "provider_unavailable"],
      [404, '{"error":"no such path"}', {}, "provider_unavailable"],
      [429, '{"error":"slow down"}', {}, "provider_unavailable"],
      [200, "<html>not json</html>", { "content-type": "text/html" }, "provider_unavailable"],
      [302, "", { location: "https://127.0.0.1/" }, "provider_unavailable"],
      [201, '{"data":[]}', {}, "provider_unavailable"],
    ];
    for (const [status, body, headers, error] of cases) {
      stub.answer(() => ({ status, body, headers }));
      expect([status, await test()]).toEqual([status, { status: 200, json: { ok: false, error } }]);
    }
    // (This app allows loopback for its stub, so the private addresses here are not loopback ones.)
    for (const baseUrl of ["https://10.0.0.5/v1", "https://169.254.169.254/latest", "https://[fd00::1]/v1"]) {
      const q = await mustCreate(owner, { name: baseUrl, baseUrl });
      expect([baseUrl, await api(app, owner, "POST", `/api/providers/${q.id}/test`)]).toEqual([
        baseUrl,
        { status: 200, json: { ok: false, error: "address_not_allowed" } },
      ]);
    }
  });
});

describe("refreshing the model list", () => {
  it("merges the names the provider lists into models, keeping the flags of the ones already there", async () => {
    const owner = await signUp(app, "rita");
    const p = await mustCreate(owner, { baseUrl: stub.baseUrl(), models: [{ name: "keep", reasoning: true, vision: true, contextTokens: 50000 }] });
    stub.answer(() => ({
      status: 200,
      body: JSON.stringify({
        data: [{ id: "new-1" }, { id: "keep" }, { id: "new-2" }, { id: 42 }, { id: "x".repeat(101) }, { id: "" }, { id: "bad\nname" }, { id: "new-1" }, {}, "loose"],
      }),
    }));
    const res = await api(app, owner, "POST", `/api/providers/${p.id}/models/refresh`);
    const models = [model("keep", { reasoning: true, vision: true, contextTokens: 50000 }), model("new-1"), model("new-2")];
    expect(res).toEqual({ status: 200, json: { listed: ["new-1", "keep", "new-2"], provider: { ...p, models } } });
    expect((await api(app, owner, "GET", "/api/providers")).json.providers).toEqual([{ ...p, models }]);
    expect(stub.requests.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /v1/models"]);
  });

  it("reads each protocol's list: data[].id for OpenAI and Anthropic, models[].name without models/ for Gemini", async () => {
    const owner = await signUp(app, "lena");
    const cases: Array<[string, unknown, string[]]> = [
      ["openai_responses", { object: "list", data: [{ id: "gpt-a", object: "model" }] }, ["gpt-a"]],
      ["anthropic", { data: [{ id: "claude-a", type: "model", display_name: "Claude A" }], has_more: false }, ["claude-a"]],
      ["gemini", { models: [{ name: "models/gemini-a", displayName: "A" }, { name: "gemini-b" }] }, ["gemini-a", "gemini-b"]],
      ["openai_chat", { unexpected: true }, []],
    ];
    for (const [protocol, body, names] of cases) {
      const p = await mustCreate(owner, { name: protocol, protocol, baseUrl: stub.baseUrl() });
      stub.answer(() => ({ status: 200, body: JSON.stringify(body) }));
      const res = await api(app, owner, "POST", `/api/providers/${p.id}/models/refresh`);
      expect([protocol, res.status, res.json.listed, res.json.provider.models.map((m: any) => m.name)]).toEqual([protocol, 200, names, names]);
    }
  });

  it("never keeps more than 100 models: names past the hundredth are left out", async () => {
    const owner = await signUp(app, "hugo");
    const p = await mustCreate(owner, { baseUrl: stub.baseUrl(), models: Array.from({ length: 98 }, (_, i) => ({ name: `old${i}` })) });
    stub.answer(() => ({ status: 200, body: JSON.stringify({ data: ["n1", "n2", "n3", "n4"].map((id) => ({ id })) }) }));
    const res = await api(app, owner, "POST", `/api/providers/${p.id}/models/refresh`);
    expect(res.json.listed).toEqual(["n1", "n2", "n3", "n4"]);
    expect(res.json.provider.models).toHaveLength(100);
    expect(res.json.provider.models.slice(-2).map((m: any) => m.name)).toEqual(["n1", "n2"]);
  });

  it("an upstream refusal is 502 provider_rejected, a failure 502 provider_unavailable, a private address 400; nothing changes", async () => {
    const owner = await signUp(app, "fay");
    const p = await mustCreate(owner, { baseUrl: stub.baseUrl(), models: [{ name: "kept" }] });
    const refresh = (id: string) => api(app, owner, "POST", `/api/providers/${id}/models/refresh`);
    stub.answer(() => ({ status: 401, body: '{"error":"nope"}' }));
    expect(await refresh(p.id)).toEqual({ status: 502, json: { error: "provider_rejected" } });
    stub.answer(() => ({ status: 503, body: "<html>down</html>" }));
    expect(await refresh(p.id)).toEqual({ status: 502, json: { error: "provider_unavailable" } });
    const q = await mustCreate(owner, { name: "private", baseUrl: "https://192.168.0.10/v1" });
    expect(await refresh(q.id)).toEqual({ status: 400, json: { error: "address_not_allowed" } });
    expect((await api(app, owner, "GET", "/api/providers")).json.providers.map((x: any) => x.models.map((m: any) => m.name))).toEqual([["kept"], []]);
  });
});

describe("an Agent's provider model", () => {
  it("a stored models value that is malformed counts as no models: listing works and choosing one is 400, not 500", async () => {
    const owner = await signUp(app, "mal");
    const insert = async (name: string, models: string) =>
      (
        await db.query<{ id: string }>(
          `insert into providers (owner_id, name, protocol, base_url, key_cipher, key_last4, models)
           values ($1, $2, 'openai_chat', 'https://api.example.com/v1', '\\x00', 'abcd', $3::jsonb) returning id`,
          [owner.id, name, models],
        )
      ).rows[0]!.id;
    const object = await insert("object", '{"name":"m"}');
    const text = await insert("text", '"m"');
    const mixed = await insert("mixed", '[1, {"name": 5}, {"name": "m", "reasoning": "yes"}, {"name": "ok", "vision": false, "pdf": false, "reasoning": true, "contextTokens": 1000}]');

    const listed = (await api(app, owner, "GET", "/api/providers")).json.providers;
    expect(listed.map((p: any) => [p.name, p.models.map((m: any) => m.name)])).toEqual([["object", []], ["text", []], ["mixed", ["ok"]]]);
    expect((await createAgent(app, owner, { model: useModel(object, "m") })).status).toBe(400);
    expect((await createAgent(app, owner, { model: useModel(text, "m") })).status).toBe(400);
    expect((await createAgent(app, owner, { model: useModel(mixed, "m") })).status).toBe(400);
    expect((await createAgent(app, owner, { model: useModel(mixed, "ok"), reasoning: "high" })).status).toBe(201);
  });
});
