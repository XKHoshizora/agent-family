import { describe, expect, it } from "vitest";
import { api, signUp } from "./helpers/actors.ts";
import { useApp } from "./helpers/harness.ts";

// Scale 1: 30 tickets, 60 syncs and 60 catch-ups per minute per principal.
const { app } = useApp({ env: { RATE_LIMIT_SCALE: "1" } });

describe("sync and ticket rate limits", () => {
  it("allows 30 websocket tickets per minute per principal, then 429 rate_limited; others are unaffected", async () => {
    const [a, b] = [await signUp(app, "alice"), await signUp(app, "bob")];
    for (let i = 1; i <= 30; i++) expect((await api(app, a, "POST", "/api/ws-ticket")).status).toBe(200);
    expect(await api(app, a, "POST", "/api/ws-ticket")).toEqual({ status: 429, json: { error: "rate_limited" } });
    expect((await api(app, b, "POST", "/api/ws-ticket")).status).toBe(200);
  });

  it("allows 60 syncs and 60 catch-ups per minute per principal, each counted on its own", async () => {
    const [a, b] = [await signUp(app, "carol"), await signUp(app, "dave")];
    for (let i = 1; i <= 60; i++) expect((await api(app, a, "GET", "/api/sync")).status).toBe(200);
    expect(await api(app, a, "GET", "/api/sync")).toEqual({ status: 429, json: { error: "rate_limited" } });
    const catchup = (who: typeof a) => api(app, who, "POST", "/api/sync/catchup", { positions: {} });
    for (let i = 1; i <= 60; i++) expect((await catchup(a)).status).toBe(200);
    expect(await catchup(a)).toEqual({ status: 429, json: { error: "rate_limited" } });
    expect((await api(app, b, "GET", "/api/sync")).status).toBe(200);
  });
});
