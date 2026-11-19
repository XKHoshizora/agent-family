-- Up Migration
-- 034 gave every note that already existed `seen_at = now()` (the migration's own time), which is later than the time it was
-- last written: a first dream would take all of them for freshly mentioned. A note's last-mentioned time is at first the time
-- it was last written.
update owner_notes set seen_at = updated_at where seen_at > updated_at;
update agent_notes set seen_at = updated_at where seen_at > updated_at;

-- The dream's sweep asks, for every owner, whether they have sent a message lately and whether a change was made since their
-- last dream (src/memory/dream.ts).
create index messages_sender_created_idx on messages (sender_id, created_at);
create index memory_changes_owner_status_idx on memory_changes (owner_id, status);

-- A change made by a dream is told from the others: a nap's own change is no activity for the next night's dream.
alter table memory_changes add column phase text not null default 'rest' check (phase in ('rest', 'dream'));

-- Down Migration
alter table memory_changes drop column phase;
drop index memory_changes_owner_status_idx;
drop index messages_sender_created_idx;
