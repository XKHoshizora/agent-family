-- Up Migration
-- Family names (Task N). An Agent's account name hangs under its owner's like a family name: `<owner's handle>.<name
-- part>`, e.g. `xiaolin.jarvis`. Only the name part is stored — in `principals.handle`, where an Agent's handle was — and
-- the full handle is put together wherever it is read (src/principals/store.ts `handleOf`), so it follows its owner's
-- rename by itself. Every Agent's handle so far was unique site-wide, so as a name part it is unique among its owner's
-- Agents too: no row changes.
--
-- A person's handle keeps its shape (3–24 of a-z0-9_) and stays unique among people, case ignored. An Agent's name part is
-- 2–24 of them and shares no pool with people's handles nor with other owners' Agents. It is unique among its owner's
-- Agents that are not deleted, checked where an Agent is created, under its owner's account lock (src/agents/
-- conversation.ts `createAgent`, the one writer): an index here cannot see `agents.deleted_at`. A deleted Agent's name
-- part is free at once.
alter table principals drop constraint principals_handle_key;
alter table principals drop constraint principals_handle_check;
alter table principals add constraint principals_handle_check
  check (handle::text ~ case when kind = 'human' then '^[a-z0-9_]{3,24}$' else '^[a-z0-9_]{2,24}$' end);
create unique index principals_human_handle_key on principals (handle) where kind = 'human';
create index principals_agent_name_idx on principals (owner_id, handle) where kind = 'agent';
comment on column principals.handle is 'A person: their handle. An Agent: its name part; its handle is <owner handle>.<name part> (handleOf).';

-- A person may change their handle once every 365 days: the time of their last change (null: never; the first change waits for nothing).
alter table principals add column handle_changed_at timestamptz;

-- Every handle a person gave up, theirs for good: nobody else may register it or change to it; they may take it back once
-- their year has passed. While it is not their current handle it names nobody (a lookup, a mention). No expiry.
create table reserved_handles (
  handle citext primary key check (handle::text ~ '^[a-z0-9_]{3,24}$'),
  principal_id uuid not null references principals (id) on delete restrict,
  reserved_at timestamptz not null default now()
);
create index reserved_handles_principal_idx on reserved_handles (principal_id);

-- Down Migration
-- Fails when two Agents' name parts are the same, or one is a person's handle, or 2 characters long: they shared one pool before.
drop table reserved_handles;
alter table principals drop column handle_changed_at;
comment on column principals.handle is null;
drop index principals_agent_name_idx;
drop index principals_human_handle_key;
alter table principals drop constraint principals_handle_check;
alter table principals add constraint principals_handle_check check (handle::text ~ '^[a-z0-9_]{3,24}$');
alter table principals add constraint principals_handle_key unique (handle);
