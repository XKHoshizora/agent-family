-- Up Migration
-- A user's own model provider. The key is stored encrypted (key_cipher); only its last four characters in the clear.
create table providers (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references principals (id) on delete restrict,
  name text not null,
  protocol text not null check (protocol in ('openai_chat', 'openai_responses', 'anthropic', 'gemini')),
  base_url text not null,
  key_cipher bytea not null,
  key_last4 text not null,
  models jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  unique (owner_id, name)
);

alter table agents
  add constraint agents_provider_id_fkey foreign key (provider_id) references providers (id) on delete restrict;

-- Down Migration
alter table agents drop constraint agents_provider_id_fkey;
drop table providers;
