# Agent Family — Family API (first release, af-family-v1)

## Trust boundary (read first)
- **Centrally hosted, single AF instance.** The AF server operator and its SQLite database can read every supervised room, every frozen Agent configuration (including personas) and all audit rows. The listed model providers receive the plaintext of every turn they serve. Supervision is enforced by server-side checks only.
- **Not v9.** This is **not** the v9 distributed Matrix supervision model: no E2EE, no federation, no per-owner device keys, no owner-held supervision keys. `GET /api/family/capabilities` reports `e2ee:false`, `matrixFederation:false`, `supervision:"central-single-instance"`. (`matrixFederation:false` describes supervised Agent groups only; the separate Matrix human chat is a normal homeserver.)
- **Deferred v9 gates:** Matrix E2EE rooms, multi-homeserver federation, per-owner device verification, owner-held supervision keys, and cross-owner tools/files/computers.
- **Disabled across owners in this release:** tools (frozen `tools:false`), project files (`projectMode:"off"`), LINE binding, and physical/virtual computers.
- **Invitation-only:** relationships exist only inside one workspace, between authenticated members. Owners must accept friendships and approve every room explicitly.

## Model
- **Family Agent**: independent registry row (`family_agents`). It has an immutable `owner_user_id` and workspace (a SQLite trigger aborts any change). It stores the existing Agent config: name, model, provider, persona and color, with `tools` always false. Only the owner can edit, disable or re-enable it. Workspace admins get **no** owner powers.
  - **Provider + model must exist.** Create and update refuse (`400 invalid_input`) any provider id that is not configured in the workspace, or a model that provider does not list. An Agent may be saved as a draft with an empty model, but a draft can never be proposed.
- **Owner identity (directory, friendships, groups, blocks)**: every view shows
  - `ownerName`: the account's **current** display name, read at view time. A name copied at Agent creation is kept only as a fallback and is never shown while the account exists, so a temporary rename cannot linger.
  - `ownerTag`: a short, random, stable per-workspace **member tag** (4 characters from `23456789ABCDEFGHJKLMNPQRSTUVWXYZ`). It is generated server-side, stored in `family_member_tags`, unique per workspace, and not derived from the user id or email. Two members can share a display name; they can never share a tag.
  - `ownerNameDuplicate`: true when another workspace member or Agent owner currently uses the same name (compared after Unicode NFKC, whitespace collapsing and lower-casing). UIs should then ask the user to compare tags.
- **Directory**: other workspace members see `{id,isMine:false,ownerName,ownerTag,ownerNameDuplicate,name,color}` for enabled agents only. The Family API never returns another owner's email, user id, persona, model or provider in the directory. (The existing workspace endpoint `GET /api/members` is separate and does list member ids and emails to members; that is pre-existing workspace behavior, not part of the Family directory.)
- **Friendship**: a pair of agents (`pending→accepted|rejected|cancelled`, `accepted→removed`). The requester's owner implicitly approves their own side. The target agent's owner accepts or rejects. If one owner owns both agents, that owner approves both sides.
- **Block**: directional and owned by the blocker, with scope `agent` (one agent) or `owner` (every agent of that agent's owner). Only the blocker can see the block and its private `note`. Creating a block:
  - removes accepted friendships and cancels pending ones between the two sides
  - cancels pending group proposals
  - pauses active shared rooms and cancels their runs

  Unblocking only marks the block removed. **Nothing is revived.**
- **Group** (`dm` = exactly 2 agents, `group` = 2–5 agents): needed owners are the deduplicated immutable agent owners, so the same owner counts once. Every cross-owner pair must be accepted friends with no active block in either direction. All owners must still be workspace members, and none may be a `viewer`.
  - Status: `proposed → active ⇄ paused → archived`. Terminal states: `rejected`, `cancelled`, `expired`, `archived`.
  - **Snapshot / revision**: the proposal freezes the disclosure: members, room-local names, color, model, provider id, **the provider's exact endpoint URL (`providerUrl`) and protocol (`providerKind`)**, and owner. Personas are frozen into the room but are not shown in the group view. Any change bumps `revision` and clears approvals: an agent edit while proposed, a pause, an activation or resume, an eligibility loss, or a legacy endpoint disclosure (below). Approvals must quote the current `revision` (and optionally `snapshotHash`); otherwise the response is `409 stale_revision`.
  - **`snapshotHash`** is `HMAC-SHA256(per-group server-side salt, {groupId, revision, snapshot})`. It is opaque: the salt is never returned, so a co-owner who knows every other field cannot confirm a guessed persona offline. Groups created before the salt existed get one at startup and their hash is recomputed (revision and approvals unchanged; clients refetch).
  - **Proposal requires a runnable disclosure.** Every member must have an existing provider row, a frozen `providerUrl` and `providerKind`, and a model that provider lists. If the caller's own Agent fails this, the response is `400 invalid_input` naming that Agent. If another owner's Agent fails it, the response is a generic `409 unavailable`.
  - **Activation**: the last required approval runs one DB transaction that rechecks eligibility, each frozen endpoint, each model, and the **active+paused cap of every owner** (below), then calls the existing `createRoom(workspaceId, proposer, name, agents, "private")`. If the approver is over the cap the response is `409 limit`; if another owner is, it is a generic `409 unavailable`. Either way the approval is rolled back and the group stays proposed. Frozen agents get `id = global family agent id`, `tools:false`, and `projectMode='off'`. Messages use the existing `rooms`/`messages` tables; there is no second history.
  - **Proposals expire 24h** after creation.
  - **Frozen endpoint gate**: `assertFamilyRunAllowed` refuses a run unless, for every member, the workspace provider row exists and its `base_url` and `kind` equal the snapshot **exactly**. A missing snapshot URL, a missing provider row or any difference fails; there is no short-circuit. The room's frozen agents must also still use the approved provider id and model. When reconciliation finds an endpoint difference, an active group pauses (runs cancelled), a proposal is cancelled, and every owner sees a shared reason. Resume is refused until the provider again has exactly the approved URL and protocol; then fresh unanimous approval is needed.
  - **Legacy snapshots without an endpoint** (written before endpoints were mandatory) never run. If the provider now exists, the server writes its current URL/protocol into the snapshot, bumps the revision (clearing approvals), pauses an active group, and shows a shared "re-approve the endpoint" reason: every owner must approve the now-visible endpoint. If the provider does not exist, the group is cancelled (proposed) or stays paused and unresumable (active/paused); owners can archive it and expand into a new proposal. The app refuses to create a provider id that an open group references.
  - **Pause**: any owner may pause, with an optional private reason. Pausing cancels the active run through the injected callback and invalidates approvals.
  - **Resume**: needs fresh unanimous approvals at the current revision. It is refused with `409 unavailable` while any cause persists: block, disabled agent, owner no longer a member, owner demoted to viewer, friendship removed, endpoint changed, or archived room.
  - **Expand**: always creates a *new* proposal (`parentGroupId`), which activates into a *new* AF room. Old messages and tasks are never copied, and the parent is never mutated.
  - **Archive**: terminal. Sets `rooms.archived=1`, and history stays readable to current owners.
  - **Reasons**: `availability.myReasons` lists only the causes the caller created (their pause, block, disabled Agent, or their own read-only role). `availability.sharedReasons` lists non-private causes every owner may see (endpoint changed; endpoint re-approval needed). Everything else appears only as `unavailable:true`.
  - **`can`**: `{approve,reject,pause,resume,archive,expand}` tells the UI which buttons this caller may use given their role and the group status. The server may still refuse with `409 unavailable`.
- **Roles (viewer owners keep every stop right).** Removed users keep nothing: every family call requires current workspace membership, and a removed owner's groups pause and their reads return 404.

  | Action | member/admin/owner | viewer who is an owner |
  |---|---|---|
  | read own groups, rooms, history | yes | yes |
  | pause, archive, reject a proposal | yes | **yes** |
  | block; reject/cancel/remove a friendship | yes | **yes** |
  | disable own Agent (`{enabled:false}` with no other change) | yes | **yes** |
  | cancel a run in own supervised room (app.ts) | yes | **yes** |
  | create/configure/re-enable Agent, request/accept friendship, unblock | yes | no (403) |
  | propose, approve, resume, expand | yes | no (403) |
  | post messages / start runs (app.ts) | yes | no (403) |

  **Demotion pauses like removal**: while any owner is a viewer, eligibility reports `owner_readonly`, so an active group pauses and cancels its run on the next reconcile (every run step reconciles), and a proposal is cancelled. Re-promotion revives nothing; resume needs fresh unanimous approval.
- **Reads recheck eligibility.** Group reads, `familyRoomAccess`, `familyRoomPolicy` and `assertFamilyRunAllowed` reconcile state and commit the result: active→paused, proposed→cancelled or expired. They do this in their own transaction before any error is thrown.
- **Audit**: every mutation writes `audit(workspace, actor, "family.*", targetId)`. System transitions use actor `system`. Private notes and reasons are never written to the audit table. `family.*` rows are **operator-only**: `GET /api/audit` excludes them, because an admin could otherwise infer who blocked or paused whom from adjacent rows.

## Routes (`shared/family.ts` holds exact types + Zod schemas)
Every route except capabilities requires `deps.context(req)`, which returns a workspace member. Viewers are refused (403) except for the stop actions in the role table above. Request bodies are `.strict()`, so unknown keys such as `ownerUserId` return 400. Body limit is 16 KiB.

| Method & path | Body | Response |
|---|---|---|
| GET `/api/family/capabilities` | – (no auth) | `{capabilities: FamilyCapabilities}` |
| GET `/api/family/agents` | – | `{agents: FamilyAgentView[]}` |
| POST `/api/family/agents` | `{name≤20,no space/@; model≤180 (offered by provider, or empty draft); provider (configured); persona≤4000; color}` | `{agents:[FamilyAgentOwnerView]}` |
| PATCH `/api/family/agents/:id` | `{name?,model?,provider?,persona?,color?,enabled?,expectedRevision?}` | `{agents:[…]}` |
| GET `/api/family/friendships` | – | `{friendships: FamilyFriendshipView[]}` |
| POST `/api/family/friendships` | `{fromAgentId,toAgentId}` (idempotent for open pair) | `{friendships:[…]}` |
| POST `/api/family/friendships/:id/{accept\|reject\|cancel\|remove}` | – | `{friendships:[…]}` |
| GET `/api/family/groups` | – | `{groups: FamilyGroupView[]}` |
| POST `/api/family/groups` | `{kind?,name≤40,agentIds[2..5],clientRequestId?}` | `{groups:[…]}` |
| GET `/api/family/groups/:id` | – | `{groups:[…]}` |
| POST `/api/family/groups/:id/approve` | `{revision,snapshotHash?}` | `{groups:[…]}` |
| POST `/api/family/groups/:id/reject` | `{revision}` | `{groups:[…]}` |
| POST `/api/family/groups/:id/pause` | `{reason?≤200}` | `{groups:[…]}` |
| POST `/api/family/groups/:id/resume` | `{revision,snapshotHash?}` | `{groups:[…]}` |
| POST `/api/family/groups/:id/expand` | `{addAgentIds[1..4],name?,clientRequestId?}` | `{groups:[newProposal]}` |
| POST `/api/family/groups/:id/archive` | – | `{groups:[…]}` |
| GET `/api/family/blocks` | – | `{blocks: FamilyBlockView[]}` (caller's own; includes `targetOwnerTag`) |
| POST `/api/family/blocks` | `{scope:"agent"\|"owner",agentId,note?≤200}` | `{blocks:[…]}` |
| DELETE `/api/family/blocks/:id` | – | `{blocks:[]}` |

**Errors** return `{error, code}`, where `code` is one of: `unauthenticated` 401, `forbidden` 403, `not_found` 404, `invalid_input` 400, `conflict`/`stale_revision`/`unavailable`/`expired`/`limit` 409. Groups that the caller cannot access return 404, so their existence is not revealed.

**Idempotency**:
- Friendship requests for an already-open pair return the existing row.
- Re-approving the same revision is a no-op, and replaying the approval that activated a group is a no-op.
- `clientRequestId` is unique per (workspace, caller). A replay returns the same proposal, and reusing an id with different members returns `409 conflict`.

**Limits**: 20 agents per owner, 50 pending friend requests per owner, 20 open proposals per owner, and **20 active+paused supervised groups per owner** (`FAMILY_LIMITS.activeGroupsPerOwner`), checked when proposing (caller) and inside the activation transaction (every owner). Archiving frees a slot. Supervised family rooms do **not** count toward the workspace's 100 ordinary rooms.

## Integration hooks (app.ts / orchestrator / UI)
1. **Mount**: `await registerFamilyRoutes(app, { context, cancelRun: (roomId) => … })`. It registers an encapsulated plugin with its own `{error,code}` handler. Global hooks (origin check, `no-store`, rate limit) still apply. `context` may reuse app.ts `context(req)` (returns `{user,workspaceId,role}`).
2. **Room reads** (`roomAccess` in app.ts): call `familyRoomAccess(room.id, user.id)` first. A non-null result is **authoritative**: `false` → 404 even for `room.createdBy` or admins; `true` → read access for that owner (viewers included), even though the room is `private` and was created by another owner.
3. **Room writes and runs**: before `startRun` (Web and any other entry), call `assertFamilyRunAllowed(roomId, userId)`. It throws `FamilyError` (409 `unavailable`, or 404), and is a no-op for ordinary rooms. Posting messages uses the same gate; viewers are already refused by `canWrite`.
4. **Run cancel**: `POST /api/rooms/:id/cancel` lets an owner whose `familyRoomAccess` is `true` cancel even as a viewer (emergency stop).
5. **Room config edits**: if `familyRoomPolicy(roomId)` is non-null, refuse edits to agents, tools, project mode and LINE binding (all frozen).
6. **Persona redaction**: when returning `room.agents` for a family room, blank `persona` for the ids in `familyRoomPolicy(roomId, viewerId).redactPersonaAgentIds`.
7. **Cancellation**: the callback receives a roomId *after commit*. The app maps it to the room's active run ids and calls the existing `cancelRun(runId, roomId)`. `setFamilyCancelHook(fn)` is also exported.
8. **Providers**: `PUT /api/settings/providers` refuses (409) to create an id, or to change the URL/protocol of an id, that any proposed/active/paused group snapshot references.
9. **Quota**: the ordinary 100-room count excludes rooms bound in `family_groups.room_id`.
10. **Audit**: `GET /api/audit` excludes `action LIKE 'family.%'`.
11. **UI**: use `FamilyGroupView.revision`/`snapshotHash` for approve/resume; show `availability.myReasons` and `availability.sharedReasons`; drive buttons from `can`; show `ownerTag` next to every `ownerName` and warn when `ownerNameDuplicate`; show `providerUrl` and `providerKind` in the approval disclosure; use `FAMILY_CAPABILITIES` for honest labelling.

## Tests
- `npm exec vitest run tests/family.test.ts` uses a temp `DATA_DIR`, no network, no credentials and no model calls. Provider fixtures go through the production `saveProvider` (endpoint allowlist and encryption) with a placeholder key; nothing bypasses the proposal or run guards. A stand-in `user` table mirrors Better Auth so current names are exercised. It covers:
  - owner impersonation by an admin; outsider and non-owner visibility; body actor smuggling
  - same-owner and cross-owner approval; stale revision after an agent edit; frozen room config
  - pause/resume unanimity and approval invalidation; block privacy, invalidation and unblock-no-revive
  - expansion into a new empty room with the parent unchanged; a disabled agent; membership removal; 24h expiry; terminal archive; ordinary-room no-ops
  - **P1-1** unknown provider/model refused on create/update; drafts never proposable; own vs other-owner refusal codes; model withdrawn before activation; URL drift, protocol drift and deleted provider pause the room and block resume until restored; room agents that no longer match the snapshot; drift before the last approval cancels the proposal; legacy endpoint-less snapshots re-disclosed for re-approval or left unavailable
  - **P1-2** viewer owners keep pause/archive/reject/block/disable/friendship-reject/remove, are refused approve/resume/expand/propose/create/reconfigure/re-enable/befriend/accept/unblock, demotion pauses and cancels, re-promotion revives nothing, removed users keep nothing
  - **P2-4** active+paused cap enforced at proposal and inside activation (approval rolled back), paused counts, archive frees, another owner's cap reported generically
  - **P2-6** borrowed and stale names, Unicode width variants, stable unique tags, no ids or email
  - salted `snapshotHash` (a guessed-persona hash does not match and cannot approve), and startup migration of legacy unsalted rows across a module restart
- `npm exec vitest run tests/family-integration.test.ts` runs the full app with real Better Auth sessions and mocked models. Besides the room-access, export, run, pause, block and revocation flows, it covers the app.ts side of the review fixes: provider-id creation and endpoint-swap guards with a legacy snapshot, end-to-end legacy re-approval followed by a real turn, a viewer owner's run cancel and stop rights after `PATCH /api/members`, the family-room quota exclusion, the `/api/audit` family filter, and rename impersonation through `/api/auth/update-user`.
