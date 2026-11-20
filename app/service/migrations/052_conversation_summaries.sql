-- Up Migration
-- The rolling summary (Task 9; design rule 21; src/agents/summary/): per conversation and Agent, what no longer fits that
-- Agent's replies there, folded by the memory model into one text. It covers the messages the Agent could see whose place in
-- the conversation (a message's seq; an Agent's reply, the seq its run covered: it goes with the question it answered) is
-- from `from_seq` to `upto_seq`, both included, all after the latest new topic and, in a group, after the Agent joined. A
-- reply is shown it only when nothing it covers is at or before the reply's asker's line (src/agents/context.ts). Deleted with
-- a new topic (src/agents/conversation.ts `resetTopic`) and when the Agent leaves the group (in the transaction that ends its
-- membership); it goes with the conversation or the Agent. Never on the wire, never in search, a tool or a memory review.
create table conversation_summaries (
  conversation_id uuid not null references conversations (id) on delete cascade,
  agent_id uuid not null references agents (principal_id) on delete cascade,
  from_seq bigint not null,
  upto_seq bigint not null,
  text text not null check (char_length(text) between 1 and 6000),
  updated_at timestamptz not null default now(),
  primary key (conversation_id, agent_id),
  check (from_seq <= upto_seq)
);

-- Down Migration
drop table conversation_summaries;
