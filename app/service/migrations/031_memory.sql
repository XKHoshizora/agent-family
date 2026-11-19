-- Up Migration
-- An Agent's memory: notes about the owner (shared by all their Agents), an Agent's own notes, what an Agent heard in a
-- group, the changes a review made (to undo or to confirm), and the bookkeeping of reviews. Principals and conversations
-- are referenced, never `agents` (its rows are keyed by the Agent's principal, as everywhere).
-- A note is in the vault unless it was sorted out: `vault_by` says whether code ('auto') or the owner chose.
create table owner_notes (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references principals (id) on delete cascade,
  text text not null check (char_length(text) between 1 and 3000),
  vault boolean not null default true,
  vault_by text not null default 'auto' check (vault_by in ('auto', 'owner')),
  unsure boolean not null default false,
  origin_conversation_id uuid references conversations (id) on delete set null,
  origin text not null default 'review' check (origin in ('review', 'owner', 'hearsay')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index owner_notes_owner_idx on owner_notes (owner_id, created_at);

create table agent_notes (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references principals (id) on delete cascade,
  text text not null check (char_length(text) between 1 and 3000),
  vault boolean not null default true,
  vault_by text not null default 'auto' check (vault_by in ('auto', 'owner')),
  unsure boolean not null default false,
  origin_conversation_id uuid references conversations (id) on delete set null,
  origin text not null default 'review' check (origin in ('review', 'owner', 'hearsay')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index agent_notes_agent_idx on agent_notes (agent_id, created_at);

create table agent_hearsay (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references principals (id) on delete cascade,
  conversation_id uuid not null references conversations (id) on delete cascade,
  speaker_id uuid references principals (id) on delete set null,
  speaker_name text not null,
  text text not null check (char_length(text) between 1 and 200),
  said_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index agent_hearsay_agent_idx on agent_hearsay (agent_id, created_at);

create table memory_changes (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references principals (id) on delete cascade,
  agent_id uuid not null references principals (id) on delete cascade,
  conversation_id uuid references conversations (id) on delete set null,
  status text not null check (status in ('applied', 'undone', 'pending', 'discarded')),
  ops jsonb not null,
  "full" boolean not null default false,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create table memory_review_state (
  agent_id uuid not null references principals (id) on delete cascade,
  conversation_id uuid not null references conversations (id) on delete cascade,
  reviewed_seq bigint not null default 0,
  primary key (agent_id, conversation_id)
);

create table memory_flags (
  agent_id uuid not null references principals (id) on delete cascade,
  conversation_id uuid not null references conversations (id) on delete cascade,
  seq bigint not null,
  kind text not null check (kind in ('hearsay', 'own')),
  created_at timestamptz not null default now(),
  primary key (agent_id, conversation_id, seq, kind)
);

alter table agents
  add column memory boolean not null default true,
  add column memory_ask boolean not null default false,
  add column shared_notes boolean not null default true;
alter table accounts add column new_notes text not null default 'auto' check (new_notes in ('auto', 'vault', 'open'));

-- Down Migration
alter table accounts drop column new_notes;
alter table agents drop column shared_notes, drop column memory_ask, drop column memory;
drop table memory_flags;
drop table memory_review_state;
drop table memory_changes;
drop table agent_hearsay;
drop table agent_notes;
drop table owner_notes;
