import type { FastifyBaseLogger } from "fastify";
import type { Config, SiteModel } from "../config.ts";
import type { Db, Queryable } from "../db.ts";
import { AppError } from "../errors.ts";
import { memoryLeft } from "../metering/admit.ts";
import { ownerCall } from "../metering/owner-call.ts";
import type { ModelGateway } from "../models/gateway.ts";
import { resolveModel, type Resolved } from "../models/resolve.ts";
import { KeyUnreadableError } from "../providers/crypto.ts";
import { count } from "./stats.ts";
import { getMemoryModel, type MemoryModelChoice } from "./store.ts";

/**
 * The one way an Agent's memory calls a model in the background (a review of what the owner said, a consolidation).
 * It is metered as a reply and a persona draft are (`draftPersona`, README "Usage and points"): an `agent_runs` row of
 * purpose `memory` with no Agent and no conversation, belonging to the Agent's owner in the owner's own lane, admitted
 * against the owner's MEMORY allowance (`memory_usage`, paid by the site: never the owner's free allowance or balance) and
 * settled on what the upstream reported. Nothing else of memory calls a model on the owner's account.
 *
 * Whose model: the owner's own choice (`accounts.memory_model`, a model they could give an Agent: a site model or a
 * model of their own provider) when they made one, else the site's memory model. A choice that cannot be used is never
 * replaced by the site's model — that would spend what the owner chose not to spend: the call is not made. A site model is
 * charged to the memory allowance, a model of their own provider costs the site nothing (`admitRun`).
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

/**
 * The model a call for `ownerId` is made on, ready to call: their choice `own`, else the site's memory model; null when there
 * is none or it does not resolve now (a provider deleted, a model off its list or removed from the site, a site key
 * unset). Throws `KeyUnreadableError` when a provider's saved key cannot be opened.
 */
async function modelFor(q: Queryable, config: Config, ownerId: string, own: MemoryModelChoice | null): Promise<Resolved | null> {
  const site = memoryModel(config);
  const choice: MemoryModelChoice | null = own ?? (site ? { source: "site", id: site.id } : null);
  return choice === null ? null : resolveModel(q, config, { model: choice, ownerId });
}

/**
 * Whether the owner's chosen model `own` (`GET /api/me` `memoryModelUsable`) can be called now; true when they chose none.
 * The static part of a call's checks: it resolves and its context holds its own output (a call's input is judged per call).
 */
export async function memoryModelUsable(q: Queryable, config: Config, ownerId: string, own: MemoryModelChoice | null): Promise<boolean> {
  if (own === null) return true;
  try {
    const resolved = await modelFor(q, config, ownerId, own);
    return resolved !== null && resolved.contextTokens > resolved.call.maxOutputTokens;
  } catch (err) {
    if (err instanceof KeyUnreadableError) return false;
    throw err;
  }
}

/**
 * Whether a memory call for `ownerId` would be refused for the memory allowance right now: its model, resolved as `memoryCall` resolves
 * it, is a site model, and the allowance of the site day `now` is in has nothing left (`memoryLeft`). False for a model of the owner's
 * own provider (never limited by the allowance) and when there is no model to call (that refusal is another one). Reads only, no lock:
 * a cheap look before something else is spent on a call (admission decides, under the lock).
 */
export async function allowanceRefuses(q: Queryable, config: Config, ownerId: string, now: Date): Promise<boolean> {
  const own = await getMemoryModel(q, ownerId);
  // A provider's model is never charged to the allowance: nothing to look at (and its saved key is not opened for it).
  if (own?.source === "provider") return false;
  const resolved = await modelFor(q, config, ownerId, own);
  if (resolved === null || resolved.source !== "site") return false;
  return (await memoryLeft(q, config, ownerId, now)) <= 0n;
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
 * there is no model to call (none configured, its key unset), the memory allowance is spent, the owner already has as many
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
export async function memoryCall(
  deps: MemoryCallDeps,
  ownerId: string,
  input: MemoryCallInput,
  closing: AbortSignal,
  report?: MemoryCallReport,
): Promise<string | null> {
  const call = callOnce(deps, ownerId, input, closing, report);
  underWay.add(call);
  try {
    return await call;
  } finally {
    underWay.delete(call);
  }
}

/**
 * What a caller may ask to be told of a call that returned nothing: `answered` is set when the model did answer (and was
 * charged for it) but what it said cannot be used — cut at its limit, or empty. A call that could not be made, failed, or
 * was abandoned leaves it false.
 */
export interface MemoryCallReport {
  answered: boolean;
  /** Set when no call was started because the owner's memory allowance was empty (counted as `memory_refused_allowance`, no failure). */
  refused?: boolean;
}

async function callOnce(deps: MemoryCallDeps, ownerId: string, input: MemoryCallInput, closing: AbortSignal, report?: MemoryCallReport): Promise<string | null> {
  const { config, log } = deps;
  if (closing.aborted) return null;

  const outcome = await ownerCall(
    deps,
    {
      purpose: "memory",
      label: "memory call",
      ownerId,
      system: input.system,
      user: input.user,
      choose: async (t) => modelFor(t, config, ownerId, await getMemoryModel(t, ownerId)),
      keyUnreadableMessage: "memory call: the model's saved key cannot be opened",
      maxOutputTokens: input.maxOutputTokens,
      deadlineMs: config.agentRunTimeoutMs,
      keepAnswerOnTimeout: false,
      answer: (text) => text.trim() || null,
      measure: (text) => text.length,
    },
    closing,
  );
  if (outcome.kind === "not_started") {
    // No model, no quota, too many calls running: nothing is recorded (the transaction rolled back).
    const err = outcome.error;
    if (err instanceof AppError && err.status === 402) {
      count(deps.db, "memory_refused_allowance");
      if (report) report.refused = true;
    }
    if (!(err instanceof AppError)) log.error({ err, ownerId }, "memory call: could not be started");
    else if (err.status === 400) log.warn({ ownerId }, "memory call: the input does not fit the model's context; skipped");
    return null;
  }
  if (outcome.kind !== "ended") return null;
  if (report && outcome.answered) report.answered = true;
  if (outcome.end.status !== "done" || outcome.truncated) return null;
  return outcome.answer;
}
