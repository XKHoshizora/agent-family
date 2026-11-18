-- Up Migration
-- An Agent's message in a group that named Agent agent_id and was refused for it when it was posted: the group was
-- halted, the chain limit, that Agent's chain budget, its others' daily budget, or a block (src/agents/runs.ts
-- triggerFromAgent). A follow-up of that Agent re-reads the messages after what its reply covered (followUp); one
-- refused so is no call of it. Never on the wire.
create table refused_agent_calls (
  conversation_id uuid not null,
  seq bigint not null,
  agent_id uuid not null references agents (principal_id) on delete cascade,
  primary key (conversation_id, seq, agent_id),
  foreign key (conversation_id, seq) references messages (conversation_id, seq) on delete cascade
);

-- Down Migration
drop table refused_agent_calls;
