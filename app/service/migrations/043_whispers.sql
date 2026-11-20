-- Up Migration
-- A whisper (悄悄话, src/whispers/): a small note in a conversation that only the owner of one of its Agents ever sees, with the
-- buttons it offers. Never a message: it takes no seq (the other members would see a gap) and sits after the message that was the
-- conversation's last when it was made (`after_seq`). Open until its owner answers it, the periodic sweep expires it (7 days), its
-- owner or its Agent leaves the conversation, or its Agent is deleted; it goes with the conversation, the owner or the Agent's row.
create table whispers (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations (id) on delete cascade,
  owner_id uuid not null references principals (id) on delete cascade,
  agent_id uuid not null references agents (principal_id) on delete cascade,
  after_seq bigint not null,
  kind text not null check (kind in ('found_elsewhere', 'tools_off', 'memory')),
  body jsonb not null,
  status text not null default 'open' check (status in ('open', 'accepted', 'declined', 'expired')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
-- The owner's whispers of a conversation, by where they sit (sync, catch-up, the list route, the conversation's count).
create index whispers_owner_conversation_idx on whispers (owner_id, conversation_id, after_seq);
-- The sweep's: the open ones by age.
create index whispers_status_created_idx on whispers (status, created_at);

-- Down Migration
drop table whispers;
