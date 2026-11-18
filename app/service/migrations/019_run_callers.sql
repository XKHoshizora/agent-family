-- Up Migration
-- Who called for a run, and its lane (the limits: per-lane replies a minute, a limit per caller, per-lane concurrency,
-- the others' daily budget all read these two).

-- The person behind the call: the person whose message called for the reply, or the owner of the Agent whose message
-- did; its owner for a reply in the Agent's own conversation, a retry and a persona draft. Null for every run recorded
-- before this column existed, and once that person is gone.
-- own: the Agent's owner called for it (themselves, or through one of their own Agents); others: someone else did;
-- proactive: nobody did (batch 2D). Every run recorded before this column existed is own.
alter table agent_runs
  add column caller_id uuid references principals (id) on delete set null,
  add column lane text not null default 'own' check (lane in ('own', 'others', 'proactive'));

-- One caller's calls on other people's Agents over time, and an owner's replies by lane over time.
create index agent_runs_caller_created_idx on agent_runs (caller_id, created_at) where purpose = 'reply' and lane <> 'own';
create index agent_runs_owner_lane_created_idx on agent_runs (owner_id, lane, created_at) where purpose = 'reply';

-- Down Migration
drop index agent_runs_owner_lane_created_idx;
drop index agent_runs_caller_created_idx;
alter table agent_runs
  drop column lane,
  drop column caller_id;
