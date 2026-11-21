import { nextSiteMidnight, siteDay } from "../accounts/store.ts";
import type { Config } from "../config.ts";
import type { Db, Queryable, Tx } from "../db.ts";
import { createWhisper, type Whisper, type WhisperBody } from "../whispers/store.ts";
import type { Settled } from "./settle.ts";

/**
 * Reminders to an owner about their money (Task H, rule 6; README "Metering", Reminders): a whisper of kind `allowance`,
 * offering no button, in one of the owner's Agents' own conversations — which only the owner and that Agent are in, so
 * nobody else can ever meet it:
 * - `warn`: the day's free allowance is `ALLOWANCE.warnAt` used (at the default, `这个周期的额度已经用了 80%。`);
 * - `empty`: it is used up and the balance is at or below zero, so no reply on a free-tier model starts before the site's
 *   midnight: `额度用完了，{when} 恢复。` — `{when}` the date and time it comes back, written as the web writes a date
 *   (`M月D日 HH:MM`, app/web/src/data/errorTexts.js `resetTimeText`) in `SITE_TIMEZONE`, never `明天`: a whisper stays open
 *   for days. Nothing about topping up — points are only granted by the operator;
 * - `balance`: the settlement took the balance from above zero to zero or below: `余额用完了。` — once per crossing, again
 *   after a grant has brought it above zero and a call takes it down again.
 * `warn` and `empty` are each said at most once per owner and site day, whatever paid it; an `empty` said marks `warn` said
 * too, and on the settlement that says `empty` no `balance` is said beside it. A state, not an edge: what someone else's
 * spending used is told at the next settlement. Where: a reply's own Agent's conversation; a persona draft's, or a reply
 * whose Agent was deleted meanwhile, the conversation of the owner's Agent they used last (its newest message; then the
 * conversation's id); none, when the owner has no Agent left — then nothing is recorded and the next settlement tries again.
 *
 * Two steps, so nothing is lost and no lock is taken out of order. (1) In the settlement's own transaction, under the account
 * lock `settle` took, the reminder is recorded (`remindInSettlement`: a row of `allowance_reminders`; an owner's earlier days
 * are deleted as a new one is written) — no conversation or Agent row is locked there (they come before `accounts` in the
 * lock order: conversation → Agent → run rows → accounts). (2) Once that commits, its whisper is made in a transaction of
 * its own (`deliverReminder`: `createWhisper` takes the conversation's row and then the Agent's, as everything else does),
 * and the row marked delivered in it; a whisper that cannot be made (the Agent deleted meanwhile, say) is nothing, the row
 * marked all the same. A reminder recorded but not delivered — the service stopped between the two — is delivered by the
 * periodic sweep (`deliverReminders`), once: a delivery whose row another has marked meanwhile is rolled back, its whisper
 * with it. Counted once delivered (the caller logs `metric`), never with an owner or an amount: `allowance_warn_80`,
 * `allowance_empty`, `balance_empty`.
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

/** Records today's `threshold` for the owner unless it is already (`allowance_reminders_once`); the new row's id, or null. */
async function once(t: Tx, ownerId: string, day: string, threshold: "warn" | "empty", agentId: string): Promise<string | null> {
  const { rows } = await t.query<{ id: string }>(
    `insert into allowance_reminders (owner_id, day, threshold, agent_id) values ($1, $2::date, $3, $4)
     on conflict do nothing returning id::text`,
    [ownerId, day, threshold, agentId],
  );
  return rows[0]?.id ?? null;
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

/**
 * Where the owner's reminder goes when there is no live Agent of theirs to name: the conversation of their Agent used last.
 * Plain reads, no row lock (a settlement calls it).
 */
async function lastUsed(q: Queryable, ownerId: string): Promise<{ agentId: string; conversationId: string } | null> {
  const { rows } = await q.query<{ agent_id: string; conversation_id: string }>(
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

/** A reminder delivered: its whisper, to push to its owner, and the metric to count. */
export interface Reminded {
  whisper: Whisper;
  metric: string;
}

/**
 * In the settling transaction of a call of `ownerId` (a reply's or a persona draft's), after `settle`, which took the
 * account's lock: the reminder its settlement calls for, recorded for `agentId` (the reply's own Agent, alive; null: the
 * Agent the owner used last, read here without a lock) — the new row's id, its whisper to make once committed
 * (`deliverReminder`); null when none is due or there is nowhere to say it. Takes no conversation or Agent row.
 */
export async function remindInSettlement(
  t: Tx,
  config: Pick<Config, "freeDailyMicro" | "siteTimezone" | "allowance">,
  ownerId: string,
  settled: Settled,
  now: Date,
  agentId: string | null,
): Promise<string | null> {
  const state = due(config, settled);
  if (!state || !(state.empty || state.balance || state.warn)) return null;
  const to = agentId ?? (await lastUsed(t, ownerId))?.agentId;
  if (to === undefined) return null;
  const day = siteDay(now, config.siteTimezone);
  await t.query("delete from allowance_reminders where owner_id = $1 and day < $2::date", [ownerId, day]);
  if (state.empty) {
    const id = await once(t, ownerId, day, "empty", to);
    if (id !== null) {
      // An `empty` said is the day's `warn` said too: recorded as delivered, nothing to make.
      await t.query(
        `insert into allowance_reminders (owner_id, day, threshold, agent_id, delivered_at) values ($1, $2::date, 'warn', $3, now())
         on conflict do nothing`,
        [ownerId, day, to],
      );
      return id;
    }
  }
  if (state.balance) {
    const { rows } = await t.query<{ id: string }>(
      "insert into allowance_reminders (owner_id, day, threshold, agent_id) values ($1, $2::date, 'balance', $3) returning id::text",
      [ownerId, day, to],
    );
    return rows[0]!.id;
  }
  return state.warn ? once(t, ownerId, day, "warn", to) : null;
}

/** Thrown to roll a delivery back: its row was delivered by another meanwhile. */
const ALREADY = Symbol("already delivered");

/**
 * The whisper of the recorded reminder `id`, made in a transaction of its own, after the settlement that recorded it has
 * committed: in the conversation of the Agent it was recorded for, or, that Agent deleted since, of the Agent its owner used
 * last; `createWhisper` takes the conversation's row and then the Agent's (the lock order), then the reminder's row is
 * marked delivered. The made whisper and its metric, for the caller to push to the owner and count; null when there is
 * nothing to tell — it was delivered already (by another, the sweep or the settlement's own caller: this one is rolled back,
 * whisper and all), or no whisper could be made (marked delivered all the same).
 */
export async function deliverReminder(
  db: Pick<Db, "query" | "tx">,
  config: Pick<Config, "siteTimezone" | "allowance">,
  id: string,
): Promise<Reminded | null> {
  const { rows } = await db.query<{ owner_id: string; threshold: Reminder; agent_id: string | null; created_at: Date }>(
    "select owner_id, threshold, agent_id, created_at from allowance_reminders where id = $1 and delivered_at is null",
    [id],
  );
  const row = rows[0];
  if (!row) return null;
  try {
    return await db.tx(async (t) => {
      const own =
        row.agent_id === null
          ? undefined
          : (
              await t.query<{ conversation_id: string }>(
                `select ac.conversation_id from agent_conversations ac join agents a on a.principal_id = ac.agent_id
                  where ac.agent_id = $1 and ac.owner_id = $2 and a.deleted_at is null`,
                [row.agent_id, row.owner_id],
              )
            ).rows[0];
      const target = own && row.agent_id !== null ? { agentId: row.agent_id, conversationId: own.conversation_id } : await lastUsed(t, row.owner_id);
      const made = target
        ? await createWhisper(t, {
            conversationId: target.conversationId,
            ownerId: row.owner_id,
            agentId: target.agentId,
            kind: "allowance",
            body: reminderBody(row.threshold, config, row.created_at),
          })
        : null;
      const marked = await t.query("update allowance_reminders set delivered_at = now(), whisper_id = $2 where id = $1 and delivered_at is null", [id, made?.id ?? null]);
      if (marked.rowCount === 0) throw ALREADY;
      return made ? { whisper: made, metric: REMINDER_METRIC[row.threshold] } : null;
    });
  } catch (err) {
    if (err === ALREADY) return null;
    throw err;
  }
}

/**
 * The periodic sweep's step (app.ts): every reminder recorded but not delivered — the service stopped between a settlement
 * and its whisper — delivered now (`deliverReminder`), oldest first; one recorded on an earlier site day than today is no
 * longer true and is marked delivered with nothing made. What was delivered, for the caller to push and count; a reminder
 * that fails is left for the next sweep.
 */
export async function deliverReminders(
  db: Pick<Db, "query" | "tx">,
  config: Pick<Config, "siteTimezone" | "allowance">,
  log: { warn(details: Record<string, unknown>, msg: string): void },
  now: Date = new Date(),
): Promise<Reminded[]> {
  const today = siteDay(now, config.siteTimezone);
  await db.query("update allowance_reminders set delivered_at = now() where delivered_at is null and day < $1::date", [today]);
  const { rows } = await db.query<{ id: string }>("select id::text from allowance_reminders where delivered_at is null order by created_at, id limit 500");
  const made: Reminded[] = [];
  for (const { id } of rows) {
    try {
      const reminded = await deliverReminder(db, config, id);
      if (reminded) made.push(reminded);
    } catch (err) {
      log.warn({ code: (err as { code?: string }).code }, "a reminder about money could not be delivered; trying again next interval");
    }
  }
  return made;
}
