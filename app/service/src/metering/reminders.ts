import type { FastifyBaseLogger } from "fastify";
import { nextSiteMidnight, siteDay } from "../accounts/store.ts";
import type { Config } from "../config.ts";
import type { Tx } from "../db.ts";
import { createWhisperUnlocked, type Whisper, type WhisperBody } from "../whispers/store.ts";
import type { Settled } from "./settle.ts";

/**
 * Reminders to an owner about their money (Task H, rule 6; README "Metering", Reminders): a whisper of kind `allowance`,
 * offering no button, in one of the owner's Agents' own conversations — which only the owner and that Agent are in, so
 * nobody else can ever meet it —, written in the very transaction of the settlement that calls for it (a reply's, or a
 * persona draft's), so it is never lost to a crash between the two:
 * - `warn`: the day's free allowance is `ALLOWANCE.warnAt` used (at the default, `这个周期的额度已经用了 80%。`);
 * - `empty`: it is used up and the balance is at or below zero, so no reply on a free-tier model starts before the site's
 *   midnight: `额度用完了，{when} 恢复。` — `{when}` the date and time it comes back, written as the web writes a date
 *   (`M月D日 HH:MM`, app/web/src/data/errorTexts.js `resetTimeText`) in `SITE_TIMEZONE`, never `明天`: a whisper stays open
 *   for days. Nothing about topping up — points are only granted by the operator;
 * - `balance`: the settlement took the balance from above zero to zero or below: `余额用完了。` — once per crossing, again
 *   after a grant has brought it above zero and a call takes it down again.
 * `warn` and `empty` are each said at most once per owner and site day, whatever paid it (a row of `allowance_reminders`,
 * written under the account lock the settlement holds; an owner's earlier days are deleted as a new one is written); an
 * `empty` said marks `warn` said too, and on the settlement that says `empty` no `balance` is said beside it. A state, not
 * an edge: what someone else's spending used is told at the next settlement. Where: a reply's own Agent's conversation; a
 * persona draft's, or a reply whose Agent was deleted meanwhile, the conversation of the owner's Agent they used last (its
 * newest message; then the conversation's id); none, when the owner has no Agent left — then nothing is written and the
 * next settlement tries again. Counted once committed (the caller logs `metric`), never with an owner or an amount:
 * `allowance_warn_80`, `allowance_empty`, `balance_empty`.
 *
 * Lock order: run → `accounts` (the settlement's) → `allowance_reminders` → the whisper's row (`createWhisperUnlocked`:
 * no conversation or Agent row, which would come before `accounts`).
 */

export type Reminder = "warn" | "empty" | "balance";

/** The metric each reminder is counted under. */
export const REMINDER_METRIC: Record<Reminder, string> = { warn: "allowance_warn_80", empty: "allowance_empty", balance: "balance_empty" };

/** What a reminder says, `now` being when it is said (`empty`'s time is the next midnight in `SITE_TIMEZONE`). */
export function reminderBody(reminder: Reminder, config: Pick<Config, "siteTimezone" | "allowance">, now: Date): WhisperBody {
  const text =
    reminder === "warn"
      ? `这个周期的额度已经用了 ${Math.round(config.allowance.warnAt * 100)}%。`
      : reminder === "empty"
        ? `额度用完了，${dateWords(nextSiteMidnight(now, config.siteTimezone), config.siteTimezone)} 恢复。`
        : "余额用完了。";
  return { text, actions: [] };
}

/** `at` as the web writes a date (`resetTimeText`'s `M月D日 HH:MM`), in `timeZone`: it never goes stale. */
export function dateWords(at: Date, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  return `${Number(parts.month)}月${Number(parts.day)}日 ${parts.hour}:${parts.minute}`;
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

/** The reminder `settled` calls for, by the state after it (no rows written). */
function due(config: Pick<Config, "freeDailyMicro" | "allowance">, settled: Settled): { empty: boolean; balance: boolean; warn: boolean } | null {
  if ((settled.chargeTo !== "free" && settled.chargeTo !== "balance") || settled.after === null) return null;
  const allowance = config.freeDailyMicro;
  const { freeUsedMicro: used, balanceMicro: balance } = settled.after;
  const warnAt = BigInt(Math.round(config.allowance.warnAt * 1_000_000));
  return {
    empty: allowance > 0n && used >= allowance && balance <= 0n,
    balance: settled.balanceMicro > 0n && balance <= 0n && balance + settled.balanceMicro > 0n,
    warn: allowance > 0n && used * 1_000_000n >= warnAt * allowance,
  };
}

/** Where the owner's reminder goes when the caller names no live Agent: the conversation of their Agent used last. */
async function lastUsed(t: Tx, ownerId: string): Promise<{ agentId: string; conversationId: string } | null> {
  const { rows } = await t.query<{ agent_id: string; conversation_id: string }>(
    `select ac.agent_id, ac.conversation_id
       from agent_conversations ac
       join agents a on a.principal_id = ac.agent_id
       join principals p on p.id = ac.agent_id
      where p.owner_id = $1 and a.deleted_at is null
      order by (select max(m.created_at) from messages m where m.conversation_id = ac.conversation_id) desc nulls last, ac.conversation_id
      limit 1`,
    [ownerId],
  );
  return rows[0] ? { agentId: rows[0].agent_id, conversationId: rows[0].conversation_id } : null;
}

/** A reminder written in a settlement: the whisper to push to its owner and the metric to count, once committed. */
export interface Reminded {
  whisper: Whisper;
  metric: string;
}

/**
 * In the settling transaction of a call of `ownerId` (a reply's or a persona draft's), after `settle`, which took the
 * account's lock: the reminder its settlement calls for, written — the once-row and the whisper — in `where` (the reply's
 * own Agent and its conversation; null: the Agent the owner used last), or null when none is due or there is nowhere to
 * write it. The caller, once committed, pushes it to its owner (`Hub.pushWhisper`) and logs its metric.
 */
export async function remindInSettlement(
  t: Tx,
  config: Pick<Config, "freeDailyMicro" | "siteTimezone" | "allowance">,
  ownerId: string,
  settled: Settled,
  now: Date,
  where: { agentId: string; conversationId: string } | null,
  log: Pick<FastifyBaseLogger, "warn">,
): Promise<Reminded | null> {
  const state = due(config, settled);
  if (!state || !(state.empty || state.balance || state.warn)) return null;
  const target = where ?? (await lastUsed(t, ownerId));
  if (!target) return null;
  const day = siteDay(now, config.siteTimezone);
  let reminder: Reminder | null = null;
  if (state.empty && (await once(t, ownerId, day, ["empty", "warn"]))) reminder = "empty";
  else if (state.balance) reminder = "balance";
  else if (state.warn && (await once(t, ownerId, day, ["warn"]))) reminder = "warn";
  if (reminder === null) return null;
  const made = await createWhisperUnlocked(t, { conversationId: target.conversationId, ownerId, agentId: target.agentId, kind: "allowance", body: reminderBody(reminder, config, now) }, log);
  return made ? { whisper: made, metric: REMINDER_METRIC[reminder] } : null;
}
