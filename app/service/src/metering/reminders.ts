import { freeUsedToday, nextSiteMidnight, siteDay } from "../accounts/store.ts";
import type { Config } from "../config.ts";
import type { Tx } from "../db.ts";
import type { WhisperBody } from "../whispers/store.ts";
import type { Settled } from "./settle.ts";

/**
 * Reminders to an owner about their money (Task H, rule 6; README "Metering", Reminders): a whisper of kind `allowance`,
 * offering no button, in the replying Agent's own conversation — which only its owner and the Agent are in, so nobody else
 * can ever meet it —, after a reply's settlement:
 * - `warn`: the day's free allowance is `ALLOWANCE.warnAt` used (at the default, `这个周期的额度已经用了 80%。`);
 * - `empty`: it is used up and the balance is at or below zero, so no reply on a free-tier model starts before the site's
 *   midnight: `额度用完了，{when} 恢复。` (`{when}` worded as the web words a reset time: `明天 00:00`; nothing about
 *   topping up — points are only granted by the operator);
 * - `balance`: the reply took the balance from above zero to zero or below: `余额用完了。` — once per crossing, again after
 *   a grant has brought it above zero and a reply takes it down again.
 * `warn` and `empty` are each said at most once per owner and site day, whichever of their Agents replied (a row of
 * `allowance_reminders`, written under the account lock settlement holds; an owner's earlier days are deleted as a new
 * one is written); an `empty` said marks `warn` said too, and on the settlement that says `empty` no `balance` is said
 * beside it. A state, not an edge: what a draft or someone else's spending used is told at the next reply's settlement.
 * Counted, never logged with an owner or an amount: `allowance_warn_80`, `allowance_empty`, `balance_empty`.
 */

export type Reminder = "warn" | "empty" | "balance";

/** The metric each reminder is counted under. */
export const REMINDER_METRIC: Record<Reminder, string> = { warn: "allowance_warn_80", empty: "allowance_empty", balance: "balance_empty" };

/** What a reminder says, `now` being when it is said (`empty`'s reset time is the next midnight in `SITE_TIMEZONE`). */
export function reminderBody(reminder: Reminder, config: Pick<Config, "siteTimezone" | "allowance">, now: Date): WhisperBody {
  const text =
    reminder === "warn"
      ? `这个周期的额度已经用了 ${Math.round(config.allowance.warnAt * 100)}%。`
      : reminder === "empty"
        ? `额度用完了，${resetWords(nextSiteMidnight(now, config.siteTimezone), now, config.siteTimezone)} 恢复。`
        : "余额用完了。";
  return { text, actions: [] };
}

/**
 * When `at` is, as the web words a reset time (app/web/src/data/errorTexts.js `resetTimeText`), in `timeZone`: `今天 HH:MM`,
 * `明天 HH:MM`, else `M月D日 HH:MM`.
 */
export function resetWords(at: Date, now: Date, timeZone: string): string {
  const time = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at);
  const day = siteDay(at, timeZone);
  if (day === siteDay(now, timeZone)) return `今天 ${time}`;
  if (day === siteDay(new Date(now.getTime() + 86_400_000), timeZone)) return `明天 ${time}`;
  const [, month, date] = day.split("-").map(Number) as [number, number, number];
  return `${month}月${date}日 ${time}`;
}

/** Writes today's rows for `thresholds`, deleting the owner's earlier days; whether the first of them is new. */
async function once(t: Tx, ownerId: string, day: string, thresholds: Array<"warn" | "empty">): Promise<boolean> {
  await t.query("delete from allowance_reminders where owner_id = $1 and day < $2::date", [ownerId, day]);
  const { rows } = await t.query<{ threshold: string }>(
    `insert into allowance_reminders (owner_id, day, threshold) select $1, $2::date, unnest($3::text[])
     on conflict do nothing returning threshold`,
    [ownerId, day, thresholds],
  );
  return rows.some((r) => r.threshold === thresholds[0]);
}

/**
 * In the settling transaction of a reply of `ownerId`, after `settle` (which took the account's lock): the reminder its
 * settlement calls for (`settled`), or null. Only a reply charged to the free allowance or the balance can call for one.
 */
export async function reminderAfter(
  t: Tx,
  config: Pick<Config, "freeDailyMicro" | "siteTimezone" | "allowance">,
  ownerId: string,
  settled: Settled,
  now: Date,
): Promise<Reminder | null> {
  if (settled.chargeTo !== "free" && settled.chargeTo !== "balance") return null;
  const allowance = config.freeDailyMicro;
  const day = siteDay(now, config.siteTimezone);
  const used = await freeUsedToday(t, ownerId, now, config.siteTimezone);
  const balance = BigInt((await t.query<{ b: string }>("select balance_micro::text as b from accounts where principal_id = $1", [ownerId])).rows[0]!.b);
  if (allowance > 0n && used >= allowance && balance <= 0n && (await once(t, ownerId, day, ["empty", "warn"]))) return "empty";
  if (settled.balanceMicro > 0n && balance <= 0n && balance + settled.balanceMicro > 0n) return "balance";
  const warnAt = BigInt(Math.round(config.allowance.warnAt * 1_000_000));
  if (allowance > 0n && used * 1_000_000n >= warnAt * allowance && (await once(t, ownerId, day, ["warn"]))) return "warn";
  return null;
}
