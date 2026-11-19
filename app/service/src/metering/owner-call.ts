import type { FastifyBaseLogger } from "fastify";
import { lockAccount } from "../accounts/store.ts";
import { contextBudget } from "../agents/runtime/context.ts";
import { UNAVAILABLE } from "../agents/runtime/port.ts";
import type { Config } from "../config.ts";
import type { Db, Tx } from "../db.ts";
import { AppError } from "../errors.ts";
import { ModelError, type ModelErrorCode, type ModelGateway } from "../models/gateway.ts";
import type { Resolved } from "../models/resolve.ts";
import { KeyUnreadableError } from "../providers/crypto.ts";
import { admitRun } from "./admit.ts";
import { estimateTokens } from "./prices.ts";
import { settle, type Usage } from "./settle.ts";

/**
 * A metered owner call: a model call that is not a chat reply, metered to an owner in the owner's own lane (a persona draft, charged to
 * the owner; a memory review, charged to the memory allowance the site pays). One `agent_runs` row (no Agent, no conversation) goes through the same three steps as a reply does:
 *
 * 1. One transaction: the run is inserted `running`; under the owner's account lock the model is chosen and resolved
 *    (`spec.choose`; none to call: 502 `provider_unavailable`; a saved key that cannot be opened: 502
 *    `provider_rejected`), the owner's calls running at once must be fewer than `agentMaxConcurrentRuns` (429
 *    `rate_limited`), the context must hold the input (400 `context_too_small`), then admission (402 `no_quota`). Any
 *    refusal rolls all of it back: nothing recorded, nothing called.
 * 2. The call, outside any transaction, reasoning `none`, ended after `spec.deadlineMs`.
 * 3. One transaction: settled (`settle`: a failed call is charged only what the upstream reported) and the run ended.
 *
 * What the callers differ in is parameters of `ownerCall`; what to do with the outcome is theirs. Nothing here throws
 * for what goes wrong in the three steps: each is a kind of `OwnerCallOutcome`.
 */

export interface OwnerCallDeps {
  db: Db;
  config: Config;
  models: Pick<ModelGateway, "stream">;
  log: Pick<FastifyBaseLogger, "error" | "warn">;
  /** The calls this process is working on, by run id (the stale-run sweep leaves them alone). */
  inFlight: Set<string>;
}

export interface OwnerCallSpec {
  /** The run's `purpose`; the log lines are prefixed `label` (`"persona draft"`, `"memory call"`). */
  purpose: "draft" | "memory";
  label: string;
  ownerId: string;
  system: string;
  user: string;
  /** In the start transaction, under the account lock: the model the call is made on, or null when there is none. May throw `AppError` (400 for a choice that is not allowed). */
  choose(t: Tx): Promise<Resolved | null>;
  /** The log line (an error) for a saved key that cannot be opened. */
  keyUnreadableMessage: string;
  /** When given, the call's output limit is at most this (and what admission holds for is the same limit). */
  maxOutputTokens?: number;
  deadlineMs: number;
  /** A call that ran past `deadlineMs` after saying something has its answer used (it is `done`); otherwise it is `provider_unavailable`. */
  keepAnswerOnTimeout: boolean;
  /**
   * What of the model's text is the answer: the cleaned text, or null when it holds nothing usable (the run then ends
   * `provider_unavailable`).
   */
  answer(text: string): string | null;
  /** The size of a piece of output text for the estimate used when the upstream reported no usage. */
  measure(text: string): number;
  /**
   * What happens when `closing` aborts (the service is stopping). Given: the call is handed to it (it ends the run as it
   * sees fit) and the outcome is `closed`; the run is not settled here. Absent: the call is abandoned and settled
   * here as recovery settles a run, `failed` / `provider_unavailable`, nothing charged.
   */
  onClosing?(runId: string): Promise<void>;
}

export type OwnerCallOutcome =
  /** The start transaction was refused or failed; nothing was recorded. */
  | { kind: "not_started"; error: unknown }
  /** `closing` aborted the call and `onClosing` took it. */
  | { kind: "closed" }
  /** The settle transaction failed (logged here); the run stays `running` until the stale-run sweep or the next start. */
  | { kind: "unsettled"; error: unknown }
  | {
      kind: "ended";
      runId: string;
      /** How the run ended. `failed` carries the code: a `ModelErrorCode` (`UNAVAILABLE` included). */
      end: { status: "done" } | { status: "failed"; error: ModelErrorCode };
      /** `spec.answer` of the text; null when it held nothing usable. */
      answer: string | null;
      /** The model reported its end (`finish`), and no failure came; `abandoned` is false. */
      answered: boolean;
      /** The answer was cut at the model's limit. */
      truncated: boolean;
      /** Set when the run was no longer `running` at settlement (ended elsewhere, so settled there): its status then, or `gone`. */
      endedElsewhere: string | null;
    };

/** One metered owner call; see the file comment. */
export async function ownerCall(deps: OwnerCallDeps, spec: OwnerCallSpec, closing: AbortSignal): Promise<OwnerCallOutcome> {
  const { db, config, models, log, inFlight } = deps;
  const { ownerId, system, user, label } = spec;
  const inputChars = estimateTokens(system) + estimateTokens(user);

  let started: { runId: string; call: Resolved["call"] };
  try {
    started = await db.tx(async (t) => {
      const inserted = await t.query<{ id: string }>(
        "insert into agent_runs (purpose, owner_id, status, started_at, caller_id, lane) values ($2, $1, 'running', now(), $1, 'own') returning id",
        [ownerId, spec.purpose],
      );
      const runId = inserted.rows[0]!.id;
      await lockAccount(t, ownerId);
      let resolved: Resolved | null;
      try {
        resolved = await spec.choose(t);
      } catch (err) {
        if (!(err instanceof KeyUnreadableError)) throw err;
        // As a key the provider refused: its owner must save it again.
        log.error({ err }, spec.keyUnreadableMessage);
        throw new AppError(502, "provider_rejected");
      }
      if (!resolved) throw new AppError(502, "provider_unavailable");
      const others = await t.query<{ n: number }>(
        "select count(*)::int as n from agent_runs where owner_id = $1 and status = 'running' and id <> $2",
        [ownerId, runId],
      );
      if (others.rows[0]!.n >= config.agentMaxConcurrentRuns) throw new AppError(429, "rate_limited");
      // The output the call is sent, and the hold admission takes, are the same limit.
      const sized: Resolved =
        spec.maxOutputTokens === undefined
          ? resolved
          : { ...resolved, call: { ...resolved.call, maxOutputTokens: Math.min(spec.maxOutputTokens, resolved.call.maxOutputTokens) } };
      if (contextBudget(sized.contextTokens, sized.call.maxOutputTokens, system) < estimateTokens(user)) {
        throw new AppError(400, "context_too_small");
      }
      await admitRun(t, config, runId, ownerId, sized, inputChars, new Date());
      return { runId, call: sized.call };
    });
  } catch (error) {
    return { kind: "not_started", error };
  }

  // From here until the call has ended, the run is this process's: the stale-run sweep leaves it alone.
  inFlight.add(started.runId);
  try {
    const deadline = AbortSignal.timeout(spec.deadlineMs);
    let text = "";
    let reasoning = "";
    let finished: { usage: Usage | null; truncated: boolean } | null = null;
    let failure: ModelErrorCode | null = null;
    try {
      const stream = models.stream({
        ...started.call,
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
      if (spec.onClosing && closing.aborted) {
        await spec.onClosing(started.runId);
        return { kind: "closed" };
      }
      if (!closing.aborted && !deadline.aborted) {
        failure = err instanceof ModelError ? err.code : "provider_unavailable";
        // A failure the upstream reported usage for (`thinking_exhausted`) is charged that usage.
        if (err instanceof ModelError && err.usage) finished = { usage: err.usage, truncated: false };
        if (!(err instanceof ModelError)) log.error({ err, runId: started.runId }, `${label}: the model call failed unexpectedly`);
      }
    }

    // Without `onClosing`, a call the closing service aborted is abandoned: ended as recovery ends one, nothing charged.
    const abandoned = !spec.onClosing && closing.aborted;
    const answer = spec.answer(text);
    const end =
      failure !== null
        ? ({ status: "failed", error: failure } as const)
        : abandoned || (finished === null && !(spec.keepAnswerOnTimeout && deadline.aborted)) || answer === null
          ? UNAVAILABLE
          : ({ status: "done" } as const);
    const outputChars = end.status === "done" ? spec.measure(text) + spec.measure(reasoning) : 0;
    let endedElsewhere: string | null = null;
    try {
      await db.tx(async (t) => {
        // The run row first (the order `settle` keeps): one that is no longer running was ended elsewhere meanwhile —
        // another instance's recovery or the stale-run sweep settled it already; nothing more is recorded.
        const now = await t.query<{ status: string }>("select status from agent_runs where id = $1 for update", [started.runId]);
        if (now.rows[0]?.status !== "running") {
          endedElsewhere = now.rows[0]?.status ?? "gone";
          return;
        }
        await settle(t, config, started.runId, finished?.usage ?? null, { inputChars, outputChars }, end.status, new Date(), { forgiveAll: abandoned, log });
        await t.query("update agent_runs set status = $2, error = $3, finished_at = now() where id = $1", [
          started.runId,
          end.status,
          end.status === "failed" ? end.error : null,
        ]);
      });
    } catch (error) {
      // Nothing of it was recorded: the run stays running, its hold counting, until the stale-run sweep or the next start
      // releases it.
      log.error({ err: error, runId: started.runId }, `${label}: could not be settled; the run stays running until the stale-run sweep or the next start releases it`);
      return { kind: "unsettled", error };
    }
    return {
      kind: "ended",
      runId: started.runId,
      end,
      answer,
      answered: failure === null && !abandoned && finished !== null,
      truncated: finished?.truncated === true,
      endedElsewhere,
    };
  } finally {
    inFlight.delete(started.runId);
  }
}
