import { describe, expect, it } from "vitest";
import { api, signUp } from "./helpers/actors.ts";
import { createAgent, mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";

// Scale 1: Agent writes are limited to 30 per minute per principal.
const { app } = useApp({ env: { ...SITE_ENV, RATE_LIMIT_SCALE: "1" } });

describe("Agent write rate limit", () => {
  it("allows 30 writes a minute per principal across create, edit, pause, resume and delete, then 429; reads and others are unaffected", async () => {
    const [a, b] = [await signUp(app, "rate_a"), await signUp(app, "rate_b")];
    const agent = await mustCreateAgent(app, a); // 1
    for (let i = 2; i <= 15; i++) expect((await api(app, a, "PATCH", `/api/agents/${agent.id}`, { intro: `v${i}` })).status).toBe(200);
    for (let i = 16; i <= 30; i++) {
      const res = await api(app, a, "POST", `/api/agents/${agent.id}/${i % 2 ? "pause" : "resume"}`);
      expect(res.status).toBe(200);
    }
    const limited = { status: 429, json: { error: "rate_limited" } };
    expect(await api(app, a, "PATCH", `/api/agents/${agent.id}`, { intro: "x" })).toEqual(limited);
    expect(await createAgent(app, a)).toEqual(limited);
    expect(await api(app, a, "DELETE", `/api/agents/${agent.id}`)).toEqual(limited);
    expect((await api(app, a, "GET", "/api/agents")).status).toBe(200);
    expect((await api(app, a, "GET", `/api/agents/${agent.id}`)).status).toBe(200);
    expect((await createAgent(app, b)).status).toBe(201);
  });
});
