-- Up Migration
-- How an Agent addresses people, set by its owner. `owner_appellation`: what it calls its owner (null: by name).
-- `agent_appellations`: what it calls a specific other person or Agent. A row goes with its Agent or its target; nobody
-- but the Agent's owner reads or writes them (the route checks who the target may be and that there are at most 100).
alter table agents
  add column owner_appellation text null check (char_length(owner_appellation) between 1 and 20);

create table agent_appellations (
  agent_id uuid not null references agents (principal_id) on delete cascade,
  principal_id uuid not null references principals (id) on delete cascade,
  appellation text not null check (char_length(appellation) between 1 and 20),
  primary key (agent_id, principal_id),
  check (agent_id <> principal_id)
);
-- Deleting a target's principal finds its rows by this column.
create index agent_appellations_principal_idx on agent_appellations (principal_id);

-- Down Migration
drop table agent_appellations;
alter table agents drop column owner_appellation;
