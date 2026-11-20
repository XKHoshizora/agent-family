import { describe, expect, it } from "vitest";
import { api, befriend, signUp } from "./helpers/actors.ts";
import { useApp } from "./helpers/harness.ts";

// Scale 1: 120 sends and 10 group creations per minute per principal.
const { app } = useApp({ env: { RATE_LIMIT_SCALE: "1" } });

describe("message and group rate limits", () => {
  it("allows 120 sends per minute per principal, then 429 rate_limited; the other party is unaffected", async () => {
    const [a, b] = [await signUp(app, "alice"), await signUp(app, "bob")];
    const { conversationId: dm } = await befriend(app, a, b);
    const send = (who: typeof a, i: number) =>
      api(app, who, "POST", `/api/conversations/${dm}/messages`, { text: `n${i}`, clientTxn: `${who.handle}-${i}` });

    for (let i = 1; i <= 120; i++) expect((await send(a, i)).status).toBe(201);
    expect(await send(a, 121)).toMatchObject({ status: 429, json: { error: "rate_limited" } });
    expect((await send(b, 1)).status).toBe(201);
  });

  it("allows 120 reads of one message per minute per principal (what a reply's lookups open), then 429 rate_limited; the other party is unaffected", async () => {
    const [a, b] = [await signUp(app, "fay"), await signUp(app, "gus")];
    const { conversationId: dm } = await befriend(app, a, b);
    expect((await api(app, a, "POST", `/api/conversations/${dm}/messages`, { text: "hi", clientTxn: "fay-1" })).status).toBe(201);
    const read = (who: typeof a) => api(app, who, "GET", `/api/conversations/${dm}/messages/1`);
    for (let i = 1; i <= 120; i++) expect((await read(a)).status).toBe(200);
    expect(await read(a)).toMatchObject({ status: 429, json: { error: "rate_limited" } });
    expect((await read(b)).status).toBe(200);
  });

  it("allows 10 group creations per minute per principal, then 429 rate_limited", async () => {
    const [a, b, c] = [await signUp(app, "carol"), await signUp(app, "dave"), await signUp(app, "erin")];
    await befriend(app, a, b);
    await befriend(app, a, c);
    const create = () => api(app, a, "POST", "/api/conversations", { title: "g", memberIds: [b.id, c.id] });
    for (let i = 1; i <= 10; i++) expect((await create()).status).toBe(201);
    expect(await create()).toMatchObject({ status: 429, json: { error: "rate_limited" } });
  });
});
