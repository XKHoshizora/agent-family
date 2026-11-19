-- Up Migration
-- The site's judgement model is asked on behalf of one owner's memory (sorting, the duplicate test, the faithful check, the hearsay
-- pre-check) at most MEMORY.judgePerOwnerDay times a site day: one row per owner and site day. Counted as `judge_usage` is (every
-- call whatever came of it, in a statement of its own, so a failed count never changes an answer).
create table memory_judge_usage (
  owner_id uuid not null references principals (id) on delete cascade,
  day date not null,
  calls integer not null default 0 check (calls >= 0),
  primary key (owner_id, day)
);

-- Down Migration
drop table memory_judge_usage;
