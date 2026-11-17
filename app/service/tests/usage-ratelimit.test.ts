import { describe, expect, it } from "vitest";
import { api, signUp } from "./helpers/actors.ts";
import { useApp } from "./helpers/harness.ts";

// Scale 1: GET /api/usage is limited to 60 a minute per principal.
const { app } = useApp({ env: { RATE_LIMIT_SCALE: "1" } });

describe("GET /api/usage rate limit", () => {
  it("allows 60 reads a minute per principal, then 429; another person is unaffected", async () => {
    const [a, b] = [await signUp(app, "usage_rl_a"), await signUp(app, "usage_rl_b")];
    for (let i = 1; i <= 60; i++) expect([i, (await api(app, a, "GET", "/api/usage")).status]).toEqual([i, 200]);
    expect(await api(app, a, "GET", "/api/usage")).toEqual({ status: 429, json: { error: "rate_limited" } });
    expect((await api(app, b, "GET", "/api/usage")).status).toBe(200);
    // Other reads of the same person are not counted against it.
    expect((await api(app, a, "GET", "/api/me")).status).toBe(200);
  });
});
