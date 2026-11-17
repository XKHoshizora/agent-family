-- Up Migration
-- Groundwork for an owner's Agent in the owner's groups (batch 2C).

-- At most one active reply per Agent per conversation (it was per Agent): covers_seq and pending_seq are seqs of the
-- run's own conversation, so later messages are folded into the active reply of that conversation only. An Agent may
-- then be answering in its own conversation and in a group at once; its owner's limits still bound how many run.
drop index agent_runs_one_active_per_agent;
create unique index agent_runs_one_active_per_agent_conversation on agent_runs (agent_id, conversation_id)
  where status in ('queued', 'running');

-- agent_removed: a running reply whose Agent left that conversation (removed from the group, or its owner left it).
alter table agent_runs drop constraint agent_runs_interrupted_check;
alter table agent_runs
  add constraint agent_runs_interrupted_check check (interrupted in ('agent_paused', 'agent_deleted', 'agent_removed'));

-- Who may call the Agent with @ in a group it is in: every member, or its owner only. Its owner's setting, shown to
-- nobody else.
alter table agents
  add column group_mentions text not null default 'members' check (group_mentions in ('members', 'owner'));

-- Down Migration
-- No Agent may have an active reply in more than one conversation, nor any run be interrupted for agent_removed,
-- before this can run.
alter table agents drop column group_mentions;
alter table agent_runs drop constraint agent_runs_interrupted_check;
alter table agent_runs add constraint agent_runs_interrupted_check check (interrupted in ('agent_paused', 'agent_deleted'));
drop index agent_runs_one_active_per_agent_conversation;
create unique index agent_runs_one_active_per_agent on agent_runs (agent_id) where status in ('queued', 'running');
