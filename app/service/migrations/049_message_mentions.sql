-- Up Migration
-- Who a message's mentions mean, decided once when it was sent (Task M): `[{"id", "start", "length"}]` — the principal a
-- mention means (a member of the conversation when the message was sent) and the range of the message's text that
-- names it, `start` and `length` in UTF-16 code units of `body ->> 'text'` (the web is JS), ascending, not overlapping,
-- each range beginning with `@`; at most 20. Null: the message names nobody — and every message from before this column,
-- which is never read again for its mentions (src/agents/mentions.ts). Picked mentions are sent with the message;
-- typed ones are read once, at send (or, for an Agent's reply, at its post). A rename or a member joining or leaving
-- changes nothing here. Sent to every reader of the message.
alter table messages add column mentions jsonb;
alter table messages add constraint messages_mentions_shape
  check (mentions is null or (jsonb_typeof(mentions) = 'array' and jsonb_array_length(mentions) between 1 and 20));
-- Whether, when it was sent, the message asked an Agent it could not name (Task M fix round 1): an `@owner.name` of an
-- Agent that is not one of the conversation's Agents, or a bare `@name` two or more of its Agents share (and no person).
-- Decided by the same reading, at the same moment, as `mentions`. Read by the proactive judgement only (whoever asked an
-- Agent asked that one, and none other answers in its place); never sent to anyone. False for every message from before.
alter table messages add column asks_agent boolean not null default false;

-- Down Migration
alter table messages drop column if exists asks_agent;
alter table messages drop constraint if exists messages_mentions_shape;
alter table messages drop column if exists mentions;
