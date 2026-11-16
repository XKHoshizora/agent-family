-- Up Migration
-- A model call in flight or finished. purpose 'reply' belongs to an agent conversation; a 'draft'
-- (persona drafting) has neither agent nor conversation but is a row so that its hold counts in admission.
create table agent_runs (
  id uuid primary key default gen_random_uuid(),
  purpose text not null check (purpose in ('reply', 'draft')),
  conversation_id uuid references conversations (id) on delete restrict,
  agent_id uuid references principals (id) on delete restrict,
  owner_id uuid not null references principals (id) on delete restrict,
  status text not null check (status in ('queued', 'running', 'done', 'failed', 'stopped', 'cancelled')),
  covers_seq bigint,
  pending_seq bigint,
  charge_to text check (charge_to in ('free', 'balance')),
  hold_micro bigint not null default 0 check (hold_micro >= 0),
  error text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  -- A reply has both a conversation and an agent; a draft has neither.
  check ((purpose = 'reply') = (conversation_id is not null and agent_id is not null)),
  check (purpose = 'reply' or (conversation_id is null and agent_id is null))
);
-- At most one active reply per agent; later messages are folded into pending_seq.
create unique index agent_runs_one_active_per_agent on agent_runs (agent_id) where status in ('queued', 'running');
create index agent_runs_owner_active_idx on agent_runs (owner_id) where status in ('queued', 'running');
create index agent_runs_conversation_idx on agent_runs (conversation_id, created_at) where conversation_id is not null;

alter table usage_records
  add constraint usage_records_run_id_fkey foreign key (run_id) references agent_runs (id) on delete restrict;

-- A persona the agent proposed in a message, which the owner may confirm or discard.
create table persona_proposals (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references principals (id) on delete restrict,
  message_id bigint not null references messages (id) on delete restrict,
  base_persona_version int not null,
  persona text not null,
  intro text,
  field text,
  status text not null default 'open' check (status in ('open', 'confirmed', 'discarded', 'superseded', 'stale')),
  created_at timestamptz not null default now()
);
create index persona_proposals_agent_idx on persona_proposals (agent_id, created_at);
create index persona_proposals_message_idx on persona_proposals (message_id);

-- Down Migration
drop table persona_proposals;
alter table usage_records drop constraint usage_records_run_id_fkey;
drop table agent_runs;
