-- Up Migration
-- The reasoning level a run's call was sent at (the Agent's when its model takes it, else `none`), recorded with the
-- call's source and model when it is admitted, so that its owner can be shown which model and level a reply used
-- (`via`, messages/read.ts) whatever the Agent's settings are by then. Null until admission, and for every run admitted
-- before this column existed (their replies show no `via`).
alter table agent_runs
  add column reasoning text check (reasoning in ('none', 'low', 'medium', 'high', 'xhigh', 'max')),
  add constraint agent_runs_reasoning_with_source check (reasoning is null or source is not null);

-- Down Migration
alter table agent_runs
  drop constraint agent_runs_reasoning_with_source,
  drop column reasoning;
