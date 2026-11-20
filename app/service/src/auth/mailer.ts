import type { Config } from "../config.ts";
import type { Queryable } from "../db.ts";
import { RESET_PASSWORD_TTL_SECONDS, VERIFY_EMAIL_TTL_SECONDS } from "./mail-copy.ts";

export type MailKind = "verify_email" | "reset_password" | "registration_attempt";

/** How long a mail is worth sending: until the link in it stops working (the routes' own constants); a mail with no such link, a day. */
const EXPIRES_AFTER_SECONDS: Record<MailKind, number> = {
  verify_email: VERIFY_EMAIL_TTL_SECONDS,
  reset_password: RESET_PASSWORD_TTL_SECONDS,
  registration_attempt: 24 * 60 * 60,
};

/** What `sendMail` needs of the configuration: whether rows are to be delivered, and the hourly cap per address and kind. */
export interface MailPolicy {
  deliver: boolean;
  perAddressHour: number;
}

export const mailPolicy = (config: Pick<Config, "mailMode" | "mailPerAddressHour">): MailPolicy => ({
  deliver: config.mailMode === "resend",
  perAddressHour: config.mailPerAddressHour,
});

/**
 * Queues mail by writing it to `mail_outbox` (the sender, src/auth/mail-sender.ts, delivers it in `resend` mode). Pass `q` to
 * write through a transaction client so the mail commits or rolls back together with the work that caused it.
 *
 * The cap: when this address already has `perAddressHour` mails of this kind from the last hour, the row is still written, by the
 * same two statements as any other, but is marked not to be delivered (`failed`/`capped` in `resend` mode; untouched in `outbox`
 * mode, where nothing is delivered anyway). Whoever asked sees no difference.
 */
export async function sendMail(
  q: Queryable,
  kind: MailKind,
  recipient: string,
  subject: string,
  body: string,
  policy: MailPolicy,
): Promise<void> {
  const recent = await q.query<{ n: number }>(
    "select count(*)::int as n from mail_outbox where recipient = $1 and kind = $2 and created_at > now() - interval '1 hour'",
    [recipient, kind],
  );
  const capped = (recent.rows[0]?.n ?? 0) >= policy.perAddressHour;
  const deliver = policy.deliver && !capped;
  await q.query(
    `insert into mail_outbox (recipient, kind, subject, body, deliver, status, last_error, expires_at)
     values ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(secs => $8))`,
    [
      recipient,
      kind,
      subject,
      body,
      deliver,
      policy.deliver && capped ? "failed" : "queued",
      policy.deliver && capped ? "capped" : null,
      EXPIRES_AFTER_SECONDS[kind],
    ],
  );
}
