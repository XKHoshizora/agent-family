-- Up Migration
-- A third purpose besides a reply and a persona draft: the background calls of an Agent's memory (a review of what the
-- owner said, a consolidation). Like a draft it has neither Agent nor conversation, belongs to the owner, and is paid
-- with the owner's points (src/memory/call.ts).
alter table agent_runs drop constraint agent_runs_purpose_check;
alter table agent_runs add constraint agent_runs_purpose_check check (purpose in ('reply', 'draft', 'memory'));
alter table usage_records drop constraint usage_records_purpose_check;
alter table usage_records add constraint usage_records_purpose_check check (purpose in ('reply', 'draft', 'memory'));

-- Down Migration
-- `not valid`: runs and usage records of purpose 'memory' may exist, and the old checks must not be proved against them (as 038's Down does).
alter table usage_records drop constraint usage_records_purpose_check;
alter table usage_records add constraint usage_records_purpose_check check (purpose in ('reply', 'draft')) not valid;
alter table agent_runs drop constraint agent_runs_purpose_check;
alter table agent_runs add constraint agent_runs_purpose_check check (purpose in ('reply', 'draft')) not valid;
