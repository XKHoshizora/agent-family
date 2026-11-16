-- Up Migration
-- Agents: a principal of kind 'agent' plus its configuration, and the conversation with its owner.
-- agents.provider_id references providers, which 009 creates; that foreign key is added there.

alter table principals add column avatar_version int not null default 0;

-- Only an agent principal may have an agents row: kind is generated as the constant 'agent' and
-- (principal_id, kind) must match a row of principals (id, kind), see principals_id_kind_key in 004.
create table agents (
  principal_id uuid primary key,
  kind text generated always as ('agent') stored,
  intro text not null default '',
  field text not null default '',
  persona text not null default '',
  persona_version int not null default 0,
  reply_mode text not null default 'always' check (reply_mode in ('always', 'mention')),
  reasoning text not null default 'none' check (reasoning in ('none', 'low', 'medium', 'high', 'xhigh', 'max')),
  model_source text check (model_source in ('site', 'provider')),
  site_model_id text,
  provider_id uuid,
  provider_model text,
  paused boolean not null default false,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (principal_id, kind) references principals (id, kind) on delete restrict,
  -- The three model columns say the same thing as model_source.
  constraint agents_model_consistent check (
    (model_source is null and site_model_id is null and provider_id is null and provider_model is null)
    or (model_source is not distinct from 'site' and site_model_id is not null and provider_id is null and provider_model is null)
    or (model_source is not distinct from 'provider' and site_model_id is null and provider_id is not null and provider_model is not null)
  )
);
create index agents_provider_idx on agents (provider_id) where provider_id is not null;

alter table conversations drop constraint conversations_type_check;
alter table conversations add constraint conversations_type_check check (type in ('direct', 'group', 'agent'));

create table agent_conversations (
  conversation_id uuid primary key references conversations (id) on delete restrict,
  agent_id uuid not null unique references principals (id) on delete restrict,
  owner_id uuid not null references principals (id) on delete restrict,
  created_at timestamptz not null default now()
);
create index agent_conversations_owner_idx on agent_conversations (owner_id);

-- Down Migration
-- Rows of type 'agent' must be gone before this can run.
drop table agent_conversations;
alter table conversations drop constraint conversations_type_check;
alter table conversations add constraint conversations_type_check check (type in ('direct', 'group'));
drop table agents;
alter table principals drop column avatar_version;
