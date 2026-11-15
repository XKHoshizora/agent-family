# Agent Family service

Fastify 5 + Postgres backend. TypeScript (strict, ESM), zod validation via `fastify-type-provider-zod`, `pg`, `node-pg-migrate`, vitest.

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

```
npm install
npm run migrate   # node-pg-migrate up against DATABASE_URL
npm run dev       # tsx watch src/server.ts
npm test          # vitest, against TEST_DATABASE_URL
npm run build     # type-check only (tsc --noEmit)
```

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

## Errors

Every error body is `{"error": "<snake_case_code>"}`, sometimes with string details next to it (`reason`).
Shared codes: `not_found` (404), `forbidden` (403), `invalid_request` (400; 414 for an over-long path
parameter, 415 for an unsupported content type), `unauthenticated` (401), `rate_limited` (429),
`cannot_send` (403, with `reason`), `too_large` (413), and `busy` (503: a database statement ran past its
timeout — a search's own or the pool's —, no database connection was free in time, or too many searches
are running site-wide; nothing was changed, try again later). Feature codes
(`handle_taken`, `already_member`, `request_not_pending`, …) are given with their routes. `internal` (500)
is always a bug.

**Cross-site requests.** Any `POST`, `PUT`, `PATCH` or `DELETE`, whatever its path, whose `Origin` header is
present and is not exactly `APP_ORIGIN` (byte for byte: no other case, port, trailing slash, `null` or list)
is refused with 403 `{"error":"forbidden"}` before anything else runs
(`src/app.ts`; the WebSocket upgrade uses the same comparison and also refuses a missing `Origin`).
Requests without `Origin` (non-browser clients) pass. The session cookie is `HttpOnly`, `SameSite=Lax`, and
`Secure` (with the `__Secure-` name prefix) when `APP_ORIGIN` is https.

`buildApp(deps?: Partial<Deps>, options?: { logStream })` takes `{ config, db }`; anything omitted is built
from the environment. Tests pass their own config (raised `RATE_LIMIT_SCALE`) and a pool on `TEST_DATABASE_URL`.

**Logs.** JSON lines at info level on stdout (none under test unless a test passes `logStream`). A request
is logged as method, path, host and address: the query string is replaced by `?[redacted]` (it carries
WebSocket tickets, e-mail verification tokens and search terms), and headers (cookies) are never logged.

## Tests

`vitest` global setup runs the migrations once on `TEST_DATABASE_URL`. `useApp()` in
`tests/helpers/harness.ts` builds the app once per file and truncates every table except
`pgmigrations` before each test. Test files run serially because they share one database.

## Accounts (`src/auth/`, `src/session.ts`)

Better Auth (e-mail + password, verified e-mail required, 7-day sessions) mounted at `/api/auth/*`;
only these endpoints are exposed: `POST /sign-in/email`, `POST /sign-out`, `GET /verify-email`,
`POST /request-password-reset`, `POST /reset-password`. Registration is `POST /api/register`
(invite code unless `REGISTRATION_MODE=open`). `GET /api/me` returns the signed-in principal.
Each of these declares its query and body; anything else is 400 before Better Auth sees it. A
`callbackURL` / `redirectTo` must be a path on the site (not `//…`) or a URL on `APP_ORIGIN`. No response
body carries the session token (sign-in's `token` field is removed): the `HttpOnly` cookie is the session.
Mail goes to the `mail_outbox` table. CLI: `npx tsx src/cli.ts invite:create [--ttl-hours n]` / `inbox:list [--to <email>]`.
The address the IP-keyed limits count is set up as described under Deployment.

## Deployment

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

Never set either unless the service is reachable only through that proxy.

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

All ids are lower-case UUIDs. No response or push carries a global message id or any site-wide
counter: a message is identified by `conversationId` + `seq` (gapless per conversation).

**First load.** Open the socket first (below), buffer its pushes, then `GET /api/sync`:

```jsonc
{
  "me": { "id": "…", "handle": "alice", "displayName": "Alice", "email": "alice@example.test" },
  "conversations": [{
    "id": "…", "type": "direct" | "group", "title": "team" /* null in direct chats */,
    "creatorId": "…",                                // groups only: a direct chat has no creator role
    "myRole": "speaker" | "observer", "closed": false,
    "createdAt": "2026-11-16T01:02:03.000Z",       // when the conversation was created; the list is in this order
    "peerId": "…",                                   // direct chats only: the other person of the pair
    "canSend": { "ok": true } | { "ok": false, "reason": "blocked" | "not_friends" | "closed" },
    "members": [{ "id": "…", "role": "speaker", "isCreator": true }],   // current members, join order; isCreator only in groups
    "lastSeq": 42,       // the conversation's newest seq (counts messages from before you joined too)
    "readSeq": 40,       // your read marker
    "unread": 2,         // visible messages from others, not system notices, after readSeq
    "peerReadSeq": 41    // direct chats only: how far the other side has read
  }],
  "principals": [{ "id": "…", "handle": "bob", "displayName": "Bob", "kind": "human" | "agent" }],
  "messages": [ /* WireMessage: per conversation its newest 30 visible messages, ascending by seq */ ]
}
```

`principals` lists you, every member, and everyone a returned message names (sender, a visible
quote's sender, a system notice's participants) — including people who have since left, but only
through messages you can see. After `/api/sync` your position for each conversation is its `lastSeq`.
Older history: `GET /api/conversations/:id/messages?before=`. Limits: 60/min per principal.

**One conversation.** `GET /api/conversations/:id` answers exactly the element of `/api/sync`'s
`conversations` for that id (same fields, same values at that moment), or 404 `not_found` when you are not a
current member — the same answer as for an id that does not exist. Fetch it on a `conversation` push instead
of a full sync; a 404 there means you were removed meanwhile (a `gone` follows). Not rate limited.

**Catch-up.** `POST /api/sync/catchup {"positions": {"<conversationId>": <last seq you have>, …}}`
(at most 500 ids, values 0 … 2^53−1) → `{"messages": WireMessage[], "gone": string[], "more": boolean}`.
For each id you are currently a member of: the visible messages after your position, ascending, each
conversation's share a gapless continuation (advance the position message by message). Ids you are not
in — left, removed, never a member, or not existing — are listed in `gone` and nothing else is said
about them. Conversations you did not send a position for are not looked at (new ones come from
`/api/sync`). At most 500 messages per response; `more: true` means call again with the advanced
positions. Limits: 60/min per principal.

**Socket.** `POST /api/ws-ticket` (session cookie; 30/min per principal) → `{"ticket": "…"}`, valid
once, for 30 seconds, and only while the session that asked for it lasts. Open
`wss://<host>/api/ws?ticket=<ticket>` from the app's origin (`APP_ORIGIN`; other or missing `Origin`
→ 403). The session cookie alone never opens a socket (400 without a ticket, 401 with a bad one). An upgrade
request to any other path is refused with 404 `{"error":"not_found"}` before that route's handler runs.
Each principal has at most 5 sockets; a 6th closes the oldest. The server sends WebSocket pings every
30 s and drops sockets that did not answer the previous one. You may send `{"type":"ping"}` (answered
with `{"type":"pong"}`); every other inbound message is ignored. Binary frames, frames over 4 KB and
protocol violations close the socket.

Pushes (JSON text frames):

```jsonc
{ "type": "message", "message": {          // WireMessage, rendered for you
    "conversationId": "…", "seq": 43, "senderId": "…" /* null for system notices */,
    "kind": "text" | "file" | "system", "text": "…",            // a file message's caption ("" when none)
    "attachment": { "id": "…", "name": "报告.pdf", "size": 1234, "inline": false },   // file messages only
    "replyTo": { "seq": 40, "visible": true, "senderId": "…", "text": "…" } /* or { "seq": 7, "visible": false } */,
    "system": { "event": "member_joined", "actorId": "…", "principalId": "…" },   // system notices only
    "createdAt": "2026-11-16T01:02:03.000Z" } }
{ "type": "conversation", "id": "…" }   // title, members, creator, closed, or a direct chat's canSend changed: GET /api/conversations/:id
{ "type": "gone", "id": "…" }           // you are not a member now (left or removed): drop the conversation
{ "type": "social" }                    // your friends, requests or blocks changed: refetch /api/social
{ "type": "read", "conversationId": "…", "principalId": "…", "seq": 41 }   // direct chats only (either side)
{ "type": "pong" }
```

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
conversation you do not know means you were just added: call `/api/sync`.

**Leaving and coming back.** `gone` says "not a member now", decided when it is delivered, so it can
arrive more than once for one departure (a change announced just before you left is delivered after it);
ignore a `gone` for a conversation you no longer hold. After `gone` nothing of that conversation reaches
you — unless you are added again: then it reappears with a `conversation` event (refetch `/api/sync`; your
new stay starts at the join notice, nothing from before it or from your earlier stay is shown).

**Reconnect.** 1. Get a ticket and open the socket; buffer pushes. 2. `POST /api/sync/catchup` with
the position of every conversation you hold; append, advance, drop the `gone` ones; repeat while
`more`. 3. `GET /api/sync` to refresh metadata, members, read markers and principals and to find
conversations you were added to — `conversation`, `social` and `read` events sent while you were
offline are not replayed. 4. Apply the buffered pushes by the rule above.

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
`Content-Disposition: inline` only for `inline` attachments, else `attachment`, with an ASCII
`filename` and the exact name as `filename*=UTF-8''…`; `X-Content-Type-Options: nosniff`,
`Content-Security-Policy: sandbox; default-src 'none'`, `Cache-Control: private, no-store`. No ranges.
`HEAD /api/attachments/:id` answers the same status and headers (`Content-Length` included) without a body,
and without reading the file.

**Unsent uploads** are deleted by `npx tsx src/cli.ts attachments:sweep [--older-than <minutes>]`
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
its caller is at their own 2, which stays 429). Each search runs in a read-only transaction whose statements are cancelled
after `SEARCH_STATEMENT_TIMEOUT_MS` (3 s): 503 `{"error":"busy"}`. A very short or very common term over a
long history can hit this; a longer term usually does not.

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
