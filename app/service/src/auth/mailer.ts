import type { Queryable } from "../db.ts";

export type MailKind = "verify_email" | "reset_password" | "registration_attempt";

/**
 * Delivers mail by writing it to `mail_outbox` (the only transport in this plan).
 * Pass `q` to write through a transaction client so the mail commits or rolls back
 * together with the work that caused it.
 */
export async function sendMail(
  q: Queryable,
  kind: MailKind,
  recipient: string,
  subject: string,
  body: string,
): Promise<void> {
  await q.query("insert into mail_outbox (recipient, kind, subject, body) values ($1, $2, $3, $4)", [
    recipient,
    kind,
    subject,
    body,
  ]);
}
