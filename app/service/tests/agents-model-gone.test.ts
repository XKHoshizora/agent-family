import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, group, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { scriptedGateway } from "./helpers/models.ts";
import { providerBody } from "./helpers/providers.ts";

/**
 * An Agent whose model is gone (reverse-paths audit C6, C8): its provider model taken off the provider's list, or a site
 * model no longer configured. A reply on it fails `model_gone`, which trying again as it is cannot change (not
 * retryable), with no call and nothing charged; its owner's view of it says `modelUsable: false` until they choose
 * another; members who call it in a group are told only that it cannot reply (`unavailable`), as for any failure.
 */

const gateway = scriptedGateway();
const { app, db } = useApp({ env: SITE_ENV, models: gateway, agentWorker: false });

let first = 0;
beforeEach(() => {
  first = gateway.calls.length;
});
afterEach(() => {
  vi.restoreAllMocks();
  expect(gateway.pending()).toBe(0);
});

const FAST = { source: "site", id: "fast" } as const;
let txn = 0;
const say = async (who: Actor, conv: string, text: string): Promise<void> => {
  const sent = await api(app, who, "POST", `/api/conversations/${conv}/messages`, { text, clientTxn: `mg${++txn}` });
  if (sent.status !== 201) throw new Error(`say: ${sent.status} ${JSON.stringify(sent.json)}`);
};
const view = async (who: Actor, agentId: string) => (await api(app, who, "GET", `/api/agents/${agentId}`)).json;
const listed = async (who: Actor, agentId: string) => (await api(app, who, "GET", "/api/agents")).json.agents.find((a: { id: string }) => a.id === agentId);
const charged = async (agentId: string): Promise<string> =>
  (
    await db.query<{ n: string }>(
      "select coalesce(sum(u.free_micro + u.balance_micro), 0)::text as n from usage_records u join agent_runs r on r.id = u.run_id where r.agent_id = $1",
      [agentId],
    )
  ).rows[0]!.n;

/** An owner's provider with two models, and an Agent of theirs on the one (`gone-1`) that `trim` takes off the list. */
async function providerAgent(name: string, over: Record<string, unknown> = {}) {
  const owner = await signUp(app, name);
  const created = await api(app, owner, "POST", "/api/providers", providerBody({ models: [{ name: "keep-1" }, { name: "gone-1" }] }));
  expect(created.status).toBe(201);
  const provider = created.json.id as string;
  const agent = await mustCreateAgent(app, owner, { model: { source: "provider", providerId: provider, model: "gone-1" }, persona: "简短地回答。", ...over });
  const trim = async () => expect((await api(app, owner, "PATCH", `/api/providers/${provider}`, { models: [{ name: "keep-1" }] })).status).toBe(200);
  return { owner, provider, agent, trim };
}

/** Takes the Agent's site model out of what the site offers, as removing it from `SITE_MODELS` (and restarting) does. */
const retireSiteModel = (agentId: string) => db.query("update agents set site_model_id = 'retired_q7' where principal_id = $1", [agentId]);

describe("modelUsable, the owner's view of whether the Agent's model is there to call", () => {
  it("is true on a model that is there and with none chosen; false once its provider model is off the list (that edit is still allowed), in every view; true again once another is chosen", async () => {
    const w = await providerAgent("mg_owner");
    expect((await view(w.owner, w.agent.id)).modelUsable).toBe(true);
    expect(w.agent.modelUsable).toBe(true);
    expect((await mustCreateAgent(app, w.owner)).modelUsable).toBe(true);
    await w.trim();
    expect((await view(w.owner, w.agent.id)).modelUsable).toBe(false);
    expect((await listed(w.owner, w.agent.id)).modelUsable).toBe(false);
    // Its model stays as it was: the owner chooses again.
    expect((await view(w.owner, w.agent.id)).model).toEqual({ source: "provider", providerId: w.provider, model: "gone-1" });
    expect((await api(app, w.owner, "PATCH", `/api/agents/${w.agent.id}`, { intro: "x" })).json.modelUsable).toBe(false);
    const changed = await api(app, w.owner, "PATCH", `/api/agents/${w.agent.id}`, { model: { source: "provider", providerId: w.provider, model: "keep-1" } });
    expect(changed.json.modelUsable).toBe(true);
  });

  it("is false on a site model no longer configured", async () => {
    const owner = await signUp(app, "mg_site");
    const agent = await mustCreateAgent(app, owner, { model: FAST, persona: "简短地回答。" });
    await retireSiteModel(agent.id);
    expect((await view(owner, agent.id)).modelUsable).toBe(false);
    expect((await listed(owner, agent.id)).modelUsable).toBe(false);
  });

  it("a provider edit of its models (one that takes an Agent's model off the list, say) pushes the Agents on it to their owner, so their pages read it again", async () => {
    const w = await providerAgent("mg_push");
    // Another of the owner's Agents, on a site model: not pushed.
    await mustCreateAgent(app, w.owner, { model: FAST });
    const pushed = vi.spyOn(app.realtime, "pushAgentChanged");
    await w.trim();
    expect(pushed.mock.calls).toEqual([[w.owner.id, w.agent.id]]);
    // An edit that leaves its model on the list pushes nothing.
    pushed.mockClear();
    expect((await api(app, w.owner, "PATCH", `/api/providers/${w.provider}`, { name: "改个名字" })).status).toBe(200);
    expect(pushed).not.toHaveBeenCalled();
  });
});

describe("a reply on a model that is gone", () => {
  it("in its own conversation: fails model_gone, not retryable, with no call, nothing charged and no message", async () => {
    const w = await providerAgent("mg_own");
    await w.trim();
    await say(w.owner, w.agent.conversationId, "在吗？");
    expect(await app.agentWorker.runOnce()).toBe(true);
    expect(gateway.calls.length).toBe(first);
    const { run } = (await api(app, w.owner, "GET", `/api/conversations/${w.agent.conversationId}/run`)).json;
    expect(run).toMatchObject({ status: "failed", error: "model_gone", retryable: false });
    expect(await charged(w.agent.id)).toBe("0");
    expect((await db.query("select 1 from messages where sender_id = $1 and kind = 'text'", [w.agent.id])).rowCount).toBe(0);
  });

  it("on a site model no longer configured: the same", async () => {
    const owner = await signUp(app, "mg_site2");
    const agent = await mustCreateAgent(app, owner, { model: FAST, persona: "简短地回答。" });
    await retireSiteModel(agent.id);
    await say(owner, agent.conversationId, "在吗？");
    expect(await app.agentWorker.runOnce()).toBe(true);
    expect(gateway.calls.length).toBe(first);
    expect((await api(app, owner, "GET", `/api/conversations/${agent.conversationId}/run`)).json.run).toMatchObject({
      status: "failed",
      error: "model_gone",
      retryable: false,
    });
  });

  it("in a group: a member who calls it is told only that it cannot reply, one line however often they call; its owner sees model_gone, not retryable", async () => {
    const w = await providerAgent("mg_group", { handle: "gone_bot", name: "小去" });
    const [member, third] = [await signUp(app, "mg_member"), await signUp(app, "mg_third")];
    const g = await group(app, w.owner, "team", [member, third]);
    expect((await api(app, w.owner, "POST", `/api/conversations/${g}/members`, { principalId: w.agent.id })).status).toBe(201);
    await w.trim();
    for (const text of ["@gone_bot 帮我看看", "@gone_bot 还在吗"]) {
      await say(member, g, text);
      expect(await app.agentWorker.runOnce()).toBe(true);
    }
    expect(gateway.calls.length).toBe(first);
    expect((await api(app, member, "GET", `/api/conversations/${g}/runs`)).json.runs).toEqual([{ agentId: w.agent.id, state: "unavailable" }]);
    const mine = (await api(app, w.owner, "GET", `/api/conversations/${g}/runs`)).json.runs;
    expect(mine).toEqual([{ agentId: w.agent.id, state: "unavailable", run: expect.objectContaining({ status: "failed", error: "model_gone", retryable: false }) }]);
    expect(await charged(w.agent.id)).toBe("0");
  });
});
