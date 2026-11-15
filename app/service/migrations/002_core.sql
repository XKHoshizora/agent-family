-- Up Migration
create table principals (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('human', 'agent')),
  handle citext not null unique check (handle::text ~ '^[a-z0-9_]{3,24}$'),
  display_name text not null,
  owner_id uuid references principals (id) on delete restrict,
  auth_user_id text unique,
  avatar_key text,
  created_at timestamptz not null default now(),
  check ((kind = 'agent') = (owner_id is not null)),
  check (kind = 'agent' or auth_user_id is not null)
);
create index principals_owner_idx on principals (owner_id) where owner_id is not null;

create table invites (
  code_hash text primary key,
  expires_at timestamptz not null,
  used_by uuid references principals (id) on delete restrict,
  used_at timestamptz
);

create table mail_outbox (
  id bigserial primary key,
  recipient text not null,
  kind text not null,
  subject text not null,
  body text not null,
  created_at timestamptz not null default now()
);

create table friend_requests (
  id uuid primary key default gen_random_uuid(),
  from_id uuid not null references principals (id) on delete restrict,
  to_id uuid not null references principals (id) on delete restrict,
  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'rejected', 'withdrawn', 'expired')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  resolved_at timestamptz,
  check (from_id <> to_id)
);
create unique index friend_requests_one_pending_per_pair
  on friend_requests (least(from_id, to_id), greatest(from_id, to_id))
  where status = 'pending';
create index friend_requests_to_idx on friend_requests (to_id, status);
create index friend_requests_from_idx on friend_requests (from_id, status);

create table friendships (
  a_id uuid not null references principals (id) on delete restrict,
  b_id uuid not null references principals (id) on delete restrict,
  since timestamptz not null default now(),
  primary key (a_id, b_id),
  check (a_id < b_id)
);
create index friendships_b_idx on friendships (b_id);

create table blocks (
  blocker_id uuid not null references principals (id) on delete restrict,
  blocked_id uuid not null references principals (id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);
create index blocks_blocked_idx on blocks (blocked_id);

create table conversations (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('direct', 'group')),
  title text,
  creator_id uuid not null references principals (id) on delete restrict,
  seq bigint not null default 0,
  closed_at timestamptz,
  created_at timestamptz not null default now()
);

create table direct_pairs (
  conversation_id uuid primary key references conversations (id) on delete restrict,
  a_id uuid not null references principals (id) on delete restrict,
  b_id uuid not null references principals (id) on delete restrict,
  unique (a_id, b_id),
  check (a_id < b_id)
);

create table memberships (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations (id) on delete restrict,
  principal_id uuid not null references principals (id) on delete restrict,
  role text not null check (role in ('speaker', 'observer')),
  joined_seq bigint not null,
  left_seq bigint,
  read_seq bigint not null default 0,
  joined_at timestamptz not null default now()
);
create unique index memberships_one_current
  on memberships (conversation_id, principal_id)
  where left_seq is null;
create index memberships_principal_current_idx
  on memberships (principal_id)
  where left_seq is null;
create index memberships_conversation_idx on memberships (conversation_id);

create table messages (
  id bigserial primary key,
  conversation_id uuid not null references conversations (id) on delete restrict,
  seq bigint not null,
  sender_id uuid not null references principals (id) on delete restrict,
  kind text not null check (kind in ('text', 'file', 'system')),
  body jsonb not null,
  client_txn text,
  created_at timestamptz not null default now(),
  unique (conversation_id, seq),
  unique (conversation_id, sender_id, client_txn)
);
create index messages_sender_idx on messages (sender_id);

create table attachments (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations (id) on delete restrict,
  uploader_id uuid not null references principals (id) on delete restrict,
  blob_key text not null,
  name text not null,
  size bigint not null check (size >= 0),
  mime text not null,
  inline boolean not null default false,
  message_id bigint references messages (id) on delete restrict,
  created_at timestamptz not null default now()
);
create index attachments_conversation_idx on attachments (conversation_id);
create index attachments_message_idx on attachments (message_id) where message_id is not null;

-- Down Migration
drop table attachments;
drop table messages;
drop table memberships;
drop table direct_pairs;
drop table conversations;
drop table blocks;
drop table friendships;
drop table friend_requests;
drop table mail_outbox;
drop table invites;
drop table principals;
