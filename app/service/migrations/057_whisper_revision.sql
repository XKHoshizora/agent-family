-- Up Migration
-- Which of two copies of a whisper is the later (round 3: a tell is never lost — a `found_elsewhere` whisper whose told reply
-- ended without posting goes back to open, src/whispers/store.ts `afterTell`): raised by one at every change of its status
-- (an answer, an expiry, a reopening). Its owner's clients keep the copy with the higher one, so a copy read before a change
-- (a sync, a page of the list) never undoes it, and a reopening is never taken for such a stale copy. Owner-only, as every
-- whisper field.
alter table whispers add column revision integer not null default 0;

-- Down Migration
alter table whispers drop column revision;
