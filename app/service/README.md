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
`MAIL_MODE` (`outbox`), `RATE_LIMIT_SCALE` (multiplier for every rate limit, default 1).

`buildApp(deps?: Partial<Deps>)` takes `{ config, db }`; anything omitted is built from the
environment. Tests pass their own config (raised `RATE_LIMIT_SCALE`) and a pool on `TEST_DATABASE_URL`.

## Tests

`vitest` global setup runs the migrations once on `TEST_DATABASE_URL`. `useApp()` in
`tests/helpers/harness.ts` builds the app once per file and truncates every table except
`pgmigrations` before each test. Test files run serially because they share one database.

## Accounts (`src/auth/`, `src/session.ts`)

Better Auth (e-mail + password, verified e-mail required, 7-day sessions) mounted at `/api/auth/*`;
only these endpoints are exposed: `POST /sign-in/email`, `POST /sign-out`, `GET /verify-email`,
`POST /request-password-reset`, `POST /reset-password`. Registration is `POST /api/register`
(invite code unless `REGISTRATION_MODE=open`). `GET /api/me` returns the signed-in principal.
Mail goes to the `mail_outbox` table. CLI: `npx tsx src/cli.ts invite:create [--ttl-hours n]` / `inbox:list [--to <email>]`.
Set `TRUST_PROXY=true` only behind a reverse proxy you control (IP rate limits then trust `X-Forwarded-For`).

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
    "id": "…", "type": "direct" | "group", "title": "team" /* null in direct chats */, "creatorId": "…",
    "myRole": "speaker" | "observer", "closed": false,
    "peerId": "…",                                   // direct chats only
    "canSend": { "ok": true } | { "ok": false, "reason": "blocked" | "not_friends" | "closed" },
    "members": [{ "id": "…", "role": "speaker", "isCreator": true }],   // current members, join order
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
→ 403). The session cookie alone never opens a socket (400 without a ticket, 401 with a bad one).
Each principal has at most 5 sockets; a 6th closes the oldest. The server sends WebSocket pings every
30 s and drops sockets that did not answer the previous one. You may send `{"type":"ping"}` (answered
with `{"type":"pong"}`); every other inbound message is ignored. Binary frames, frames over 4 KB and
protocol violations close the socket.

Pushes (JSON text frames):

```jsonc
{ "type": "message", "message": {          // WireMessage, rendered for you
    "conversationId": "…", "seq": 43, "senderId": "…" /* null for system notices */,
    "kind": "text" | "file" | "system", "text": "…",
    "replyTo": { "seq": 40, "visible": true, "senderId": "…", "text": "…" } /* or { "seq": 7, "visible": false } */,
    "system": { "event": "member_joined", "actorId": "…", "principalId": "…" },   // system notices only
    "createdAt": "2026-11-16T01:02:03.000Z" } }
{ "type": "conversation", "id": "…" }   // title, members, creator, closed, or a direct chat's canSend changed: refetch /api/sync
{ "type": "gone", "id": "…" }           // you left or were removed: drop the conversation; nothing more of it follows
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

**Reconnect.** 1. Get a ticket and open the socket; buffer pushes. 2. `POST /api/sync/catchup` with
the position of every conversation you hold; append, advance, drop the `gone` ones; repeat while
`more`. 3. `GET /api/sync` to refresh metadata, members, read markers and principals and to find
conversations you were added to — `conversation`, `social` and `read` events sent while you were
offline are not replayed. 4. Apply the buffered pushes by the rule above.
