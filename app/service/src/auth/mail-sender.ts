import type { Db } from "../db.ts";
import { count } from "../memory/stats.ts";

/** Resend's send endpoint (https://resend.com/docs/api-reference/emails/send-email). Tests point the sender elsewhere (`BuildOptions.mail`). */
export const RESEND_API_URL = "https://api.resend.com/emails";

/** At most this many tries a mail gets; the waits between them add up to about half an hour. */
export const MAX_ATTEMPTS = 5;
const BACKOFF_SECONDS = [60, 240, 600, 900];
/** A mail still queued after this long is not sent any more: its link has gone stale (and old outbox rows are never sent). */
const EXPIRES_AFTER_MINUTES = 60;
/** While a call is in flight its row is leased this long; a process that dies mid-call leaves it to be retried after. */
const LEASE_SECONDS = 60;
const CALL_TIMEOUT_MS = 15_000;
const BATCH = 10;
/** How often the timer looks for queued mail. */
export const DEFAULT_POLL_MS = 3000;

export interface MailSettings {
  apiKey: string;
  from: string;
  replyTo?: string | undefined;
}

export interface MailSender {
  /** One pass: closes what can no longer be sent, then delivers what is due. Returns how many calls it made. Never throws. */
  runOnce(): Promise<number>;
  /** Starts the timer (no-op in `outbox` mode). */
  start(intervalMs?: number): void;
  /** Stops the timer and waits for a pass in flight. */
  stop(): Promise<void>;
}

interface Logger {
  warn(obj: Record<string, unknown>, msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
}

interface Claimed {
  id: string;
  recipient: string;
  subject: string;
  body: string;
  attempts: number;
}

type Outcome = { ok: true; providerId: string | null } | { ok: false; code: string; retry: boolean };

/** What a call came to, as a short code: the provider's body is never read beyond the id of a success. */
async function call(fetchFn: typeof fetch, url: string, settings: MailSettings, row: Claimed): Promise<Outcome> {
  try {
    const res = await fetchFn(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${settings.apiKey}`,
        "content-type": "application/json",
        // One key per mail: a retry of a call whose answer was lost cannot send it twice (kept by the provider for 24 hours).
        "idempotency-key": `mail-${row.id}`,
      },
      body: JSON.stringify({
        from: settings.from,
        to: [row.recipient],
        subject: row.subject,
        text: row.body,
        ...(settings.replyTo === undefined ? {} : { reply_to: settings.replyTo }),
      }),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    if (res.status >= 200 && res.status < 300) {
      const id = await res.json().then(
        (j: unknown) => (typeof (j as { id?: unknown })?.id === "string" ? (j as { id: string }).id : null),
        () => null,
      );
      return { ok: true, providerId: id };
    }
    await res.body?.cancel().catch(() => undefined);
    // 429 is a rate or quota limit, 409 an identical request still in progress ("retry later"), 5xx the provider's own trouble.
    return { ok: false, code: `http_${res.status}`, retry: res.status === 429 || res.status === 409 || res.status >= 500 };
  } catch (err) {
    return { ok: false, code: (err as { name?: string }).name === "TimeoutError" ? "timeout" : "network", retry: true };
  }
}

/**
 * The in-process sender of `MAIL_MODE=resend`. `mail_outbox` is the source of truth: `runOnce` claims queued rows that are
 * due (`for update skip locked`, one transaction: it adds the try and leases the row), calls the provider outside any
 * transaction, then records the answer. Only content-free counters (`mail_sent`, `mail_retry`, `mail_failed`) and log lines
 * with a row id and a code come out of it. In `outbox` mode `settings` is undefined and nothing is ever delivered.
 */
export function createMailSender(opts: { db: Db; settings: MailSettings | undefined; apiUrl?: string; fetch?: typeof fetch; log: Logger }): MailSender {
  const { db, settings, log } = opts;
  const url = opts.apiUrl ?? RESEND_API_URL;
  const fetchFn = opts.fetch ?? fetch;
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<number> | undefined;
  let stopped = false;

  async function pass(): Promise<number> {
    if (settings === undefined) return 0;
    try {
      // Rows that cannot be sent any more: all their tries used (a process died in the last), or too old to be worth sending.
      const closed = await db.query<{ last_error: string }>(
        `update mail_outbox
            set status = 'failed',
                last_error = case when attempts >= $1 then 'gave_up' else 'expired' end
          where status = 'queued' and next_attempt_at <= now()
            and (attempts >= $1 or created_at <= now() - make_interval(mins => $2))
        returning last_error`,
        [MAX_ATTEMPTS, EXPIRES_AFTER_MINUTES],
      );
      if (closed.rows.length > 0) {
        count(db, "mail_failed", closed.rows.length);
        log.warn({ metric: "mail_failed", closed: closed.rows.length }, "mail closed without being sent (all tries used, or too old)");
      }
      const { rows } = await db.query<Claimed>(
        `with due as (
           select id from mail_outbox where status = 'queued' and next_attempt_at <= now() and attempts < $1
            order by id limit $2 for update skip locked)
         update mail_outbox m set attempts = m.attempts + 1, next_attempt_at = now() + make_interval(secs => $3)
           from due where m.id = due.id
        returning m.id::text as id, m.recipient, m.subject, m.body, m.attempts`,
        [MAX_ATTEMPTS, BATCH, LEASE_SECONDS],
      );
      for (const row of rows) await record(row, await call(fetchFn, url, settings, row));
      return rows.length;
    } catch (err) {
      // The database was unreachable or slow: the rows are still queued, the next pass looks again. Only a code is logged.
      log.warn({ code: (err as { code?: string }).code }, "mail sender pass failed; trying again next time");
      return 0;
    }
  }

  async function record(row: Claimed, outcome: Outcome): Promise<void> {
    if (outcome.ok) {
      await db.query(
        "update mail_outbox set status = 'sent', sent_at = now(), last_error = null, provider_id = $2 where id = $1 and status = 'queued'",
        [row.id, outcome.providerId],
      );
      count(db, "mail_sent");
      return;
    }
    if (outcome.retry && row.attempts < MAX_ATTEMPTS) {
      const wait = BACKOFF_SECONDS[Math.min(row.attempts, BACKOFF_SECONDS.length) - 1]!;
      await db.query(
        "update mail_outbox set last_error = $2, next_attempt_at = now() + make_interval(secs => $3) where id = $1 and status = 'queued'",
        [row.id, outcome.code, wait],
      );
      count(db, "mail_retry");
      log.info({ metric: "mail_retry", id: row.id, code: outcome.code, attempts: row.attempts }, "a mail will be tried again");
      return;
    }
    await db.query("update mail_outbox set status = 'failed', last_error = $2 where id = $1 and status = 'queued'", [row.id, outcome.code]);
    count(db, "mail_failed");
    log.warn({ metric: "mail_failed", id: row.id, code: outcome.code, attempts: row.attempts }, "a mail could not be sent");
  }

  const runOnce = (): Promise<number> => pass();

  return {
    runOnce,
    start(intervalMs = DEFAULT_POLL_MS) {
      if (settings === undefined || timer !== undefined || stopped) return;
      timer = setInterval(() => {
        if (inFlight) return; // passes never overlap in one process
        inFlight = pass().finally(() => {
          inFlight = undefined;
        });
      }, intervalMs);
      timer.unref();
    },
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      await inFlight;
    },
  };
}

/** How many rows are in each state (counts only: the numbers `mail:status` prints). */
export async function mailCounts(db: Db): Promise<{ queued: number; sent: number; failed: number }> {
  const { rows } = await db.query<{ status: string; n: string }>("select status, count(*)::text as n from mail_outbox group by status");
  const n = (status: string): number => Number(rows.find((r) => r.status === status)?.n ?? 0);
  return { queued: n("queued"), sent: n("sent"), failed: n("failed") };
}
