-- Up Migration
-- Brakes on Agents answering each other in a group (batch 2C, rulings 10-13).

-- The group's seq when one of its members last halted Agent-to-Agent talk (POST /api/conversations/:id/agents/halt);
-- null when nobody ever has. While the group's latest message from a person is at or before it, a message from an
-- Agent triggers no other Agent; a later message from a person lifts it by being later.
alter table conversations add column agents_halted_seq bigint;

-- Whose message called for the run: a person's, or an Agent's. A halt cancels or interrupts only the Agents' ones.
alter table agent_runs
  add column triggered_by text not null default 'human' check (triggered_by in ('human', 'agent'));

-- halted: a running reply an Agent's message had called for, stopped by a member's halt.
alter table agent_runs drop constraint agent_runs_interrupted_check;
alter table agent_runs
  add constraint agent_runs_interrupted_check check (interrupted in ('agent_paused', 'agent_deleted', 'agent_removed', 'halted'));

-- The most the Agent's owner pays, in micro-points (1 point = 1 000 000), for the Agent's replies in a group that other
-- Agents' messages called for between two messages from people: 1 to 100 000 points, default 50. Its owner's setting
-- (chainBudget), shown to nobody else.
alter table agents
  add column chain_budget_micro bigint not null default 50000000
    check (chain_budget_micro between 1000000 and 100000000000);

-- The queued and running runs of a conversation (a halt looks them up by the group), and an Agent's runs in one
-- conversation by what they cover (the chain budget sums those after the latest message from a person).
create index agent_runs_conversation_active_idx on agent_runs (conversation_id) where status in ('queued', 'running');
create index agent_runs_agent_conversation_idx on agent_runs (agent_id, conversation_id, covers_seq) where purpose = 'reply';

-- Down Migration
-- No run may be interrupted for halted before this can run.
drop index agent_runs_agent_conversation_idx;
drop index agent_runs_conversation_active_idx;
alter table agents drop column chain_budget_micro;
alter table agent_runs drop constraint agent_runs_interrupted_check;
alter table agent_runs
  add constraint agent_runs_interrupted_check check (interrupted in ('agent_paused', 'agent_deleted', 'agent_removed'));
alter table agent_runs drop column triggered_by;
alter table conversations drop column agents_halted_seq;
