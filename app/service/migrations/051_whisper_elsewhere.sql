-- Up Migration
-- "Not in this group, but I have it elsewhere" (Task 8; src/agents/tools/elsewhere.ts). `whisper_elsewhere`: whether an Agent,
-- when a search of its reply in a group finds nothing there, looks once more in its other conversations and whispers what it
-- finds to its owner (群里没找到时悄悄告诉我; on by default: the product owner's decision 9). `whisper_id`: the whisper a reply
-- `告诉他们` queued tells the group about (its hits are read from the whisper when the reply begins); null for every other
-- reply. No foreign key: a whisper is deleted 30 days after it was made, and the run that told it stays as it was.
alter table agents add column whisper_elsewhere boolean not null default true;
alter table agent_runs add column whisper_id uuid;

-- Down Migration
alter table agent_runs drop column whisper_id;
alter table agents drop column whisper_elsewhere;
