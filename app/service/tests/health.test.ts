import { describe, expect, test } from "vitest";
import { useApp } from "./helpers/harness.ts";

describe("health", () => {
  const { app } = useApp();

  test("health reports database reachable", async () => {
    const r = await app.inject({ method: "GET", url: "/api/health" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true });
  });

  test("unknown route is 404 with an error body, malformed URL does not crash", async () => {
    expect((await app.inject({ method: "GET", url: "/api/nope" })).json()).toEqual({ error: "not_found" });
    const r = await app.inject({ method: "GET", url: "//" });
    expect(r.statusCode).toBeLessThan(500);
    expect((await app.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(200);
  });

  test("a path the router cannot decode, or an over-long id, is answered in the error shape", async () => {
    // Fastify's router answered these itself with its own body ({"error":"Bad Request","code":"FST_ERR_…"}).
    for (const url of ["/api/attachments/%ED%A0%80", "/api/conversations/%zz/messages", "/api/friend-requests/%"]) {
      const r = await app.inject({ method: "GET", url });
      expect([url, r.statusCode, r.json()]).toEqual([url, 400, { error: "invalid_request" }]);
    }
    const long = await app.inject({ method: "GET", url: `/api/attachments/${"x".repeat(500)}` });
    expect([long.statusCode, long.json()]).toEqual([414, { error: "invalid_request" }]);
    expect((await app.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(200);
  });
});
