import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { api, signUp } from "./helpers/actors.ts";
import { createAgent, mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";

// Scale 1: Agent writes are limited to 30 per minute per principal, persona drafts to 5.
const { app } = useApp({ env: { ...SITE_ENV, RATE_LIMIT_SCALE: "1" } });

describe("Agent write rate limit", () => {
  it("allows 30 writes a minute per principal across create, edit, pause, resume, delete, new topics and proposals, then 429; reads and others are unaffected", async () => {
    const [a, b] = [await signUp(app, "rate_a"), await signUp(app, "rate_b")];
    const agent = await mustCreateAgent(app, a); // 1
    for (let i = 2; i <= 10; i++) expect((await api(app, a, "PATCH", `/api/agents/${agent.id}`, { intro: `v${i}` })).status).toBe(200);
    for (let i = 11; i <= 15; i++) expect((await api(app, a, "POST", `/api/conversations/${agent.conversationId}/topic`)).status).toBe(201);
    for (let i = 16; i <= 28; i++) {
      const res = await api(app, a, "POST", `/api/agents/${agent.id}/${i % 2 ? "pause" : "resume"}`);
      expect(res.status).toBe(200);
    }
    // A proposal that does not exist is refused, and still counted.
    for (const action of ["confirm", "discard"]) {
      expect((await api(app, a, "POST", `/api/agents/${agent.id}/proposals/${randomUUID()}/${action}`)).status).toBe(404); // 29, 30
    }
    const limited = { status: 429, json: { error: "rate_limited" } };
    expect(await api(app, a, "PATCH", `/api/agents/${agent.id}`, { intro: "x" })).toEqual(limited);
    expect(await createAgent(app, a)).toEqual(limited);
    expect(await api(app, a, "DELETE", `/api/agents/${agent.id}`)).toEqual(limited);
    expect(await api(app, a, "POST", `/api/conversations/${agent.conversationId}/topic`)).toEqual(limited);
    expect(await api(app, a, "POST", `/api/agents/${agent.id}/proposals/${randomUUID()}/confirm`)).toEqual(limited);
    expect(await api(app, a, "POST", `/api/agents/${agent.id}/proposals/${randomUUID()}/discard`)).toEqual(limited);
    expect((await api(app, a, "GET", "/api/agents")).status).toBe(200);
    expect((await api(app, a, "GET", `/api/agents/${agent.id}`)).status).toBe(200);
    expect((await createAgent(app, b)).status).toBe(201);
  });

  it("counts setting and removing an appellation in the same budget as editing the Agent, refused ones too", async () => {
    const a = await signUp(app, "rate_e");
    const agent = await mustCreateAgent(app, a); // 1
    for (let i = 2; i <= 28; i++) expect((await api(app, a, "PATCH", `/api/agents/${agent.id}`, { intro: `v${i}` })).status).toBe(200);
    // Refused for its target, and still counted.
    expect((await api(app, a, "PUT", `/api/agents/${agent.id}/appellations/${randomUUID()}`, { appellation: "称" })).status).toBe(404); // 29
    expect((await api(app, a, "DELETE", `/api/agents/${agent.id}/appellations/${randomUUID()}`)).status).toBe(200); // 30
    const limited = { status: 429, json: { error: "rate_limited" } };
    expect(await api(app, a, "PUT", `/api/agents/${agent.id}/appellations/${randomUUID()}`, { appellation: "称" })).toEqual(limited);
    expect(await api(app, a, "DELETE", `/api/agents/${agent.id}/appellations/${randomUUID()}`)).toEqual(limited);
    expect(await api(app, a, "PATCH", `/api/agents/${agent.id}`, { intro: "x" })).toEqual(limited);
  });

  it("allows 5 persona drafts a minute per principal, a budget of their own", async () => {
    const [c, d] = [await signUp(app, "rate_c"), await signUp(app, "rate_d")];
    const draft = (who: typeof c) => api(app, who, "POST", "/api/agents/draft-persona", { name: "x", model: { source: "site", id: "nope" } });
    // Refused for its model, and still counted.
    for (let i = 1; i <= 5; i++) expect((await draft(c)).status).toBe(400);
    expect(await draft(c)).toEqual({ status: 429, json: { error: "rate_limited" } });
    expect((await createAgent(app, c)).status).toBe(201);
    expect((await draft(d)).status).toBe(400);
  });
});
