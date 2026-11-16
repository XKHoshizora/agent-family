-- Up Migration
-- All amounts are bigint micro-points (1 point = 1 000 000).

-- balance_micro has no non-negative check on purpose: one reply of debt is allowed.
create table accounts (
  principal_id uuid primary key references principals (id) on delete restrict,
  tier text not null default 'free',
  balance_micro bigint not null default 0,
  created_at timestamptz not null default now()
);

-- What the free daily allowance has used, per owner and site-timezone day.
create table free_usage (
  owner_id uuid not null references principals (id) on delete restrict,
  day date not null,
  used_micro bigint not null default 0 check (used_micro >= 0),
  primary key (owner_id, day)
);

-- One row per model call (reply or persona draft). agent_id and run_id are null for a draft;
-- run_id gets its foreign key in 011, where agent_runs is created.
create table usage_records (
  id bigserial primary key,
  owner_id uuid not null references principals (id) on delete restrict,
  agent_id uuid references principals (id) on delete restrict,
  run_id uuid,
  purpose text not null check (purpose in ('reply', 'draft')),
  source text not null check (source in ('site', 'provider')),
  model text not null,
  input_tokens bigint not null default 0 check (input_tokens >= 0),
  output_tokens bigint not null default 0 check (output_tokens >= 0),
  estimated boolean not null default false,
  cost_micro bigint not null default 0 check (cost_micro >= 0),
  free_micro bigint not null default 0 check (free_micro >= 0),
  balance_micro bigint not null default 0 check (balance_micro >= 0),
  forgiven_micro bigint not null default 0 check (forgiven_micro >= 0),
  outcome text not null check (outcome in ('done', 'stopped', 'failed', 'cancelled')),
  created_at timestamptz not null default now()
);
create index usage_records_owner_idx on usage_records (owner_id, created_at);
create index usage_records_run_idx on usage_records (run_id) where run_id is not null;

-- Append-only record of every change to accounts.balance_micro.
create table balance_ledger (
  id bigserial primary key,
  owner_id uuid not null references principals (id) on delete restrict,
  delta_micro bigint not null,
  reason text not null check (reason in ('grant', 'adjust', 'usage')),
  note text,
  usage_id bigint references usage_records (id) on delete restrict,
  created_at timestamptz not null default now()
);
create index balance_ledger_owner_idx on balance_ledger (owner_id, id);

-- Down Migration
drop table balance_ledger;
drop table usage_records;
drop table free_usage;
drop table accounts;
