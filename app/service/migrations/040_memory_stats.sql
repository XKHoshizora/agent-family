-- Up Migration
-- Content-free counters of how the memory feature really behaves (src/memory/stats.ts): one row per site-timezone day and
-- counter name. Nothing in it names an owner, a conversation or a text.
create table memory_stats (
  day date not null,
  name text not null,
  n bigint not null default 0 check (n >= 0),
  primary key (day, name)
);

-- Down Migration
drop table memory_stats;
