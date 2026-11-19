import type { FastifyBaseLogger } from "fastify";
import { lockAccount } from "../accounts/store.ts";
import { contextBudget } from "../agents/runtime/context.ts";
import { UNAVAILABLE } from "../agents/runtime/port.ts";
import type { Config, SiteModel } from "../config.ts";
import type { Db } from "../db.ts";
import { AppError } from "../errors.ts";
import { admitRun } from "../metering/admit.ts";
import { estimateTokens } from "../metering/prices.ts";
import { settle, type Usage } from "../metering/settle.ts";
import { ModelError, type ModelErrorCode, type ModelGateway } from "../models/gateway.ts";
import { resolveModel, type Resolved } from "../models/resolve.ts";
import { KeyUnreadableError } from "../providers/crypto.ts";

/**
 * The one way an Agent's memory calls a model in the background (a review of what the owner said, a consolidation).
 * It is paid for as a reply and a persona draft are (`draftPersona`, README "Usage and points"): an `agent_runs` row of
 * purpose `memory` with no Agent and no conversation, belonging to the Agent's owner in the owner's own lane, admitted
 * against the owner's allowance or balance and settled on what the upstream reported. Nothing else of memory calls a
 * model on the owner's account.
 */

/**
 * The site model memory calls use: `MEMORY.model` when it names a site model, else the free-tier site model that costs
 * least per token (input plus output price; the lowest id among equals), else null.
 */
export function memoryModel(config: Pick<Config, "siteModels" | "memory">): SiteModel | null {
  const named = config.memory.model;
  if (named !== null) {
    const site = config.siteModels.find((m) => m.id === named);
    if (site) return site;
  }
  let cheapest: SiteModel | null = null;
  for (const m of config.siteModels) {
    if (m.tier !== "free") continue;
    if (cheapest === null) {
      cheapest = m;
      continue;
    }
    const price = m.inputMicroPerToken + m.outputMicroPerToken;
    const best = cheapest.inputMicroPerToken + cheapest.outputMicroPerToken;
    if (price < best || (price === best && m.id < cheapest.id)) cheapest = m;
  }
  return cheapest;
}

export interface MemoryCallDeps {
  db: Db;
  config: Config;
  models: Pick<ModelGateway, "stream">;
  log: Pick<FastifyBaseLogger, "error" | "warn">;
  /** The memory calls this process is working on, by run id (the stale-run sweep leaves them alone). */
  inFlight: Set<string>;
}

export interface MemoryCallInput {
  system: string;
  user: string;
  maxOutputTokens: number;
}

/** The calls under way, each with what settles once it has ended: `endMemoryCalls` waits for them. */
const underWay = new Set<Promise<unknown>>();

/** Resolves once every memory call under way has ended (each is told to by its `closing` signal; for `preClose`). */
export async function endMemoryCalls(): Promise<void> {
  while (underWay.size > 0) await Promise.allSettled([...underWay]);
}

/**
 * One metered model call for `ownerId`; the model's text, trimmed, or null — after settling whatever was used — when
 * there is no model to call (none configured, its key unset), the owner has no quota, the owner already has as many
 * calls running as `agentMaxConcurrentRuns`, the input does not fit the model's context, the call failed or timed out
 * (`agentRunTimeoutMs`), the answer was cut at its limit, or it said nothing. Never throws for any of these.
 *
 * 1. One transaction: the run is inserted `running` (purpose `memory`, lane `own`); under the owner's account lock the
 *    model is resolved, the concurrent-run cap checked, and the call admitted (402 `no_quota`). Any refusal rolls all
 *    of it back: nothing recorded, nothing called.
 * 2. The call, outside any transaction, reasoning `none`, its output limited to `input.maxOutputTokens` (or the
 *    model's own, if lower) — the limit admission holds for. When `closing` aborts (the service is stopping), the
 *    call is abandoned and the run ended `failed`, nothing charged, as recovery ends one.
 * 3. One transaction: `settle`d (a failed call is charged only what the upstream reported) and the run ended.
 */
export async function memoryCall(deps: MemoryCallDeps, ownerId: string, input: MemoryCallInput, closing: AbortSignal): Promise<string | null> {
  const call = callOnce(deps, ownerId, input, closing);
  underWay.add(call);
  try {
    return await call;
  } finally {
    underWay.delete(call);
  }
}

async function callOnce(deps: MemoryCallDeps, ownerId: string, input: MemoryCallInput, closing: AbortSignal): Promise<string | null> {
  const { db, config, models, log, inFlight } = deps;
  const { system, user } = input;
  const inputChars = estimateTokens(system) + estimateTokens(user);
  const model = memoryModel(config);
  if (model === null || closing.aborted) return null;

  let started: { runId: string; resolved: Resolved } | null;
  try {
    started = await db.tx(async (t) => {
      const inserted = await t.query<{ id: string }>(
        "insert into agent_runs (purpose, owner_id, status, started_at, caller_id, lane) values ('memory', $1, 'running', now(), $1, 'own') returning id",
        [ownerId],
      );
      const runId = inserted.rows[0]!.id;
      await lockAccount(t, ownerId);
      let resolved: Resolved | null;
      try {
        resolved = await resolveModel(t, config, { model: { source: "site", id: model.id }, ownerId });
      } catch (err) {
        if (!(err instanceof KeyUnreadableError)) throw err;
        log.error({ err }, "memory call: the model's saved key cannot be opened");
        throw new AppError(502, "provider_rejected");
      }
      if (!resolved) throw new AppError(502, "provider_unavailable");
      const others = await t.query<{ n: number }>(
        "select count(*)::int as n from agent_runs where owner_id = $1 and status = 'running' and id <> $2",
        [ownerId, runId],
      );
      if (others.rows[0]!.n >= config.agentMaxConcurrentRuns) throw new AppError(429, "rate_limited");
      // The output the call is sent, and the hold admission takes, are the same limit.
      const sized: Resolved = { ...resolved, call: { ...resolved.call, maxOutputTokens: Math.min(input.maxOutputTokens, resolved.call.maxOutputTokens) } };
      if (contextBudget(sized.contextTokens, sized.call.maxOutputTokens, system) < estimateTokens(user)) {
        throw new AppError(400, "context_too_small");
      }
      await admitRun(t, config, runId, ownerId, sized, inputChars, new Date());
      return { runId, resolved: sized };
    });
  } catch (err) {
    // No model, no quota, too many calls running: nothing is recorded (the transaction rolled back).
    if (!(err instanceof AppError)) log.error({ err, ownerId }, "memory call: could not be started");
    else if (err.status === 400) log.warn({ ownerId }, "memory call: the input does not fit the model's context; skipped");
    return null;
  }
  if (started === null) return null;

  inFlight.add(started.runId);
  try {
    const deadline = AbortSignal.timeout(config.agentRunTimeoutMs);
    let text = "";
    let reasoning = "";
    let finished: { usage: Usage | null; truncated: boolean } | null = null;
    let failure: ModelErrorCode | null = null;
    try {
      const stream = models.stream({
        ...started.resolved.call,
        system,
        messages: [{ role: "user", parts: [{ type: "text", text: user }] }],
        reasoning: "none",
        signal: AbortSignal.any([closing, deadline]),
      });
      for await (const event of stream) {
        if (event.type === "finish") {
          finished = { usage: event.usage, truncated: event.truncated };
          break;
        }
        if (event.type === "text") text += event.delta;
        else reasoning += event.delta;
      }
    } catch (err) {
      if (!closing.aborted && !deadline.aborted) {
        failure = err instanceof ModelError ? err.code : "provider_unavailable";
        // A failure the upstream reported usage for (`thinking_exhausted`) is charged that usage.
        if (err instanceof ModelError && err.usage) finished = { usage: err.usage, truncated: false };
        if (!(err instanceof ModelError)) log.error({ err, runId: started.runId }, "memory call: the model call failed unexpectedly");
      }
    }

    // The service is closing: the call is abandoned and the run ended as recovery ends one, nothing charged.
    const abandoned = closing.aborted;
    const answer = text.trim();
    const end =
      failure !== null
        ? ({ status: "failed", error: failure } as const)
        : abandoned || finished === null || answer === ""
          ? UNAVAILABLE
          : ({ status: "done" } as const);
    const outputChars = end.status === "done" ? text.length + reasoning.length : 0;
    try {
      await db.tx(async (t) => {
        const now = await t.query<{ status: string }>("select status from agent_runs where id = $1 for update", [started.runId]);
        // Ended elsewhere meanwhile (recovery, the stale-run sweep): settled there already.
        if (now.rows[0]?.status !== "running") return;
        await settle(t, config, started.runId, finished?.usage ?? null, { inputChars, outputChars }, end.status, new Date(), { forgiveAll: abandoned, log });
        await t.query("update agent_runs set status = $2, error = $3, finished_at = now() where id = $1", [
          started.runId,
          end.status,
          end.status === "failed" ? end.error : null,
        ]);
      });
    } catch (err) {
      log.error({ err, runId: started.runId }, "memory call: could not be settled; the run stays running until the stale-run sweep or the next start releases it");
      return null;
    }
    if (end.status !== "done" || finished?.truncated === true) return null;
    return answer;
  } finally {
    inFlight.delete(started.runId);
  }
}
