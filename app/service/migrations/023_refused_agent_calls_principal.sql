-- Up Migration
-- refused_agent_calls.agent_id referred to agents (022), so recording a refusal took a key-share lock on the refused
-- Agent's agents row inside postAsAgent's transaction, which locks no agents row but the poster's: it waited behind
-- that Agent's lockAgent (a pause, a send naming it, its own post) and could deadlock (src/agents/runs.ts
-- triggerFromAgent). It refers to the Agent's principal instead, as agent_runs.agent_id and usage_records.agent_id do.
alter table refused_agent_calls
  drop constraint refused_agent_calls_agent_id_fkey,
  add constraint refused_agent_calls_agent_id_fkey foreign key (agent_id) references principals (id) on delete cascade;

-- Down Migration
alter table refused_agent_calls
  drop constraint refused_agent_calls_agent_id_fkey,
  add constraint refused_agent_calls_agent_id_fkey foreign key (agent_id) references agents (principal_id) on delete cascade;
