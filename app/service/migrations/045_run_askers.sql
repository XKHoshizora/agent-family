-- Up Migration
-- Whose questions a reply answers (Task 10b, the product rule of 2026-11-20): the people whose messages called for it —
-- a mention's sender, the sender of the message a reply nobody asked for answers, and, for a reply an Agent's message
-- called for, the askers of the run that posted that message (so the person whose message started the chain) — each
-- once, gathered as calls are folded into it. In a group, what its model is shown of the group starts no earlier than
-- the latest of their joinings (src/agents/context.ts `askerLine`). Null when not known — every run recorded before this
-- column, and a chain whose first person cannot be told —: then the latest joining of the group's people now. Never on
-- the wire.
alter table agent_runs add column asker_ids uuid[];

-- Down Migration
alter table agent_runs drop column asker_ids;
