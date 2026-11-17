import { afterEach, describe, expect, it } from "vitest";
import { api, signUp } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { scriptedGateway } from "./helpers/models.ts";

/**
 * A model that used its whole output limit thinking (`thinking_exhausted`, src/models/gateway.ts): a reply ends
 * `failed` with that code, retryable, nothing posted, charged the usage the upstream reported, as a failed answer is;
 * a persona draft answers 502 with it, charged the same way. The `fast` site model costs 1 micro-point per input token
 * and 2 per output token.
 */

const gateway = scriptedGateway();
const { app, db } = useApp({ env: SITE_ENV, models: gateway, agentWorker: false });
afterEach(() => expect(gateway.pending()).toBe(0));

const FAST = { source: "site", id: "fast" } as const;
const USAGE = { inputTokens: 11, outputTokens: 19 };

const recordsOf = async (ownerId: string) =>
  (
    await db.query(
      `select purpose, outcome, estimated, input_tokens::int as input, output_tokens::int as output, cost_micro::text as cost
         from usage_records where owner_id = $1 order by id`,
      [ownerId],
    )
  ).rows;
const held = async () => (await db.query<{ h: string }>("select coalesce(sum(hold_micro), 0)::text as h from agent_runs")).rows[0]!.h;

describe("thinking_exhausted", () => {
  it("a reply: failed thinking_exhausted, retryable, nothing posted, charged the reported usage", async () => {
    const owner = await signUp(app, "thinker");
    const agent = await mustCreateAgent(app, owner, { model: FAST, persona: "简短地回答。" });
    gateway.fail("thinking_exhausted", { usage: USAGE });
    expect((await api(app, owner, "POST", `/api/conversations/${agent.conversationId}/messages`, { text: "想一想", clientTxn: "t1" })).status).toBe(201);
    expect(await app.agentWorker.runOnce()).toBe(true);

    const run = (await api(app, owner, "GET", `/api/conversations/${agent.conversationId}/run`)).json.run;
    expect(run).toEqual({ id: run.id, status: "failed", error: "thinking_exhausted", retryable: true });
    const messages = (await api(app, owner, "GET", `/api/conversations/${agent.conversationId}/messages`)).json.messages;
    expect(messages.filter((m: { senderId: string }) => m.senderId === agent.id)).toEqual([]);
    expect(await recordsOf(owner.id)).toEqual([{ purpose: "reply", outcome: "failed", estimated: false, input: 11, output: 19, cost: String(11 * 1 + 19 * 2) }]);
    expect(await held()).toBe("0");
  });

  it("a persona draft: 502 thinking_exhausted, charged the reported usage", async () => {
    const owner = await signUp(app, "drafter");
    gateway.fail("thinking_exhausted", { usage: USAGE });
    expect(await api(app, owner, "POST", "/api/agents/draft-persona", { name: "x", model: FAST })).toEqual({ status: 502, json: { error: "thinking_exhausted" } });
    expect(await recordsOf(owner.id)).toEqual([{ purpose: "draft", outcome: "failed", estimated: false, input: 11, output: 19, cost: String(11 * 1 + 19 * 2) }]);
    expect(await held()).toBe("0");
  });
});
