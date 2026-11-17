import { describe, expect, it } from "vitest";
import { providerBaseUrl } from "../src/providers/base-url.ts";
import { api, signUp } from "./helpers/actors.ts";
import { useApp } from "./helpers/harness.ts";
import { providerBody, useProviderStub } from "./helpers/providers.ts";

/**
 * What a typed provider address is stored as (README "Model providers", `baseUrl`): the version appended unless the
 * path names one or the address ends with `#`. The web form previews the same rule (app/web/src/pages/Providers.jsx
 * `storedBaseUrl`, tests/providers.test.jsx): BASE_URL_CASES is copied there as it is — change both together.
 */

// [protocol, typed, stored (null: refused)] — keep in step with app/web/tests/providers.test.jsx.
const BASE_URL_CASES: Array<[string, string, string | null]> = [
  ["openai_chat", "https://api.deepseek.com", "https://api.deepseek.com/v1"],
  ["openai_chat", "https://api.deepseek.com/", "https://api.deepseek.com/v1"],
  ["openai_chat", "  https://api.deepseek.com/v1/  ", "https://api.deepseek.com/v1"],
  ["openai_responses", "https://api.openai.com", "https://api.openai.com/v1"],
  ["openai_chat", "https://open.bigmodel.cn/api/paas/v4", "https://open.bigmodel.cn/api/paas/v4"],
  ["openai_chat", "https://ark.cn-beijing.volces.com/api/v3/", "https://ark.cn-beijing.volces.com/api/v3"],
  ["openai_chat", "https://dashscope.aliyuncs.com/compatible-mode/v1", "https://dashscope.aliyuncs.com/compatible-mode/v1"],
  ["openai_chat", "https://example.com/v1/openai", "https://example.com/v1/openai"],
  ["openai_chat", "https://example.com/openai", "https://example.com/openai/v1"],
  ["openai_chat", "https://example.com/v1beta", "https://example.com/v1beta"],
  ["openai_chat", "https://us-central1-aiplatform.googleapis.com/v1beta1/projects/p/locations/l/endpoints/openapi", "https://us-central1-aiplatform.googleapis.com/v1beta1/projects/p/locations/l/endpoints/openapi"],
  ["openai_chat", "https://example.com/v1alpha2", "https://example.com/v1alpha2"],
  ["openai_chat", "https://example.com/v1beta1x/", "https://example.com/v1beta1x/v1"],
  ["openai_chat", "https://example.com/v1_2", "https://example.com/v1_2/v1"],
  ["openai_chat", "https://example.com/version1", "https://example.com/version1/v1"],
  ["openai_chat", "https://example.com/v1x2", "https://example.com/v1x2"],
  ["openai_chat", "https://example.com/V1", "https://example.com/V1/v1"],
  ["anthropic", "https://api.anthropic.com", "https://api.anthropic.com/v1"],
  ["anthropic", "https://api.minimax.io/anthropic", "https://api.minimax.io/anthropic/v1"],
  ["anthropic", "https://api.minimax.io/anthropic/v1", "https://api.minimax.io/anthropic/v1"],
  ["gemini", "https://generativelanguage.googleapis.com", "https://generativelanguage.googleapis.com/v1beta"],
  ["gemini", "https://generativelanguage.googleapis.com/v1", "https://generativelanguage.googleapis.com/v1"],
  ["gemini", "https://generativelanguage.googleapis.com/v1beta/", "https://generativelanguage.googleapis.com/v1beta"],
  ["openai_chat", "https://api.longcat.chat/openai#", "https://api.longcat.chat/openai"],
  ["openai_chat", "https://api.longcat.chat/openai/#", "https://api.longcat.chat/openai"],
  ["gemini", "https://proxy.example.com/google#", "https://proxy.example.com/google"],
  ["anthropic", " https://proxy.example.com/claude# ", "https://proxy.example.com/claude"],
  ["openai_chat", "https://example.com#", "https://example.com"],
  ["openai_chat", "https://example.com/#", "https://example.com"],
  ["openai_chat", "https://API.Example.com:443/v1/?x=1#frag", "https://api.example.com/v1"],
  ["openai_chat", "https://example.com/openai?x=1", "https://example.com/openai/v1"],
  ["openai_chat", "https://example.com:8443/x", "https://example.com:8443/x/v1"],
  ["openai_chat", "https://203.0.113.9", "https://203.0.113.9/v1"],
  ["openai_chat", "http://api.example.com", null],
  ["openai_chat", "https://user:pw@api.example.com", null],
  ["openai_chat", "https://@api.example.com/v1", null],
  ["openai_chat", "https://exa_mple.com/v1", null],
  ["openai_chat", "not a url", null],
  ["openai_chat", "#", null],
  ["openai_chat", "", null],
];

describe("providerBaseUrl (the shared table)", () => {
  it("stores each typed address as the table says", () => {
    for (const [protocol, typed, stored] of BASE_URL_CASES) {
      expect([protocol, typed, providerBaseUrl(protocol as never, typed)]).toEqual([protocol, typed, stored]);
    }
  });

  it("whether an address may be one does not depend on the protocol; loopback http only for tests", () => {
    for (const [, typed, stored] of BASE_URL_CASES) {
      for (const protocol of ["openai_chat", "openai_responses", "anthropic", "gemini"] as const) {
        expect([typed, protocol, providerBaseUrl(protocol, typed) === null]).toEqual([typed, protocol, stored === null]);
      }
    }
    expect(providerBaseUrl("openai_chat", "http://127.0.0.1:9999")).toBeNull();
    expect(providerBaseUrl("openai_chat", "http://127.0.0.1:9999", true)).toBe("http://127.0.0.1:9999/v1");
  });
});

const stub = useProviderStub();
const { app, db } = useApp({ allowInsecureLocal: true });

describe("the routes store what the rule says", () => {
  const create = async (over: Record<string, unknown>, who?: Awaited<ReturnType<typeof signUp>>) => {
    const owner = who ?? (await signUp(app, `bu${Math.floor(Math.random() * 1e6)}`));
    const res = await api(app, owner, "POST", "/api/providers", providerBody(over));
    return { owner, res };
  };

  it("POST: per protocol, the version appended or kept, an address ending in # as typed", async () => {
    const owner = await signUp(app, "baseurl");
    const cases: Array<[string, string, string]> = [
      ["openai_chat", "https://api.deepseek.com/", "https://api.deepseek.com/v1"],
      ["anthropic", "https://api.anthropic.com", "https://api.anthropic.com/v1"],
      ["gemini", "https://generativelanguage.googleapis.com", "https://generativelanguage.googleapis.com/v1beta"],
      ["openai_responses", "https://open.bigmodel.cn/api/paas/v4", "https://open.bigmodel.cn/api/paas/v4"],
      ["openai_chat", "https://api.longcat.chat/openai#", "https://api.longcat.chat/openai"],
    ];
    for (const [i, [protocol, baseUrl, stored]] of cases.entries()) {
      const { res } = await create({ name: `p${i}`, protocol, baseUrl }, owner);
      expect([protocol, baseUrl, res.status, res.json.baseUrl]).toEqual([protocol, baseUrl, 201, stored]);
    }
    // (This app allows http: for its stub; the table above checks that it is refused otherwise.)
    for (const baseUrl of ["#", "https://exa_mple.com", "ftp://api.example.com", "https://user:pw@api.example.com#"]) {
      expect([baseUrl, (await create({ name: "bad", baseUrl }, owner)).res.status]).toEqual([baseUrl, 400]);
    }
  });

  it("PATCH: by the provider's own protocol; another origin still needs the key", async () => {
    const owner = await signUp(app, "patcher");
    const chat = (await create({ name: "chat", protocol: "openai_chat", baseUrl: "https://api.example.com/v1" }, owner)).res.json;
    const gemini = (await create({ name: "gem", protocol: "gemini", baseUrl: "https://api.example.com/v1beta" }, owner)).res.json;
    const patch = (id: string, body: object) => api(app, owner, "PATCH", `/api/providers/${id}`, body);
    expect((await patch(chat.id, { baseUrl: "https://api.example.com/openai" })).json.baseUrl).toBe("https://api.example.com/openai/v1");
    expect((await patch(gemini.id, { baseUrl: "https://api.example.com/google" })).json.baseUrl).toBe("https://api.example.com/google/v1beta");
    expect((await patch(gemini.id, { baseUrl: "https://api.example.com/google#" })).json.baseUrl).toBe("https://api.example.com/google");
    expect(await patch(chat.id, { baseUrl: "https://other.example.com" })).toEqual({ status: 400, json: { error: "invalid_request" } });
    expect((await patch(chat.id, { baseUrl: "https://other.example.com", apiKey: "sk-test-another-0001" })).json.baseUrl).toBe("https://other.example.com/v1");
    expect((await patch(chat.id, { baseUrl: "#" })).status).toBe(400);
  });

  it("a provider stored before the rule keeps its address: nothing rewrites it, and an edit without baseUrl leaves it", async () => {
    const { owner, res } = await create({ baseUrl: "https://api.example.com/v1" });
    await db.query("update providers set base_url = 'https://api.deepseek.com' where id = $1", [res.json.id]);
    expect((await api(app, owner, "GET", "/api/providers")).json.providers[0].baseUrl).toBe("https://api.deepseek.com");
    expect((await api(app, owner, "PATCH", `/api/providers/${res.json.id}`, { name: "Renamed" })).json.baseUrl).toBe("https://api.deepseek.com");
  });

  it("calls go to the stored address: the version appended, or the path as typed", async () => {
    const root = stub.baseUrl().replace(/\/v1$/, "");
    const { owner, res } = await create({ baseUrl: root });
    expect(res.json.baseUrl).toBe(`${root}/v1`);
    expect((await api(app, owner, "POST", `/api/providers/${res.json.id}/test`)).json.ok).toBe(true);
    const typed = await api(app, owner, "POST", "/api/providers", providerBody({ name: "as typed", baseUrl: `${root}/custom/#` }));
    expect(typed.json.baseUrl).toBe(`${root}/custom`);
    await api(app, owner, "POST", `/api/providers/${typed.json.id}/test`);
    expect(stub.requests.map((r) => r.path)).toEqual(["/v1/models", "/custom/models"]);
  });
});
