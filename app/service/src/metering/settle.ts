import { applyLedger, freeUsedToday, lockAccount, siteDay } from "../accounts/store.ts";
import type { Config } from "../config.ts";
import type { Tx } from "../db.ts";
import type { Resolved } from "../models/resolve.ts";
import { costMicro } from "./prices.ts";

/**
 * Settlement (spec 6.4): after a call, in one transaction, charge what it cost to the source its admission chose
 * (admit.ts), write its usage record and release its hold.
 */

export type Outcome = "done" | "stopped" | "failed" | "cancelled";

/** Token counts the upstream reported. */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

const isCount = (n: number): boolean => Number.isSafeInteger(n) && n >= 0;

/**
 * Settles the call of run `runId`, made on `model` (what the call actually used: its source, name and price), with
 * `outcome`:
 * - Tokens: `usage` as reported; when none was reported (or it is not two whole non-negative numbers), one token per
 *   character of `fallback` (estimateTokens' rule) and the record says `estimated`.
 * - Cost: the tokens at the model's price; 0 for a provider model, and for a `failed` call that produced no output.
 * - Charged to the run's `charge_to`: `free` grows the free allowance of the site day it is *now* (a call that
 *   started before midnight and ends after it uses the new day's allowance) by the cost, up to what is left of it;
 *   the rest is `forgiven_micro`, charged to nobody, not even the next day. `balance` debits the whole cost to the
 *   ledger (`usage`), which may take the balance below zero. A provider call charges nothing.
 * - Appends the `usage_records` row and zeroes the run's `hold_micro`.
 * Locks the run row, then (a site call) the account. Throws, changing nothing, for a run that does not exist or was
 * settled already, a site call that was never admitted, and a provider model on a run admitted for a site model.
 */
export async function settle(
  t: Tx,
  config: Pick<Config, "freeDailyMicro" | "siteTimezone">,
  runId: string,
  model: Pick<Resolved, "source" | "name" | "price">,
  usage: Usage | null,
  fallback: { inputChars: number; outputChars: number },
  outcome: Outcome,
  now: Date,
): Promise<void> {
  const { rows } = await t.query<{ owner_id: string; agent_id: string | null; purpose: string; charge_to: "free" | "balance" | null }>(
    "select owner_id, agent_id, purpose, charge_to from agent_runs where id = $1 for update",
    [runId],
  );
  const run = rows[0];
  if (!run) throw new Error(`settle: no run ${runId}`);
  if ((await t.query("select 1 from usage_records where run_id = $1", [runId])).rowCount !== 0) {
    throw new Error(`settle: run ${runId} is already settled`);
  }
  if (model.source === "provider" && run.charge_to !== null) throw new Error(`settle: run ${runId} was admitted for a site model`);
  if (model.source === "site" && run.charge_to === null) throw new Error(`settle: run ${runId} was not admitted`);

  const reported = usage !== null && isCount(usage.inputTokens) && isCount(usage.outputTokens);
  const input = reported ? usage.inputTokens : fallback.inputChars;
  const output = reported ? usage.outputTokens : fallback.outputChars;
  let cost = 0n;
  if (model.source === "site" && !(outcome === "failed" && output === 0)) {
    if (!model.price) throw new Error(`settle: site model ${model.name} has no price`);
    cost = costMicro(model.price, input, output);
  }

  let freeMicro = 0n;
  let forgivenMicro = 0n;
  let balanceMicro = 0n;
  if (run.charge_to !== null) {
    await lockAccount(t, run.owner_id);
    if (run.charge_to === "free") {
      const used = await freeUsedToday(t, run.owner_id, now, config.siteTimezone);
      const left = config.freeDailyMicro > used ? config.freeDailyMicro - used : 0n;
      freeMicro = cost < left ? cost : left;
      forgivenMicro = cost - freeMicro;
      if (freeMicro > 0n) {
        await t.query(
          `insert into free_usage (owner_id, day, used_micro) values ($1, $2::date, $3)
           on conflict (owner_id, day) do update set used_micro = free_usage.used_micro + excluded.used_micro`,
          [run.owner_id, siteDay(now, config.siteTimezone), freeMicro.toString()],
        );
      }
    } else {
      balanceMicro = cost;
    }
  }

  const inserted = await t.query<{ id: string }>(
    `insert into usage_records (owner_id, agent_id, run_id, purpose, source, model, input_tokens, output_tokens, estimated,
                                cost_micro, free_micro, balance_micro, forgiven_micro, outcome)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     returning id::text`,
    [
      run.owner_id, run.agent_id, runId, run.purpose, model.source, model.name, input, output, !reported,
      cost.toString(), freeMicro.toString(), balanceMicro.toString(), forgivenMicro.toString(), outcome,
    ],
  );
  if (balanceMicro > 0n) await applyLedger(t, run.owner_id, -balanceMicro, "usage", null, inserted.rows[0]!.id);
  await t.query("update agent_runs set hold_micro = 0 where id = $1", [runId]);
}
