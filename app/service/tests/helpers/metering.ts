import type { FastifyInstance } from "fastify";
import { applyLedger, lockAccount } from "../../src/accounts/store.ts";
import { readOwnedAgent } from "../../src/agents/store.ts";
import type { Db } from "../../src/db.ts";
import { resolveModel, type Resolved } from "../../src/models/resolve.ts";
import type { Actor } from "./actors.ts";
import { mustCreateAgent } from "./agents.ts";

const meterModel = (id: string, tier: "free" | "paid") => ({
  id,
  label: id,
  tier,
  protocol: "openai_chat",
  baseUrl: "https://api.example.test/v1",
  apiKeyEnv: "METER_UPSTREAM_KEY",
  model: `upstream-${id}`,
  inputMicroPerToken: 100,
  outputMicroPerToken: 1000,
  maxOutputTokens: 1000,
  contextTokens: 100000,
  vision: false,
  pdf: false,
  reasoning: [],
});

/**
 * Environment of the metering tests: a free-tier and a paid-tier site model at the same prices (100 and 1 000
 * micro-points per input and output token, at most 1 000 output tokens) and a free allowance of 3 points a day in
 * Shanghai. With an input estimate of `ESTIMATE` tokens one call can cost at most `MAX_COST` (2 points), so the
 * allowance is 1.5 times one reply's maximum cost.
 */
export const METER_ENV = {
  METER_UPSTREAM_KEY: "not-a-real-key",
  FREE_DAILY_POINTS: "3",
  SITE_TIMEZONE: "Asia/Shanghai",
  SITE_MODELS: JSON.stringify([meterModel("meter_free", "free"), meterModel("meter_paid", "paid")]),
} as const;

export const ESTIMATE = 10_000;
export const MAX_COST = 2_000_000n;
/** Reported usage that costs exactly `MAX_COST` on either meter model. */
export const FULL_USAGE = { inputTokens: 10_000, outputTokens: 1_000 } as const;
/** Reported usage far above what any call holds: 15 points on either meter model (an estimate gone wrong). */
export const OVER_USAGE = { inputTokens: 100_000, outputTokens: 5_000 } as const;
/** What `usage` costs on either meter model. */
export const costOf = (usage: { inputTokens: number; outputTokens: number }): bigint =>
  BigInt(usage.inputTokens) * 100n + BigInt(usage.outputTokens) * 1000n;

export interface MeteredAgent {
  agentId: string;
  conversationId: string;
  resolved: Resolved;
}

/** A new Agent of `owner` whose model is `model`, with the model as `resolveModel` resolves it. */
export async function meteredAgent(
  app: FastifyInstance,
  db: Db,
  owner: Actor,
  model: { source: "site"; id: string } | { source: "provider"; providerId: string; model: string },
): Promise<MeteredAgent> {
  const created = await mustCreateAgent(app, owner, { model });
  const row = await readOwnedAgent(db, owner.id, created.id);
  const resolved = row && (await resolveModel(db, app.deps.config, row));
  if (!resolved) throw new Error("meteredAgent: the model did not resolve");
  return { agentId: created.id, conversationId: created.conversationId, resolved };
}

/** Inserts a run that is already `running`: a reply of `agent`, or without one a persona draft. Returns its id. */
export async function runningRun(db: Db, ownerId: string, agent?: Pick<MeteredAgent, "agentId" | "conversationId">): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into agent_runs (purpose, conversation_id, agent_id, owner_id, status, started_at)
     values ($1, $2, $3, $4, 'running', now()) returning id`,
    [agent ? "reply" : "draft", agent?.conversationId ?? null, agent?.agentId ?? null, ownerId],
  );
  return rows[0]!.id;
}

/** What the operator's `credits:grant` does: a ledger entry under the account lock. */
export function grant(db: Db, ownerId: string, micro: bigint): Promise<bigint> {
  return db.tx(async (t) => {
    await lockAccount(t, ownerId);
    return applyLedger(t, ownerId, micro, micro < 0n ? "adjust" : "grant", null);
  });
}
