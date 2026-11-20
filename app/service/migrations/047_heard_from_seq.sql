-- Up Migration
-- Where an Agent's hearing in a group starts (Task 0d, M-3 of the round-3 review): a line of the group may be heard for this Agent
-- (raise a hearsay or an own flag, memory_flags) only when its seq is above this, besides being new to the group's judgement
-- (`judged_seq`, which stays the judgement's own and is read across the group's Agents). The memory switch moves it for the
-- switching Agent alone (src/memory/pipeline.ts `memorySwitched`): off, and on again without catchUp, to the group's latest seq;
-- on again with catchUp, it stays at the switch-off. 0: from the Agent's joining, as before. Never on the wire.
alter table agent_group_state add column heard_from_seq bigint not null default 0;

-- Down Migration
alter table agent_group_state drop column heard_from_seq;
