-- Up Migration
-- An owner's open whispers in a conversation (src/whispers/): their count on every conversation entry of `GET /api/sync` and
-- `GET /api/conversations/:id`, and the open half of sync and catch-up's whispers, without walking the answered and expired ones.
create index whispers_open_owner_conversation_idx on whispers (owner_id, conversation_id) where status = 'open';

-- Down Migration
drop index whispers_open_owner_conversation_idx;
