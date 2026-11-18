-- Up Migration
-- How many judgements the site asked the judgement model for on each site day (midnight in SITE_TIMEZONE; see
-- src/agents/proactive/decide.ts). Once a day's count reaches JUDGE.dailyLimit no more are asked that day, so no Agent
-- replies unasked until the next. The judgement is the site's cost, never a user's.
create table judge_usage (
  day date primary key,
  calls integer not null default 0 check (calls >= 0)
);

-- Down Migration
drop table judge_usage;
