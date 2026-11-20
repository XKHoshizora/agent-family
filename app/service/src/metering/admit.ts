import { freeUsedToday, lockAccount, memoryUsedToday, nextSiteMidnight } from "../accounts/store.ts";
import type { Config } from "../config.ts";
import type { Queryable, Tx } from "../db.ts";
import { AppError } from "../errors.ts";
import type { Resolved } from "../models/resolve.ts";
import { maxCostMicro } from "./prices.ts";

/**
 * Admission (spec 6.4): before a site-model call, in one transaction under the owner's account lock, decide the one
 * source it will charge — today's free allowance or the points balance, or for a memory call (purpose `memory`) the
 * memory allowance the site pays (`MEMORY.freeDailyPoints`), never the other two — and hold the most it can cost against
 * that source until it is settled (settle.ts). A run's hold counts while the run is `running`; settle it before, or in the
 * transaction that, moves it out of `running`. Because every call in flight holds its maximum cost and settlement
 * charges no call more than it held, what the owner's calls can overrun is bounded: the forgiven free overrun of a day
 * and the negative balance are each less than one call's maximum cost (tests/metering-concurrency.test.ts).
 *
 * A reply that offers tools makes several calls on one admission. Before each after its first, extension (`raiseHold`)
 * holds what the reply has cost so far and the true most of that call — everything it sends, every earlier round
 * included — never less than before. The bound still holds: a hold that stays within what is left overdraws nothing,
 * and one that passes it is taken, as admission's is, only while something is left after what the reply has spent, so
 * what the holds then pass the source by is less than that one call's most. Settlement then charges the reply's real
 * cost, all of it within its hold.
 *
 * Lock order: the run row (admitRun, settle), then the `accounts` row. Neither function locks a conversation or an
 * `agents` row: callers that need those take them first.
 */

export type ChargeTo = "free" | "balance" | "memory";

/** Where a call's cost goes (null: a provider model, which costs nothing) and what it holds meanwhile. */
export interface Admission {
  chargeTo: ChargeTo | null;
  holdMicro: bigint;
}

/** What the owner's running memory calls hold against the memory allowance. */
export async function readMemoryHold(q: Queryable, ownerId: string): Promise<bigint> {
  const { rows } = await q.query<{ held: string }>(
    "select coalesce(sum(hold_micro), 0)::text as held from agent_runs where owner_id = $1 and status = 'running' and charge_to = 'memory'",
    [ownerId],
  );
  return BigInt(rows[0]!.held);
}

/** What is left of the memory allowance of the site day `now` is in: the allowance less what is used and what running calls hold. */
export async function memoryLeft(q: Queryable, config: Pick<Config, "siteTimezone" | "memory">, ownerId: string, now: Date): Promise<bigint> {
  return BigInt(config.memory.freeDailyPoints) * 1_000_000n - (await memoryUsedToday(q, ownerId, now, config.siteTimezone)) - (await readMemoryHold(q, ownerId));
}

/** An amount per source: the holds against each, or what is left of each. */
export interface PerSource {
  freeMicro: bigint;
  balanceMicro: bigint;
}

/** What the owner's running calls hold, per source. */
export async function readHolds(q: Queryable, ownerId: string): Promise<PerSource> {
  const { rows } = await q.query<{ free: string; balance: string }>(
    `select coalesce(sum(hold_micro) filter (where charge_to = 'free'), 0)::text as free,
            coalesce(sum(hold_micro) filter (where charge_to = 'balance'), 0)::text as balance
       from agent_runs
      where owner_id = $1 and status = 'running'`,
    [ownerId],
  );
  return { freeMicro: BigInt(rows[0]!.free), balanceMicro: BigInt(rows[0]!.balance) };
}

/** What is left to start a call on: today's allowance and the balance, each less what running calls hold against it. */
export function headroom(state: { freeDailyMicro: bigint; freeUsedMicro: bigint; balanceMicro: bigint; holds: PerSource }): PerSource {
  return {
    freeMicro: state.freeDailyMicro - state.freeUsedMicro - state.holds.freeMicro,
    balanceMicro: state.balanceMicro - state.holds.balanceMicro,
  };
}

/**
 * The admission rule: a free-tier model takes today's allowance while some is left, then the balance; a paid-tier
 * model takes only the balance. Null when neither may be used.
 */
export function chargeSource(tier: "free" | "paid", left: PerSource): ChargeTo | null {
  if (tier === "free" && left.freeMicro > 0n) return "free";
  return left.balanceMicro > 0n ? "balance" : null;
}

/**
 * Admits one call on `resolved` for `ownerId`, under the account lock. A provider model: `{chargeTo: null,
 * holdMicro: 0n}`, nothing locked or read. A site model: the source by `chargeSource`, holding `maxCostMicro`;
 * neither source left is 402 `no_quota` with `reason` `free_and_balance` (free-tier model; `resetsAt`: the next site
 * midnight) or `balance` (paid-tier model); a memory call (`purpose` `memory`) on a site model takes the memory allowance
 * and nothing else, and is 402 `no_quota` with `reason` `memory` when it is used up. The caller stores `chargeTo` and `holdMicro` on the run in the same
 * transaction (`admitRun` does).
 */
export async function admit(
  t: Tx,
  config: Pick<Config, "freeDailyMicro" | "siteTimezone" | "memory">,
  ownerId: string,
  resolved: Pick<Resolved, "source" | "tier" | "price" | "call">,
  inputTokensEstimate: number,
  now: Date,
  purpose: "reply" | "draft" | "memory" = "reply",
): Promise<Admission> {
  if (resolved.source === "provider") return { chargeTo: null, holdMicro: 0n };
  if (purpose === "memory") {
    // Memory is paid from its own allowance, whatever the model's tier: not the free allowance, not the balance.
    await lockAccount(t, ownerId);
    if ((await memoryLeft(t, config, ownerId, now)) <= 0n) {
      throw new AppError(402, "no_quota", { reason: "memory", resetsAt: nextSiteMidnight(now, config.siteTimezone).toISOString() });
    }
    return { chargeTo: "memory", holdMicro: maxCostMicro(resolved, inputTokensEstimate) };
  }
  // A site model without a tier is treated as paid: it never touches the free allowance.
  const tier = resolved.tier === "free" ? "free" : "paid";
  const account = await lockAccount(t, ownerId);
  const left = headroom({
    freeDailyMicro: config.freeDailyMicro,
    freeUsedMicro: await freeUsedToday(t, ownerId, now, config.siteTimezone),
    balanceMicro: account.balanceMicro,
    holds: await readHolds(t, ownerId),
  });
  const chargeTo = chargeSource(tier, left);
  if (chargeTo === null) {
    throw new AppError(
      402,
      "no_quota",
      tier === "free" ? { reason: "free_and_balance", resetsAt: nextSiteMidnight(now, config.siteTimezone).toISOString() } : { reason: "balance" },
    );
  }
  return { chargeTo, holdMicro: maxCostMicro(resolved, inputTokensEstimate) };
}

/**
 * `admit` for the run `runId`, which must be `running`, belong to `ownerId` and be neither admitted nor settled yet (a
 * hold taken after its usage record would never be released): locks the run row, admits, and records on it the call's
 * `source` and `model` (`resolved.name`) with its `charge_to` and `hold_micro` — what settlement goes by — and the
 * reasoning level the call is sent at (`resolved.reasoning`: what its reply's `via` shows its owner), all in the
 * caller's transaction. A refusal throws (402 `no_quota`) and writes nothing.
 */
export async function admitRun(
  t: Tx,
  config: Pick<Config, "freeDailyMicro" | "siteTimezone" | "memory">,
  runId: string,
  ownerId: string,
  resolved: Pick<Resolved, "source" | "name" | "tier" | "price" | "call" | "reasoning">,
  inputTokensEstimate: number,
  now: Date,
): Promise<Admission> {
  const { rows } = await t.query<{ owner_id: string; status: string; source: string | null; purpose: "reply" | "draft" | "memory" }>(
    "select owner_id, status, source, purpose from agent_runs where id = $1 for update",
    [runId],
  );
  const run = rows[0];
  if (!run || run.owner_id !== ownerId || run.status !== "running") throw new Error(`admitRun: ${runId} is not a running run of ${ownerId}`);
  if (run.source !== null) throw new Error(`admitRun: ${runId} is already admitted`);
  if ((await t.query("select 1 from usage_records where run_id = $1", [runId])).rowCount !== 0) {
    throw new Error(`admitRun: ${runId} is already settled`);
  }
  const admission = await admit(t, config, ownerId, resolved, inputTokensEstimate, now, run.purpose);
  await t.query("update agent_runs set source = $2, model = $3, charge_to = $4, hold_micro = $5, reasoning = $6 where id = $1", [
    runId,
    resolved.source,
    resolved.name,
    admission.chargeTo,
    admission.holdMicro.toString(),
    resolved.reasoning,
  ]);
  return admission;
}

/**
 * Extension: a reply that offers tools makes a call per round (agents/runtime/worker.ts), and before each call after its
 * first the hold of its run — admitted on a site model, still running, its row locked by the caller — is raised to
 * `wanted`: what the reply has cost so far (`spent`) and the true most of that call. It is never lowered. `left` is what
 * is left of the run's own source (its `charge_to`: today's free allowance, the balance, or the memory allowance) by
 * admission's headroom (`headroom`, `memoryLeft`: what is left less what running calls hold), this run's own hold added
 * back; never another source than admission chose.
 * - "ok": `toolsAllowed` (the caller's cap and lane budgets) and `wanted` within `left` — the hold overdraws nothing;
 * - "final": else, while `left` is above `spent` (admission's own rule: a call starts while something is left) — the
 *   next call is the last, and its hold may pass `left`, by less than that call's most, as an admitted call's may;
 * - "stop": else; the hold is left as it is.
 * Under the owner's account lock (lock order: the run's row, then the account), so two runs of one owner raise their
 * holds one after the other, each seeing the other's.
 */
export async function raiseHold(
  t: Tx,
  config: Pick<Config, "freeDailyMicro" | "siteTimezone" | "memory">,
  run: { id: string; ownerId: string; chargeTo: ChargeTo; holdMicro: bigint },
  spent: bigint,
  wanted: bigint,
  toolsAllowed: boolean,
  now: Date,
): Promise<"ok" | "final" | "stop"> {
  const account = await lockAccount(t, run.ownerId);
  let left: bigint;
  if (run.chargeTo === "memory") {
    left = (await memoryLeft(t, config, run.ownerId, now)) + run.holdMicro;
  } else {
    const per = headroom({
      freeDailyMicro: config.freeDailyMicro,
      freeUsedMicro: await freeUsedToday(t, run.ownerId, now, config.siteTimezone),
      balanceMicro: account.balanceMicro,
      holds: await readHolds(t, run.ownerId),
    });
    left = (run.chargeTo === "free" ? per.freeMicro : per.balanceMicro) + run.holdMicro;
  }
  const answer = toolsAllowed && wanted <= left ? "ok" : left > spent ? "final" : "stop";
  if (answer !== "stop") await t.query("update agent_runs set hold_micro = greatest(hold_micro, $2::bigint) where id = $1", [run.id, wanted.toString()]);
  return answer;
}
