# Agent Family service

Fastify 5 + Postgres backend. TypeScript (strict, ESM), zod validation via `fastify-type-provider-zod`, `pg`,
`node-pg-migrate`, Better Auth (accounts), vitest.

This README is the contract for clients: **HTTP API** lists every route the service serves (a test,
`tests/readme.test.ts`, fails when a route exists without its heading here or the other way round), **Wire
shapes** the objects they share, and **Sync and realtime** how a client stays current.

## Local Postgres (already provisioned on the dev machine)

Postgres 16 runs inside WSL Ubuntu at `127.0.0.1:5432`.

- Role: `agent_family` (login, no superuser)
- Databases: `af_dev` (development), `af_test` (test suite)
- Extensions enabled in both databases: `citext`, `pgcrypto`, `pg_trgm`

Creating an extension needs a superuser, so it was done once as `postgres`
(`create extension if not exists citext;` etc., in each database).
`migrations/001_init.sql` repeats `create extension if not exists ...`, which is a
no-op for the non-superuser role because the extensions already exist.

Connection strings live in `app/service/.env` (git-ignored). Copy `.env.example`
to `.env` and fill in the password. Never commit `.env`.

## Commands

Development (TypeScript run directly by `tsx`; tests by vitest):

```
npm install
npm run migrate      # node-pg-migrate up against DATABASE_URL
npm run dev          # tsx watch src/server.ts
npm test             # vitest, against TEST_DATABASE_URL
npm run typecheck    # tsc --noEmit (src and tests)
npm run invite:create -- [--ttl-hours <n>]          # prints a new invite code (default 72 h)
npm run inbox:list -- [--to <email>]                # the mail outbox
npm run attachments:sweep -- [--older-than <min>]   # unsent uploads and abandoned blobs (cron)
```

Production: build once with the dev dependencies installed, then run plain Node on the build (no `tsx`,
no TypeScript at run time; a production install `npm ci --omit=dev` is enough):

```
npm run build                    # tsc -p tsconfig.build.json: src/ → dist/ (git-ignored), with source maps
npm run migrate:prod             # node dist/cli.js migrate (finds migrations/ next to dist/)
npm start                        # node dist/server.js
npm run invite:create:prod -- [--ttl-hours <n>]
npm run inbox:list:prod -- [--to <email>]
npm run attachments:sweep:prod -- [--older-than <min>]
```

Deploy `dist/`, `migrations/`, `package.json` and `package-lock.json` together: the build looks for
`../migrations` from `dist/`. `tests/build.test.ts` keeps `npm start` and the `:prod` scripts on `node dist/…`
and every run-time import of `src/` a production dependency.

## Configuration (`src/config.ts`)

`DATABASE_URL`, `APP_ORIGIN`, `AUTH_SECRET` (>= 32 chars), `BLOB_DIR`, `PORT`,
`S3_*` (optional, all-or-none), `REGISTRATION_MODE` (`invite` | `open`, default `invite`),
`MAIL_MODE` (`outbox`), `RATE_LIMIT_SCALE` (multiplier for every rate limit, default 1),
`CLIENT_IP_HEADER` / `TRUST_PROXY` (where the client's address comes from; see Deployment),
`ATTACHMENT_QUOTA_BYTES` (attachment bytes one principal may store, default 2 GiB),
`UPLOAD_IDLE_TIMEOUT_MS` / `UPLOAD_TOTAL_TIMEOUT_MS` (an upload is cut off after 45 s without body bytes or
15 min in all), and the server-wide `HTTP_CONNECTION_TIMEOUT_MS` (socket idle, default 2 min),
`HTTP_REQUEST_TIMEOUT_MS` (whole request, default the upload total + 1 min) and `HTTP_KEEP_ALIVE_TIMEOUT_MS`
(default 72 s). The server-wide ones must be longer than the upload deadlines (checked at start-up), so
uploads are governed by their own deadlines; WebSockets are not subject to them.
`DB_STATEMENT_TIMEOUT_MS` (default 30 s) is Postgres' `statement_timeout` on every connection of the app's
pool (and of the CLI's): a statement running longer, lock waits included, is cancelled and the request
answered 503 `busy`. Only statements count, not the time between them, so a long upload or a sweep deleting
blobs is not cut off; migrations run on their own connection and are not subject to it.
`SEARCH_STATEMENT_TIMEOUT_MS` (default 3 s) is the same for each search (see Search).
`DB_ACQUIRE_TIMEOUT_MS` (default 10 s): the pool has 10 connections; a request that cannot get one within
this long (or whose new connection takes longer to open) is answered 503 `busy`.
An invalid value stops the service at start-up with a message naming the variable.

`buildApp(deps?: Partial<Deps>, options?: { logStream })` takes `{ config, db }`; anything omitted is built
from the environment. Tests pass their own config (raised `RATE_LIMIT_SCALE`) and a pool on `TEST_DATABASE_URL`.

## Deployment

**Build and start.** See Commands: `npm run build`, `npm run migrate:prod`, `npm start`.

**One instance.** Run exactly one instance of the service (one replica, no cluster mode); see Sync and
realtime for why and what scaling out would take.

**Client address.** Registration and the sign-in / reset-request limiters count requests per client
address (`clientIp` in `src/limits.ts`, which the request log shows as `remoteAddress` too). By default
that is the address of the TCP connection and nothing a client sends is believed. Behind a proxy every
request comes from the proxy, so tell the service where the real address is:

- `CLIENT_IP_HEADER=<header name>` — a header the proxy sets to the client's address, replacing any value
  the client sent. On Railway: `CLIENT_IP_HEADER=x-real-ip`. Used when it holds exactly one address;
  absent, empty, several values or not an address → the connection's address.
- `TRUST_PROXY=<addresses/CIDRs>` — alternatively, the proxies' own addresses (comma-separated, e.g.
  `10.0.0.0/8,fd00::/8`): on connections from them the right-most `X-Forwarded-For` entry they did not
  write is the client. Empty, `false` or `0` trust nothing. `TRUST_PROXY=true` and hop counts are refused
  at start-up (`true` would believe the left-most entry, which the client writes; a hop count cannot tell
  the proxy from a client that connects directly).

Never set either unless the service is reachable only through that proxy. Better Auth itself reads and
stores no client address (`disableIpTracking`).

**Logs.** JSON lines at info level on stdout (none under test unless a test passes `logStream`); Better Auth's
own errors go to the same log. A request is logged as method, path, host and address: the query string is
replaced by `?[redacted]` (it carries WebSocket tickets, e-mail verification tokens and search terms), and
headers (cookies) are never logged.

**Cron.** `npm run attachments:sweep:prod` (see Attachments), e.g. every 10 minutes.

## Tests

`vitest` global setup runs the migrations once on `TEST_DATABASE_URL`. `useApp()` in
`tests/helpers/harness.ts` builds the app once per file and truncates every table except
`pgmigrations` before each test. Test files run serially because they share one database.

## HTTP API

### Conventions

- **Paths and ids.** Everything is under `/api`. Ids are UUIDs: a path id is accepted in any case and
  lower-cased; every id in a response is lower-case. A path id that is not a UUID is 400 `invalid_request`;
  a path parameter over 100 characters is 414 `invalid_request`. A message is identified by
  `conversationId` + `seq` (no global message id exists).
- **Bodies.** JSON (`Content-Type: application/json`), at most 1 MiB (413 `too_large`), except the avatar
  upload (raw image bytes) and attachment uploads (`multipart/form-data`). Another content type is 415
  `invalid_request`, malformed JSON 400 `invalid_request`. Unknown body fields and unknown query parameters
  are ignored (dropped before the handler), except on the Better Auth endpoints, where an undeclared query
  parameter is 400. Every declared field is validated before any handler code runs: a request that does not
  fit is 400 `invalid_request`, never a 5xx. "Characters" below are Unicode code points (an emoji is one)
  where the text is user text (titles, messages, names, search terms); trimmed means leading and trailing
  white space is removed before the length is checked and the value stored.
- **Session.** Sign-in sets the `HttpOnly`, `SameSite=Lax` session cookie `better-auth.session_token`
  (`Secure` and named `__Secure-better-auth.session_token` when `APP_ORIGIN` is https). Routes marked *Session: required* answer 401
  `{"error":"unauthenticated"}` without a valid session of a principal whose e-mail is verified. The
  acting principal always comes from the session: no body names a sender, actor or owner.
- **Cross-site requests.** Any `POST`, `PUT`, `PATCH` or `DELETE`, whatever its path, whose `Origin` header
  is present and is not exactly `APP_ORIGIN` (byte for byte: no other case, port, trailing slash, `null` or
  list) is refused with 403 `{"error":"forbidden"}` before anything else runs (`src/app.ts`). Requests
  without `Origin` (non-browser clients) pass. The WebSocket upgrade uses the same comparison and also
  refuses a missing `Origin`.
- **Not found means not yours.** A conversation, message, attachment or friend request you may not see
  answers exactly like one that does not exist (`tests/enumeration.test.ts`): 404 `{"error":"not_found"}`,
  byte for byte. Two intended exceptions: any existing principal has an avatar and can be blocked.
- **HEAD.** Every `GET` route also answers `HEAD` with the same status and headers and no body (Fastify
  runs the `GET` handler). `HEAD /api/attachments/:id` is its own route (below): it does not read the file.
- **Order of checks.** Cross-site `Origin` (403) → shape of path, query and body (400) → session (401) →
  rate limit (429) → the route's own rules. Registration counts its rate limit before checking the shape,
  and so do the sign-in and reset-request limiters in front of Better Auth.

### Errors

Every error body is `{"error": "<snake_case_code>"}`, sometimes with string details next to it (`reason`).
Shared codes:

| Status | `error` | Meaning |
|---|---|---|
| 400 | `invalid_request` | Malformed or not acceptable input (also 414 for an over-long path parameter, 415 for an unsupported content type) |
| 401 | `unauthenticated` | No valid session (or a WebSocket ticket that is unknown, used or expired) |
| 403 | `forbidden` | Cross-site request, or not allowed by the route's rule (e.g. only the creator renames) |
| 403 | `cannot_send` | With `reason`: `blocked` or `not_friends` (a direct chat whose pair cannot write to each other) |
| 404 | `not_found` | Does not exist, or is not yours to see (identical answers) |
| 413 | `too_large` | Body over its limit; for uploads also `{"error":"too_large","reason":"quota"}` |
| 429 | `rate_limited` | Over a rate limit or a cap on work in progress (see Rate limits) |
| 503 | `busy` | A database statement ran past its timeout (the pool's or a search's), no database connection was free in time (`DB_ACQUIRE_TIMEOUT_MS`), or the site-wide search cap is reached. Nothing was changed; try again later |
| 500 | `internal` | A bug (also any failure inside Better Auth); logged with the request |

Feature codes (`handle_taken`, `invalid_invite`, `already_member`, `request_not_pending`, Better Auth's
`invalid_email_or_password`, …) are listed with their routes. Every route can also answer 400, 403 (cross-site),
503 and 500 as above; the route sections list what else it answers.

### Rate limits

All limits are per minute unless stated, multiplied by `RATE_LIMIT_SCALE`, counted in fixed windows that
start with the first request, and count every request that reaches them (see Order of checks), including
ones the route then refuses. Over a limit: 429 `rate_limited`. Only
`POST /api/register` sends `x-ratelimit-limit` / `x-ratelimit-remaining` / `x-ratelimit-reset` headers and
`retry-after` on its 429; elsewhere wait for the window (a minute; uploads an hour) to pass.

| What | Limit | Counted per |
|---|---|---|
| `POST /api/register` | 10 | client address |
| `POST /api/auth/sign-in/email` | 10 per client address + e-mail, and 60 per client address | address (+ e-mail, trimmed and lower-cased) |
| `POST /api/auth/request-password-reset` | 10 per client address + e-mail, and 60 per client address (counters of its own) | address (+ e-mail) |
| `GET /api/principals/lookup` | 30 | principal |
| `PATCH /api/me` | 10 | principal |
| `PUT /api/me/avatar` | 10 | principal |
| `POST /api/friend-requests` | 20 | principal |
| `PUT` + `DELETE /api/blocks/:principalId` | 20 together | principal |
| `POST /api/conversations` | 10 | principal |
| `PATCH /api/conversations/:id`, `POST /api/conversations/:id/members`, `DELETE /api/conversations/:id/members/:principalId` | 20 together | principal |
| `POST /api/conversations/:id/messages` | 120 | principal |
| `GET /api/conversations/:id/search` + `GET /api/search` | 30 together; at most 2 in progress per principal (429) and 4 site-wide (503 `busy`) | principal |
| `POST /api/conversations/:id/attachments` | 60 per hour; at most 3 in progress | principal |
| `GET /api/sync` | 60 | principal |
| `POST /api/sync/catchup` | 60 | principal |
| `POST /api/ws-ticket` | 30 | principal |
| WebSockets | at most 5 open; a 6th closes the oldest (code 4002) | principal |

Everything else is not rate limited.

### Health

#### `GET /api/health`

*Session: none.* → 200 `{"ok": true}` once the database answers a query; 503 `busy` when it does not in time.

### Accounts and sessions

Accounts are Better Auth's (e-mail + password, verified e-mail required) mounted at `/api/auth/*`, with a
principal (`id`, `handle`, `displayName`) created alongside by `POST /api/register`. Only the five endpoints
below are reachable under `/api/auth`; every other path there (including Better Auth's own sign-up, which
would bypass invites) is 404 `not_found`. Each declares its query and body; anything else is 400
`invalid_request` before Better Auth sees it. A `callbackURL` / `redirectTo` must be a path on the site (not
`//…` or `/\…`, no control characters or backslashes) or a URL on `APP_ORIGIN`, at most 2048 characters. No
response body carries the session token (sign-in's `token` field is removed): the cookie is the session.
Better Auth's own error codes reach the client lower-cased (`INVALID_TOKEN` → `invalid_token`), never its
message text; a failure inside it is 500 `internal`, a busy database 503 `busy`. Mail goes to the
`mail_outbox` table (read it with `npm run inbox:list`).

Sessions last 7 days from sign-in (the cookie's `Max-Age`; with `rememberMe: false` the cookie ends with the
browser session and the session after a day). Sign-out and a password reset end sessions at once: their
WebSockets close with 4001; an expired session's sockets close within 30 s.

#### `POST /api/register`

*Session: none.* Creates the account and its principal in one transaction and mails a verification link.

- Body: `inviteCode` (string, at most 100; required when `REGISTRATION_MODE=invite`, ignored when `open`),
  `email` (an e-mail address, at most 254), `password` (10–128 characters), `displayName` (see
  `PATCH /api/me`: 1–40 characters after removing format characters and trimming, one line), `handle`
  (`^[a-z0-9_]{3,24}$`: lower-case letters, digits, `_`).
- 201 `{"ok": true}`. Also for an e-mail that already has an account: then nothing is written, no invite is
  used and no mail is sent (the answer does not reveal which e-mails exist).
- Mail (`verify_email`): `<APP_ORIGIN>/api/auth/verify-email?token=…&callbackURL=<APP_ORIGIN>/verify` (the
  callback URL-encoded), valid 24 h; opening it lands on the client's `<APP_ORIGIN>/verify` (or
  `/verify?error=CODE`).
  The e-mail must be verified before sign-in works.
- Errors: 400 `invalid_invite` (missing, unknown, expired or used invite; checked first, so without a usable
  invite nothing else — not even whether the handle is taken — is revealed), 409 `handle_taken`,
  400 `invalid_request` (shape, or a value Better Auth refuses).
- Limit: 10 per minute per client address.

#### `POST /api/auth/sign-in/email`

*Session: none.* Signs in; sets the session cookie.

- Query: none allowed. Body: `email` (string, at most 254), `password` (string, at most 1024; more than 128
  characters is `password_too_long`), `callbackURL` (optional redirect target, see above), `rememberMe`
  (optional boolean; `false`: a browser-session cookie and a one-day session).
- 200 `{"redirect": false, "user": {"id", "name", "email", "emailVerified", "image", "createdAt", "updatedAt"}}`
  with `Set-Cookie`. `user` is Better Auth's account record: its `id` is **not** the principal id (use
  `GET /api/me`), `name` is the display name given at registration. With `callbackURL`: `"redirect": true`,
  `"url": <callbackURL>` and a `Location` header (still status 200).
- Errors: 401 `invalid_email_or_password` (wrong password or unknown e-mail: the same answer, in about the
  same time), 403 `email_not_verified` (right password, e-mail not verified: a fresh verification mail is
  sent, whose link ends at `callbackURL` or `/`), 400 `invalid_email`, 400 `password_too_long`,
  400 `invalid_request`.
- Limit: 10 per minute per client address + e-mail, and 60 per minute per client address.

#### `POST /api/auth/sign-out`

*Session: optional.* Query: none allowed. Body: none or `{}`. → 200 `{"success": true}` and an expiring
`Set-Cookie`, with or without a session. The session ends: its WebSockets close with 4001.

#### `GET /api/auth/verify-email`

*Session: none.* The link from the verification mail.

- Query: `token` (at most 4096), `callbackURL` (optional redirect target). Nothing else.
- With `callbackURL`: 302 to `callbackURL` once verified (or already verified); a bad token redirects to
  `callbackURL?error=INVALID_TOKEN` (or `TOKEN_EXPIRED`, `USER_NOT_FOUND`, `INVALID_USER`).
- Without: 200 `{"status": true, "user": null}`, or 401 `invalid_token` / `token_expired` / `user_not_found` /
  `invalid_user`. Verifying does not sign in.

#### `POST /api/auth/request-password-reset`

*Session: none.* Query: none allowed. Body: `email` (at most 254), `redirectTo` (optional redirect target;
accepted but not used: the mail links to the web app).

- 200 `{"status": true, "message": "If this email exists in our system, check your email for the reset link"}`
  for every e-mail, registered or not (only a registered one gets mail).
- Mail (`reset_password`): `<APP_ORIGIN>/reset-password?token=…`, valid 1 hour, usable once. The web app's
  page at that path posts the token to `POST /api/auth/reset-password`.
- Limit: 10 per minute per client address + e-mail, and 60 per minute per client address.

#### `POST /api/auth/reset-password`

*Session: none.* Query: none allowed. Body: `newPassword` (string; 10–128 characters), `token` (at most 512).

- 200 `{"status": true}`. Every session of the account ends (sockets close with 4001); sign in again.
- Errors: 400 `invalid_token` (unknown, used or expired), 400 `password_too_short`, 400 `password_too_long`,
  400 `invalid_request`.

#### `GET /api/me`

*Session: required.* → 200 `{"id", "handle", "displayName", "email"}`: the signed-in principal.

### Profiles and principals

#### `PATCH /api/me`

*Session: required.* Changes your display name (only yours: no route takes a target id).

- Body: `displayName`: format characters (`\p{Cf}`: bidi overrides and isolates, zero-width spaces and
  joiners, BOM) are removed, then it is trimmed; the result must be 1–40 characters, one line (no control
  characters, no line or paragraph separators) and contain no lone surrogates. The same rule applies on
  registration.
- 200 `{"id", "handle", "displayName"}` with the name as stored. Other members see it the next time they
  load principals (`/api/sync`); system notices keep the name they were written with.
- Limit: 10 per minute.

#### `PUT /api/me/avatar`

*Session: required.* Replaces your avatar.

- Body: the raw image bytes, `Content-Type` `image/*` or `application/octet-stream` (anything else 415
  `invalid_request`), at most 2 MiB (413 `too_large`). The bytes decide: PNG, JPEG or WebP; anything else
  (GIF, SVG, …) is 400 `invalid_request`. The declared type is ignored.
- 200 `{"ok": true}`.
- Limit: 10 per minute (refused uploads count).

#### `GET /api/principals/:id/avatar`

*Session: required.* Any existing principal's avatar: their image (`image/png`, `image/jpeg` or
`image/webp`), or a generated `image/svg+xml` with their initial when they have none. Headers:
`X-Content-Type-Options: nosniff`, `Cache-Control: private, max-age=60`,
`Content-Security-Policy: default-src 'none'; sandbox`. 404 `not_found` for an id that is no principal.

#### `GET /api/principals/lookup`

*Session: required.* Finds a principal by exact handle — the way to get someone's id to befriend them.

- Query: `handle` (at most 100, lower-cased, then `^[a-z0-9_]{3,24}$`). No prefix or partial matches.
- 200 `{"id", "handle", "displayName"}` (also for yourself); 404 `not_found`.
- Limit: 30 per minute, found or not (the limit is what stops probing for handles).

### Friends and blocks

A friendship is mutual and made by a request the other side accepts. Accepting creates the pair's direct
chat (or reuses it, with a `friendship_restored` notice). Ending the friendship or a block in either
direction keeps the chat and its history but nobody can send there (`canSend.reason` `not_friends` /
`blocked`). Social changes push `social` to both people; changes to their direct chat also push
`conversation` and the notice as `message`.

#### `GET /api/social`

*Session: required.* → 200:

```jsonc
{
  "friends":   [{ "id": "…", "handle": "bob", "displayName": "Bob" }],          // by handle
  "incoming":  [{ "id": "<request id>", "principal": { "id", "handle", "displayName" }, "createdAt": "…", "expiresAt": "…" }],
  "outgoing":  [ /* the same shape; principal is the recipient */ ],             // both newest first, live pending only
  "blocked":   [{ "id", "handle", "displayName" }],                              // whom you blocked, by handle
  "blockedBy": [{ "id", "handle", "displayName" }]                               // who blocked you, by handle
}
```

Refetch it on a `social` push.

#### `POST /api/friend-requests`

*Session: required.* Body: `handle` (as for lookup). → 201 `{"id": "<request id>"}`. The request expires after
24 hours.

- Errors: 404 `not_found` (no such handle), 400 `invalid_request` (yourself), 403 `blocked` (a block in
  either direction), 409 `already_friends`, 409 `request_pending` (a live request between the two exists, in
  either direction).
- Limit: 20 per minute (refused requests count). Pushes: `social` to both.

#### `GET /api/friend-requests/:id`

*Session: required.* → 200 `{"id", "status", "fromId", "toId", "createdAt", "expiresAt"}`; `status` is
`pending`, `accepted`, `rejected`, `withdrawn` or `expired` (a pending request past `expiresAt` reads as
expired). 404 `not_found` unless you sent or received it.

#### `POST /api/friend-requests/:id/accept`

*Session: required.* No body. The recipient accepts. → 200 `{"ok": true, "conversationId": "<direct chat id>"}`.

- Errors: 404 `not_found` (unknown, not yours, or you are the sender), 409 `request_not_pending` (already
  decided or recorded as expired), 409 `request_expired` (pending but past 24 h; from now on it is
  `expired`), 403 `blocked` (a block in either direction).
- Pushes: `social` to both; `conversation` for the direct chat (a new one, or a re-opened one with its
  `friendship_restored` notice as `message`).

#### `POST /api/friend-requests/:id/reject`

*Session: required.* No body. The recipient declines. → 200 `{"ok": true, "conversationId": null}`. Errors:
404 `not_found` (unknown, not yours, or you are the sender), 409 `request_not_pending`, 409
`request_expired`. Pushes: `social` to both.

#### `POST /api/friend-requests/:id/withdraw`

*Session: required.* No body. The sender takes the request back. → 200 `{"ok": true, "conversationId": null}`.
Errors: 404 `not_found` (unknown, not yours, or you are the recipient), 409 `request_not_pending`, 409
`request_expired`. Pushes: `social` to both.

#### `DELETE /api/friends/:principalId`

*Session: required.* Ends the friendship. → 200 `{"ok": true}`; 404 `not_found` when you are not friends
(also for unknown ids and yourself). The direct chat gets a `friendship_ended` notice and can no longer be
written to by either side. Pushes: `social`, `conversation`, the notice.

#### `PUT /api/blocks/:principalId`

*Session: required.* Blocks someone (one direction; only you can lift it). → 200 `{"ok": true}`, also when
you had blocked them already (then nothing changes and nothing is pushed).

- A new block cancels the live requests between you (yours withdrawn, theirs rejected; a lapsed one is
  recorded as expired), leaves the friendship as it is, appends a `blocked` notice to your direct chat if
  you have one, and stops both of you from sending there.
- Errors: 400 `invalid_request` (yourself), 404 `not_found` (no such principal; any existing principal can
  be blocked).
- Limit: 20 per minute together with unblocking. Pushes: `social` to both; `conversation` and the notice
  when you have a direct chat.

#### `DELETE /api/blocks/:principalId`

*Session: required.* Lifts your block. → 200 `{"ok": true}` always (for an id you never blocked, existing or
not, nothing happens). A lifted block appends an `unblocked` notice to the direct chat; sending works again
if you are still friends and no block remains the other way. Limit: 20 per minute together with blocking.
Pushes (when a block was lifted): `social`, `conversation`, the notice.

### Conversations

A conversation is a direct chat (exactly two people; created when the first friend request between them is
accepted; never left, and kept when the friendship ends) or a group (created by a member, at most 500
members). Every member is a `speaker`
(`observer` is reserved). You see a conversation's messages from the moment you (last) joined; see
Visibility under Sync and realtime.

#### `POST /api/conversations`

*Session: required.* Creates a group of you and at least two of your friends; nobody has to confirm.

- Body: `title` (1–60 characters, trimmed, one line), `memberIds` (2–1000 principal ids, distinct, not
  you).
- 201 `{"id": "<conversation id>"}`. Everyone joins at once; the first message (seq 1) is the
  `group_created` notice.
- Errors: 400 `invalid_request` (duplicates, fewer than two, or you among them), 403 `forbidden` (someone
  is not your friend, a block in either direction, or more than 500 members including you).
- Limit: 10 per minute. Pushes: `conversation` and the notice to every member.

#### `GET /api/conversations/:id`

*Session: required.* → 200: exactly the element of `GET /api/sync`'s `conversations` for this id, as it is
now (shape under Wire shapes). 404 `not_found` unless you are a current member — the same answer as for an
id that does not exist. Fetch it on a `conversation` push instead of a full sync.

#### `PATCH /api/conversations/:id`

*Session: required.* The group's creator renames it. Body: `title` (1–60 characters, trimmed, one line).

- 200 `{"id", "title"}`. The same title again changes nothing and appends no notice; otherwise a
  `group_renamed` notice.
- Errors: 404 `not_found` (not a current member, a direct chat, closed, unknown), 403 `forbidden` (not the
  creator).
- Limit: 20 per minute together with adding and removing members. Pushes: `conversation`, the notice.

#### `GET /api/conversations/:id/members`

*Session: required.* → 200 `{"members": [{"id", "handle", "displayName", "kind", "role", "isCreator"}]}`:
current members in join order; `kind` `human` | `agent`; `isCreator` only ever true in groups. 404
`not_found` unless you are a current member.

#### `POST /api/conversations/:id/members`

*Session: required.* Any member adds one of their friends to a group. Body: `principalId`.

- 201 `{"ok": true}`. The newcomer sees the `member_joined` notice and everything after it, nothing before.
- Errors: 404 `not_found` (you are not a current member, a direct chat, closed, unknown), 409
  `already_member`, 403 `forbidden` (not your friend, a block in either direction, or the group has 500
  members).
- Limit: 20 per minute together with renaming and removing. Pushes: `conversation` to every member (the
  newcomer included), the notice.

#### `DELETE /api/conversations/:id/members/:principalId`

*Session: required.* With your own id: you leave (anyone). With someone else's: the creator removes them.

- 200 `{"ok": true}`. Leaving appends `member_left` (when the creator leaves, the member who joined earliest
  becomes creator: `newCreatorId`); removing appends `member_removed`. Whoever leaves or is removed loses the
  whole conversation at once (404 everywhere, no history; the notice is not theirs to see). When the last
  member leaves, the group closes.
- Errors: 404 `not_found` (you are not a current member, a direct chat — those cannot be left —, closed,
  unknown, or the person to remove is not a current member), 403 `forbidden` (removing someone without being
  the creator).
- Limit: 20 per minute together with renaming and adding. Pushes: `gone` to whoever left or was removed;
  `conversation` and the notice to the others.

### Messages

#### `POST /api/conversations/:id/messages`

*Session: required.* Sends a text or file message as you.

- Body: `clientTxn` (required, `^[A-Za-z0-9_-]{1,64}$`: your retry key), `text` (0–8000 characters,
  trimmed; line breaks allowed; no NUL or lone surrogates), `attachmentId` (optional: your own upload in this
  conversation that no message carries yet; makes a `file` message with `text` as its caption),
  `replyToSeq` (optional positive integer: a message of this conversation you can see). Without
  `attachmentId`, `text` must not be empty.
- 201 `{"message": WireMessage, "duplicate": false}`.
- Retries: the same `clientTxn` again (same sender, same conversation) stores nothing and answers 200
  `{"message": <the stored message>, "duplicate": true}` — even if you could no longer send there now (you
  must still be a member). The same
  `clientTxn` in another conversation is a new message there. 409 `client_txn_reused` when the message stored
  under it is no longer visible to you (you left and were added again).
- Errors: 404 `not_found` (not a current member, closed, unknown), 403 `cannot_send` with `reason`
  `blocked` or `not_friends` (direct chats), 400 `invalid_request` (empty text without attachment, a
  `replyToSeq` you cannot see, an attachment that is not your unsent upload here).
- Limit: 120 per minute. Pushes: `message` to every member who can see it.

#### `GET /api/conversations/:id/messages`

*Session: required.* History, a page at a time.

- Query: `before` (optional positive integer: only seqs below it), `limit` (1–100, default 50).
- 200 `{"messages": WireMessage[], "nextBefore": number | null}`: up to `limit` messages you can see, the
  newest page first, each page ascending by seq; pass `nextBefore` as `before` for the next older page
  (`null`: nothing older you can see).
- 404 `not_found` unless you are a current member.

#### `GET /api/conversations/:id/messages/:seq`

*Session: required.* → 200 `{"message": WireMessage}`; 404 `not_found` when you cannot see it (from before
you joined, not a member, no such seq — identical).

#### `POST /api/conversations/:id/read`

*Session: required.* Moves your read marker. Body: `seq` (positive integer).

- 200 `{"readSeq": number}`: the marker is set to `seq` clamped to [your current marker, the conversation's
  last seq] — never backwards, never past the end.
- 404 `not_found` unless you are a current member.
- Pushes: in a direct chat, when the marker moved, `read` to both people (all their sockets). Not rate
  limited.

### Search

The rules (matching, order, limits, timing) are under Search below.

#### `GET /api/conversations/:id/search`

*Session: required.* Query: `q` (1–100 characters, trimmed, one line), `before` (optional positive integer),
`limit` (1–50, default 20). → 200 `{"messages": WireMessage[], "nextBefore": number | null}`, newest first;
404 `not_found` unless you are a current member; 429 / 503 `busy` as under Search.

#### `GET /api/search`

*Session: required.* Query: `q`, `limit` as above, `before` (optional: the `nextBefore` cursor of the previous
page, opaque; anything else is 400). → 200 `{"messages": WireMessage[], "nextBefore": string | null}`: hits in
every conversation you are currently in, newest first; 429 / 503 `busy` as under Search.

### Attachments

The rules (types, names, limits, deadlines, cleanup) are under Attachments below.

#### `POST /api/conversations/:id/attachments`

*Session: required.* `multipart/form-data` with exactly one part, a file named `file`. → 201
`{"id", "name", "size", "inline"}`; send it with `POST /api/conversations/:id/messages`.
Errors: 404 `not_found` and 403 `cannot_send` exactly as for a send (checked before the body is read and
again after it is stored), 400 `invalid_request` (any other shape, a broken or stalled body), 413
`too_large` (over 50 MB) or `{"error":"too_large","reason":"quota"}`, 429 `rate_limited` (60 per hour,
3 at once).

#### `GET /api/attachments/:id`

*Session: required.* The bytes, iff a message carrying the attachment is visible to you now; everything else
is the same 404 `not_found`. Headers as under Attachments.

#### `HEAD /api/attachments/:id`

*Session: required.* The same decision and headers as the `GET` (`Content-Length` included), no body; the
file is not read.

### Sync and realtime routes

How they work together is under Sync and realtime below.

#### `GET /api/sync`

*Session: required.* Everything a client loads at start → 200 `{"me", "conversations", "principals",
"messages"}` (shape under Wire shapes). Limit: 60 per minute.

#### `POST /api/sync/catchup`

*Session: required.* Body: `positions`: an object of at most 500 conversation ids (no two differing only in
case) → the last seq you have (0 … 2^53−1). → 200 `{"messages": WireMessage[], "gone": string[],
"more": boolean}`. Limit: 60 per minute.

#### `POST /api/ws-ticket`

*Session: required.* Body: none or `{}`. → 200 `{"ticket": "…"}`: opens one socket, once, within 30 seconds,
while the session that asked for it lasts. Limit: 30 per minute.

#### `GET /api/ws`

*Session: none (the ticket).* `GET /api/ws?ticket=<ticket>` as a WebSocket upgrade from `APP_ORIGIN`:
`ticket` is 1–128 characters (missing: 400 `invalid_request`); a bad, used or expired ticket is 401
`unauthenticated`; another or a missing `Origin` 403 `forbidden`; a plain `GET` without an upgrade 404
`not_found`. An upgrade request to any other path is 404 `not_found` before that route runs.

## Wire shapes

**Principal** (in `/api/sync`'s `principals`): `{"id", "handle", "displayName", "kind": "human" | "agent"}`.

**Conversation** (an element of `/api/sync`'s `conversations`, and `GET /api/conversations/:id`):

```jsonc
{
  "id": "…", "type": "direct" | "group", "title": "team" /* null in direct chats */,
  "creatorId": "…",                                // groups only: a direct chat has no creator role
  "myRole": "speaker" | "observer", "closed": false,
  "createdAt": "2026-11-16T01:02:03.000Z",       // when the conversation was created; /api/sync lists them in this order
  "peerId": "…",                                   // direct chats only: the other person of the pair
  "canSend": { "ok": true } | { "ok": false, "reason": "blocked" | "not_friends" | "closed" },
  "members": [{ "id": "…", "role": "speaker", "isCreator": true }],   // current members, join order; isCreator only in groups
  "lastSeq": 42,       // the conversation's newest seq (counts messages from before you joined too)
  "readSeq": 40,       // your read marker
  "unread": 2,         // visible messages from others, not system notices, after readSeq
  "peerReadSeq": 41    // direct chats only: how far the other side has read
}
```

**WireMessage** — a message as one reader receives it (history, sync, catch-up, search, pushes):

```jsonc
{
  "conversationId": "…", "seq": 43,
  "senderId": "…",                     // null for system notices
  "kind": "text" | "file" | "system",
  "text": "…",                         // the message; a file message's caption ("" when none); a notice's sentence
  "attachment": { "id": "…", "name": "报告.pdf", "size": 1234, "inline": false },   // file messages only
  "replyTo": { "seq": 40, "visible": true, "senderId": "…", "text": "<first 200 characters>",
               "kind": "text" | "file", "attachmentName": "…" /* quoted file messages only */ },
                                       // or { "seq": 7, "visible": false } when you cannot see the quoted message;
                                       // absent when not a reply. A quoted notice: kind "text", senderId null
  "system": { "event": "member_joined", "actorId": "…", "principalId": "…" },   // system notices only
  "createdAt": "2026-11-16T01:02:03.000Z"
}
```

**System notices** (`kind: "system"`) are written by the service when something happens in a conversation;
nobody sends them, every member who can see that seq sees them, and they are never unread. `text` is a
sentence in Chinese with the display names of that moment; `system` carries the event and its ids so a
client can render its own:

| `system.event` | Fields besides `event` | Written when |
|---|---|---|
| `group_created` | `actorId` (creator), `title`, `memberIds` (the invited members, without the creator) | a group is created (its seq 1) |
| `member_joined` | `actorId` (who added), `principalId` (who joined) | `POST /api/conversations/:id/members` |
| `member_left` | `actorId` = `principalId` (who left), `newCreatorId` (id, or null when the creator did not leave or nobody is left) | leaving |
| `member_removed` | `actorId` (the creator), `principalId` (who was removed) | removal |
| `group_renamed` | `actorId`, `title` (the new one) | a rename that changes the title |
| `friendship_ended` | `actorId` (who ended it), `principalId` (the other) | `DELETE /api/friends/:principalId`, in the pair's direct chat |
| `friendship_restored` | `actorId` (who accepted), `principalId` (who asked) | accepting a request when the pair already has a direct chat |
| `blocked` | `actorId` (who blocked), `principalId` (who is blocked) | a new block, in the pair's direct chat if any |
| `unblocked` | `actorId`, `principalId` | lifting a block, in the pair's direct chat if any |

Clients must ignore fields and events they do not know: later batches add more.

**Pushes** (WebSocket text frames, JSON):

```jsonc
{ "type": "message", "message": WireMessage }   // rendered for you
{ "type": "conversation", "id": "…" }   // title, members, creator, closed, or a direct chat's canSend changed: GET /api/conversations/:id
{ "type": "gone", "id": "…" }           // you are not a member now (left or removed): drop the conversation
{ "type": "social" }                    // your friends, requests or blocks changed: GET /api/social
{ "type": "read", "conversationId": "…", "principalId": "…", "seq": 41 }   // direct chats only (either side)
{ "type": "pong" }                      // answer to your { "type": "ping" }
```

## Sync and realtime (`src/sync/`)

### Single instance only

The WebSocket ticket store (`tickets.ts`) and the hub that holds the open sockets and delivers pushes
(`hub.ts`) live in this process's memory, and the events they deliver are announced in-process after
each commit. **Run exactly one instance of the service** (one replica, no cluster mode): with two, a
socket on instance A never hears about writes handled by instance B, and a ticket issued by A cannot be
redeemed on B.

To scale out, move both into Postgres: after commit, publishers `NOTIFY` a channel with only ids
(event kind, conversation id, seq range or principal ids — never message content, which must be
rendered per reader anyway and would not fit the 8000-byte payload limit); every instance `LISTEN`s
and runs the same per-conversation delivery for its own sockets. Tickets become rows
`(sha256(ticket), principal_id, session_id, expires_at)` consumed with `delete … returning`.

### Client contract

No response or push carries a global message id or any site-wide counter: a message is identified by
`conversationId` + `seq` (gapless per conversation).

**Visibility.** You see a message iff you are a current member of its conversation and joined before it
(the join notice is the first thing you see). Nothing else grants read access: not an earlier stay, not
having sent it, not a quote of it. The same rule decides history, sync, catch-up, search, pushes, quotes and
downloads.

**First load.** Open the socket first (below), buffer its pushes, then `GET /api/sync`:

```jsonc
{
  "me": { "id": "…", "handle": "alice", "displayName": "Alice", "email": "alice@example.test" },
  "conversations": [ /* Conversation, see Wire shapes; the ones you are a current member of */ ],
  "principals": [{ "id": "…", "handle": "bob", "displayName": "Bob", "kind": "human" | "agent" }],   // by handle
  "messages": [ /* WireMessage: per conversation its newest 30 visible messages, ascending by seq */ ]
}
```

`principals` lists you, every member, and everyone a returned message names (sender, a visible
quote's sender, a system notice's participants) — including people who have since left, but only
through messages you can see. After `/api/sync` your position for each conversation is its `lastSeq`.
Older history: `GET /api/conversations/:id/messages?before=`.

**One conversation.** `GET /api/conversations/:id` answers exactly the element of `/api/sync`'s
`conversations` for that id (same fields, same values at that moment), or 404 `not_found` when you are not a
current member — the same answer as for an id that does not exist. Fetch it on a `conversation` push instead
of a full sync; a 404 there means you were removed meanwhile (a `gone` follows). Members new to you are
listed with names by `GET /api/conversations/:id/members`.

**Catch-up.** `POST /api/sync/catchup {"positions": {"<conversationId>": <last seq you have>, …}}`
→ `{"messages": WireMessage[], "gone": string[], "more": boolean}`.
For each id you are currently a member of: the visible messages after your position, ascending, each
conversation's share a gapless continuation (advance the position message by message). Ids you are not
in — left, removed, never a member, or not existing — are listed in `gone` and nothing else is said
about them. Conversations you did not send a position for are not looked at (new ones come from
`/api/sync`). At most 500 messages per response, shared evenly between the conversations that have some;
`more: true` means call again with the advanced positions.

**Socket.** `POST /api/ws-ticket` → `{"ticket": "…"}`, valid once, for 30 seconds, and only while the
session that asked for it lasts. Open `wss://<host>/api/ws?ticket=<ticket>` from the app's origin
(`APP_ORIGIN`). The session cookie alone never opens a socket. Each principal has at most 5 sockets; a 6th
closes the oldest. The server sends WebSocket pings every 30 s and drops sockets that did not answer the
previous one. You may send `{"type":"ping"}` (answered with `{"type":"pong"}`); every other inbound message
is ignored. Binary frames, frames over 4 KB and protocol violations close the socket.

Close codes: `4001` session ended (sign-out, password reset, or expiry — checked every 30 s),
`4002` replaced by a newer socket, `4003` too slow to read its pushes, `1003` binary frame,
`1002`/`1007`/`1009` protocol error / bad UTF-8 / frame over 4 KB, `1011` server error. On `4001`
sign in again; on anything else reconnect (with backoff).

**Ordering and gaps.** Within one conversation a socket receives that conversation's events one at a
time, in the order the writes announced them after commit, with `message` seqs strictly ascending
(messages are read back from the table by seq range, not taken from the announcement). Who receives
what is decided against the database at delivery time. Across conversations, and for `social`, there
is no order. Messages from before you joined are never pushed, so after joining the first `message` is the
join notice. Apply a `message` like this: `seq ≤ position` → duplicate, ignore; `seq = position + 1`
→ append and advance; `seq > position + 1` → a gap: call catch-up for that conversation from your
position. Gaps are rare (a backlog of more than 200 messages at once, a delivery step that failed, an
announcement race right after a server start) but always repairable this way. A `message` for a
conversation you do not know means you were just added: call `GET /api/conversations/:id` (or `/api/sync`).

**Read markers.** Apply a `read` push as `max(current, seq)` for that person in that conversation: pushes
can arrive out of order (two marks close together are announced in the order their requests finished, which
need not be the order of their seqs), and a marker never moves backwards. `/api/sync`'s `readSeq` /
`peerReadSeq` are the stored values at that moment; take the max with what you have too.

**Leaving and coming back.** `gone` says "not a member now", decided when it is delivered, so it can
arrive more than once for one departure (a change announced just before you left is delivered after it);
ignore a `gone` for a conversation you no longer hold. After `gone` nothing of that conversation reaches
you — unless you are added again: then it reappears with a `conversation` event (fetch it; your new stay
starts at the join notice, nothing from before it or from your earlier stay is shown).

**Reconnect.** 1. Get a ticket and open the socket; buffer pushes. 2. `POST /api/sync/catchup` with
the position of every conversation you hold; append, advance, drop the `gone` ones; repeat while
`more`. 3. `GET /api/sync` to refresh metadata, members, read markers and principals and to find
conversations you were added to — `conversation`, `social` and `read` events sent while you were
offline are not replayed. 4. Apply the buffered pushes by the rules above.

## Attachments (`src/attachments/`)

**Upload.** `POST /api/conversations/:id/attachments`, `multipart/form-data` with exactly one part: a file
named `file` (any other part or field, or none, is 400). → 201 `{"id", "name", "size", "inline"}`. Only a
current member who may send there can upload; the refusals are exactly a send's (404 `not_found`, 403
`cannot_send` with `reason`), checked before the body is read and again, under the send locks, after it
was stored — an upload that finishes after you were unfriended or removed is refused and deleted. The
server decides the type from the first bytes (the declared `Content-Type` and file name are ignored):
`inline: true` only for PNG, JPEG, WebP and GIF. The name is for display only (NFC; path, control,
bidi and zero-width characters removed; at most 120 characters; `file` when empty). Limits per
principal: 50 MB per file (413 `too_large`, enforced while streaming), 60 uploads per hour and 3 at a time
(429 `rate_limited`), 2 GiB stored in total, sent or not (413 `{"error": "too_large", "reason": "quota"}`).
A client that sends no body bytes for 45 s, or is still sending after 15 minutes, is disconnected and
its partial upload deleted.

**Send.** `POST /api/conversations/:id/messages {"attachmentId": "…", "text"?: "caption", "clientTxn": "…"}`
makes a `file` message (caption 0–8000 characters). The attachment must be your own upload in this
conversation that no message carries yet (400 otherwise); each upload can be sent once.

**Download.** `GET /api/attachments/:id` serves the bytes iff a message carrying the attachment is
visible to you now (the same rule as for reading the message); everything else — unknown, never sent
(also for the uploader), sent before you joined, after you left — is the same 404. Headers: the
server's `Content-Type` (markup such as HTML or SVG is always `application/octet-stream`),
`Content-Length`, `Content-Disposition: inline` only for `inline` attachments, else `attachment`, with an
ASCII `filename` and the exact name as `filename*=UTF-8''…`; `X-Content-Type-Options: nosniff`,
`Content-Security-Policy: sandbox; default-src 'none'`, `Cache-Control: private, no-store`. No ranges.
`HEAD /api/attachments/:id` answers the same status and headers without a body, and without reading the file.

**Unsent uploads** are deleted by `npm run attachments:sweep:prod -- [--older-than <minutes>]`
(default 60; run it from cron). Send an upload within that time. A blob that cannot be deleted keeps its
row and is retried on the next sweep.

**Blobs nothing references.** Every blob key (attachment or avatar) is recorded in `pending_blobs`, and
committed, before its bytes are written; the record is deleted in the transaction that makes a row
reference the blob, or once the blob itself is deleted. A replaced avatar's key is recorded in the swap
transaction. The same sweep deletes blobs still recorded after the upload deadline plus a minute (refused
uploads whose delete failed, uploads cut off or interrupted by a crash, including a partial `.part` file,
replaced avatars), blob first; a failed delete keeps the record for the next run, and a key some row
references is never deleted. With S3, also give the bucket an `AbortIncompleteMultipartUpload` lifecycle
rule: an upload interrupted by a crash can leave an incomplete multipart upload behind.

## Search (`src/messages/search.ts`)

`GET /api/conversations/:id/search?q=&before=&limit=` → `{"messages": WireMessage[], "nextBefore": number | null}`:
hits in one conversation you are currently in, newest first; pass `nextBefore` as `before` for the next
page. Any conversation you are not in now is 404 `not_found`.
`GET /api/search?q=&before=&limit=` → `{"messages": WireMessage[], "nextBefore": string | null}`: hits in
every conversation you are currently in; `before` is the opaque cursor of the previous page (anything else
is 400). Each hit carries `conversationId` and `seq`, the place to jump to.

`q` is 1–100 characters after trimming, one line, matched as a substring (`%`, `_` and `\` are ordinary
characters) of a message's text (captions included) or a file message's name; system notices never match.
You only get messages you could read anyway (the same visibility rule), quotes resolved for you. `limit`
1–50, default 20.

**Limits** per principal: 30 searches a minute over both routes, and at most 2 in progress at once (one
more is 429 `rate_limited`; a search keeps its place until its database work ends, even if the client has
gone, because the work goes on). Site-wide at most 4 searches run at once: one more is 503 `busy` (unless
its caller is at their own 2, which stays 429). Each search runs in a read-only transaction whose statements
are cancelled after `SEARCH_STATEMENT_TIMEOUT_MS` (3 s): 503 `{"error":"busy"}`. A very short or very common
term over a long history can hit this; a longer term usually does not.

**Order of global search.** Hits are ordered by their message's timestamp (`created_at`: when its
transaction began), newest first, ties by conversation id and then seq, both descending; the cursor resumes
exactly after the last hit. On messages that do not change, paging never repeats or skips a hit. A message
committed while you page can be missed when its timestamp falls behind your cursor (its transaction began
before, but committed after, the page you already have): search again from the top to see it. Messages
written at the same moment in one conversation may appear in another order than their seqs.

**Case.** Matching ignores case as the database's character classification defines it. The databases here
are UTF8 with collation and ctype `C.UTF-8`, under which letters with a simple case mapping fold (`É`/`é`,
full-width `Ａ`/`ａ`), and nothing is normalised: accents are not stripped (`é` does not match `e`),
full-width letters never match ASCII ones, `ß` does not match `SS`. A database created with another locale
may fold differently; `tests/search.test.ts` pins the behaviour above so that a change is noticed.

**Timing.** The match runs over a site-wide trigram index before the visibility rule narrows it, so how long
a search takes depends slightly on how often the term occurs in messages you cannot read. That says nothing
about any particular conversation or person, but a patient client could estimate how common a term is
across the site. Accepted for now; the limits above bound how much can be learnt.

## Robustness suites

- `tests/fuzz.test.ts` walks `app.routeList` (filled by an `onRoute` hook, so a route added later is fuzzed
  without touching the test) and sends every route malformed path ids, query values, bodies and content
  types, signed in and signed out; plus the Better Auth mount, malformed multipart, the avatar routes and
  WebSocket handshakes. Every answer must be < 500, every 4xx a `{"error": "<snake_case>"}` JSON body, and
  `/api/health` must answer afterwards.
- `tests/concurrency.test.ts` races real HTTP requests on the 10-connection pool (sends against an unfriend,
  a block and a removal; 20 adds of one person; two senders; accept against withdraw; a block against a
  group add; the last two members leaving; read markers; uploads at the quota; a request against a block)
  for several rounds and checks each stated invariant against the database.
- `tests/enumeration.test.ts`: on every route taking a conversation id, a seq, an attachment, request or
  principal id, an id that exists but is not yours gets byte for byte the answer a random id gets; the two
  intended differences (any existing principal can be blocked and has an avatar) are asserted. Catch-up
  and downloads also take about as long for both (medians within a factor of 2).
- `tests/readme.test.ts`: the route headings of this README are exactly the routes the app serves.

### The prototype's defects (`spikes/base-gate/README.md`, candidate C) and what now covers them

| # | Defect in the prototype | Covered by |
|---|---|---|
| 1 | One request with a malformed URL ends the process, no sign-in needed | `tests/fuzz.test.ts` (every route: undecodable, over-long, `..`, encoded-slash and non-UUID path ids, signed in and out; health checked after); `tests/health.test.ts` "malformed URL does not crash", "a path the router cannot decode, or an over-long id, is answered in the error shape" |
| 2 | Any signed-in user ends the process with a malformed WebSocket frame | `tests/sync.test.ts` "an unmasked or oversized frame closes the socket and the server keeps serving"; `tests/fuzz.test.ts` WebSocket handshakes (bad tickets, keys, versions, origins) |
| 3 | An owner who leaves a conversation leaves their Agent in it | batch 3 (needs Agents) |
| 4 | An upload completes although the conversation was frozen while it streamed | the batch 1 counterpart — losing the right to send mid-upload — `tests/attachments.test.ts` "upload that completes after the uploader was unfriended (direct) or removed (group) is refused and leaves no blob"; freezing itself is batch 3 |
| 5 | Leaving during a freeze still writes a system notice | batch 3 (manual freeze; in batch 1 only direct chats can become unable to send, and they cannot be left) |
| 6 | A retry id reused in another conversation silently drops the second message | `tests/messages.test.ts` "same clientTxn twice in one conversation stores one message; the same clientTxn in a second conversation stores a new message there" |
| 7 | Sign-in time tells whether an account exists; no rate limit | `tests/auth.test.ts` "a wrong password takes about as long for an existing as for a non-existing e-mail", "the 11th sign-in attempt for one account from one address is 429 …", "one address cycling through many e-mails …", "password reset answers identically …" |
| 8 | The sync cursor is a site-wide counter (anyone sees site-wide activity); a late joiner sees how many messages came before them | site-wide: no global id or counter anywhere — `tests/sync.test.ts` "initial sync contains only my conversations …", `tests/search.test.ts` "the cursor does not reveal how many messages exist site-wide", `tests/enumeration.test.ts`. Per conversation, seqs are gapless and count messages from before you joined (`lastSeq`, the join notice's seq): kept by design, see the client contract |
| 9 | Approvals never expire; an old approval still works after removal | batch 1 has no join approvals (members add their friends directly; expansion approval is batch 3). Friend requests expire after 24 h — `tests/social.test.ts` "a request older than 24h cannot be accepted and reads as expired"; a removed member loses access at once — `tests/messages.test.ts` "removed member gets 404 on every read and write …", `tests/enumeration.test.ts`, `tests/concurrency.test.ts` "… racing removal of the sender from a group" |
| 10 | Several malformed parameters cause 500s | `tests/fuzz.test.ts` (the 500s it found are fixed and pinned in `tests/auth.test.ts` "inputs Better Auth answered with a 500 are refused with 400 first …" and `tests/health.test.ts`) |
