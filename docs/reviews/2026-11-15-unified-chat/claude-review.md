I found 6 blockers or high-severity issues, 4 medium and 2 low. I only read files and ran nothing; findings marked "likely" depend on library or deployment behaviour I couldn't check here.

## Blockers / high

**1. A removed or demoted member's Agent keeps running on the workspace's model credentials, and the owner can't stop it.**
- **Where:** `server/chat-agents.ts:86-94`. `onMessage` reads `a.workspace_id` and calls `modelFor(a.workspace_id, …)` but never checks that the owner is still a member. `app.ts:883` (role change) and `app.ts:894` (membership delete) exist.
- **Effect:** After removal, `context()` returns 403 (`app.ts:129`), so the owner can't even pause the Agent through `/api/social/agents/:id`. It keeps answering and billing the workspace until midnight-reset limits.
- **Fix:** In `onMessage` before `reserveChatCall`, and again in the post-generate recheck, run `SELECT role FROM memberships WHERE user_id=? AND workspace_id=?` with `(a.owner_id, a.workspace_id)` and require a row with `role!=='viewer'`.

**2. Agents are validated against one workspace and run against another.**
- **Where:** `af-module.js:14` sends no `x-workspace-id`, so `c.workspaceId` is always the earliest-created membership (`app.ts:123-127`). Execution uses `a.workspace_id` (`chat-agents.ts:94`).
- **Effect:**
  - `updateChatAgent` (`:47`) checks models against `c.workspaceId`, not the Agent's workspace.
  - The viewer check (`social-routes.ts:41`) uses the default workspace's role.
  - `/me` (`social-routes.ts:15`) lists models from the default workspace.
  - So a multi-workspace user, or one whose earliest workspace changes, can save a model that the Agent's workspace doesn't have, or edit while being only a viewer in the Agent's workspace.
- **Fix:** In update, use `configured({...c, workspaceId: old.workspace_id}, merged)` and check the role in `old.workspace_id`.

**3. Pause race: a reply can still be sent after pause.**
- **Where:** `chat-agents.ts:95-96`. `controller.signal.aborted`, `latest.status` and `latest.generation` are all read before `await exactMembership(...)`.
- **Effect:** A pause or edit that lands during that network call isn't seen, and `sendMessage` (`:98`) goes out anyway.
- **Fix:** Check membership first, then re-read the row and the abort signal synchronously, right before sending:
  ```ts
  if(!await exactMembership(live.client,a)) {live.history=[];return;}
  const latest=db.prepare('SELECT status,generation FROM chat_agents WHERE id=?').get(agentId) as any;
  if(controller.signal.aborted||latest.status!=='active'||latest.generation!==a.generation){live.history=[];return;}
  await live.client.sendMessage(...)
  ```
  The `catch` notice path (`:103-104`) has the same ordering; it's lower impact because it only sends a notice.

**4. A start failure at boot bricks Agents permanently.**
- **Where:** `chat-agents.ts:128` sets `status='error'` on any `startAgent` failure, such as Synapse not being ready when AF starts. This also overwrites `paused`.
- **Effect:** No recovery path exists:
  - The UI disables both 聊天 and 暂停/恢复 unless the status is active or paused (`af-module.js:60`).
  - An edit keeps the `error` status (`updateChatAgent:50`).
- **Fix:** Don't persist `error` on a boot failure; keep the status and retry in memory with backoff. Alternatively, allow `PATCH {paused:false}` when `status==='error' && token` and enable the 恢复 button for that state.

**5. Failed provisioning rows use up the 10-Agent limit forever.**
- **Where:** `chat-agents.ts:28` counts every row, including `error` rows with no token, and there is no delete route.
- **Effect:** Ten failed creates (for example during a Synapse outage) and the owner can never create another Agent.
- **Fix:** Count with `AND NOT (status='error' AND token='')`. Separately, the encrypted password stays stored on failed rows (`:32`, cleared only at `:38`); clear it in the `catch` at `:42`.

**6. If the owner leaves or declines the Agent DM, they can never chat with that Agent again.**
- **Where:** `openAgentRoom` (`chat-agents.ts:59`) returns the stored `room_id` without checking membership. The room is invite-only (`private_chat`), and the owner's power level (50) is below the invite level (100) (`:64`).
- **Effect:** `openRoom(…, {autoJoin:true})` (`af-module.js:60`) fails.
- **Fix:** When `room_id` exists, read the owner's `m.room.member` state with `live.client.getRoomStateEvent(room, 'm.room.member', ownerMx)`.
  - If it's `leave`, call `inviteUser(ownerMx, room)`.
  - If the Agent itself is no longer joined, create a new room and update `room_id`.
  - Also re-read `room_id` after the `await startAgent`, because `a` from `:57` can be stale.

## Medium

**7. The "invited members" check likely doesn't work.**
- **Where:** `chat-agents.ts:82`. The bot SDK likely sends the array as `membership=join&membership=invite`, and Synapse's `/members` likely reads only the first value, so invited users are never returned.
- **Exposure:** Low today, because only the Agent can invite. But the invariant in the comment isn't actually enforced.
- **Fix:** Call `getRoomMembers(a.room_id)` with no filter, drop entries whose membership is `leave`, and require exactly two entries, both `join`, matching the two expected IDs. You can confirm the current behaviour from the Synapse request log during your E2EE test.

**8. Blocking is inconsistent between AF and Matrix.**
- **a. Write order:** `af-module.js:30-33` updates `m.ignored_user_list` first and then calls `/blocks`.
  - If `/blocks` fails (409 identity mismatch, rate limit, network), the user is ignored in Matrix but still an AF friend.
  - On unblock it's the reverse: the user is un-ignored in Matrix but still AF-blocked.
  - **Fix:** Call `/blocks` first and update account data only after it succeeds; if the account-data write fails, revert the AF block.
- **b. Two separate block lists:** Element's native Ignore/Unignore (user panel, Settings) never touches `social_blocks`. Natively ignored users can still send friend requests that show in 新朋友, and they don't appear in 已拉黑. At minimum, compare the two lists when Contacts loads.
- **c. Friend-request harassment loop:** Incoming pending cards only offer 接受/拒绝 (`af-module.js:45`). After a rejection, the requester can immediately re-request, because `social-store.ts:47` resets `rejected` back to `pending`.
  - **Fix:** Add 拉黑 to incoming cards (the server already supports this at `social-store.ts:67`), and/or refuse a re-request from the same `requested_by` for a while after `rejected`.

**9. Missing anti-framing headers on the Element app.**
- **Where:** `nginx.conf.template`.
- **Effect:** `/` redirects internally to `/index.html` (`:23`), and that location's own `add_header` stops any higher-level headers from being inherited. So the app HTML is served with no `X-Frame-Options` or `frame-ancestors`. This origin now holds the AF session cookie and the friend, block and Agent actions, so clickjacking applies.
- **Fix:** Add `add_header Content-Security-Policy "frame-ancestors 'self'" always; add_header X-Frame-Options SAMEORIGIN always; add_header X-Content-Type-Options nosniff always;` to every location that has its own `add_header`.

**10. Possible shared IP and rate limit across all users (a deployment check for the live cloud run).**
- **Where:** nginx forwards to AF over public HTTPS (`:10-17`). Unless `TRUST_PROXY` (`app.ts:204`) trusts the Element hop or hops, every Element user gets the same `req.ip`.
- **Effect:**
  - Everyone shares the global limit of 240 requests per minute (`app.ts:226`) and the sign-in limiter.
  - Each open Contacts or Agents panel polls 2 requests every 15 s (`af-module.js:21,36,51`), so roughly 30 users with a panel open would hit the limit.
  - Check what `req.ip` actually is in the cloud run.

## Low

- **11. Messages sent while busy are silently dropped.** At `chat-agents.ts:87`, a message sent while a reply is in progress is never claimed, never answered and gets no notice. Send a short "上一条仍在处理，本条未执行" notice instead.
- **12. A failed start leaves the Agent active but not running.** At `chat-agents.ts:51-52`, the status and generation are committed before `startAgent`. If start throws, the PATCH returns an error, but the database already says `active` with nothing running.

Things I checked that look fine:
- The `x-af-matrix-id` vs. session cross-check catches Element/AF account mismatches.
- `social-store` block and friend transactions hold together on the server; the gaps above are in the UI and the Element side.
- `X-AF-Client-IP` is stripped at nginx and set again from `req.ip`.