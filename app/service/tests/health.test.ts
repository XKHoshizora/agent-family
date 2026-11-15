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
});
