-- Up Migration
-- 也回顾一下 in a group (Task 0d Part F, the product owner's decision of 2026-11-21): switching an Agent's memory on with catchUp
-- queues one catch-up per group it is in (src/memory/catchup.ts): the lines after `from_seq` up to `to_seq` (the group's latest at
-- the switch), judged for this Agent alone, oldest first. `from_seq` is where switching off left its heard position (never before
-- its join) until the first window's step moves it up to the bounded start (`MEMORY.catchUpLines`, `catchUpDays`), which a
-- catch-up resumed after a restart then goes on from.
-- `next_seq`: the next line to judge; past `to_seq` it is done (finished, stopped at a bound, or stopped by the allowance). The row
-- stays until the Agent's memory is switched again: until then the group's normal judgements flag nothing for this Agent at or below
-- `to_seq` (the catch-up's lines). `token`: this row's instance; a step of a catch-up is recorded only while it is still the row it
-- read (a new switch replaces it). Stored, so a catch-up queued before a restart runs after it. Never on the wire.
create table memory_catchups (
  agent_id uuid not null references principals (id) on delete cascade,
  conversation_id uuid not null references conversations (id) on delete cascade,
  from_seq bigint not null,
  to_seq bigint not null,
  next_seq bigint not null,
  token uuid not null default gen_random_uuid(),
  created_at timestamptz not null default now(),
  primary key (agent_id, conversation_id),
  check (to_seq > from_seq and next_seq > from_seq)
);
-- Deleting a conversation finds its rows by this column.
create index memory_catchups_conversation_idx on memory_catchups (conversation_id);

-- Down Migration
drop table memory_catchups;
