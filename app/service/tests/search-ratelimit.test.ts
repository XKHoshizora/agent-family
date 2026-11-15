import { describe, expect, it } from "vitest";
import { api, befriend, signUp } from "./helpers/actors.ts";
import { useApp } from "./helpers/harness.ts";

// Scale 1: 30 searches per minute per principal, both search routes together.
const { app } = useApp({ env: { RATE_LIMIT_SCALE: "1" } });

describe("search rate limit", () => {
  it("allows 30 searches per minute per principal across both routes, then 429 rate_limited; others unaffected", async () => {
    const [a, b] = [await signUp(app, "alice"), await signUp(app, "bob")];
    const { conversationId: dm } = await befriend(app, a, b);
    for (let i = 1; i <= 30; i++) {
      const url = i % 2 ? `/api/conversations/${dm}/search?q=x` : "/api/search?q=x";
      expect((await api(app, a, "GET", url)).status).toBe(200);
    }
    expect(await api(app, a, "GET", "/api/search?q=x")).toMatchObject({ status: 429, json: { error: "rate_limited" } });
    expect(await api(app, a, "GET", `/api/conversations/${dm}/search?q=x`)).toMatchObject({
      status: 429,
      json: { error: "rate_limited" },
    });
    expect((await api(app, b, "GET", "/api/search?q=x")).status).toBe(200);
  });
});
