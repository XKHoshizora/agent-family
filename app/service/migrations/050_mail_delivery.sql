-- Up Migration
-- Real delivery (MAIL_MODE=resend, src/auth/mail-sender.ts). The outbox stays the source of truth: every mail is a row first.
-- `status`: queued (waiting for the sender; in `outbox` mode a row stays so), sent, failed. `attempts` counts tries (a claim adds
-- one before the call is made, so a process that dies mid-call still has the try counted); `next_attempt_at` is when the next try is
-- due (and, while a call is in flight, the end of its lease); `last_error` is a short code (`http_500`, `network`, `expired` ...),
-- never the provider's words or the recipient; `provider_id` is the provider's id of the mail it accepted.
-- Rows that exist now (written in outbox mode, never meant to be sent) stay `queued`; the sender closes any that has waited more
-- than an hour as failed/expired instead of sending a stale link.
alter table mail_outbox
  add column status text not null default 'queued' check (status in ('queued', 'sent', 'failed')),
  add column attempts int not null default 0,
  add column next_attempt_at timestamptz not null default now(),
  add column sent_at timestamptz,
  add column last_error text,
  add column provider_id text;

create index mail_outbox_queued on mail_outbox (next_attempt_at) where status = 'queued';

-- Down Migration
drop index mail_outbox_queued;
alter table mail_outbox
  drop column provider_id,
  drop column last_error,
  drop column sent_at,
  drop column next_attempt_at,
  drop column attempts,
  drop column status;
