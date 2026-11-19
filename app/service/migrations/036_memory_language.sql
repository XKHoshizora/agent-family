-- Up Migration
-- The one language the owner's notes are written in (src/memory/language.ts has the list of codes); null is automatic: the
-- language the notes already have, or the one the owner speaks.
alter table accounts add column memory_language text;

-- Down Migration
alter table accounts drop column memory_language;
