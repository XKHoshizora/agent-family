-- Up Migration
-- Real delivery (MAIL_MODE=resend, src/auth/mail-sender.ts). The outbox stays the source of truth: every mail is a row first.
-- `deliver`: the row is to be sent (MAIL_MODE was `resend` when it was queued, and its address was not over the hourly cap,
--   src/auth/mailer.ts). Rows written in `outbox` mode, and every row that exists before this migration, are false and are never
--   sent, whatever mode runs later.
-- `status`: queued (waiting for the sender), sent, failed (an answer that cannot succeed), expired (`expires_at` passed unsent),
--   capped (over the hourly cap for its address and kind: written, never delivered).
-- `attempts` counts tries (a claim adds one before the call is made, so a process that dies mid-call still has it counted);
--   `next_attempt_at` is when the next try is due (and, while a call is in flight, the end of its lease).
-- `expires_at`: when the link in the mail stops working; the sender never sends past it (set at queue time, src/auth/mailer.ts).
-- `last_error` is a short code (`http_500`, `network`, `expired` ...), never the provider's words or the recipient.
-- `provider_id` is the provider's id of the mail it accepted.
alter table mail_outbox
  add column deliver boolean not null default false,
  add column status text not null default 'queued' check (status in ('queued', 'sent', 'failed', 'expired', 'capped')),
  add column attempts int not null default 0,
  add column next_attempt_at timestamptz not null default now(),
  add column expires_at timestamptz not null default now(),
  add column sent_at timestamptz,
  add column last_error text,
  add column provider_id text;

-- The sender's pick and close-out; `mail:status` by day; the per-address cap's count (case-insensitive, as its lock is).
create index mail_outbox_due on mail_outbox (next_attempt_at) where status = 'queued' and deliver;
create index mail_outbox_created on mail_outbox (created_at);
create index mail_outbox_recipient on mail_outbox (lower(recipient), kind, created_at);

-- Down Migration
drop index mail_outbox_recipient;
drop index mail_outbox_created;
drop index mail_outbox_due;
alter table mail_outbox
  drop column provider_id,
  drop column last_error,
  drop column sent_at,
  drop column expires_at,
  drop column next_attempt_at,
  drop column attempts,
  drop column status,
  drop column deliver;
