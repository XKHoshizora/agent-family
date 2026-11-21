-- Up Migration
-- Whose each speaker label in a group's rolling summary was when it was written (final review m-11; src/agents/summary/):
-- `{"<label as written>": "<principal id>", …}` for every label the system allowed that its text holds, the owner's
-- `主人（…）` among them. A rename changes how an account is labelled, not who it is: the summary is shown and built on
-- with each label rewritten to how its account is labelled now (store.ts `shownSummary`), so no line of a renamed
-- person goes. Null for a row written before this, and in the Agent's own conversation (it holds no label): such a group
-- row is held to the labels of now as it is. Never on the wire.
alter table conversation_summaries add column speakers jsonb;

-- Down Migration
alter table conversation_summaries drop column speakers;
