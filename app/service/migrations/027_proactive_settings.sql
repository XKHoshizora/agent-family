-- Up Migration
-- The owner's settings for proactive replies (an Agent answering in a group without being @-mentioned, when the
-- judgement model picks it). `proactive`: on or off. `proactive_level`: how readily it speaks (`less`, `normal`, `more`).
-- `proactive_budget_micro`: the most its owner pays, in micro-points, in a site day for such replies (1 to 100 000 points,
-- 20 by default; there is no unlimited setting).
alter table agents
  add column proactive boolean not null default false,
  add column proactive_level text not null default 'normal' check (proactive_level in ('less', 'normal', 'more')),
  add column proactive_budget_micro bigint not null default 20000000 check (proactive_budget_micro between 1000000 and 100000000000);

-- Down Migration
alter table agents
  drop column proactive_budget_micro,
  drop column proactive_level,
  drop column proactive;
