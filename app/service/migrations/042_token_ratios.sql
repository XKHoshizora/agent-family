-- Up Migration
-- How many tokens a model really counts for a unit of the service's estimate (src/metering/tokens.ts): learned from the input
-- tokens upstreams report for replies, one row per model: `site:<id>` (shared by every owner), `provider:<provider row
-- id>:<model name>` (that provider's own; deleted with it). Nothing in it names an owner, a conversation or a text.
create table token_ratios (
  key text primary key,
  ratio double precision not null,
  samples integer not null,
  updated_at timestamptz not null
);
-- Written at admission: a reply's input estimate at ratio 1 when it showed text only (null otherwise, and for every run
-- before this), and the key of the ratio it was held by — what settlement learns from.
alter table agent_runs add column input_estimate integer, add column ratio_key text;

-- Down Migration
alter table agent_runs drop column ratio_key, drop column input_estimate;
drop table token_ratios;
