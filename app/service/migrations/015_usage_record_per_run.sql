-- Up Migration
-- A run is settled exactly once: at most one usage record per run, held by the database itself (settle and admitRun
-- check it too). Replaces the plain index on the same column.
drop index usage_records_run_idx;
create unique index usage_records_run_id_key on usage_records (run_id) where run_id is not null;

-- Down Migration
drop index usage_records_run_id_key;
create index usage_records_run_idx on usage_records (run_id) where run_id is not null;
