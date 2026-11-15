import { describe, expect, it } from "vitest";
import { api, signUp, type Actor } from "./helpers/actors.ts";
import { useApp } from "./helpers/harness.ts";

// Scale 1: request creation is limited to 20 per minute per principal.
const { app } = useApp({ env: { RATE_LIMIT_SCALE: "1" } });

const send = (from: Actor, to: Actor) => api(app, from, "POST", "/api/friend-requests", { handle: to.handle });

describe("friend request creation rate limit", () => {
  it("allows 20 per minute per principal, then 429 rate_limited; other principals are unaffected", async () => {
    const [a, b, c] = [await signUp(app, "alice"), await signUp(app, "bob"), await signUp(app, "carol")];
    const first = await send(a, b);
    expect(first.status).toBe(201);
    for (let i = 2; i <= 20; i++) expect((await send(a, b)).status).toBe(409); // counted even when refused
    expect(await send(a, b)).toMatchObject({ status: 429, json: { error: "rate_limited" } });
    expect(await send(a, c)).toMatchObject({ status: 429, json: { error: "rate_limited" } });

    expect((await send(c, b)).status).toBe(201); // a different principal has its own budget
    expect((await send(b, a)).status).toBe(409); // not rate limited (pending request exists)
  });
});
