-- Up Migration
-- Strength and last-mentioned time of a note (src/memory/pipeline.ts: a review that finds the owner repeating a note makes it
-- stronger and seen now, without changing it), and whether the owner's notes are consolidated at night (src/memory/dream.ts)
-- and when that last happened.
alter table owner_notes add column strength integer not null default 0, add column seen_at timestamptz not null default now();
alter table agent_notes add column strength integer not null default 0, add column seen_at timestamptz not null default now();
alter table accounts add column dream boolean not null default true, add column dreamed_at timestamptz;

-- Down Migration
alter table accounts drop column dreamed_at, drop column dream;
alter table agent_notes drop column seen_at, drop column strength;
alter table owner_notes drop column seen_at, drop column strength;
