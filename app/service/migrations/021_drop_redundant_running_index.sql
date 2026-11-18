-- Up Migration
-- The index 020 made for the others' budget's sum of running replies duplicates agent_runs_one_active_per_agent_conversation,
-- whose condition covers status = 'running' and which leads on agent_id; the budget's query uses that one.
drop index agent_runs_agent_running_idx;

-- Down Migration
create index agent_runs_agent_running_idx on agent_runs (agent_id) where status = 'running';
