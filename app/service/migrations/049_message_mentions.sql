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

-- Down Migration
alter table messages drop constraint messages_mentions_shape;
alter table messages drop column mentions;
