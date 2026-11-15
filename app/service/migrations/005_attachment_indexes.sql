-- Up Migration
-- Every upload sums its uploader's stored bytes (the quota), and the orphan sweep looks for old unsent uploads.
create index attachments_uploader_idx on attachments (uploader_id);
create index attachments_unsent_idx on attachments (created_at) where message_id is null;

-- Down Migration
drop index attachments_unsent_idx;
drop index attachments_uploader_idx;
