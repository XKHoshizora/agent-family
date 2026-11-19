-- Up Migration
-- The periodic clean-up of memory_changes (src/memory/sweep.ts) looks for what is over by status and by when it was resolved.
create index memory_changes_status_resolved_idx on memory_changes (status, resolved_at);

-- Down Migration
drop index memory_changes_status_resolved_idx;
