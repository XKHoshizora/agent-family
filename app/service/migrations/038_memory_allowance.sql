-- Up Migration
-- Memory has its own daily allowance, paid by the site (MEMORY.freeDailyPoints): a call of purpose 'memory' on a site model is
-- charged to it, never to the free allowance or the balance. What it has used, per owner and site-timezone day (as free_usage).
create table memory_usage (
  owner_id uuid not null references principals (id) on delete restrict,
  day date not null,
  used_micro bigint not null default 0 check (used_micro >= 0),
  primary key (owner_id, day)
);

-- A third source a run can be charged to, and the part of a usage record the memory allowance paid.
alter table agent_runs drop constraint agent_runs_charge_to_check;
alter table agent_runs add constraint agent_runs_charge_to_check check (charge_to in ('free', 'balance', 'memory'));
alter table usage_records add column memory_micro bigint not null default 0 check (memory_micro >= 0);

-- Down Migration
alter table usage_records drop column memory_micro;
alter table agent_runs drop constraint agent_runs_charge_to_check;
-- `not valid`: runs charged to 'memory' may exist, and the old check must not be proved against them (as 039's Down does).
alter table agent_runs add constraint agent_runs_charge_to_check check (charge_to in ('free', 'balance')) not valid;
drop table memory_usage;
