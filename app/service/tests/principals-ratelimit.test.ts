import { describe, expect, it } from "vitest";
import { api, signUp } from "./helpers/actors.ts";
import { useApp } from "./helpers/harness.ts";

// Scale 1: handle lookups are limited to 30 per minute per principal.
const { app } = useApp({ env: { RATE_LIMIT_SCALE: "1" } });

const lookup = (who: { cookie: string }, handle: string) => api(app, who, "GET", `/api/principals/lookup?handle=${handle}`);

describe("handle lookup rate limit", () => {
  it("allows 30 lookups per minute per principal, found or not, then 429 rate_limited; other principals are unaffected", async () => {
    const [a, b] = [await signUp(app, "alice"), await signUp(app, "bob")];
    for (let i = 1; i <= 30; i++) {
      // Misses count too: the limit is what stops probing for handles.
      const res = await lookup(a, i % 2 ? b.handle : `nobody_${i}`);
      expect(res.status).toBe(i % 2 ? 200 : 404);
    }
    expect(await lookup(a, b.handle)).toEqual({ status: 429, json: { error: "rate_limited" } });
    expect(await lookup(a, "nobody_x")).toEqual({ status: 429, json: { error: "rate_limited" } });
    expect((await lookup(b, a.handle)).status).toBe(200);
  });
});
