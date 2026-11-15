-- Up Migration
-- Substring search (ILIKE '%q%') over what a message says: its text (captions included) and a file
-- message's attachment name. System notices are excluded by the query, not the indexes.
-- The expressions must match src/messages/search.ts exactly for the planner to use them. Trigram indexes
-- cannot serve patterns shorter than 3 characters; those queries are answered correctly by a scan.
-- Plain (not partial) so the planner can combine both with a BitmapOr for the one OR condition.
create index messages_text_trgm_idx on messages using gin ((body ->> 'text') gin_trgm_ops);
create index messages_attachment_name_trgm_idx on messages using gin (((body -> 'attachment') ->> 'name') gin_trgm_ops);

-- Down Migration
drop index messages_attachment_name_trgm_idx;
drop index messages_text_trgm_idx;
