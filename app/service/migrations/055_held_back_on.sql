-- Up Migration
-- The source a held-back reply waits for (Task H fix round 1; README "Metering", Money that does not block): `free` (the
-- day's free allowance) or `balance`, beside `held_back_by` (054). Kept, with `held_back_by`, until the reply is admitted
-- (src/metering/admit.ts `admitRun` clears both): until then the worker's claim keeps the owner's younger site-model
-- replies that would be paid from the same source behind it (src/agents/port-impl.ts `claimNext`) — a reply on the owner's
-- own provider key, or one the other source pays, is never held behind it. Null for every other run. Never on the wire.
alter table agent_runs add column held_back_on text check (held_back_on in ('free', 'balance'));

-- Down Migration
alter table agent_runs drop column held_back_on;
