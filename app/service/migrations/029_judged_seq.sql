-- Up Migration
-- The latest message of the group a judgement that was answered looked at for this Agent. The messages after it are the
-- new ones the next judgement is asked about ("did anyone ask it to be quiet"): a request a later message covered still
-- counts, and one that was judged already is not counted again (src/agents/proactive/candidates.ts).
alter table agent_group_state add column judged_seq bigint;

-- Down Migration
alter table agent_group_state drop column judged_seq;
