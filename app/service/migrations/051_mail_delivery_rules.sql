-- Up Migration
-- Fix round 1 of the mail delivery (050_mail_delivery.sql, already applied in databases that exist; could be folded into it before it is first applied anywhere shared).
-- `deliver`: the row is to be sent (MAIL_MODE was `resend` when it was queued, and its address was not over the hourly cap,
--   src/auth/mailer.ts). Rows written in `outbox` mode, and every row that exists now, are false and are never sent, whatever mode runs later.
-- `expires_at`: when the link in the mail stops working; the sender never sends past it, and a row that gets there ends `expired`.
-- `status` gains `expired`. `failed` is an answer that cannot succeed, or `capped` (over the hourly cap for its address and kind).
alter table mail_outbox
  add column deliver boolean not null default false,
  add column expires_at timestamptz not null default now();
alter table mail_outbox drop constraint mail_outbox_status_check;
alter table mail_outbox add constraint mail_outbox_status_check check (status in ('queued', 'sent', 'failed', 'expired'));

drop index mail_outbox_queued;
create index mail_outbox_due on mail_outbox (next_attempt_at) where status = 'queued' and deliver;
create index mail_outbox_created on mail_outbox (created_at);
create index mail_outbox_recipient on mail_outbox (recipient, kind, created_at);

-- Down Migration
drop index mail_outbox_recipient;
drop index mail_outbox_created;
drop index mail_outbox_due;
create index mail_outbox_queued on mail_outbox (next_attempt_at) where status = 'queued';
update mail_outbox set status = 'failed' where status = 'expired';
alter table mail_outbox drop constraint mail_outbox_status_check;
alter table mail_outbox add constraint mail_outbox_status_check check (status in ('queued', 'sent', 'failed'));
alter table mail_outbox drop column expires_at, drop column deliver;
