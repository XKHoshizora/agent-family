-- Up Migration
-- Money that does not block (Task H; README "Metering").
--
-- A reply held back (src/metering/admit.ts `HeldBack`, src/agents/port-impl.ts `begin`): its admission found the holds of
-- its owner's other running calls against its source too large beside its own (`HOLDS.maxOpenShare` of what is left), so
-- it went back to `queued` with the ids of those running calls. The worker's claim (`claimNext`) passes it over — and every
-- younger queued reply of the same owner after it — until one of them is no longer running; null for every other run.
-- Decided and written under the owner's `accounts` row lock, which every settlement takes before a run leaves `running`,
-- so none of them can have ended unseen. Never on the wire.
alter table agent_runs add column held_back_by uuid[];

-- The reminders an owner was sent about the day's free allowance (src/metering/reminders.ts): at most one of each
-- threshold per owner and site day (`warn`: `ALLOWANCE.warnAt` of it used; `empty`: used up with the balance at or below
-- zero). Written once, under the owner's `accounts` row lock; an owner's earlier days are deleted as a new one is written.
create table allowance_reminders (
  owner_id uuid not null references principals (id) on delete cascade,
  day date not null,
  threshold text not null check (threshold in ('warn', 'empty')),
  primary key (owner_id, day, threshold)
);

-- A whisper of kind `allowance`: one of those reminders, or `余额用完了。` when a reply takes the balance to zero or below.
alter table whispers drop constraint whispers_kind_check;
alter table whispers add constraint whispers_kind_check check (kind in ('found_elsewhere', 'tools_off', 'memory', 'allowance'));

-- Down Migration
delete from whispers where kind = 'allowance';
alter table whispers drop constraint whispers_kind_check;
alter table whispers add constraint whispers_kind_check check (kind in ('found_elsewhere', 'tools_off', 'memory'));
drop table allowance_reminders;
alter table agent_runs drop column held_back_by;
