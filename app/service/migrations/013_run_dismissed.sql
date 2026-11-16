-- Up Migration
-- dismissed_at: the owner closed the notice of a failed reply; GET /api/conversations/:id/run no longer shows it.
-- resets_at: for a reply that failed with no_quota on a free-tier model, when the free allowance starts again.
alter table agent_runs
  add column dismissed_at timestamptz,
  add column resets_at timestamptz;
-- The replies one owner started in the last minute (agentRunsPerMinute).
create index agent_runs_owner_created_idx on agent_runs (owner_id, created_at) where purpose = 'reply';

-- Down Migration
drop index agent_runs_owner_created_idx;
alter table agent_runs
  drop column resets_at,
  drop column dismissed_at;
