-- Up Migration
-- Blobs that may exist with no row referencing them. A key is recorded (and committed) before its bytes
-- are written, and the record is deleted in the transaction that makes a row reference the blob, or
-- after the blob itself was deleted. A replaced avatar's old key is recorded in the swap transaction.
-- Whatever stays past the upload deadline is deleted, blob and record, by the sweep.
create table pending_blobs (
  key text primary key,
  created_at timestamptz not null default now()
);
create index pending_blobs_created_idx on pending_blobs (created_at);

-- A blob belongs to one attachment; also lets the sweep check by key that nothing references it.
create unique index attachments_blob_key_key on attachments (blob_key);

-- Down Migration
drop index attachments_blob_key_key;
drop table pending_blobs;
