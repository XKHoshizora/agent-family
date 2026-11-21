-- Up Migration
-- Money that does not block (Task H; README "Metering").
--
-- A reply held back (src/metering/admit.ts `HeldBack`, src/agents/port-impl.ts `begin`): its admission found the holds of
-- its owner's other running calls against its source too large beside its own (`HOLDS.maxOpenShare` of what is left), so
-- it went back to `queued` with the ids of those running calls (`held_back_by`) and the source it waits on
-- (`held_back_on`: `free`, `balance`, or `any` when the holds left neither source it may use anything). Both are kept until
-- it is admitted (`admitRun` clears them). The worker's claim (`claimNext`) passes it over while every one of those calls
-- is still running; and until it is admitted — queued, or claimed again and not admitted yet — the owner's younger
-- site-model replies that would be paid from that source wait behind it (a reply nobody asked for in another's lane never
-- holds back the owner's own; a reply on the owner's own provider key, or one the other source pays, is never held back).
-- Decided and written under the owner's `accounts` row lock, which every settlement takes before a run leaves `running`,
-- so none of those calls can have ended unseen. Null for every other run. Never on the wire.
alter table agent_runs add column held_back_by uuid[];
alter table agent_runs add column held_back_on text check (held_back_on in ('free', 'balance', 'any'));

-- Its owner asked it to stop while it was running (src/agents/runs.ts `stopRun`): kept in the row, so a stop that lands
-- while the reply is being held back, or claimed again, is still seen (`begin`'s `halted`). Never on the wire.
alter table agent_runs add column stop_asked boolean not null default false;

-- The reminders an owner is due about their money (src/metering/reminders.ts), each written in the transaction of the
-- settlement that calls for it, under the owner's `accounts` row: `warn` (`ALLOWANCE.warnAt` of the day's free allowance
-- used) and `empty` (used up with the balance at or below zero), at most one of each per owner and site day; `balance` (a
-- call took the balance from above zero to zero or below), once per crossing. Its whisper is made after that transaction
-- commits, in the conversation of `agent_id` (a reply's own Agent; null: the Agent its owner used last), with the
-- whisper's own locks; `delivered_at` says it was (also when no whisper could be made, or none was due: an `empty`'s
-- `warn`). The periodic sweep delivers any left undelivered (a crash between the two). `agent_id` has no foreign key: the
-- settlement must take no lock on an Agent's row it does not hold already. An owner's earlier days are deleted as a new
-- one is written.
create table allowance_reminders (
  id bigserial primary key,
  owner_id uuid not null references principals (id) on delete cascade,
  day date not null,
  threshold text not null check (threshold in ('warn', 'empty', 'balance')),
  agent_id uuid,
  whisper_id uuid,
  delivered_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index allowance_reminders_once on allowance_reminders (owner_id, day, threshold) where threshold in ('warn', 'empty');
create index allowance_reminders_undelivered on allowance_reminders (created_at) where delivered_at is null;

-- A whisper of kind `allowance`: one of those reminders.
alter table whispers drop constraint whispers_kind_check;
alter table whispers add constraint whispers_kind_check check (kind in ('found_elsewhere', 'tools_off', 'memory', 'allowance'));

-- Down Migration
delete from whispers where kind = 'allowance';
alter table whispers drop constraint whispers_kind_check;
alter table whispers add constraint whispers_kind_check check (kind in ('found_elsewhere', 'tools_off', 'memory'));
drop table allowance_reminders;
alter table agent_runs drop column stop_asked;
alter table agent_runs drop column held_back_on;
alter table agent_runs drop column held_back_by;
