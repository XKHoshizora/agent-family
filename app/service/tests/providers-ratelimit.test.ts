import { describe, expect, it } from "vitest";
import { api, signUp } from "./helpers/actors.ts";
import { useApp } from "./helpers/harness.ts";
import { providerBody } from "./helpers/providers.ts";

// Scale 1. The providers point at a private address, so test and refresh are refused without any network.
const { app } = useApp({ env: { RATE_LIMIT_SCALE: "1" } });
const PRIVATE = "https://10.0.0.5/v1";
const limited = { status: 429, json: { error: "rate_limited" } };

describe("provider rate limits", () => {
  it("writes: 20 a minute per principal across create, edit and delete, then 429; reading and other people are unaffected", async () => {
    const [a, b] = [await signUp(app, "rate_a"), await signUp(app, "rate_b")];
    const created = await api(app, a, "POST", "/api/providers", providerBody({ baseUrl: PRIVATE })); // 1
    expect(created.status).toBe(201);
    const id = created.json.id;
    for (let i = 2; i <= 19; i++) expect((await api(app, a, "PATCH", `/api/providers/${id}`, { name: `v${i}` })).status).toBe(200);
    expect((await api(app, a, "DELETE", `/api/providers/${id}`)).status).toBe(200); // 20
    expect(await api(app, a, "POST", "/api/providers", providerBody())).toEqual(limited);
    expect(await api(app, a, "PATCH", `/api/providers/${id}`, { name: "x" })).toEqual(limited);
    expect(await api(app, a, "DELETE", `/api/providers/${id}`)).toEqual(limited);
    expect((await api(app, a, "GET", "/api/providers")).status).toBe(200);
    expect((await api(app, b, "POST", "/api/providers", providerBody())).status).toBe(201);
  });

  it("test and models/refresh: 10 a minute together, a budget of their own", async () => {
    const c = await signUp(app, "rate_c");
    const created = await api(app, c, "POST", "/api/providers", providerBody({ baseUrl: PRIVATE }));
    const id = created.json.id;
    for (let i = 1; i <= 5; i++) {
      expect(await api(app, c, "POST", `/api/providers/${id}/test`)).toEqual({ status: 200, json: { ok: false, error: "address_not_allowed" } });
      expect(await api(app, c, "POST", `/api/providers/${id}/models/refresh`)).toEqual({ status: 400, json: { error: "address_not_allowed" } });
    }
    expect(await api(app, c, "POST", `/api/providers/${id}/test`)).toEqual(limited);
    expect(await api(app, c, "POST", `/api/providers/${id}/models/refresh`)).toEqual(limited);
    expect((await api(app, c, "PATCH", `/api/providers/${id}`, { name: "still writable" })).status).toBe(200);
  });
});
