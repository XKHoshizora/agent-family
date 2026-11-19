-- Up Migration
-- How many times a flag has been tried and could not be acted on (a call that could not be made, a step that threw): a flag is
-- tried at most twice, then deleted (src/memory/hearsay.ts).
alter table memory_flags add column tries smallint not null default 0;

-- Speakers whose hearsay is not listened to for an owner for a while (a member who flooded or probed): the group
-- judgement raises no hearsay flag for the owner's Agents from a muted speaker until `until`.
create table hearsay_mutes (
  owner_id uuid not null references principals (id) on delete cascade,
  speaker_id uuid not null references principals (id) on delete cascade,
  until timestamptz not null,
  primary key (owner_id, speaker_id)
);

-- Down Migration
drop table hearsay_mutes;
alter table memory_flags drop column tries;
