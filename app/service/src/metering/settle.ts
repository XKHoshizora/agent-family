import { applyLedger, freeUsedToday, lockAccount, siteDay } from "../accounts/store.ts";
import type { Config } from "../config.ts";
import type { Tx } from "../db.ts";
import { assertCount, costMicro, isCount } from "./prices.ts";

/**
 * Settlement (spec 6.4): after a call, in one transaction, charge what it cost — at most what it held — to the source
 * its admission chose (admit.ts), write its usage record and release its hold.
 */

export type Outcome = "done" | "stopped" | "failed" | "cancelled";

/** Where settlement says what it could not do (a call on a site model no longer configured). Every caller passes one. */
export interface SettleLog {
  warn(details: Record<string, unknown>, msg: string): void;
}

/** Token counts the upstream reported. */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);

/**
 * Settles the call of run `runId` with `outcome`, by what its admission recorded on the run (`source`, `model`,
 * `charge_to`, `hold_micro`), whatever the Agent's model is by now:
 * - Tokens: `usage` as reported; when none was reported (or it is not two whole non-negative numbers), one token per
 *   character of `fallback` (estimateTokens' rule; its input side counts what the call showed besides text, such as
 *   images, at their token estimate) and the record says `estimated`. `fallback` is ours, so its counts must be
 *   whole numbers of 0 or more: anything else throws before anything is read or written.
 * - Cost (`cost_micro`, the true cost): the tokens at the site model's configured price; 0 for a provider model, for a
 *   `failed` call that produced no output, for no tokens at all (a run recovered at start-up settles so), and for a
 *   run never admitted (no model recorded; nothing is charged). A call that cost something on a site model removed from
 *   the configuration since cannot be priced: its true cost is unknown, so it is recorded as 0 and `estimated`, nothing
 *   is charged, and that is logged (`log.warn`, with the run and the model).
 * - Charged: the cost up to the run's hold — never more than admission held; the part above it is forgiven. Then by
 *   `charge_to`: `free` grows the free allowance of the site day it is *now* (a call that started before midnight and
 *   ends after it uses the new day's allowance) by the charge, up to what is left of it, and the rest is forgiven too,
 *   charged to nobody, not even the next day; `balance` debits the whole charge to the ledger (`usage`), which may
 *   take the balance below zero. `forgiven_micro` is everything of the cost not charged.
 * - Appends the `usage_records` row and zeroes the run's `hold_micro`.
 * - `forgiveAll`: the call's result was lost on the service's side (its reply could not be stored): nothing is charged
 *   and the whole cost, still recorded in `cost_micro`, is `forgiven_micro`.
 * Locks the run row, then (a site call) the account. Throws, changing nothing, for a run that does not exist or was
 * settled already (`usage_records_run_id_key` holds that in the database too).
 */
export async function settle(
  t: Tx,
  config: Pick<Config, "freeDailyMicro" | "siteTimezone" | "siteModels">,
  runId: string,
  usage: Usage | null,
  fallback: { inputChars: number; outputChars: number },
  outcome: Outcome,
  now: Date,
  { forgiveAll = false, log }: { forgiveAll?: boolean; log: SettleLog },
): Promise<void> {
  assertCount("settle: fallback.inputChars", fallback.inputChars);
  assertCount("settle: fallback.outputChars", fallback.outputChars);
  const { rows } = await t.query<{
    owner_id: string;
    agent_id: string | null;
    purpose: string;
    source: "site" | "provider" | null;
    model: string | null;
    charge_to: "free" | "balance" | null;
    hold_micro: string;
  }>("select owner_id, agent_id, purpose, source, model, charge_to, hold_micro::text from agent_runs where id = $1 for update", [runId]);
  const run = rows[0];
  if (!run) throw new Error(`settle: no run ${runId}`);
  if ((await t.query("select 1 from usage_records where run_id = $1", [runId])).rowCount !== 0) {
    throw new Error(`settle: run ${runId} is already settled`);
  }

  const reported = usage !== null && isCount(usage.inputTokens) && isCount(usage.outputTokens);
  const input = reported ? usage.inputTokens : fallback.inputChars;
  const output = reported ? usage.outputTokens : fallback.outputChars;
  let cost = 0n;
  let priced = true;
  if (run.source === "site" && !(outcome === "failed" && output === 0) && input + output > 0) {
    const site = config.siteModels.find((m) => m.id === run.model);
    if (site) {
      cost = costMicro(site, input, output);
    } else {
      priced = false;
      log.warn({ runId, model: run.model }, "settle: the run's site model is no longer configured, so its cost is unknown: recorded as 0 and not charged");
    }
  }

  let freeMicro = 0n;
  let balanceMicro = 0n;
  if (run.charge_to !== null) {
    const charged = forgiveAll ? 0n : min(cost, BigInt(run.hold_micro));
    await lockAccount(t, run.owner_id);
    if (run.charge_to === "free") {
      const used = await freeUsedToday(t, run.owner_id, now, config.siteTimezone);
      freeMicro = min(charged, config.freeDailyMicro > used ? config.freeDailyMicro - used : 0n);
      if (freeMicro > 0n) {
        await t.query(
          `insert into free_usage (owner_id, day, used_micro) values ($1, $2::date, $3)
           on conflict (owner_id, day) do update set used_micro = free_usage.used_micro + excluded.used_micro`,
          [run.owner_id, siteDay(now, config.siteTimezone), freeMicro.toString()],
        );
      }
    } else {
      balanceMicro = charged;
    }
  }
  const forgivenMicro = cost - freeMicro - balanceMicro;

  const inserted = await t.query<{ id: string }>(
    `insert into usage_records (owner_id, agent_id, run_id, purpose, source, model, input_tokens, output_tokens, estimated,
                                cost_micro, free_micro, balance_micro, forgiven_micro, outcome)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     returning id::text`,
    [
      run.owner_id, run.agent_id, runId, run.purpose, run.source, run.model, input, output, !reported || !priced,
      cost.toString(), freeMicro.toString(), balanceMicro.toString(), forgivenMicro.toString(), outcome,
    ],
  );
  if (balanceMicro > 0n) await applyLedger(t, run.owner_id, -balanceMicro, "usage", null, inserted.rows[0]!.id);
  await t.query("update agent_runs set hold_micro = 0 where id = $1", [runId]);
}
