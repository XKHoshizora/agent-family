import { describe, expect, it } from "vitest";
import { api, signUp } from "./helpers/actors.ts";
import { useProbeBlobs } from "./helpers/blobs.ts";
import { useApp } from "./helpers/harness.ts";

// Scale 1: handle lookups are limited to 30 per minute per principal; renaming yourself and replacing your
// avatar to 10 each.
const { blobs } = useProbeBlobs("af-principals-rl-");
const { app } = useApp({ blobs, env: { RATE_LIMIT_SCALE: "1" } });

const lookup = (who: { cookie: string }, handle: string) => api(app, who, "GET", `/api/principals/lookup?handle=${handle}`);

const PNG = Buffer.concat([
  Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"),
  Buffer.from("00000001000000010806000000", "hex"),
  Buffer.from("1f15c4890000000d49444154789c6360000002000001e221bc330000000049454e44ae426082", "hex"),
]);
const putAvatar = (who: { cookie: string }, body: Buffer = PNG) =>
  app
    .inject({ method: "PUT", url: "/api/me/avatar", headers: { cookie: who.cookie, "content-type": "image/png" }, payload: body })
    .then((r) => ({ status: r.statusCode, json: r.json() }));

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

describe("profile change rate limits", () => {
  it("allows 10 display-name changes per minute per principal, then 429 rate_limited", async () => {
    const [a, b] = [await signUp(app, "carol"), await signUp(app, "dave")];
    for (let i = 1; i <= 10; i++) expect((await api(app, a, "PATCH", "/api/me", { displayName: `Carol ${i}` })).status).toBe(200);
    expect(await api(app, a, "PATCH", "/api/me", { displayName: "Carol 11" })).toEqual({ status: 429, json: { error: "rate_limited" } });
    expect((await api(app, a, "GET", "/api/me")).json.displayName).toBe("Carol 10");
    expect((await api(app, b, "PATCH", "/api/me", { displayName: "Dave" })).status).toBe(200);
    // A budget of its own: the avatar can still be replaced.
    expect((await putAvatar(a)).status).toBe(200);
  });

  it("allows 10 avatar uploads per minute per principal, refused ones included, then 429 rate_limited", async () => {
    const [a, b] = [await signUp(app, "erin"), await signUp(app, "frank")];
    expect(await putAvatar(a, Buffer.from("<svg/>"))).toEqual({ status: 400, json: { error: "invalid_request" } });
    for (let i = 2; i <= 10; i++) expect((await putAvatar(a)).status).toBe(200);
    expect(await putAvatar(a)).toEqual({ status: 429, json: { error: "rate_limited" } });
    expect((await putAvatar(b)).status).toBe(200);
    expect((await api(app, a, "PATCH", "/api/me", { displayName: "Erin" })).status).toBe(200);
  });

  it("an Agent's avatar counts against the same 10 a minute as your own (besides the Agent writes' 30)", async () => {
    const [a, b] = [await signUp(app, "gina"), await signUp(app, "hank")];
    const agent = (await api(app, a, "POST", "/api/agents", { namePart: "rl_avatar_bot", name: "Bot" })).json;
    const putAgentAvatar = (who: { cookie: string }, id: string) =>
      app
        .inject({ method: "PUT", url: `/api/agents/${id}/avatar`, headers: { cookie: who.cookie, "content-type": "image/png" }, payload: PNG })
        .then((r) => ({ status: r.statusCode, json: r.json() }));
    for (let i = 1; i <= 5; i++) expect((await putAvatar(a)).status).toBe(200);
    for (let i = 6; i <= 10; i++) expect((await putAgentAvatar(a, agent.id)).status).toBe(200);
    expect(await putAgentAvatar(a, agent.id)).toEqual({ status: 429, json: { error: "rate_limited" } });
    expect(await putAvatar(a)).toEqual({ status: 429, json: { error: "rate_limited" } });
    // The Agent writes' own budget is not used up: an edit still goes through.
    expect((await api(app, a, "PATCH", `/api/agents/${agent.id}`, { intro: "still fine" })).status).toBe(200);
    expect((await putAvatar(b)).status).toBe(200);
  });
});
