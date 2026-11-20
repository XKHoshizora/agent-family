# Reverse paths: what happens when things are removed, shrink, are revoked or disappear

Date: 2026-11-20. Scope: `app/service` (schema, routes, README, tests) in the working tree of `claude/agent-family-review-8a6084`; the web client only where noted. A read-only audit: no test was run and no database was touched. Files under `src/agents/` were being edited by other agents while this was written, so their line numbers may have drifted by a few lines; the function name is given with each.

Classes used in the tables:

- **HANDLED**: the code resolves it, and a test covers it.
- **HANDLED-UNTESTED**: the code resolves it, but I found no test.
- **PARTIAL**: resolved in part; the row names what is left dangling.
- **NOT-POSSIBLE**: no path exists today; the row says whether the absence matters.
- **UNHANDLED**: a state with no way out can be reached; the row says how, and whether a user or only an operator can get there.

## 1. Summary

107 rows. **HANDLED 65 · HANDLED-UNTESTED 9 · PARTIAL 16 · NOT-POSSIBLE 15 · UNHANDLED 2.**

The removal paths that exist are careful and heavily tested: leaving and removal from groups, the creator handing over on leaving, unfriending, blocking, pausing and deleting an Agent, deleting a provider, a run dying with the process. I found no way to leave a group without a creator or with only Agents in it. No run stays stuck past the stale-run sweep, no hold is never released, and a delete leaves no memory card or whisper with live buttons (persona proposals are the one exception, B6). The gaps are of three other kinds:

1. **Things that can never go away.** Nothing in the product deletes an account, a message, a sent attachment, a group, a conversation from your list, or an Agent's principal row. The core schema (migrations 002–024) is `on delete restrict` everywhere: it was built for "nothing is ever deleted". Both of today's no-way-out states follow from that (the attachment quota, and handles that are never freed). The most important features missing before real users are all "delete" features.
2. **Switches turned back on.** Turning an Agent's memory off and then on again makes the reviewer read what was said while it was off.
3. **References that vanish without the referrer being told.** When a provider model is taken off its list, or a site model is removed, the Agent keeps failing with a retry button that cannot work.

**UNHANDLED, worst first**

1. **F4: the attachment quota.** The quota (20 GiB by default) counts every byte a person ever uploaded, sent or not, in every conversation, including ones they left and groups that closed. Nothing can delete a sent attachment. A person who reaches it can never upload again. The same happens at once if the operator lowers `ATTACHMENT_QUOTA_BYTES` below what someone stores. Only hand-made database and object-store surgery gets them out, and there is no tool for it.
2. **B10: a deleted Agent's handle is never freed.** The principal row stays, and handles are unique across people and Agents. Create-then-delete costs 2 of the 30 Agent writes allowed per minute, so one user can permanently burn about 15 handles a minute. The whole 3-character namespace (about 50 000 handles) goes in a few days. Nobody, the operator included, can free one without deleting rows that about ten restrict foreign keys protect.

**NOT-POSSIBLE today but needed before real users, ranked**

1. **A16: deleting or deactivating an account.** Needed for legal reasons (the right to erasure) and for basic trust. The schema actively prevents it: about 25 restrict foreign keys point at `principals`, and `principals.auth_user_id` points at Better Auth's `user` with restrict. It needs a tombstone design that covers:
   - their messages in groups;
   - their Agents and those Agents' memory;
   - other owners' hearsay that names them;
   - their provider keys and attachments;
   - their handle.
2. **F1 and F3: recalling or deleting a message, and deleting an attachment.**
   - Why it matters: a mis-send to a 500-person group, or a secret pasted by mistake, cannot be taken back.
   - It is also the only way out of F4.
   - It needs a rule for everything derived from a message: quotes, tools' `found` references, search, notes and hearsay learned from it, and an Agent's later context.
3. **A9: hiding or leaving a conversation.** A direct chat with an ex-friend, or with someone you blocked, stays in your list forever, and so does every deleted Agent's own conversation. Direct chats cannot be left, and there is no hide or archive.
4. **A21: signing out everywhere, or seeing your sessions.** Today only a password reset by mail ends your other sessions (the stolen-phone case).
5. **A17: changing the e-mail address.** Someone who loses their mailbox loses their account for good, because a reset needs the mailbox.
6. **A4 and A8: group moderation.**
   - The creator cannot hand over the role without leaving.
   - Nobody can dissolve a group.
   - Nobody but the creator can remove a member.
7. **D4: self-service top-up and refunds.** Only the operator's `credits:grant` CLI exists. Needed only before any paid tier is sold.
8. **E8: a site-wide kill switch for memory and whispers.** Tools have one (`TOOLS.enabled`); memory and whispers do not. Matters for incident response.

Lower priority: B11 (hiding deleted Agents), A18 (changing the password while signed in), H13 (migration rollback tooling), H14 (a second instance).

**PARTIAL rows to decide on first**

- **B18: memory switched back on learns the off period.** This contradicts the README: "With `memory` off nothing is shown and nothing is learned" (l.836).
- **C6 and C8: a vanished model.** The Agent's failures say `retryable: true`, so retrying fails forever. There is no `modelUsable` signal for an Agent, although memory has `memoryModelUsable`.
- **A13 and F9: hearsay outlives its speaker's consent.** It is kept and fed to the model after the speaker blocked the owner or left the group.
- **C5: rotating `PROVIDER_KEY_SECRET` silently breaks every stored key.**
- **E1: after a room limit is lowered, the owner cannot even shorten a note.**

**Surprises**

- **The schema has two philosophies.**
  - The core tables restrict every delete.
  - The memory and whisper tables (026–045) cascade or set null, as if principals and conversations could be deleted.
  - Nothing deletes principals or conversations, so every one of those cascade and set-null rules is dead in production.
  - Some README sentences describe states that cannot happen:
    - l.848: a note's origin is gone because "the conversation was deleted";
    - l.916: `speakerHandle` is "null when the account is gone";
    - l.600: "a deleted account's" id;
    - l.504: appellations say "a deleted Agent's … go with it". They do not: a deleted Agent's rows stay and can no longer be removed (B9).
  - `tests/memory-hearsay.test.ts:1102` ("a dropped entry whose group is gone") tests one of these unreachable states by deleting rows directly.
- **Only memory is told when its model vanishes.** Memory has `memoryModelUsable`; an Agent's own model has no such flag, and its failures say `retryable: true`.
- **A group's title leaks after you leave.**
  - The notes page shows the current title of a group the owner has left, including renames made after they left.
  - The hearsay on the same page hides that group (`group: null`).
  - The model is still given the current title in the owner's own chat.
- **Migrations:** 025 does not exist (a harmless gap), and the migration runner only goes up.

## 2. The inventory

### 2.0 What the schema says happens on delete

Restrict, cascade and set-null rules, by the table that would be deleted. Numbers are migrations.

| Table deleted | `on delete restrict` (blocks the delete) | `on delete cascade` | `on delete set null` |
|---|---|---|---|
| `principals` | principals.owner_id (004), invites.used_by, friend_requests.from_id/to_id, friendships.a_id/b_id, blocks.*, conversations.creator_id, direct_pairs.a_id/b_id, memberships.principal_id, messages.sender_id, attachments.uploader_id (002); agents (principal_id, kind) and agent_conversations.agent_id/owner_id (008); providers.owner_id (009); accounts, free_usage, usage_records.owner_id/agent_id, balance_ledger.owner_id (010); agent_runs.agent_id/owner_id, persona_proposals.agent_id (011); memory_usage.owner_id (038) | refused_agent_calls (023), agent_appellations.principal_id (024), agent_group_state (026), owner_notes, agent_notes, agent_hearsay.agent_id, memory_changes, memory_review_state, memory_flags (031), hearsay_mutes (033), memory_judge_usage (037), whispers.owner_id (043) | agent_runs.caller_id (019), agent_hearsay.speaker_id (031) |
| `"user"` (Better Auth) | principals.auth_user_id (003) | session, account | |
| `conversations` | direct_pairs, memberships, messages, attachments (002), agent_conversations (008), agent_runs (011) | agent_group_state (026), agent_hearsay, memory_review_state, memory_flags (031), whispers (043) | owner_notes/agent_notes.origin_conversation_id, memory_changes.conversation_id (031) |
| `messages` | attachments.message_id (002), persona_proposals.message_id (011) | refused_agent_calls (022) | |
| `agents` | | agent_appellations.agent_id (024), whispers.agent_id (043) | |
| `providers` | agents.provider_id (009) | | |
| `agent_runs` / `usage_records` | usage_records.run_id (011) / balance_ledger.usage_id (010) | | |

Two references have no foreign key at all: `accounts.memory_model` (jsonb, 032) and `token_ratios.key` (text, 042).

What deletes rows today:

- `removeUnverifiedAccount` (src/auth/accounts.ts:55–75), for an account that never signed in;
- the owner deleting notes, hearsay entries, appellations and providers;
- the sweeps: unsent attachments, pending blobs, old memory changes, old whispers, stale flags and expired mutes.

Principals, conversations, messages, memberships and sent attachments are never deleted. An Agent's delete is a soft `deleted_at`.

### 2.1 People

| # | Event | What depends on it | What the code does today | Evidence (code · test) | Class |
|---|---|---|---|---|---|
| A1 | A member leaves a group | their membership, their Agents there, those Agents' runs and whispers, read access | Their membership ends at the notice's seq. Their Agents leave first, each with a notice of its own. Their runs end `agent_removed`, their whispers expire, and the leaver loses the whole conversation (404 everywhere). | conversations/groups.ts:155–196 · conversations.test.ts:135; agents-group-membership.test.ts:363 | HANDLED |
| A2 | Removed by the group's creator | as A1 | Only the creator removes people (an owner may also remove their own Agent). The person's Agents leave first; the notice is `member_removed`. | groups.ts:165, 176–188 · agents-group-membership.test.ts:410, 426 | HANDLED |
| A3 | The creator leaves | `conversations.creator_id` (the right to rename and remove) | The earliest remaining person becomes creator (lowest joined_seq, then membership id), never an Agent. The notice carries `newCreatorId`. | groups.ts:172–173, 190 · conversations.test.ts:188; agents-group-membership.test.ts:440 | HANDLED |
| A4 | The creator hands over without leaving; anyone else moderates | — | No route. The role only moves when the creator leaves, and only the creator removes people or renames the group. | groups.ts:165, 198–207 | NOT-POSSIBLE (medium: an absent creator leaves a group with no moderator) |
| A5 | The last person leaves | the group | The group closes, every Agent having left just before with its owner. A closed group refuses every write and every add. | groups.ts:172, 191 · agents-group-membership.test.ts:462; conversations.test.ts:209 | HANDLED |
| A6 | A group without a creator, or with only Agents | the rule that an Agent is only where its owner is | Cannot happen. An Agent joins only by its owner's hand and leaves with them, and the creator is always a person while one remains. The races are tested. | groups.ts:131–138, 170–173 · agents-group-membership.test.ts:618 | HANDLED |
| A7 | What a closed group leaves behind | messages, attachments and their blobs, hearsay heard there, notes learned there, review state, flags, `agent_group_state` | All kept forever and readable by nobody. Its attachments still count toward their uploaders' quotas (F4). Nothing reopens the group, so an accidental last leave is final. | groups.ts:191; attachments/store.ts:29–35 · none | PARTIAL |
| A8 | A group dissolved or deleted | every restrict foreign key onto `conversations` | No path; the only end is everyone leaving (A5). The cascade rules on the memory and whisper tables never fire (§2.0). | §2.0 | NOT-POSSIBLE (medium) |
| A9 | Leaving, hiding or archiving a conversation | the conversation list (`GET /api/sync`) | A direct chat cannot be left: both people stay members for good, also after unfriending or a block. A deleted Agent's own conversation also stays, and sync lists every current membership. | conversations/store.ts:248–272; sync/read.ts:114–135; README 1884–1888 · conversations.test.ts:223 | NOT-POSSIBLE (needed: harassment residue) |
| A10 | Unfriending | the direct chat, shared groups, appellations, adding to groups | The friendship row is deleted and a `friendship_ended` notice posted; the chat stays read-only (`not_friends`). Groups are unaffected. Appellations are kept, but not shown to the model unless the two share a group. | social/friends.ts:148–159; README 507–508 · social.test.ts:43; agents-appellations.test.ts:203 | HANDLED |
| A11 | Blocking | pending requests, the direct chat, Agent calls, proactive picks, hearsay flags | Pending requests are cancelled and the chat becomes read-only (`blocked`); the friendship is kept. In groups a block in either direction stops @-calls, Agent-to-Agent relays, follow-ups, proactive picks and hearsay reading. | social/blocks.ts:27–48; agents/runs.ts `triggerInGroup` (~l.846), `triggerFromAgent` (~l.1007), `followUp` (~l.1147); proactive/candidates.ts:107–113, 239–249 · social.test.ts:144–221; memory-hearsay.test.ts:299, 310 | HANDLED |
| A12 | A block made while a reply to the blocked person's @-call is queued or running | that run | Blocks are checked when the call is made and at follow-up, not when the worker claims or begins the run. The queued reply still answers the person just blocked. | port-impl.ts `claimNext` (l.304), `begin` (l.415–515): no block check · none | PARTIAL (low) |
| A13 | Hearsay already kept about or from someone who then blocks the owner, or whom the owner blocks | `agent_hearsay` rows | New flags from them are refused. Entries already stored stay, and keep being shown to the model in that group and in the owner's own chat. | memory/store.ts:145–158 (no block filter) · memory-hearsay.test.ts:299 (flags only) | PARTIAL (a policy decision) |
| A14 | Unblocking | sending in the direct chat | The block row is deleted and an `unblocked` notice posted. Sending works again only if they are still friends and no block remains the other way. | blocks.ts:54–64 · social.test.ts:221 | HANDLED |
| A15 | A friend request withdrawn, rejected or expired | the one-pending-request-per-pair slot | Each is resolved under the pair lock. A lapsed request reads as expired, and is stored as expired when the pair is next touched. | friends.ts:60–133 · social.test.ts:63, 82, 106, 171, 184 | HANDLED |
| A16 | An account deleted or deactivated | Through foreign keys (§2.0): their messages and memberships, groups they created, direct chats, their Agents (each with its conversation, runs, memory and providers' keys), owner notes, usage and ledger rows, attachments and blobs, sessions. Outside foreign keys: other owners' hearsay with their name and words (the speaker id would go null; name and text stay), other owners' notes naming them (free text), quotes of their messages, search over their text, `mail_outbox` rows with their address. | No route and no CLI. A hard delete is blocked by about 25 restrict foreign keys. The only deletion is `removeUnverifiedAccount`, for an account with no signed-in traces. | auth/accounts.ts:37–75; auth/auth.ts:402–408 (five endpoints) · registration.test.ts | NOT-POSSIBLE (high: needed before real users) |
| A17 | Changing the e-mail address | sign-in, password reset | No endpoint: Better Auth's change-email route is not mounted. | auth.ts:402–408 | NOT-POSSIBLE (medium) |
| A18 | Changing the password while signed in | — | Not mounted; the only way is a reset by mail. | auth.ts:402–408 | NOT-POSSIBLE (low) |
| A19 | A password reset | every session, socket and other reset link | Every session is revoked, sockets close with 4001 and other links stop working, all announced after commit. | auth.ts:274, 293–297 · auth.test.ts:205, 234, 314, 340; sync.test.ts:702 | HANDLED |
| A20 | Signing out | the session, its sockets, its WebSocket tickets | The session ends, its sockets close with 4001 and its unredeemed tickets are dropped. | auth.ts:404; sync/tickets.ts:21–22 · auth.test.ts:297; sync.test.ts:702 | HANDLED |
| A21 | Signing out everywhere, or listing sessions | a stolen device | Not mounted; the only way is a password reset by mail. | auth.ts:402–408 | NOT-POSSIBLE (medium) |
| A22 | An unverified account replaced by a new registration of the same address | its principal, requests to it, blocks of it, its invite | Deleted in the registration's transaction; requests to it and blocks of it are removed and their makers told. Refused if the principal has anything only a signed-in person makes. | auth/accounts.ts:37–75 · registration.test.ts | HANDLED |
| A23 | A display name changed | system notices, hearsay labels | Notices keep the name they were written with, and hearsay keeps the name at the time. `speakerHandle` (the current handle) tells colliding names apart. An owner renamed to a stored speaker's name sees 某人 (someone) for that speaker. | README 1755–1756, 916 · memory-hearsay.test.ts:654 | HANDLED |

### 2.2 Agents

| # | Event | What depends on it | What the code does today | Evidence (code · test) | Class |
|---|---|---|---|---|---|
| B1 | An Agent is deleted: its runs, queued follow-ups, unfinished tool rounds and holds | `agent_runs`, holds | All in the delete's transaction. Queued runs are cancelled `agent_deleted`. Running ones are marked interrupted, their noted follow-ups dropped and their calls aborted after commit; they are never posted, and are settled for what the upstream reported. | agents/routes.ts:384–433; runs.ts `interruptRuns` (l.333–351) · runs-pause.test.ts:55; agents-group-membership.test.ts:575, 649 | HANDLED |
| B2 | … its pending memory cards | pending `memory_changes` | Discarded in the same transaction. | routes.ts:407; memory/apply.ts:1076–1080 · memory-review.test.ts:610 | HANDLED |
| B3 | … its whispers | open `whispers` | Expired everywhere in the same transaction and pushed to the owner. A whisper being created at that moment waits for the delete, then is refused. | routes.ts:409; whispers/store.ts:195–225, 349–357 · whispers.test.ts:452, 706 | HANDLED |
| B4 | … its group memberships | memberships, members' views | After commit, one transaction per group posts a `member_left` (actor: the owner). A leaving that failed or was cut off is finished by the start-up sweep, or by repeating the delete. Meanwhile the Agent never replies there. | agents/group-leave.ts:82–130; routes.ts:422–427 · agents-group-membership.test.ts:483, 516, 550, 575 | HANDLED |
| B5 | … its messages and its own conversation | history | Its messages stay and are named by its old profile, and its own conversation stays readable. Sending there and starting a new topic are 403 `agent_deleted`. | conversations/store.ts:196–205 · agents.test.ts:348, 367; topic-reset.test.ts:57 | HANDLED |
| B6 | … its open persona proposals | `persona_proposals.status = open`, the proposal card | Not resolved: stored and sent as `open`, and confirm or discard answers 409 `agent_deleted`. Only the web hides the buttons (AgentChatBits.jsx:614). Memory cards and whispers, by contrast, are closed by the delete. | messages/read.ts:57–80 · persona.test.ts:469 (the 409 only) | PARTIAL (low) |
| B7 | … its own notes, hearsay and applied changes | `agent_notes`, `agent_hearsay`, `memory_changes` | Kept, because the principal row is never deleted and so the cascades never fire. They can be read and deleted; editing is 409. Undoing an applied change still works, as do deleting and confirming hearsay. They are kept forever unless the owner deletes them one by one. | memory/routes.ts:220–247, 384–445, 477–521 · memory-routes.test.ts:535 | HANDLED |
| B8 | … its memory jobs in flight (reviews, hearsay flags, dreams, naps) | in-process jobs | Every memory writer re-reads the Agent under its lock and does nothing for a deleted, paused or memory-off one. Its flags are deleted, and dreams only pick live Agents. | pipeline.ts:74–79, 104–109; hearsay.ts:268–275; dream.ts:292, 338 · memory-review.test.ts:422; memory-hearsay.test.ts:866 | HANDLED |
| B9 | … its appellations | `agent_appellations` rows | Kept forever and frozen: setting and removing are both 409 `agent_deleted`. They are never shown to anyone. README l.504 says they "go with it". | routes.ts:441–455 (l.449) · agents-appellations.test.ts:291 | PARTIAL (low; the README disagrees) |
| B10 | … its handle | `principals.handle`, unique across people and Agents | Never freed. Create plus delete costs 2 of the 30 Agent writes a minute, so one user can burn about 15 handles a minute for good. An operator cannot free one without deleting the principal's dependants. | agents/routes.ts:228, 239–262; 002:5 · none | UNHANDLED (any user; low–medium; an abuse vector) |
| B11 | … listed forever | `GET /api/agents`, sync | Deleted Agents stay in `GET /api/agents` (with `deleted: true`), and their conversations stay in sync. They cannot be hidden. | routes.ts:313–325; sync/read.ts:114–135 · agents.test.ts:173 | NOT-POSSIBLE (low) |
| B12 | Paused and resumed | runs, mentions, memory | A pause ends queued and running replies for good. A resume first ends what the pause could not see, and answers nothing written meanwhile. A paused Agent's memory jobs do nothing and its flags are deleted. | routes.ts:384–433; runs.ts `endWhatPauseMissed` (l.364) · runs-pause.test.ts:55–214; runs-pause-race.test.ts | HANDLED |
| B13 | Taken out of a group by the creator or by its owner | its runs and whispers there | Posts `member_removed`. Its runs in that group are cancelled or interrupted `agent_removed`; its runs elsewhere go on. Its whispers there expire. | groups.ts:155–196; group-leave.ts:34–51 · agents-group-membership.test.ts:284, 314, 343; whispers.test.ts:691 | HANDLED |
| B14 | Leaves because its owner left or was removed | the same | Taken along in the owner's transaction, each Agent with a `member_left` before the owner's notice. | groups.ts:170–188 · agents-group-membership.test.ts:363, 410, 426 | HANDLED |
| B15 | Its model changed mid-reply | the running call, its price, `via` | The model is resolved once, when the run begins, and kept for the run. Settlement prices the model the run was admitted on, and `via` shows that model. | port-impl.ts:437–444, 628 · metering.test.ts:427; agents-reply-via.test.ts:232, 254 | HANDLED |
| B16 | Its persona emptied | onboarding, the memory passage | `PATCH persona: ""` is allowed (`agentPersona` has minimum length 0). The Agent is back in onboarding and interviews the owner again, and its own chat shows no notes. A proposal cannot be empty. | persona.ts:31–33; port-impl.ts:458–460 · memory-prompt.test.ts:218–255 (the prompt only) | HANDLED-UNTESTED (the PATCH path) |
| B17 | Memory switched off | shown notes, reviews, flags, dreams | Nothing is shown or learned. Armed timers ask nothing, listeners raise no flags, flags are deleted at wake-up and the dream skips the Agent. Notes and pending cards are kept, and the cards can still be decided. | memory/store.ts:150; pipeline.ts:74–79, 104–109; hearsay.ts:268–275; dream.ts:292, 338 · memory-review.test.ts:422; memory-flags.test.ts:200; memory-hearsay.test.ts:866 | HANDLED |
| B18 | Memory switched back on | `memory_review_state.reviewed_seq` | Nothing moves `reviewed_seq` when the switch changes, and while memory is off `runReview` returns before reading anything, so the seq stays where it was. After memory is turned on, the next review (after any reply, or re-armed at start-up) reads the newest `reviewMessages` (40) owner and Agent messages after that old seq. It writes notes from what was said while memory was off. The same holds per group. | pipeline.ts:86–97, 204–218; review.ts:145–153; reviewer.ts:88, 371; README 836 · none | PARTIAL (medium: breaks a stated promise; the owner can only undo afterwards) |
| B19 | 先问我再记 (`memoryAsk`, "ask me before noting") toggled while cards are open | pending changes | Cards stay pending and can be decided either way. Turning it off applies nothing retroactively. Pending cards are discarded after 30 days. | apply.ts:1034–1089; memory/sweep.ts · memory-changes-sweep.test.ts:58 (the 30 days only) | HANDLED-UNTESTED (the toggle) |
| B20 | Proactive replies turned off, or their budget lowered, with an unasked reply queued | the queued run | Checked again at admission: the run ends quietly, with no call and no charge. A mention the owner made meanwhile is still answered, as theirs. | runs.ts `refusedAtAdmission` (l.785–795) · proactive-runs.test.ts:199, 208, 218 | HANDLED |
| B21 | The owner's tier lowered below their live Agents (`tier:set`, or `AGENT_TIERS` shrunk) | existing Agents | Existing Agents stay usable; only creating new ones is refused. | cli.ts:132–137; agent limit checked at creation · agents.test.ts:115–139 (creation only) | HANDLED-UNTESTED (the downgrade) |

### 2.3 Models and providers

| # | Event | What depends on it | What the code does today | Evidence (code · test) | Class |
|---|---|---|---|---|---|
| C1 | An owner's provider deleted while a live Agent uses it | `agents.provider_id` (restrict) | Refused with 409 `provider_in_use`, naming the Agents. A race with an Agent taking the provider never leaves an Agent on a deleted provider. | providers/store.ts:275–285 · providers.test.ts:232, 252 | HANDLED |
| C2 | … once only deleted Agents use it | deleted Agents' model columns, `token_ratios` | Deleted Agents' model is cleared, and the provider's learned token ratios are deleted in the same transaction. | store.ts:286–292; metering/tokens.ts:158–161 · providers.test.ts:232 (the delete); no test found for the ratios | HANDLED-UNTESTED (the ratios) |
| C3 | … while it is the owner's memory model | `accounts.memory_model` (jsonb, no foreign key) | Not checked at delete time. Afterwards no memory call is made (the choice is never replaced by the site's model) and `/api/me` says `memoryModelUsable: false`. The owner must choose again. | memory/call.ts:62–87; README 930–931 · memory-model.test.ts:205, 248 | HANDLED |
| C4 | Its key revoked or invalid upstream | replies, drafts, memory calls | Replies fail `provider_rejected`, which is not retryable. Memory calls fail: flags are tried twice, dreams three times a day. | runs.ts:35 · runs-faults.test.ts:150; memory-hearsay.test.ts:878 | HANDLED |
| C5 | The operator changes `PROVIDER_KEY_SECRET` | every stored provider key | Every key becomes unreadable: replies fail `provider_rejected` and memory choices become unusable. Each owner must re-enter each key. There is no dual-secret or re-encryption path, and if the old secret is lost the keys are gone. | providers/crypto.ts; port-impl.ts:437–443 (`KEY_UNREADABLE`, l.147); README 66 · provider-secrets.test.ts:56, 87 | PARTIAL (operator) |
| C6 | A provider model taken off the provider's list (`PATCH` of `models`) while an Agent uses it | the Agent's `provider_model` | Accepted with no check, unlike a delete. Every reply then fails `provider_unavailable`, which is `retryable: true`, so each retry fails again, indefinitely. In a group, other members see "暂时无法回复" (temporarily unable to reply) on every call. The Agent view has no usable flag, while memory has `memoryModelUsable`. The way out: the owner picks another model. | store.ts:195–223; resolve.ts:108–110; port-impl.ts:444; runtime/port.ts:137; runs.ts:35, 67 · none | PARTIAL |
| C7 | "Sync models" (`models/refresh`) after the upstream retired a model | the provider's list | A refresh only adds names. A retired model stays listed until the owner removes it, and calls to it fail at the upstream. | store.ts:225–242 · providers.test.ts:398 | HANDLED (by design: the stale entry is the owner's to remove) |
| C8 | A site model removed from `SITE_MODELS` | Agents on it, memory choices, running replies, usage labels | Agents: as in C6 (`provider_unavailable`, retryable, no signal). A memory choice of it becomes unusable and no call is made. A run admitted on it before a restart is settled at no charge, and `via` shows the model's id. | resolve.ts:79–82 · metering.test.ts:434; agents-reply-via.test.ts:272; memory-model.test.ts:263 | PARTIAL (the Agents part) |
| C9 | A site model id reused for a different model | the `site:<id>` token ratio, `via` labels | The new model inherits the old one's learned ratio (bounded between 0.8 and 2), and old replies' `via` shows the new label. | tokens.ts:152–156; messages/read.ts:102–107 · none | PARTIAL (low) |
| C10 | A site model's tier changed from free to paid | Agents on it, memory choices | Replies are charged to the balance only (402 `no_quota` `balance` for someone without one). A memory choice of it is ignored and the site's memory model used. | memory/call.ts:51–60 · memory-model.test.ts:124, 137; metering.test.ts:273 | HANDLED |
| C11 | A site model's `tools` changed from true to false, or a provider model found unable to use tools | tool offers | The next reply is offered no tools. A provider model is marked once and its owner gets a whisper. | port-impl.ts:495, 715–728 · models-resolve.test.ts:187; tools-capability.test.ts | HANDLED |
| C12 | The judgement model removed or failing | proactive Agents; memory sorting, merges and the hearsay pre-check | Proactive Agents stay `proactive` but do nothing, and other edits are accepted. Memory judgements fail closed: the note goes to the vault as unsure, with no merge and no split. A failing hearsay pre-check lets the paid call go ahead. | README 591 · agents-proactive-settings.test.ts:115; memory-dream.test.ts:618, 1022 | HANDLED |
| C13 | The memory model unavailable (none configured, or its key unset) | reviews, hearsay, dreams, language conversion | No call is made and nothing recorded. Flags are tried twice, then dropped; dreams are retried three times a day; a conversion answers 503 `unavailable` up front. | memory/call.ts:62–119 · memory-call.test.ts; memory-hearsay.test.ts:878; memory-dream.test.ts:824 | HANDLED |
| C14 | Object storage unavailable, or a blob missing | uploads, downloads, avatars, replies that read files | A failed upload leaves no row. Downloading a missing blob is 404 (and logged). A reply shows a missing or unreadable file by its name. Two failures before any success mean the store is down: the reply fails `busy`, retryable, with no model call. | attachments/routes.ts:363–374; agents/context.ts:617–647 · runs-faults.test.ts:244–302; blob-s3.test.ts | HANDLED |
| C15 | A provider deleted while a reply admitted on it is still running (the Agent was first switched to another model) | `token_ratios` | The call goes on with the key it loaded. Its settlement then writes a ratio row for the deleted provider, which nothing ever deletes. | settle.ts:144–146; tokens.ts:204–232 · none | PARTIAL (low: an orphan row, no personal data) |

### 2.4 Money going down

| # | Event | What depends on it | What the code does today | Evidence (code · test) | Class |
|---|---|---|---|---|---|
| D1 | The free allowance runs out mid-reply | the running reply | Admitted calls finish; what they cost beyond what was left is forgiven, never taken from the balance or from tomorrow. | metering/settle.ts · metering.test.ts:192 | HANDLED |
| D2 | … mid tool loop | the next round | `extend` answers "final" or "stop". A hold is never lowered, and a raised hold is released however the tool phase ends. | port-impl.ts:665–689 · tool-loop-money.test.ts:205, 427, 557 | HANDLED |
| D3 | The balance at or below zero | paid-tier replies; free-tier replies once the allowance is used | Refused with 402 `no_quota` (on the free tier with `resetsAt`, the next midnight). One reply may take the balance below zero; only a grant makes it positive again. | accounts/store.ts:93–111 · metering.test.ts:255, 273, 281 | HANDLED |
| D4 | A user tops up, asks for a refund or disputes a charge | — | No path; only the operator's `credits:grant`. | cli.ts:104–131 | NOT-POSSIBLE (needed before a paid tier) |
| D5 | The memory allowance runs out mid-review or mid-dream | reviews, flags, dreams | A refused call is not a failure: flags are kept with no try counted, and the pair is woken after the next site midnight. Dreams retry at the next sweep. | README 967, 983 · memory-allowance.test.ts:127, 144; memory-dream.test.ts:824 | HANDLED |
| D6 | A hold left by a crashed run | the owner's allowance, balance or memory allowance; a concurrency slot | Released at the next start (recovery) or by the stale-run sweep (about 12 minutes with the defaults), at no charge. | port-impl.ts:927, 1017; README 2877–2954 · runs-restart.test.ts:479–594; tool-loop-money.test.ts:608; memory-allowance.test.ts:106 | HANDLED |
| D7 | A negative adjustment by the operator | balance, ledger | `credits:grant --points -n` writes an `adjust` ledger row. It may take the balance below zero; there is no floor. | cli.ts:108–131 · cli-credits.test.ts:79 | HANDLED |
| D8 | `FREE_DAILY_POINTS` or `MEMORY.freeDailyPoints` lowered below what an owner already used today | today's admissions | With nothing left, calls are refused until midnight. `freeDailyPoints 0` turns site-paid memory off. | memory/call.ts · memory-allowance.test.ts:173 (0 only) | HANDLED-UNTESTED (lowering mid-day) |

### 2.5 Limits lowered and switches turned off by the operator

All configuration is read at start-up (config.ts:688), so "mid-run" means "at the next restart". Replies running at that moment are recovered as `failed`, `provider_unavailable`, retryable (D6).

| # | Event | What depends on it | What the code does today | Evidence (code · test) | Class |
|---|---|---|---|---|---|
| E1 | `MEMORY.roomOwner` or `roomSelf` lowered below what a room holds | adds, edits, undo, confirm, dreams | Adds are refused, and an undo or confirm that would grow the room is 409 `room_full`. The pipeline and dreams may still shrink the room (`fits`: any shrink fits). The edit route, however, computes the room left as max(0, limit − used + the note's own weight). In a room over its limit by more than that note's weight, every text edit, even a shortening one, is 409; only deleting works. | memory/routes.ts:139, 176–190; write.ts:19 · none | PARTIAL |
| E2 | `MEMORY.roomNotes` lowered below a room's count | adds, undo of a remove | Adds are refused with `count: true`; deleting notes makes room. | routes.ts:142–146; apply.ts:852–857 · memory-routes.test.ts:292 (at the cap, not below it) | HANDLED-UNTESTED |
| E3 | `MEMORY.roomHearsay` lowered | the hearsay room | The next hearsay consolidation trims the oldest entries until the room fits. An undo that would overfill it is `full`. | apply.ts (~l.740), 962–973 · none found | HANDLED-UNTESTED |
| E4 | Context sizes lowered (a site model's `contextTokens`, or `PROVIDER_DEFAULT_MAX_OUTPUT_TOKENS` raised past a provider model's context) | context plans | No plan is stored; each run plans afresh. A model that can no longer hold the newest message fails `context_too_small`, which is not retryable. A site model whose context is not above its output limit is refused at start-up. | config.ts:718–738; port-impl.ts:513–514 · context.test.ts; config-agents.test.ts | HANDLED |
| E5 | Rate limits lowered (`RATE_LIMIT_SCALE`, per-minute settings) | counters | Kept in process memory; the new limits apply from the restart. | app.ts:321–327 · the *-ratelimit tests | HANDLED |
| E6 | `TOOLS.enabled` switched off | tool offers | No reply is offered tools; each reply is one call, as before. | port-impl.ts:495 · tool-loop-money.test.ts:698 | HANDLED |
| E7 | Sweeps switched off (`SWEEP_INTERVAL_MINUTES 0`, `MEMORY.changesSweepMs 0`) | unsent uploads, pending blobs, old memory changes, whispers | Unsent uploads stay (and count toward the quota, F4) until someone runs `attachments:sweep` by hand. Open whispers never expire. Pending cards are never discarded, though they can still be decided. | config.ts:319–323, 563–568; cli.ts:96–100 · memory-changes-sweep.test.ts:160; sweeper.test.ts | PARTIAL (operator) |
| E8 | Turning memory, whispers or proactive replies off site-wide while data exists | — | Only proactive replies (remove `JUDGE`, C12) and tools (`TOOLS.enabled`) have a switch. Memory can only be turned off per Agent: `MEMORY.freeDailyPoints 0` stops only site-paid calls, so owners using their own provider keep memory. Whispers have no switch. | config.ts:184, 317 | NOT-POSSIBLE (low–medium: incident response) |
| E9 | Concurrency lowered (`AGENT_MAX_CONCURRENT_RUNS`, `AGENT_MAX_RUNS_IN_FLIGHT`) | queued runs | Runs wait queued. Start-up refuses a configuration that allows more of others' replies than replies in all. | config.ts:702–706 · config-agents.test.ts | HANDLED |

### 2.6 Content going away

| # | Event | What depends on it | What the code does today | Evidence (code · test) | Class |
|---|---|---|---|---|---|
| F1 | A message deleted, recalled or edited | quotes (`replyToSeq`), tools' `found` references, notes and hearsay learned from it, the search index, attachments, unread counts, an Agent's later context; `persona_proposals.message_id` and `attachments.message_id` (both restrict) | No route: the message routes are send, list, get, mark read and search. | messages/routes.ts:66–206; 002:103–114 | NOT-POSSIBLE (high) |
| F2 | A conversation's history cleared | — | No path. A new topic hides history from the Agent only. | — | NOT-POSSIBLE (medium) |
| F3 | An attachment deleted, or expiring | its blob, the quota, the message that carries it, an Agent's context | Only unsent uploads are swept, after 60 minutes; a sent attachment lives forever. A sent attachment whose blob went missing is handled (C14). | attachments/store.ts:127–158; sweeper.ts:6 · attachments.test.ts; sweeper.test.ts | NOT-POSSIBLE (needed with F4) |
| F4 | The attachment quota fills | the uploader's future uploads | `usedBytes` sums every attachment row of the uploader, sent or not, in every conversation, including ones they left, closed groups and a deleted Agent's own. None can be removed, so at the quota every upload is 413 `quota`, forever. The same happens at once if the operator lowers `ATTACHMENT_QUOTA_BYTES` below what someone stores. | attachments/store.ts:29–35, 45–49; README 3482–3483 · attachments-quota.test.ts:38 | UNHANDLED (any user; also the operator) |
| F5 | A note deleted or changed while a pending card, an undo, a merge or a conversion refers to it | `memory_changes.ops` | A confirm drops every in-place op if any note it names has moved, applies the adds, and otherwise discards the change as stale. An undo answers `stale_change`. A dream op or merge naming a changed note is dropped. | apply.ts:867–877, 1034–1046 · memory-apply.test.ts:222, 414; memory-dream.test.ts:670 | HANDLED |
| F6 | A hearsay entry deleted or confirmed while an undo refers to it | hearsay change ops | The undo is stale unless every entry it inserted is still there and none it dropped has come back. | apply.ts:962–980 · memory-hearsay.test.ts:1069 | HANDLED |
| F7 | A new topic started | the Agent's context, a queued reply, reviews | Cannot be undone (two in a row are fine). History, search and unread counts are unchanged. A queued reply gets the new topic, and what came before is reviewed at once. | agents/routes.ts:532–556 · topic-reset.test.ts:27, 57, 66 | HANDLED |
| F8 | The memory language changed back | notes | No note moves. With automatic chosen, a conversion is 409 `no_language`. Each room's conversion is one change that can be undone. | memory/routes.ts:282–297 · memory-language.test.ts | HANDLED |
| F9 | A hearsay entry whose speaker left the group, unfriended the owner, blocked them (A13), or would delete their account (A16) | `agent_hearsay` | Kept until the owner deletes it or newer entries push it out of the room. It is shown to the model in that group (while the Agent is there) and in the owner's own chat. The speaker has no say. | memory/store.ts:145–158; 031:38 (the speaker id set to null: unreachable) · memory-routes.test.ts:425 | PARTIAL (a policy decision) |
| F10 | A note whose origin group the owner has left, or that closed | `origin_conversation_id`, the notes page's `source` | Still used in the owner's own chat. A vault note is never shown in another group; a non-vault note is shown in any group. The notes page names the group by its current title with no membership check, so renames made after the owner left are shown to them. | memory/routes.ts:79–108 (compare hearsay, 333–350) · memory-routes.test.ts:190 (a member's view only) | PARTIAL (low; a leak) |
| F11 | Quotes and tools' `found` references to messages a reader can no longer see | the wire's `replyTo` and `looked.found` | Decided per reader by the one visibility rule. An invisible quote is sent as `visible: false`, with no text. | conversations/store.ts:21–23; messages/read.ts:159–212 · messages.test.ts:391, 424; search.test.ts:284; tool-lookups.test.ts | HANDLED |

### 2.7 Visibility that shrinks with membership

| # | Event | What depends on it | What the code does today | Evidence (code · test) | Class |
|---|---|---|---|---|---|
| G1 | After leaving or being removed | history, search, attachments, members, an Agent's avatar, pushes | All 404 or absent at once. Open sockets get `gone`, and catch-up treats the conversation as unknown. | conversations/store.ts:21–23, 303–337 · messages.test.ts:235; search.test.ts:213, 327; sync.test.ts:338, 426, 824 | HANDLED |
| G2 | After re-joining | history, whispers, quotes | Only what comes after the new joining is shown. Whispers from the earlier stay are not sent, and a quote from the first stay is hidden. | whispers/store.ts:272–306 · messages.test.ts:235, 424; whispers.test.ts:359 | HANDLED |
| G3 | Hearsay from a group the owner (and so the Agent) has left | the notes passage in the owner's own chat | Still given to the model there, with the group's current title (`loadNotes`), while the owner's memory page shows `group: null`. | memory/passage.ts:16–22; memory/routes.ts:333–350 · memory-routes.test.ts:425 (the page only) | PARTIAL (low) |
| G4 | An Agent's notes about a group its owner left | the notes passage | By the one rule: everything in the owner's own chat; in a group, only non-vault notes, notes that began there, and that group's hearsay. | memory/store.ts:145–158 · memory-store.test.ts | HANDLED |
| G5 | Appellations of someone who left the group or ended the friendship | the model's roster | The row is kept but not shown to the model while the two share nothing, and comes back when they do. | README 507–510 · agents-appellations.test.ts:203, 248 | HANDLED |
| G6 | People and Agents who left, named in old messages | `principals` in reads | Listed only to readers who can still see those messages. An Agent's avatar stops being served. | README 470–473 · sync.test.ts:156 | HANDLED |

### 2.8 Infrastructure

| # | Event | What depends on it | What the code does today | Evidence (code · test) | Class |
|---|---|---|---|---|---|
| H1 | Restart with replies running | runs | Each is ended without a model call. A posted reply ends done or stopped; an interrupted one ends cancelled; anything else fails `provider_unavailable`, retryable. Its hold is released at no charge and follow-ups are queued. | port-impl.ts:927–1016 · runs-restart.test.ts:187–285 | HANDLED |
| H2 | Restart with replies queued | runs | They stay queued and are answered once the worker starts. | README 2891 · runs-restart.test.ts:240 | HANDLED |
| H3 | Restart with memory review timers armed | in-process timers | Re-armed only for pairs whose Agent replied in the last day with owner lines still unreviewed, and for pairs with flags less than a day old. Older ones wait for the next reply. | reviewer.ts:88–90, 360–390 · memory-review.test.ts:1536 | HANDLED |
| H4 | Restart: in-process counters and marks | hearsay calls per hour, dream failures and rooms done, failed-review marks, proactive debounce, fuse and per-hour counts, the gateway's remembered upstream refusals, rate-limit windows | All start afresh: the hearsay allowance for the hour is fresh, and a refusal is learned again on the next refused call. | reviewer.ts:110–124; dream.ts:93; proactive/scheduler.ts:87; proactive/hourly.ts:31; models/gateway.ts:290–330 · none found for the reset itself | HANDLED-UNTESTED |
| H5 | Restart during a language conversion | conversion state | Rooms already done stay converted (each is its own change); the rest are not. `GET …/convert` then says `idle`. | reviewer.ts:124; README 908 · none found | HANDLED-UNTESTED |
| H6 | Restart during a persona draft | the request and its run | The request answers 503 `busy`; the run fails with nothing held. | routes.ts:576–581 · runs-restart.test.ts:285 | HANDLED |
| H7 | A deleted Agent's leaving of its groups not done before the restart | memberships | The start-up sweep finishes it before any request is served. | group-leave.ts:82–114 · agents-group-membership.test.ts:516 | HANDLED |
| H8 | A shutdown that takes longer than its 5 s | runs | Runs not ended in time are left running and logged, and are recovered at the next start or by another instance's sweep. | README 2896–2905 · runs-restart.test.ts:155 | HANDLED |
| H9 | A deploy overlap (two instances briefly) | runs | The new instance's recovery ends the old one's runs; the old one then posts nothing and records nothing twice. | README 2907–2916 · runs-restart.test.ts:364 | HANDLED |
| H10 | A run stuck `running` with nobody working on it (any purpose) | a concurrency slot, a hold | The stale-run sweep runs every minute and releases a run after twice the longer run timeout plus a minute. | port-impl.ts:1017 · runs-restart.test.ts:479–578; memory-allowance.test.ts:106 | HANDLED |
| H11 | The database unavailable | requests | Answered 503 `busy`, with statement time-outs. | db.ts · db-busy.test.ts; db-timeout.test.ts | HANDLED |
| H12 | Whispers and memory changes swept | old rows | Open whispers expire after 7 days and answered ones are deleted after 30, in bounded batches that skip locked rows. | whispers/store.ts:367–411; memory/sweep.ts · whispers.test.ts:569–652; memory-changes-sweep.test.ts | HANDLED |
| H13 | A migration's Down | schema and data | The runner only goes up (`direction: "up"`) and there is no down command. Several Downs have preconditions or lose data: 008 needs no agent conversations; 012 deletes rows; 016 and 017 refuse with live data; 031 and 043 drop tables with content. Only 030's Down is tested. Rolling back means restoring a backup. | migrate.ts:9–15; migrations 008, 012, 016, 017, 031, 043 · schema.test.ts:236 | NOT-POSSIBLE (operator) |
| H14 | Two instances | sockets, pushes and WebSocket tickets (hub.ts, tickets.ts); the worker's stop and silence flags (a pause handled on B does not stop A from streaming, though A's post is then refused by the database mark); one review per Agent and one dream per owner (both enforced in process); hearsay calls per hour; proactive debounce and per-hour counts; rate limits (in-memory `@fastify/rate-limit`); conversion state; start-up sweeps that run twice | Unsupported, and documented: "Run exactly one instance". Claiming runs, admission, settlement and recovery happen in the database and are safe; everything else listed is doubled or goes unseen. | README 2292–2304, 2976 · runs-restart.test.ts:364 (the overlap only) | NOT-POSSIBLE (scale) |

## 3. States with no way out, as short scenarios

**S1. The full attachment drawer (F4).**

- **Who can get there:** any user; also the operator, by lowering the quota.
- **Scenario:** Lin shares photos and videos in family groups for a year. She later leaves two of the groups, and one closes. At 20 GiB every upload answers "too large (quota)". Nothing she can do frees a byte: no message or attachment can be deleted, and bytes in groups she left or that closed still count.
- **The only exit:** an operator deleting `attachments` rows and blobs by hand. That breaks nothing visible (the file shows as a name and downloads 404), but there is no tool for it.
- **Fix direction:** message and attachment deletion (F1, F3), or count only what is still reachable.

**S2. The handle that can never come back (B10).**

- **Who can get there:** any user.
- **Scenario:** Wei creates an Agent called `xiaoai`, deletes it, and creates `xiaoai` again: 409 `handle_taken`, forever. Worse, a script can create and delete about 15 Agents a minute and permanently reserve every short handle.
- **Why the operator cannot undo it:** the deleted Agent's principal is held in place by its greeting message, its membership, its agents row and its dedicated conversation, all restrict.
- **Fix direction:** free or rename the handle on delete (e.g. `deleted_<id>`), and count deletes against a daily cap.

**S3. The account that cannot leave (A16).**

- **Who can get there:** any user (by asking).
- **Scenario:** a user asks to be deleted. There is no route. An operator who tries `delete from principals` is refused by about 25 foreign keys; one who tries to delete the Better Auth user is refused by `principals_auth_user_fk`.
- **What a deletion would even need to decide:**
  - What other members see of the person's group messages.
  - What happens to their Agents' memory.
  - Other owners' hearsay that names them (it would keep their name and words).
  - Their provider keys and blobs.
  - Their handle.
- **The only exit:** none, short of a schema change and a tombstone procedure.

**S4. The lost mailbox (A17).**

- **Who can get there:** any user.
- **Scenario:** a user's old work address is closed and they forget their password. A reset needs the mailbox, and the address cannot be changed while signed in (no endpoint), so the account is unreachable for good.
- **The only exit:** an operator editing Better Auth's `user` row by hand, which is not documented.

**S5. Memory remembers the switch-off (B18).**

- **Who can get there:** any user.
- **What makes it bad:** not a dead end, but the promise is broken quietly.
- **Scenario:** Mei turns her Agent's memory off before talking about her divorce, then turns it back on a day later and says "hi". The first review after that reply reads the newest 40 of her and the Agent's messages after the last reviewed seq, i.e. the divorce conversation, and writes notes from it.
- **The only exit:** undoing the change chip after the fact.
- **Fix direction:** when `memory` changes, move `reviewed_seq` to each conversation's current seq for that Agent (and drop its flags).

**S6. The model that is gone but looks retryable (C6, C8).**

- **Who can get there:** a user (editing their provider's list) or the operator (removing a site model).
- **What makes it bad:** a way out exists but nothing points to it.
- **Scenario:**
  1. The owner trims their provider's model list, or the operator drops a site model.
  2. Every reply of the Agents on it fails `provider_unavailable` with `retryable: true`; each retry fails the same way.
  3. In groups the Agent shows as "暂时无法回复" (temporarily unable to reply) to everyone.
  4. Nothing on the Agent says its model is gone.
- **The exit:** the owner picks another model. Memory has the signal (`memoryModelUsable`); Agents should get the same, and the failure should not be retryable.

**S7. The rotated secret (C5).**

- **Who can get there:** operator only.
- **Scenario:** the operator rotates `PROVIDER_KEY_SECRET` (for example after a leak). Every owner's provider key is now unreadable, and every Agent on an own provider fails `provider_rejected` until its owner re-enters the key. If the old secret is not kept, there is no other way back.
- **Fix direction:** a re-encryption command that reads with the old secret and writes with the new one.

**S8. The accidental last leave (A5, A7).**

- **Who can get there:** any user.
- **What makes it different:** irreversible by design rather than a bug.
- **Scenario:** in a group whose other members have all left, the last person leaves by mistake. The group closes for good. Its history is readable by nobody and cannot be reopened, while its files still count toward their uploaders' quotas (S1).

**S9. The chat that never goes away (A9).**

- **Who can get there:** any user.
- **Scenario:** a user blocks someone who harassed them. The direct chat with that person stays in their list forever, read-only, as do chats with every ex-friend and every deleted Agent's conversation.
- **The only exit:** none (no hide, archive or leave).

## 4. What I could not determine

- **The web client.** Other agents were editing `app/web`, so I spot-checked only that it hides a deleted Agent's proposal and memory-card buttons (AgentChatBits.jsx:614, MemoryChip.jsx:46). I did not audit how it shows a vanished model, a closed group, an over-full room, or `retryable` failures.
- **Two instances reviewing the same window.** Whether two concurrent reviews of the same window can each apply the same adds. Within one process "one review per Agent at a time" prevents it. I did not trace whether `applyOps` re-checks exact duplicates under the Agent's lock strongly enough to stop a second instance doing so.
- **Better Auth's session rows.** Whether expired and revoked sessions are ever deleted, or accumulate.
- **Sync payload size.** How `GET /api/sync` behaves for someone with many dead conversations (deleted Agents, ex-friends). It lists every current membership, and I did not check for a cap.
- **Tools (in progress).** The `found_elsewhere` whisper has no answer hooks yet (`ANSWER_HOOKS` is empty, whispers/routes.ts:21). Reverse paths for what tools will do on "告诉他们" (tell them) are not designed yet.
- **E3, the hearsay trim.** Whether lowering `roomHearsay` trims at the next consolidation only (as I read apply.ts), or anywhere else. I did not find a test.
- **Group reviews after memory is back on (B18).** Whether group reviews run immediately or only once a new flag or reply arrives. They read from the same stale `reviewed_seq` either way.
- **Operator documentation.** Whether any deployment document covers secret rotation, quota relief or handle recovery. I looked only at `app/service/README.md`.
