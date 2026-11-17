import { freeUsedToday, lockAccount, nextSiteMidnight } from "../accounts/store.ts";
import type { Config } from "../config.ts";
import type { Queryable, Tx } from "../db.ts";
import { AppError } from "../errors.ts";
import type { Resolved } from "../models/resolve.ts";
import { maxCostMicro } from "./prices.ts";

/**
 * Admission (spec 6.4): before a site-model call, in one transaction under the owner's account lock, decide the one
 * source it will charge — today's free allowance or the points balance — and hold the most it can cost against that
 * source until it is settled (settle.ts). A run's hold counts while the run is `running`; settle it before, or in the
 * transaction that, moves it out of `running`. Because every call in flight holds its maximum cost and settlement
 * charges no call more than it held, what the owner's calls can overrun is bounded: the forgiven free overrun of a day
 * and the negative balance are each less than one call's maximum cost (tests/metering-concurrency.test.ts).
 *
 * Lock order: the run row (admitRun, settle), then the `accounts` row. Neither function locks a conversation or an
 * `agents` row: callers that need those take them first.
 */

export type ChargeTo = "free" | "balance";

/** Where a call's cost goes (null: a provider model, which costs nothing) and what it holds meanwhile. */
export interface Admission {
  chargeTo: ChargeTo | null;
  holdMicro: bigint;
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
 * midnight) or `balance` (paid-tier model). The caller stores `chargeTo` and `holdMicro` on the run in the same
 * transaction (`admitRun` does).
 */
export async function admit(
  t: Tx,
  config: Pick<Config, "freeDailyMicro" | "siteTimezone">,
  ownerId: string,
  resolved: Pick<Resolved, "source" | "tier" | "price" | "call">,
  inputTokensEstimate: number,
  now: Date,
): Promise<Admission> {
  if (resolved.source === "provider") return { chargeTo: null, holdMicro: 0n };
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
  config: Pick<Config, "freeDailyMicro" | "siteTimezone">,
  runId: string,
  ownerId: string,
  resolved: Pick<Resolved, "source" | "name" | "tier" | "price" | "call" | "reasoning">,
  inputTokensEstimate: number,
  now: Date,
): Promise<Admission> {
  const { rows } = await t.query<{ owner_id: string; status: string; source: string | null }>(
    "select owner_id, status, source from agent_runs where id = $1 for update",
    [runId],
  );
  const run = rows[0];
  if (!run || run.owner_id !== ownerId || run.status !== "running") throw new Error(`admitRun: ${runId} is not a running run of ${ownerId}`);
  if (run.source !== null) throw new Error(`admitRun: ${runId} is already admitted`);
  if ((await t.query("select 1 from usage_records where run_id = $1", [runId])).rowCount !== 0) {
    throw new Error(`admitRun: ${runId} is already settled`);
  }
  const admission = await admit(t, config, ownerId, resolved, inputTokensEstimate, now);
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
