-- Up Migration
-- The model a run's call was admitted on, recorded with its charge_to and hold, so that settlement prices and
-- records the call that was made whatever the Agent's model is by then. Both null until admission.
alter table agent_runs
  add column source text check (source in ('site', 'provider')),
  add column model text,
  add constraint agent_runs_model_with_source check ((source is null) = (model is null)),
  -- A site call is charged to exactly one source; a provider call, or a run not admitted, to none.
  add constraint agent_runs_charge_with_site check ((charge_to is not null) = (source is not distinct from 'site'));

-- A run settled without ever being admitted (it failed before reaching a model) leaves a record with neither
-- source nor model, which costs nothing.
alter table usage_records
  alter column source drop not null,
  alter column model drop not null,
  add constraint usage_records_model_with_source check ((source is null) = (model is null)),
  add constraint usage_records_no_source_no_cost check (source is not null or cost_micro = 0);

-- Down Migration
-- Records without a model cost nothing and no ledger entry refers to them.
delete from usage_records where source is null;
alter table usage_records
  drop constraint usage_records_no_source_no_cost,
  drop constraint usage_records_model_with_source,
  alter column model set not null,
  alter column source set not null;
alter table agent_runs
  drop constraint agent_runs_charge_with_site,
  drop constraint agent_runs_model_with_source,
  drop column model,
  drop column source;
