# Batch 1 / Plan B — Web Client and Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the approved `prototype-v2` interface into the real web client of the AF service built in Plan A, prove it end to end in browsers, deploy an acceptance environment, and survive an independent attack.

**Architecture:** `app/web/` is a copy of the prototype whose mock store is replaced by a real data layer speaking the service's HTTP + WebSocket contract. Page components and styles stay as they are; a view-model adapter feeds them. The service serves the built client from the same origin, so cookies, the Origin check and the WebSocket all work without CORS.

**Tech Stack:** React 19 + Vite (as in the prototype), vitest for the data layer, Playwright for browser tests, the service from Plan A (Fastify, Postgres), Railway for the acceptance environment.

**Spec:** `docs/design/2026-11-15-batch1-real-social-design.md` (read it first; §6.9 and §7 govern this plan). The service's client contract is `app/service/README.md` — it is the authority on routes, shapes, limits and the reconnect procedure. Visual baseline: `prototype-v2/` and its `AGENTS.md`.

## Global Constraints

- New client code lives under `app/web/`. Do not modify `prototype-v2/`, the old app at the repo root, or `spikes/`. `spikes/base-gate/ui-live/` may be read for ideas but not copied.
- Layout, palette, density and interaction details of the prototype do not change. Page components and `styles.css` are edited only where a real behaviour requires it; no restyling, no new design language. New screens are assembled from the prototype's existing components and classes.
- The real build contains no mock data, simulated replies, simulated attachments, "演示状态" drawer or demo reset.
- Not yet available (spec §6.9): the "Agent" nav item stays and shows an empty "尚未开放" state; contacts list only humans; nothing about Agents, tasks, discussions, expansion or recovery appears in chats.
- No third-party chat SDK. Dependencies MIT / Apache-2.0 / BSD / ISC only; record licences in the commit that adds them.
- The browser never holds another user's credentials and never stores the session token in JS-readable storage (the cookie is HttpOnly). No personal data in URLs.
- Every state-changing request is same-origin; in development the Vite dev server proxies `/api` (including the WebSocket) to the service so `APP_ORIGIN` equals the page origin.
- Client behaviour on the wire follows `app/service/README.md` exactly: open the socket first and buffer, then sync; apply `message` pushes by the seq rule; repair gaps with catch-up; reconnect procedure; `clientTxn` on every send and reuse it on retry.
- Local commits on the working branch after each task. Pushing the working branch and creating the Railway acceptance environment are authorised by the user for this run (ledger, 2026-11-16); never push to `master`, never force-push, do not touch the existing live Railway project unless a task requires it.
- Before the first push: generalise the OpenIM vulnerability specifics in `spikes/base-gate/README.md` and the design doc (public repository; upstream not yet informed).
- The user is not an engineer. Undecided product behaviour → choose the most conservative option, implement it, and list it for the user in the acceptance record. Never block on a question.
- Chinese UI copy follows the prototype's tone; reuse its existing strings where one exists.

## Review Focus

1. A push arriving while the initial sync is in flight — must not be lost or duplicated (buffer then apply by seq). → Task 2.
2. A send whose HTTP response is lost — retry with the same `clientTxn` shows one message, not two. → Task 2, Task 10.
3. The user is removed from a group while looking at it — the view closes cleanly, no stale content remains reachable, no error loop. → Task 4.
4. A file or image from a message the user can no longer see — the UI shows a neutral placeholder, not a broken layout or an endless spinner. → Task 5.
5. Session expiry mid-use (socket closes with 4001, or any request returns 401) — the app returns to the sign-in page once, without losing the draft text. → Task 3.

---

## File Structure

```
app/web/
  package.json  vite.config.mjs  index.html  public/        (from the prototype)
  src/
    main.jsx  App.jsx  styles.css  icons.js  ui/  pages/     (from the prototype, edited minimally)
    api/        http.js (fetch wrapper, error mapping) · routes.js (one function per endpoint) · socket.js
    data/       store.jsx (context, same useStore() contract) · model.js (pure state + reducers)
                sync.js (first load, push application, catch-up, reconnect) · actions.js (async actions)
                viewmodel.js (model → the shape the prototype's pages/selectors read)
    auth/       SignIn.jsx · Register.jsx · VerifyNotice.jsx · ForgotPassword.jsx · ResetPassword.jsx · router.js
    pages/      + NewGroup.jsx, GroupMembersAdd.jsx, SearchResults.jsx (new, built from existing primitives)
  tests/        model.test.js · sync.test.js · viewmodel.test.js
  e2e/          playwright specs + helpers (start service, mint invites, read test inbox)
app/service/    static file serving + SPA fallback (Task 9); Dockerfile and deploy descriptors in app/deploy/
```

View-model decision (binding): pages keep calling `useStore()` and reading the prototype's state shape for what batch 1 uses (`nav`, `convs`, `order`, `relations`, `blocks`, `toast`, plus `people`). The signed-in user appears in the view model under the alias id `"me"` so the prototype's many `ME` comparisons keep working; the module-level `PEOPLE` table is removed and `entity()` reads `state.people`. `agents` is an empty object. Conversation `type` gains `"group"` (humans only), rendered with the mixed-group layout minus Agent/owner annotations.

---

### Task 1: Scaffold `app/web` and strip the mock

- [ ] Copy `prototype-v2` (without `node_modules`, `dist`, the Sites worker, Claude/Codex run scripts and docs) to `app/web`. Keep `public/` assets.
- [ ] Remove `DemoDrawer`, simulated timers, `seed.js` content, `sim/*` actions and the demo reset; keep UI primitives and pages compiling against a temporary empty store.
- [ ] Vite config: dev server on `127.0.0.1:5273`, proxy `/api` → `http://127.0.0.1:8787` with `ws: true` and `changeOrigin: false`; document that the service must run with `APP_ORIGIN=http://127.0.0.1:5273` in development. Add vitest.
- [ ] `src/api/http.js`: `request(method, path, body?)` with `credentials: "same-origin"`, JSON in/out, throws `ApiError{status, code, reason}` from `{error, reason}` bodies, and a single global handler for 401 (see Task 3). `src/api/routes.js`: one named function per endpoint in the service README (auth, me, social, conversations, messages, read, sync, catch-up, ws-ticket, attachments, search).
- [ ] Test: `routes.js` builds the right method/path/body for every endpoint (table-driven, fetch stubbed); `ApiError` mapping.
- [ ] Commit `feat(web): scaffold from prototype, API client`.

### Task 2: Data layer — model, sync, reconnect

**Produces:** `model.js` (pure): `initial()`, `applySync(state, sync)`, `applyMessage(state, wire) → {state, gap?: {conversationId, from}}`, `applyCatchup`, `applyGone`, `markSending/markSent/markFailed` for optimistic sends keyed by `clientTxn`, `setRead`. `sync.js`: `start(transport)` implementing first load and the reconnect procedure with backoff (1 s → 30 s, jitter), buffering pushes while a sync or catch-up is in flight. `socket.js`: ticket → WebSocket, ping every 25 s, exposes `onEvent`, `onClose(code)`.

- [ ] Tests first (`tests/model.test.js`, `tests/sync.test.js`, with a fake transport — no network):
  - push with `seq ≤ position` ignored; `seq = position+1` appended; `seq > position+1` requests catch-up from position and does not append out of order.
  - pushes arriving during the initial sync are buffered and applied after it exactly once (Review Focus 1).
  - `gone` (possibly repeated) removes the conversation and its messages; a later `conversation` event for it triggers a re-sync.
  - a `message` for an unknown conversation triggers a re-sync.
  - optimistic send: appears immediately as sending; on success is replaced by the server message (matched by `clientTxn`, no duplicate when the push arrives before the HTTP response); on failure is marked failed and keeps its `clientTxn`; retry reuses it; a `duplicate:true` response resolves it (Review Focus 2).
  - reconnect: catch-up for all held positions, loops while `more`, drops `gone`, then sync refreshes metadata; unread and read markers reflect the server.
  - close code 4001 → `onSignedOut`, no reconnect; other codes → reconnect with backoff.
- [ ] Implement. Message lists are kept sorted and deduplicated by `seq`; system notices are regular messages with `kind: "system"`.
- [ ] `viewmodel.js` + test: maps model → prototype shape (alias `"me"`, `people`, `convs[id]` with `type` `human`/`group`, `members`, `messages` in the prototype's message shape incl. `status` sent/failed/sending, `kind` text/file/image/system, `replyTo`), `order` by last activity, `relations`/`blocks` from `/api/social`, and a `hold` describing "cannot send" with its real reason.
- [ ] Commit `feat(web): data layer with gap repair and reconnect`.

### Task 3: Accounts — sign in, register, verify, reset, sign out

- [ ] Minimal router (`auth/router.js`): `/signin`, `/register`, `/verify`, `/forgot`, `/reset-password?token=`, everything else = the app (requires a session; otherwise redirect to `/signin`).
- [ ] Screens built from prototype primitives and classes, centred card on the prototype's background: sign in; register (invite code, e-mail, password ≥ 10, display name, account name `^[a-z0-9_]{3,24}$`) → "check your mailbox" notice; verification landing (the mail's link hits the service, which redirects to `/verify` with a result) ; forgot password (always the same confirmation text); reset password (token from the URL, then sign in). Inline field errors, first invalid field focused (prototype rule), server error codes mapped to Chinese messages (`invalid_email_or_password`, `email_not_verified` — with the note that a new verification mail was sent, `invalid_invite`, `handle_taken`, `rate_limited`, `invalid_token`).
- [ ] Global 401 / close-code-4001 handling: stop the data layer, keep unsent drafts in memory for this tab, show `/signin` once (Review Focus 5). Sign out in Settings calls the service and returns to `/signin`.
- [ ] Remove the token from the address bar after reading it on `/reset-password`.
- [ ] Tests: unit tests for form validation and error mapping; Playwright specs are added in Task 10.
- [ ] Commit `feat(web): account screens`.

### Task 4: Chat — list, timeline, composer

- [ ] Wire `ChatList`, `ChatView`, `Messages`, `Composer`, `DetailsPanel` to the store: list with unread and last message, search box filtering conversations/contacts locally (global message search is Task 8), open conversation → mark read up to the newest visible seq (debounced, only when the tab is visible), timeline with system notices rendered in the prototype's system-line style from `system.event`, sender names from `people`.
- [ ] Composer: send text (Enter / Shift+Enter, IME guard, emoji and @ suggestions limited to current members — all as in the prototype); reply quote (`replyToSeq`); failed message shows the prototype's "发送失败，未发布 · 重试"; `cannot_send` shows the prototype's hold notice with the real reason ("对方已不是你的好友" / "某某拉黑了某某，只能由对方解除").
- [ ] Quotes: `replyTo.visible === false` renders "引用的消息不在你的可见范围内"; visible file quotes show the file name.
- [ ] History: scrolling to the top loads older messages (`before`), stops at the start of what the user may see, keeps scroll position.
- [ ] Direct chats show "已读" from `peerReadSeq`; groups do not show read state.
- [ ] Being removed while viewing: the conversation disappears from the list and the main pane shows the empty state with a toast "你已不在该会话中" (Review Focus 3).
- [ ] Remove every Agent/owner/task/discussion/expansion/recovery element from these pages' render paths for batch 1 conversation types.
- [ ] Controller check in a real browser against the local service with two accounts (see "Controller checks").
- [ ] Commit `feat(web): real chat list, timeline and composer`.

### Task 5: Attachments in chat

- [ ] Composer's image and file buttons open the file picker (also drag-and-drop and paste for images); upload with progress via `XMLHttpRequest` or streams, cancel button, then send the file message with the optional caption; client-side pre-check of 50 MB with the server as the authority; map `too_large` (incl. `reason: "quota"`), `rate_limited`, `cannot_send` to Chinese messages; at most 3 uploads in flight (queue the rest).
- [ ] Rendering: `inline` attachments render as images straight from `/api/attachments/:id` (same origin, cookie auth) with reserved aspect box; others as the prototype's file card with name, size and a download link. A 404 on fetch renders a neutral "文件不可用" card (Review Focus 4).
- [ ] Commit `feat(web): attachments`.

### Task 6: Contacts, friend requests, blocks

- [ ] `Contacts` page: list = my friends plus pending requests (incoming / outgoing); the page's search box filters this list locally; "添加" = exact account-name lookup → card → send request. Accept / reject / withdraw / unfriend / block / unblock with the prototype's confirmation dialogs. Show "对方拉黑了你" state from `blockedBy`. Request expiry shown from `expiresAt`. React to `social` pushes by refetching.
- [ ] No Agent rows, no "以谁的身份申请" selector (humans only in batch 1).
- [ ] Commit `feat(web): contacts and friend requests`.

### Task 7: Groups

- [ ] "新建" menu → "发起群聊": pick ≥ 2 friends (people who block or are blocked by me are not offered), group name 1–60 → create → open it.
- [ ] `GroupProfile`: member list with creator badge; "添加成员" (my friends not already in, not blocked either way); creator can remove a member and rename; anyone can leave (confirm dialog; creator sees who becomes creator). No expansion/visibility tabs.
- [ ] Map `forbidden`, `already_member`, the 500 limit and `rate_limited` to Chinese messages.
- [ ] Commit `feat(web): groups`.

### Task 8: Search

- [ ] In-conversation search (the magnifier in the chat header): debounced server search, results newest first with "继续向更早的记录搜索" paging via `nextBefore`, Esc/close as in the prototype, click a hit → jump to it.
- [ ] Global search in the list's search box: below the local conversation/contact matches, a "聊天记录" section fed by `/api/search` (debounced, min 1 character, paged with the opaque cursor); click → open the conversation and jump to the message.
- [ ] Jump-to-message: load the window around a seq (`before = seq + 25`, limit 50), highlight the hit briefly, allow loading newer and older from there; fall back gracefully if the message is no longer visible.
- [ ] Empty, loading, `rate_limited` and `busy` states.
- [ ] Commit `feat(web): in-conversation and global search`.

### Task 9: Settings, empty states, serving the build

- [ ] Settings: display name edit, avatar upload (PNG/JPEG/WebP ≤ 2 MB) with preview, account name and e-mail read-only, sign out. Remove demo-data controls. Devices/"拉黑" sub-pages: keep "拉黑" (list + unblock); remove device pages for batch 1.
- [ ] "Agent" nav: empty state "尚未开放" in the prototype's empty-state style.
- [ ] Avatars everywhere come from `/api/principals/:id/avatar`; the prototype's avatar atlas is no longer used for people.
- [ ] Service: serve `app/web/dist` (path from config) with long-cache for hashed assets and no-cache for `index.html`, SPA fallback for non-`/api` GETs, security headers (CSP allowing only self, `frame-ancestors 'none'`, `Referrer-Policy: same-origin`, `X-Content-Type-Options`), tests for fallback, headers and that `/api/*` unknown routes still return JSON 404.
- [ ] Basic code-splitting so the sign-in route does not load the chat bundle.
- [ ] Commit `feat: settings, empty states, service serves the web build`.

### Task 10: Browser end-to-end tests

- [ ] Playwright project in `app/web/e2e/` that starts the service on a test database (fresh per run), serves the built client from it, mints invites and reads the test inbox through the CLI/DB.
- [ ] Specs (two or three isolated browser contexts each):
  - spec §7.1: register ×2 with invite → verify from inbox → sign in → one does forgot/reset → befriend → direct chat both ways → reload keeps history → a fresh context signs in and sees the same history.
  - spec §7.2: three users, group, messages, image and file sent and opened by others (bytes equal).
  - spec §7.5: go offline, peer sends 5 messages, own send fails; back online → the 5 arrive once, retry yields exactly one message.
  - spec §7.19: restart the service process mid-session → the client reconnects and continues; nothing lost.
  - late joiner sees nothing earlier, including a quote of an earlier message; removed member's open page drops the conversation.
  - unfriend / block: the other side's composer becomes disabled with the right notice without a reload.
  - global search finds a Chinese fragment and jumps to it.
  - sign-out in one tab ends the other tab's session (socket 4001) and lands on sign-in once.
- [ ] Commit `test(web): browser end-to-end suite`.

### Task 11: Visual parity pass

- [ ] Controller (not a subagent): open the prototype and the real client side by side at 1440×900 and 390×844; compare chat home, direct chat, group chat, contacts, group profile, settings; fix any drift in layout, palette, density; confirm new screens use only existing components. Save paired screenshots under `docs/acceptance/batch1/`.

### Task 12: Acceptance environment on Railway

- [ ] `app/deploy/Dockerfile` (multi-stage: build web, install service prod deps, run migrations on start, single process), `.dockerignore`, healthcheck `/api/health`.
- [ ] Exercise the S3 blob store against a real bucket before relying on it (upload, download, delete, aborted upload) — a Railway bucket; add the lifecycle rule for incomplete multipart uploads if the provider supports it, otherwise document.
- [ ] New Railway project (name `agent-family-acceptance`), separate from the live one: Postgres (extensions `citext`, `pgcrypto`, `pg_trgm`), a bucket, the service with exactly one replica, generated `AUTH_SECRET`, `APP_ORIGIN` = the service's HTTPS domain, `TRUST_PROXY=true`, `REGISTRATION_MODE=invite`, `MAIL_MODE=outbox`; a scheduled `attachments:sweep`.
- [ ] Smoke test against the deployed URL with the Playwright §7.1 spec (pointed at the remote base URL; invites and inbox via `railway run` CLI commands).
- [ ] Rebuild rehearsal (spec §7.19): document the exact steps in `app/deploy/README.md` and follow them once from zero. Backup/restore rehearsal (spec §7.20): dump the database and copy the bucket, restore into a second database + bucket, point a temporary instance at them, run the §7.1/§7.2 read checks; then remove the temporary copies.
- [ ] Create test accounts for the user (three verified users, already friends, one group with a little history); store their credentials only in a git-ignored local file and print its path for the user.

### Task 13: Independent adversarial review

- [ ] Dispatch a reviewer that took no part in the implementation, on the most capable model, with the code, the local running service + client and the acceptance URL. Brief: break spec §7 items 6–17 and anything else (authorisation, visibility after leave/re-add, attachments, search, realtime, CSRF/origin, XSS through names/messages/file names in the web client, stored content rendered as HTML, open redirects in the auth flow, rate limits, crashes). Only confirmed, reproduced findings count.
- [ ] Fix every Critical/Important finding in the owning module with a regression test; redeploy; repeat with a fresh reviewer until a round finds nothing exploitable (cap: 3 rounds, then record what remains).

### Task 14: Acceptance record, publish, hand-over

- [ ] `docs/acceptance/batch1/README.md` (Chinese): for each of spec §7 items 1–20 — what proves it (test file or manual check), whether it runs locally and/or against the acceptance environment, and remaining limits; the adversarial rounds and what was fixed; open product decisions taken conservatively; known gaps (single instance, no mobile, etc.).
- [ ] Generalise the OpenIM specifics in `spikes/base-gate/README.md` and the design doc; push the working branch (no force, not `master`).
- [ ] Update the Notion decision log (plain Chinese): what is real now, the acceptance URL, where the test accounts are, what the user should try first, what needs their decision.

## Controller checks (between tasks)

After Tasks 3–9 the controller runs the service and the client locally and exercises the task's flows in the real browser pane with two signed-in accounts (two tabs with separate storage where needed), checks the console for errors, and compares against the prototype for visual drift. A task is not complete until this passes; findings go back to the implementer as review findings.

## Done When

Every item of spec §7 has a line in the acceptance record with evidence; the acceptance environment is up with test accounts; the adversarial rounds ended with nothing exploitable (or the remainder is recorded); the branch is pushed; the Notion log is updated.
