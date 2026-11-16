-- Up Migration
-- A running reply whose Agent was paused or deleted: set in the pause's (or delete's) own transaction. The reply is
-- then never posted and the run ends cancelled with this reason, even if the Agent is resumed before the worker has
-- noticed. Null for every other run.
alter table agent_runs
  add column interrupted text check (interrupted in ('agent_paused', 'agent_deleted'));

-- Down Migration
alter table agent_runs drop column interrupted;
