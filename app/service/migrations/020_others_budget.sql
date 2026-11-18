-- Up Migration
-- The others' daily budget (the limits plan, Task 4).

-- The most the Agent's owner pays, in micro-points (1 point = 1 000 000), in a site day for the Agent's replies that
-- people other than its owner called for (lane others: themselves or through their own Agents): 1 to 100 000 points,
-- default 20 (every Agent made before this column existed gets it too); null for no limit. Its owner's setting
-- (othersBudget), shown to nobody else.
alter table agents
  add column others_budget_micro bigint null default 20000000
    check (others_budget_micro is null or others_budget_micro between 1000000 and 100000000000);

-- What the budget sums on every call someone else makes on the Agent: what its replies were charged since the site day
-- began, and what its running replies hold.
create index usage_records_agent_created_idx on usage_records (agent_id, created_at) where agent_id is not null;
create index agent_runs_agent_running_idx on agent_runs (agent_id) where status = 'running';

-- Down Migration
drop index agent_runs_agent_running_idx;
drop index usage_records_agent_created_idx;
alter table agents drop column others_budget_micro;
