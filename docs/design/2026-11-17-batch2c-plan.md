# Batch 2C — own Agent in a group: implementation plan

> For agentic workers: executed task by task with superpowers:subagent-driven-development.

**Goal:** an owner adds their own Agent to a group they are in; it replies there when @-mentioned; the owner pays.

**Spec:** `docs/design/2026-11-17-batch2c-own-agent-in-group-design.md` (20 rules, approved 2026-11-17). Background: `docs/design/2026-11-16-batch2-personal-agent-design.md`, `app/service/README.md`.

**Tech:** unchanged (app/service Fastify 5 + Postgres + vitest; app/web React 19 + vitest + Playwright).

## Global constraints

- Lock order: pair lock → **one** conversation row → `agents` rows (id order) → run rows → `accounts` rows (id order). A group path locks the group row G and never the Agent's dedicated conversation row D. Only Agent deletion may touch several conversation rows, and it does so in separate transactions (see Task 2).
- A run is settled before or with leaving `running`; no transaction across a model call or file read; `src/agents/runtime/*` reaches the database only through `AgentPort`.
- Nothing of an Agent's `persona`, `personaVersion`, `model`, `reasoning`, `replyMode`, provider, `paused` or proposals reaches anyone but its owner — in any response, push, error or log. Provider keys never anywhere.
- A missing object and one the caller may not see answer identically.
- Every new or changed route is in the README (`tests/readme.test.ts`) and walked by the fuzz and enumeration suites.
- Money in bigint micro-points; error details are strings.
- Tests first; one service test process at a time (shared database).

## Rulings made while planning (each: what — why — cost if wrong)

1. **One active run per Agent per conversation** (the unique index and the fold become per (agent, conversation)) — `covers_seq`/`pending_seq` are seqs of one conversation, a cross-conversation queue would be a new mechanism — an Agent can be answering in its private chat and in a group at once; the owner's limits (2 running, 20 a minute) still bound cost.
2. **A group reply stores no reasoning text and streams nothing** — a model's thinking routinely restates its system prompt, and every member reads a group message; rule 20 already says no streaming — the owner cannot see the thinking of a group reply.
3. **Other members learn run state from a reduced push and a per-reader `GET …/runs`** (`replying` / `unavailable` / nothing), derived from the latest run, nothing stored per member — no new table — after a restart the line is rebuilt from the run row.
4. **Deleting an Agent leaves its groups in follow-up transactions** (one per group, after the delete commits) with a start-up sweep for leftovers — avoids locking many conversation rows at once — a deleted Agent can show in a member list for a moment; it can never reply (already refused).
5. **Another member's avatar request for the Agent works only while they share a conversation** — the cheap check — after the Agent leaves, others see its initial instead of its picture on old messages.
6. **Mentions match the handle only, on a token boundary** (`@handle` not preceded or followed by `[A-Za-z0-9_]`), case-insensitive; the composer's picker inserts `@handle` for an Agent — names are not unique in a group — typing `@显示名` by hand does not trigger.
7. **Over the per-minute limit in a group: one reusable `rate_limited` failed row per Agent per conversation**, not one per mention — members could otherwise pile up rows — repeated over-limit mentions show one line.
8. **Per-Agent setting `groupMentions`: `members` (default) or `owner`** (user's request) — who may trigger it in groups — one column, one check.
9. **Group creator hand-over skips Agents**; a group with no human left closes.

## Key facts about the current code (verify line numbers yourself)

- `app/service/src/conversations/groups.ts`: `mayAdd` requires friendship (an Agent can never be a friend) → today 403 identical to a random id; `addMember` sets `joined_seq = conversation.seq`; `removeMember` hands a creator's group to `remaining[0]`.
- `conversations/store.ts`: `visibleJoin` (`left_seq is null and joined_seq < m.seq`) is the one read rule; `agents/context.ts` already reads through it with the Agent as the reader, and attachments through `findDownloadable(q, agentId, …)` — rule 11 holds as soon as the Agent is a member.
- `agents/store.ts` `lockAgent` always locks the dedicated conversation row → needs a conversation parameter.
- `agents/runs.ts`: `maybeTrigger` only acts for `conversation.type === "agent"` and the owner's messages; `mentions()` is a substring match; fold/queue/rate-limit helpers and `interruptRuns` use `agent.conversationId`.
- `agents/port-impl.ts`: `lockRun`, `record`, `recoverRun`, follow-up `queueRun` calls and announcements use `agent.conversationId` — every one must use the run row's `conversation_id` (a missed one posts or announces into the owner's private chat); `emit` pushes deltas to the owner; `announce` → `realtime.pushRun` to the owner only.
- `agents/context.ts`: the page query and role mapping assume "owner = user, Agent = assistant, others dropped".
- `agents/conversation.ts` `postAsAgent`: refuses any conversation but the dedicated one; parses persona proposals; stores `body.reasoning`.
- `agents/runtime/prompt.ts`: preamble says the speaker is the owner and always appends the proposal instructions.
- `messages/read.ts` `toWire` sends `reasoning` to every reader.
- `principals/store.ts` `findAvatarSubject`: human, or the viewer owns it.
- `sync/read.ts`, `messages/principals.ts` `readPrincipals`, `conversations/store.ts` `listMembers`: where a co-member learns about a principal.
- Web: `viewmodel.js` `agentView` hard-codes the owner as me and turns any `kind: "agent"` principal into one of `state.agents`; `Agents.jsx` lists all of them as mine; `Composer.jsx` picker inserts the display name; `data/model.js` keys `runs` by conversation; `ChatView.jsx` shows the run line only for `conv.type === "agent"`; `GroupModals.jsx` `AddMemberModal` offers friends only; `GroupProfile.jsx` member list and remove button.
- Tests that encode the old rule: `agents-visibility.test.ts` (Agent id into a group → 403; owner-only pushes), `enumeration.test.ts` (avatar), `conversations.test.ts` (500 cap fixture uses bare `kind='agent'` principals without `agents` rows — joins must be left joins; creator hand-over), `runs.test.ts`, `runs-ratelimit.test.ts`, `schema-agents.test.ts`, `context.test.ts`, `topic-reset.test.ts`, `persona-authority.test.ts`, `fuzz.test.ts` fixture.

## Tasks

### Task 1 — schema and locking (service)
Migration 016: the one-active-run unique index becomes per (agent_id, conversation_id); the `interrupted` check gains `agent_removed`; `agents.group_mentions text not null default 'members' check in ('members','owner')`. `lockAgent(t, agentId, conversationId?)` (default: the dedicated row). Run helpers (`queueRun`, `recordRateLimited`, fold, `interruptRuns`, `record`, `recoverRun`, sweep, follow-ups, announcements) take or read the run's conversation. `groupMentions` on the Agent view (owner only), create and PATCH. **Produces:** `queueRun(t, agent, conversationId, coversSeq)`; every existing suite green, behaviour unchanged.

### Task 2 — membership (service)
`addMember`: target is an Agent → require `owner_id === actor` (else the same 403 as a random id), skip pair lock/friendship, lock the `agents` row, refuse deleted, keep cap/`already_member`/notice. `removeMember`: an Agent may be removed by the creator or its owner; a human leaving or removed takes their Agents out in the same transaction (notice per Agent before the owner's, runs of those Agents in G cancelled: queued → `cancelled`/`agent_removed`, running → `interrupted='agent_removed'`, then `interruptRuns` after commit). Creator hand-over to the earliest remaining human; close when none. Delete Agent → leave each group in follow-up transactions + start-up sweep. `createGroup` with an Agent id stays 403. **Produces:** Agent memberships with `joined_seq`; `agent_removed` run end.

### Task 3 — what co-members see (service)
`listMembers`, `readPrincipals` (sync, history, search) and `GET …/members` gain `ownerId`, `intro`, `field` for Agents (left joins). Avatar: also when the viewer currently shares a conversation with the Agent. Nothing else of the Agent. **Produces:** the wire fields the client needs.

### Task 4 — trigger (service)
`mentionedHandles(text)` (pure; token-boundary regex without backtracking risk). Group branch of `maybeTrigger`: no handles → no query; else current Agent members of G with those handles; per Agent in id order: lock, skip paused/deleted/no model, honour `groupMentions`, ignore `replyMode`; fold per (agent, conversation), else rate limit (reusable row), else queue. A sender that is an Agent never triggers. Returns a list; the route announces each. **Produces:** queued group runs.

### Task 5 — execution (service)
Group mode of the system prompt (names the group, speakers are labelled, answer whoever mentioned you, no proposal instructions, do not quote the persona or private chats). Context: everyone but this Agent is `user`, each entry prefixed with the speaker's name (other Agents marked); the dedicated conversation unchanged. `postAsAgent` in a group: membership checked under G (gone → `agent_removed`), no proposal parsing, no reasoning stored. No deltas for group runs. Charge to the owner (test: a stranger's mention leaves the stranger's account untouched). **Produces:** replies in groups.

### Task 6 — run state for members and run routes (service)
Hub task deciding per current member at delivery: owner → full run + `agentId`; others → `{agentId, state}` with `state` `replying` | `unavailable` | `null`. `GET /api/conversations/:id/runs` rendered per reader. Stop / retry / dismiss for a group run by its owner (retry and dismiss take `agentId`). README, fuzz, enumeration. **Produces:** the wire contract for the client.

### Task 7 — web data layer
Owner identity from the principal (`ownerId`); "my Agents" = mine only; run slots per (conversation, agent); sync and actions for the new routes and pushes; `groupMentions` in the Agent form (“群里谁可以叫它：所有成员 / 仅我”).

### Task 8 — web UI
Add-member dialog section “我的 Agent”; member list (owner line, intro, remove for creator and owner); composer picker inserts `@handle` for Agents; group rows “某某正在回复…”, the owner's status line with retry/dismiss, “某某暂时无法回复” for others; counts and copy.

### Task 9 — rule-by-rule verification and e2e
`tests/agents-group.test.ts`: one case per rule 1–20 including the negatives in the design's 验收; concurrency (owner leaves vs mention; delete vs send); e2e: owner adds Agent, another member mentions it, reply appears for both, member sees no persona/model anywhere, owner leaves → Agent gone. Screenshots.

## Review focus

1. A recovery/sweep/follow-up path still using the dedicated conversation.
2. Persona or model reaching a co-member through any serializer, push, error text or the reply's stored fields.
3. Deadlock between a group send mentioning Agents of two owners and membership changes.
4. Someone else's Agent appearing as mine in the client.
5. Members exhausting an owner's budget beyond the existing limits.
