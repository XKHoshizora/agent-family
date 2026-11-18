-- Up Migration
-- Where an Agent's floating threshold stands in one group (see src/agents/proactive/threshold.ts). `surcharge` rose when
-- it last spoke unasked (at `surcharge_at`, after message `surcharge_seq`); `quiet` rose when someone asked it to be quiet
-- (at `quiet_at`, halving every `quiet_half_life_s`). `judged_at`: when the judgement model last looked at it here.
-- The Agent is referenced through principals, not agents: a foreign key to agents would lock the Agent row inside every
-- message transaction that touches this one.
create table agent_group_state (
  agent_id uuid not null references principals (id) on delete cascade,
  conversation_id uuid not null references conversations (id) on delete cascade,
  surcharge real not null default 0 check (surcharge >= 0),
  surcharge_at timestamptz,
  surcharge_seq bigint,
  quiet real not null default 0 check (quiet >= 0),
  quiet_half_life_s integer check (quiet_half_life_s is null or quiet_half_life_s > 0),
  quiet_at timestamptz,
  judged_at timestamptz,
  primary key (agent_id, conversation_id)
);
-- Deleting a conversation finds its rows by this column.
create index agent_group_state_conversation_idx on agent_group_state (conversation_id);

-- Down Migration
drop table agent_group_state;
