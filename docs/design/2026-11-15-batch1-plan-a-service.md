# Batch 1 / Plan A — AF Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A single backend service that provides accounts, friends, blocks, direct and group conversations, messages, realtime sync, attachments and in-conversation search for humans, with every rule enforced server-side and proven by API-level tests.

**Architecture:** One Fastify process and one Postgres database are the only authority. Every write runs its permission check and its mutation in the same transaction. Browsers use HTTP for requests and one WebSocket for pushes; attachment bytes live in a private blob store behind an authorizing download route.

**Tech Stack:** Node ≥ 24, TypeScript (strict, ESM), Fastify 5, zod + `fastify-type-provider-zod`, Better Auth, `pg`, `node-pg-migrate`, `@fastify/websocket`, `@fastify/rate-limit`, `@fastify/multipart`, `file-type`, `@aws-sdk/client-s3`, vitest.

**Spec:** `docs/design/2026-11-15-batch1-real-social-design.md` (Chinese; read it first). Evidence and known failure modes: `spikes/base-gate/README.md`, section “第二轮”.

**What this plan does not cover:** the web client, browser tests, deployment, the independent adversarial review and the acceptance record. Those are Plan B, written after this plan lands so it can cite the real API. Spec acceptance items 3, 4, 5, 18, 19, 20 belong to Plan B.

## Global Constraints

- All new code lives under `app/service/`. Do not modify `prototype-v2/`, the old app at the repo root (`server/`, `src/`, `shared/`, `deploy/`), or `spikes/`.
- Commit locally on the current branch after each task. Never push, never deploy, never touch the live Railway project.
- Dependencies must be MIT, Apache-2.0, BSD or ISC. No AGPL/GPL. Record each new dependency’s licence in the commit message that adds it.
- Do not hand-write what a framework provides: HTTP parsing, sessions, password hashing, input validation, WebSocket framing, multipart parsing.
- Every route declares a zod schema for params, query and body. A request that fails validation returns 400 before any handler code runs. No handler may return 5xx for malformed input.
- Every write: the permission check and the mutation are in one transaction, and the conversation row is locked (`select … for update`) before a sequence number is assigned.
- The acting principal comes only from the session. Bodies never carry a sender, actor or owner id.
- A conversation the caller cannot access and a conversation that does not exist return the identical response: `404 {"error":"not_found"}`.
- Error bodies are `{"error":"<snake_case_code>"}`. Codes used by more than one task: `not_found`, `forbidden`, `invalid_request`, `unauthenticated`, `rate_limited`, `cannot_send`, `too_large`.
- Password length 10–128, session lifetime 7 days (from the old `server/auth.ts`). Friend requests expire after 24 hours. Group size limit 500. Attachment size limit 50 MB.
- Tests run against a real Postgres (the one installed in WSL, Task 1). No in-memory database substitutes.
- The user is not an engineer. Do not ask them technical questions. If a product-visible behaviour is undecided, stop and report it.

## Review Focus

Failure modes the spec implies that are most likely to bite a real user; each is pinned by a test in the named task.

1. Two actions racing (send vs. unfriend/block/remove) — nothing accepted after the change takes effect, and accepted count equals stored count. → Task 10.
2. A member who was removed keeps an open WebSocket — they must receive nothing further from that conversation. → Task 7.
3. A quoted message that the reader cannot see — the quote must render as hidden, never leak text. → Task 6.
4. An upload in flight when the uploader loses the right to send — the upload must be refused at completion. → Task 8.
5. Reusing one retry identifier in a second conversation — must create a new message there, not silently return the first. → Task 6.

---

## File Structure

```
app/service/
  package.json  tsconfig.json  vitest.config.ts  .env.example
  migrations/                  numbered node-pg-migrate SQL migrations
  src/
    config.ts                  env parsing (zod), no secrets in code
    db.ts                      pg Pool, tx(), typed query helper
    app.ts                     buildApp(deps): FastifyInstance — wires plugins and routes
    server.ts                  process entry: buildApp + listen
    errors.ts                  AppError, error handler → {error} bodies
    session.ts                 requirePrincipal preHandler
    auth/        auth.ts (Better Auth instance) · register.ts · invites.ts · mailer.ts
    principals/  routes.ts · store.ts · avatar.ts
    social/      routes.ts · friends.ts · blocks.ts
    conversations/ routes.ts · store.ts (create, membership, visibility SQL)
    messages/    routes.ts · send.ts · read.ts · search.ts
    sync/        routes.ts · hub.ts (in-process pub/sub) · ws.ts · tickets.ts
    attachments/ routes.ts · store.ts · blob.ts (BlobStore: fs + s3) · sniff.ts
    cli.ts                     `invite:create`, `inbox:list`, `migrate`
  tests/
    helpers/     harness.ts (app + db reset) · actors.ts (signUp, befriend, group) · ws.ts
    *.test.ts    one file per task area; fuzz.test.ts; concurrency.test.ts
```

Shared types used across tasks (define in the file named, do not redefine):

```ts
// src/db.ts
export type Tx = { query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> };
export function tx<T>(fn: (t: Tx) => Promise<T>): Promise<T>;       // BEGIN … COMMIT, rollback on throw
export const db: Tx;                                                // autocommit

// src/errors.ts
export class AppError extends Error { constructor(public status: number, public code: string) }
export const notFound = () => new AppError(404, "not_found");

// src/session.ts
export type Principal = { id: string; kind: "human" | "agent"; handle: string; displayName: string };
export function requirePrincipal(req: FastifyRequest): Promise<Principal>;   // 401 unauthenticated

// tests/helpers/actors.ts
export type Actor = { id: string; handle: string; email: string; password: string; cookie: string };
export function signUp(app, name: string): Promise<Actor>;          // invite → register → verify → sign in
export function befriend(app, a: Actor, b: Actor): Promise<{ conversationId: string }>;
export function group(app, creator: Actor, title: string, members: Actor[]): Promise<string>;
export function api(app, actor: Actor | null, method: string, url: string, body?: unknown): Promise<{ status: number; json: any }>;
```

---

### Task 1: Local Postgres and service skeleton

**Files:**
- Create: `app/service/package.json`, `tsconfig.json`, `vitest.config.ts`, `.env.example`, `src/config.ts`, `src/db.ts`, `src/errors.ts`, `src/app.ts`, `src/server.ts`, `src/cli.ts`, `migrations/001_init.sql`, `tests/helpers/harness.ts`, `tests/health.test.ts`, `app/service/README.md`

**Interfaces:**
- Produces: `buildApp(deps?: Partial<Deps>): Promise<FastifyInstance>`; `db`, `tx`; `AppError`; harness `useApp(): { app }` which builds the app once per file, and before each test truncates every table except the migrations table; `npm test`, `npm run migrate`.

- [ ] **Step 1: Tell the user, then install Postgres in WSL.** State in chat that you are about to run `sudo apt-get install -y postgresql` inside the user’s WSL Ubuntu and create a role and two databases; proceed (this was approved in spec §9.6). Create role `af` with a generated password and databases `af_dev`, `af_test`; enable `citext` and `pgcrypto` in both. Write the connection strings to `app/service/.env` (git-ignored) and document the commands in `app/service/README.md`. If `sudo` needs a password you do not have, stop and ask the user to run the one printed command.
- [ ] **Step 2: Write `tests/health.test.ts`**

```ts
test("health reports database reachable", async () => {
  const r = await app.inject({ method: "GET", url: "/api/health" });
  expect(r.statusCode).toBe(200);
  expect(r.json()).toEqual({ ok: true });
});
test("unknown route is 404 with an error body, malformed URL does not crash", async () => {
  expect((await app.inject({ method: "GET", url: "/api/nope" })).json()).toEqual({ error: "not_found" });
  const r = await app.inject({ method: "GET", url: "//" });
  expect(r.statusCode).toBeLessThan(500);
  expect((await app.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(200);
});
```

- [ ] **Step 3: Run it, expect failure** — `npm test -- health` → fails, no app.
- [ ] **Step 4: Implement.** `config.ts` parses `DATABASE_URL`, `APP_ORIGIN`, `AUTH_SECRET`, `BLOB_DIR`, `S3_*` (optional), `REGISTRATION_MODE` (`invite` | `open`, default `invite`), `MAIL_MODE` (`outbox` only in this plan). `app.ts` registers the zod type provider, the error handler from `errors.ts` (zod failure → 400 `invalid_request`; `AppError` → its status/code; anything else → 500 `internal` and logged), and `GET /api/health` (runs `select 1`). `migrations/001_init.sql` only enables the extensions. `cli.ts migrate` runs node-pg-migrate up.
- [ ] **Step 5: Run tests, expect pass.**
- [ ] **Step 6: Commit** — `feat(service): skeleton, config, db, health`.

### Task 2: Schema and database-level guarantees

**Files:**
- Create: `migrations/002_core.sql`, `tests/schema.test.ts`

**Interfaces:**
- Produces these tables (names and columns are relied on by every later task):

```
principals(id uuid pk default gen_random_uuid(), kind text check in ('human','agent'),
  handle citext unique not null check (handle ~ '^[a-z0-9_]{3,24}$'), display_name text not null,
  owner_id uuid references principals, auth_user_id text unique, avatar_key text, created_at timestamptz,
  check ((kind='agent') = (owner_id is not null)), check (kind='agent' or auth_user_id is not null))
invites(code_hash text pk, expires_at timestamptz, used_by uuid references principals, used_at timestamptz)
mail_outbox(id bigserial pk, recipient text, kind text, subject text, body text, created_at timestamptz)
friend_requests(id uuid pk, from_id uuid, to_id uuid, status text check in
  ('pending','accepted','rejected','withdrawn','expired'), created_at, expires_at, resolved_at)
  + unique index on (least(from_id,to_id), greatest(from_id,to_id)) where status='pending'
friendships(a_id uuid, b_id uuid, since timestamptz, primary key (a_id,b_id), check (a_id < b_id))
blocks(blocker_id uuid, blocked_id uuid, created_at, primary key (blocker_id, blocked_id))
conversations(id uuid pk, type text check in ('direct','group'), title text, creator_id uuid,
  seq bigint not null default 0, closed_at timestamptz, created_at)
direct_pairs(conversation_id uuid pk references conversations, a_id uuid, b_id uuid, unique (a_id,b_id), check (a_id < b_id))
memberships(id uuid pk, conversation_id uuid, principal_id uuid, role text check in ('speaker','observer'),
  joined_seq bigint not null, left_seq bigint, read_seq bigint not null default 0, joined_at timestamptz)
  + unique index on (conversation_id, principal_id) where left_seq is null
messages(id bigserial pk, conversation_id uuid, seq bigint, sender_id uuid, kind text check in ('text','file','system'),
  body jsonb not null, client_txn text, created_at, unique (conversation_id, seq),
  unique (conversation_id, sender_id, client_txn))
attachments(id uuid pk, conversation_id uuid, uploader_id uuid, blob_key text, name text, size bigint,
  mime text, inline boolean, message_id bigint references messages, created_at)
```

- [ ] **Step 1: Write `tests/schema.test.ts`** asserting, by direct SQL, that each of these is rejected by the database itself: an agent with no owner; a human with an owner; a second current membership for the same (conversation, principal); a second pending request for the same pair in either direction; a duplicate `(conversation_id, seq)`; a handle with an uppercase letter or a space.
- [ ] **Step 2: Run, expect failure. Step 3: Write the migration. Step 4: Run, expect pass.**
- [ ] **Step 5: Commit** — `feat(service): core schema with database-level constraints`.

### Task 3: Accounts — register, verify, sign in, reset, sign out

**Files:**
- Create: `src/auth/auth.ts`, `src/auth/register.ts`, `src/auth/invites.ts`, `src/auth/mailer.ts`, `src/session.ts`, `tests/helpers/actors.ts`, `tests/auth.test.ts`
- Modify: `src/app.ts`, `src/cli.ts`, `migrations/003_auth.sql` (Better Auth tables via its generator)

**Interfaces:**
- Consumes: `db`, `tx`, `AppError`.
- Produces:
  - `POST /api/register {inviteCode?, email, password, displayName, handle}` → 201 `{ok:true}`; creates the Better Auth user and the `principals` row in one transaction; 400 `invalid_invite`, 409 `handle_taken`. A taken e-mail returns the same 201 as success.
  - Better Auth mounted at `/api/auth/*` (sign-in, sign-out, verify-email, request-password-reset, reset-password) with `requireEmailVerification: true`, password 10–128, session 7 days.
  - `requirePrincipal(req)`; `GET /api/me` → `{id, handle, displayName, email}`.
  - `createInvite(opts:{ttlHours:number}): Promise<string>` and CLI `invite:create`, `inbox:list [--to <email>]`.
  - `sendMail(kind, recipient, subject, body)` writing to `mail_outbox`.
  - `signUp`, `api` test helpers (signUp reads the verification link from `mail_outbox`).
  - `onSessionEnded(fn: (principalId: string, sessionId: string) => void)` — fired on sign-out and on password reset; Task 7 subscribes.

- [ ] **Step 1: Write `tests/auth.test.ts`**, one test per line:
  - register → verification mail appears in `mail_outbox`; sign-in before verifying is refused; after following the link sign-in succeeds and `GET /api/me` returns the handle.
  - register without an invite code, with an unknown code, with an expired code, and with a used code → 400 `invalid_invite`; with `REGISTRATION_MODE=open` no code is needed.
  - handle already taken → 409 `handle_taken`; password of 9 chars → 400.
  - reset: request for a registered and for an unregistered address return identical status and body, and only the registered one produces an outbox row; the link works once; a second use is refused; after reset the old session cookie gets 401 on `/api/me`.
  - sign-out → the same cookie gets 401.
  - 11th sign-in attempt within a minute from one address → 429 `rate_limited`; a different account is unaffected.
  - sign-in with a wrong password takes about as long for an existing as for a non-existing e-mail (ratio of medians over 15 tries each < 3).
- [ ] **Step 2: Run, expect failure.**
- [ ] **Step 3: Implement.** Invite codes are random 20-char strings, stored as SHA-256. For the timing requirement, when the e-mail is unknown still run one password hash against a fixed dummy hash before answering. Rate limits via `@fastify/rate-limit` on `/api/register`, `/api/auth/sign-in/*`, `/api/auth/request-password-reset`: 10 per minute per IP+route.
- [ ] **Step 4: Run, expect pass. Step 5: Commit** — `feat(service): accounts with invites, verification, reset`.

### Task 4: Profile, lookup, avatars

**Files:**
- Create: `src/principals/routes.ts`, `store.ts`, `avatar.ts`, `src/attachments/blob.ts`, `src/attachments/sniff.ts`, `tests/principals.test.ts`

**Interfaces:**
- Produces:
  - `PATCH /api/me {displayName}`; `PUT /api/me/avatar` (raw image body ≤ 2 MB, PNG/JPEG/WebP by content sniffing) ; `GET /api/principals/:id/avatar` (any signed-in user; generated initial-letter SVG when none).
  - `GET /api/principals/lookup?handle=` → `{id, handle, displayName}` or 404. Exact match only.
  - `BlobStore = { put(key, stream|Buffer): Promise<{size:number}>; get(key): Promise<Readable>; delete(key): Promise<void> }`, `fsBlobStore(dir)`, `s3BlobStore(cfg)`, chosen by config.
  - `sniff(head: Buffer): { mime: string; inline: boolean }` — `inline` true only for PNG, JPEG, WebP, GIF; anything unrecognised is `application/octet-stream`, not inline.

- [ ] **Step 1: Tests:** lookup by exact handle works, a prefix does not; no endpoint lists users; another user cannot change my display name (there is no route taking a target id); avatar upload of an HTML file named `.png` is refused; unauthenticated avatar fetch → 401.
- [ ] **Steps 2–5:** fail → implement → pass → commit `feat(service): profile, exact-handle lookup, avatars`.

### Task 5: Friends and blocks

**Files:**
- Create: `src/social/routes.ts`, `friends.ts`, `blocks.ts`, `tests/social.test.ts`
- Modify: `tests/helpers/actors.ts` (add `befriend`)

**Interfaces:**
- Consumes: `ensureDirect(t: Tx, a: string, b: string): Promise<string>` from Task 6 — to keep tasks independent, this task defines it in `src/conversations/store.ts` as part of its own work and Task 6 extends that file.
- Produces:
  - `POST /api/friend-requests {handle}` → 201 `{id}`; 409 `already_friends`, `request_pending`; 403 `blocked` when either side blocks the other (same code both ways — the caller learns a block exists, per spec §6.3).
  - `POST /api/friend-requests/:id/accept | reject | withdraw`.
  - `DELETE /api/friends/:principalId`; `PUT /api/blocks/:principalId`; `DELETE /api/blocks/:principalId`.
  - `GET /api/social` → `{friends:[{id,handle,displayName}], incoming:[…], outgoing:[…], blocked:[…]}` — the caller’s own only.
  - `areFriends(t, a, b): Promise<boolean>`, `blockBetween(t, a, b): Promise<null | {blocker: string}>`, `canDirectSend(t, a, b): Promise<null | "not_friends" | "blocked">`.
  - `onSocialChanged(fn: (principalIds: string[]) => void)` for Task 7.

- [ ] **Step 1: Tests:**
  - request → accept makes both appear in each other’s `friends` and returns a direct conversation id (the same id on a second accept path, e.g. unfriend then re-befriend).
  - reject, withdraw (only by sender), accept (only by recipient) — wrong actor gets 404.
  - a request older than 24 h (set `expires_at` in the past via SQL) cannot be accepted and reads as `expired`.
  - duplicate request in either direction → 409 and one row.
  - blocked party cannot send a request; blocker cannot either until unblocking.
  - user C cannot read or act on a request between A and B (404), and `GET /api/social` never contains other people’s rows.
- [ ] **Steps 2–5:** fail → implement (every mutation in `tx`, lock the pair by taking `pg_advisory_xact_lock(hashtext(least||greatest))`) → pass → commit `feat(service): friend requests, friendships, blocks`.

### Task 6: Conversations, membership, messages

**Files:**
- Create/extend: `src/conversations/routes.ts`, `store.ts`, `src/messages/routes.ts`, `send.ts`, `read.ts`, `tests/conversations.test.ts`, `tests/messages.test.ts`
- Modify: `tests/helpers/actors.ts` (add `group`)

**Interfaces:**
- Produces (store functions take a `Tx`):

```ts
currentMembership(t, conversationId, principalId): Promise<Membership | null>
addMember(t, conversationId, principalId, role: "speaker" | "observer"): Promise<SystemMsg[]>   // joined_seq = conversations.seq at lock time
removeMember(t, conversationId, principalId, reason: "left" | "removed"): Promise<SystemMsg[]>
appendSystem(t, conversationId, text: string, meta?: object): Promise<StoredMessage>
sendMessage(t, conversationId, sender: Principal, input: SendInput): Promise<{ message: StoredMessage; duplicate: boolean }>
// the SQL fragment every read uses — a message is visible iff the reader has a CURRENT membership with joined_seq < seq
VISIBLE_JOIN: string
toWire(msg: StoredMessage, readerVisibleFromSeq: number): WireMessage   // hides quoted text the reader cannot see
onMessages(fn: (msgs: StoredMessage[]) => void); onMembershipChanged(fn: (conversationId: string, principalIds: string[]) => void)
```

  - Routes: `POST /api/conversations {title, memberIds[≥2]}`; `PATCH /api/conversations/:id {title}` (creator only); `POST /api/conversations/:id/members {principalId}`; `DELETE /api/conversations/:id/members/:principalId` (self = leave; other = creator only); `GET /api/conversations/:id/members`; `POST /api/conversations/:id/messages {text?, attachmentId?, replyToSeq?, clientTxn}`; `GET /api/conversations/:id/messages?before=&limit=` (limit 1–100, default 50); `GET /api/conversations/:id/messages/:seq`; `POST /api/conversations/:id/read {seq}`.
  - `WireMessage = { conversationId, seq, senderId|null, kind, text, attachment?: {id,name,size,inline}, replyTo?: {seq, visible:boolean, senderId?, text?}, createdAt }`.

- Rules to implement exactly:
  - Group create/add: the actor must be a current member (for add), the target must be the actor’s friend, there must be no block in either direction between actor and target, and the result must not exceed 500 current members. Otherwise 403 `forbidden`.
  - Leave by creator: `creator_id` moves to the current member with the lowest `joined_seq`; when the last member leaves set `closed_at`.
  - Direct conversations: both parties are always members; there is no leave or remove route effect on `type='direct'` (404).
  - Send in direct: `canDirectSend` must be null, else 403 `cannot_send` with `{"error":"cannot_send","reason":"not_friends"|"blocked"}`.
  - When a friendship ends, a block is added, or either is undone, append a system notice to the pair's direct conversation (text per spec §6.3, e.g. “某某拉黑了某某，只能由对方解除”) and emit a `conversation` change so clients refresh `canSend`. System notices are always allowed.
  - `replyToSeq` must be visible to the sender, else 400 `invalid_request`. Store only the seq.
  - Idempotency: unique on `(conversation_id, sender_id, client_txn)`; a repeat returns the stored message with `duplicate:true` and 200.
  - Visibility: only the current membership counts. After leaving or removal nothing is readable; after re-adding only `seq > new joined_seq`.

- [ ] **Step 1: Write the tests** (names are the assertions):
  - `direct chat exists after befriending and both can send and read`
  - `non-friend cannot be added to a group; blocked pair cannot add each other; 501st member is refused`
  - `any member can add their own friend; only the creator can remove or rename; creator leaving hands over to the earliest member; last leaver closes it`
  - `late joiner sees nothing before joining via list, before=, single-message and reply-to; sees messages after`
  - `removed member gets 404 on every read and write; re-added member sees only messages after re-joining — not the first stay, not the gap`
  - `outsider gets the same 404 body for a real and a random conversation id on every route`
  - `sender fields in the body are ignored; message is attributed to the session principal`
  - `unfriend stops direct sends with reason not_friends; block stops both directions with reason blocked; unblock/re-friend restores; history stays readable throughout`
  - `block between two members of a group does not stop either from sending there`
  - `same clientTxn twice in one conversation stores one message; the same clientTxn in a second conversation stores a new message there` (Review Focus 5)
  - `a message quoting a pre-join message reaches the late joiner with replyTo.visible=false and no text or senderId` (Review Focus 3)
  - `read marker cannot exceed conversations.seq, cannot move backwards, cannot be set by a non-member`
- [ ] **Steps 2–5:** fail → implement → pass → commit `feat(service): conversations, membership intervals, messages`.

### Task 7: Sync and realtime

**Files:**
- Create: `src/sync/routes.ts`, `hub.ts`, `ws.ts`, `tickets.ts`, `tests/helpers/ws.ts`, `tests/sync.test.ts`

**Interfaces:**
- Consumes: `onMessages`, `onMembershipChanged`, `onSocialChanged`, `onSessionEnded`, `VISIBLE_JOIN`, `toWire`.
- Produces:
  - `GET /api/sync` → `{ me, conversations:[{id,type,title,creatorId,canSend:{ok:boolean,reason?}, members:[{id,role}], lastSeq, readSeq, unread, peerReadSeq?}], principals:[{id,handle,displayName,kind}], messages: WireMessage[] }` — last 30 visible messages per conversation. `lastSeq` is the conversation’s seq (accepted leak per spec §6.6); no site-wide counters or cursors anywhere in the response.
  - `POST /api/sync/catchup {positions: Record<conversationId, seq>}` → `{messages: WireMessage[], gone: string[], more: boolean}` — visible messages with `seq > position`, capped at 500 total; `gone` lists ids the caller is no longer in.
  - `POST /api/ws-ticket` → `{ticket}` (random, single use, 30 s, bound to the session id); `GET /api/ws?ticket=`.
  - Push events: `{type:"message", message: WireMessage}`, `{type:"conversation", id}` (membership/title/canSend changed — client refetches), `{type:"gone", id}`, `{type:"social"}`, `{type:"read", conversationId, principalId, seq}` (direct chats only).
  - Tickets and the hub are in-process; record in `app/service/README.md` that the service must run as a single instance until this is moved to Postgres LISTEN/NOTIFY.

- [ ] **Step 1: Tests** (use a real listening port):
  - `initial sync contains only my conversations and never a pre-join message`
  - `a new message is pushed to every current member's socket and to nobody else`
  - `a socket that was open when its owner was removed receives a gone event and then nothing more from that conversation` (Review Focus 2)
  - `a socket opened before joining receives no pre-join pushes; after joining it does`
  - `catchup returns exactly the missed messages in order, lists conversations I left, and never returns invisible ones even when I send positions for conversations I am not in`
  - `ticket is single-use and expires; a ticket from another session is useless; the long-lived session cookie alone cannot open the socket`
  - `sign-out and password reset close that session's sockets`
  - `an unmasked or oversized frame closes the socket and the server keeps serving` (spike defect 2)
  - `peer read position is pushed in a direct chat and not exposed in groups`
- [ ] **Steps 2–5:** fail → implement → pass → commit `feat(service): sync, catch-up and websocket pushes`.

### Task 8: Attachments

**Files:**
- Create: `src/attachments/routes.ts`, `store.ts`, `tests/attachments.test.ts`
- Modify: `src/messages/send.ts` (link attachment on send), `src/cli.ts` (`attachments:sweep`)

**Interfaces:**
- Produces:
  - `POST /api/conversations/:id/attachments` (multipart, one file) → 201 `{id, name, size, inline}`.
  - `GET /api/attachments/:id` → bytes, with `Content-Type` from `sniff` (never from the uploader), `Content-Disposition: inline` only when `inline`, otherwise `attachment`; always `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox`.
  - `sweepOrphans(olderThanMinutes: number): Promise<number>`.
- Rules:
  - Upload: stream to the blob store, then in one transaction re-check “current member and may send” and insert the row; if the check fails, delete the blob and return the same error a send would. (Review Focus 4)
  - Per-principal limits: 50 MB per file, 60 uploads per hour, 2 GB total stored; exceeding → 413 `too_large` or 429 `rate_limited`.
  - Download is allowed iff a message in that conversation carries the attachment and that message satisfies `VISIBLE_JOIN` for the caller. Otherwise 404.
  - Sending a `file` message requires `attachment.uploader_id = sender`, same conversation, and `message_id is null`; it sets `message_id`.

- [ ] **Step 1: Tests:**
  - `member uploads, sends, another member downloads identical bytes`
  - `outsider, late joiner (for a pre-join attachment), removed member and signed-out caller all get 404/401; the late joiner can fetch a post-join attachment`
  - `uploaded but never sent → nobody can fetch it, including the uploader; sweep deletes row and blob`
  - `attachment id from another conversation or another uploader cannot be sent`
  - `an HTML file is served as application/octet-stream with attachment disposition; a PNG is inline`
  - `upload that completes after the uploader was unfriended (direct) or removed (group) is refused and leaves no blob` — drive this by pausing the multipart stream in the test, changing state, then finishing
  - `51 MB is refused without buffering it in memory`
- [ ] **Steps 2–5:** fail → implement → pass → commit `feat(service): attachments with message-scoped access`.

### Task 9: In-conversation search

**Files:**
- Create: `src/messages/search.ts`, `tests/search.test.ts`; Modify: `src/messages/routes.ts`, `migrations/004_search.sql` (`pg_trgm` index on `(body->>'text')`)

**Interfaces:**
- Produces: `GET /api/conversations/:id/search?q=&before=&limit=` → `{messages: WireMessage[], nextBefore: number | null}`; `q` 1–100 chars, substring match, case-insensitive, `%`/`_`/`\` treated literally; limit 1–50.

- [ ] **Step 1: Tests:** `finds a Chinese fragment such as "镰仓站" inside a longer sentence`; `late joiner's search never returns pre-join messages even when the term only occurs there`; `outsider gets 404`; `q="%"` matches only messages containing a literal percent sign; `pagination with nextBefore walks back through all hits without repeats`.
- [ ] **Steps 2–5:** fail → implement → pass → commit `feat(service): in-conversation search`.

### Task 10: Robustness and concurrency suites

**Files:**
- Create: `tests/fuzz.test.ts`, `tests/concurrency.test.ts`, `tests/enumeration.test.ts`
- Modify: whatever the suites expose as broken.

**Interfaces:**
- Consumes: every route. Produces: no new API.

- [ ] **Step 1: `tests/fuzz.test.ts`.** Build a table of every route registered on the app (read it from `app.printRoutes` / the route registry so new routes are covered automatically). For each, send with a valid session: no body, `null`, `[]`, a string, numbers as strings, strings as numbers, arrays and objects in scalar fields, `-1`, `1.5`, `1e400`, `NaN`, 23-digit integers, a NUL character, a lone surrogate, a 1 MB string, and path ids that are not UUIDs, are URL-encoded slashes, or are `..`. Assert every response status is `< 500`, and that `GET /api/health` still returns 200 afterwards.
- [ ] **Step 2: `tests/concurrency.test.ts`** (real pool, ≥ 10 connections):
  - `40 concurrent sends racing an unfriend`: accepted count equals rows stored; a send issued after the unfriend response returned is refused. Repeat for block, and for group removal of the sender. (Review Focus 1)
  - `20 concurrent adds of the same person` → exactly one current membership and one system message.
  - `two members sending concurrently` → sequence numbers are gapless and unique.
  - `accept racing withdraw of the same request` → exactly one wins; never both a friendship and a withdrawn request.
- [ ] **Step 3: `tests/enumeration.test.ts`.** For every route with a conversation, attachment, request or principal id: the response for an id the caller may not access is byte-identical (status and body) to the response for a random id.
- [ ] **Step 4: Run all three; fix every failure in the owning module; re-run the whole suite.**
- [ ] **Step 5: Map the spike’s 10 defects.** Add a table to `app/service/README.md` listing each defect from `spikes/base-gate/README.md` and the test that now covers it, or “batch 3” for the two that need Agents or manual freeze.
- [ ] **Step 6: Commit** — `test(service): fuzz, concurrency and enumeration suites`.

---

## Done When

`npm test` in `app/service` passes with all suites; `npm run migrate` builds the schema from empty; the README explains how to start the service locally, create an invite and read the test inbox. Then write Plan B against the routes that actually exist.
