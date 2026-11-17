import { describe, expect, it } from "vitest";
import { api, group, signUp } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";

// Scale 1: an owner's reads of their Agents, providers and replies share one budget of 120 a minute.
const { app } = useApp({ env: { ...SITE_ENV, RATE_LIMIT_SCALE: "1" }, agentWorker: false });

describe("reads of your Agents, providers and runs", () => {
  it("GET /api/agents, /api/agents/:id, /api/providers, /api/conversations/:id/run and a group's …/runs: 120 a minute together, then 429", async () => {
    const [a, b, c] = [await signUp(app, "reads_rl_a"), await signUp(app, "reads_rl_b"), await signUp(app, "reads_rl_c")];
    const agent = await mustCreateAgent(app, a, { model: { source: "site", id: "fast" }, persona: "简短。" });
    const g = await group(app, a, "team", [b, c]);
    const reads = ["/api/agents", `/api/agents/${agent.id}`, "/api/providers", `/api/conversations/${agent.conversationId}/run`, `/api/conversations/${g}/runs`];
    for (let i = 0; i < 120; i++) {
      const url = reads[i % reads.length]!;
      expect([i, url, (await api(app, a, "GET", url)).status]).toEqual([i, url, 200]);
    }
    for (const url of reads) expect([url, await api(app, a, "GET", url)]).toEqual([url, { status: 429, json: { error: "rate_limited" } }]);

    // Another person is unaffected, and so are the reader's other reads.
    expect((await api(app, b, "GET", "/api/agents")).status).toBe(200);
    expect((await api(app, b, "GET", `/api/conversations/${g}/runs`)).status).toBe(200);
    expect((await api(app, a, "GET", "/api/usage")).status).toBe(200);
    expect((await api(app, a, "GET", "/api/models")).status).toBe(200);
    expect((await api(app, a, "GET", "/api/me")).status).toBe(200);
  });
});
