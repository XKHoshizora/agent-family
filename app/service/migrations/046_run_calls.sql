-- Up Migration
-- The messages that called for a reply (Task 10b, fix round 2): the seq of each call it answers — the mention, the message
-- a reply nobody asked for was picked for, the Agent's message that called it — gathered as calls are folded into it,
-- noted on it or answered by a follow-up, and kept by a retry. In a group, what its model is shown starts after its
-- asker's line (src/agents/context.ts `askerLine`), but these are shown even at or before it: an older member's question
-- is answered even when a newcomer spoke meanwhile. Null when not known — every run recorded before this column —: then
-- its `covers_seq` alone. Never on the wire.
alter table agent_runs add column call_seqs bigint[];

-- Down Migration
alter table agent_runs drop column call_seqs;
