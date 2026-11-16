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
npm run attachments:sweep -- [--older-than <min>]   # unsent uploads and abandoned blobs (by hand; the server does it itself)
npm run credits:grant -- --handle <h> --points <n> [--note <text>]   # n: decimal, up to 6 fraction digits, may be negative (an adjustment); prints the new balance
npm run credits:show -- --handle <h>                # a person's tier and points balance (an Agent's handle is refused)
npm run tier:set -- --handle <h> --tier <name>      # a tier named in AGENT_TIERS
npm run models:list                                 # the site models: id, label, tier, protocol, prices (never the key)
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
npm run credits:grant:prod -- --handle <h> --points <n> [--note <text>]   # likewise credits:show:prod, tier:set:prod, models:list:prod
```

Deploy `dist/`, `migrations/`, `package.json` and `package-lock.json` together: the build looks for
`../migrations` from `dist/`. `tests/build.test.ts` keeps `npm start` and the `:prod` scripts on `node dist/…`
and every run-time import of `src/` a production dependency.

## Configuration (`src/config.ts`)

`DATABASE_URL`, `APP_ORIGIN`, `AUTH_SECRET` (>= 32 chars), `BLOB_DIR`, `PORT`,
`PROVIDER_KEY_SECRET` (**required**, >= 32 chars: encrypts users' provider API keys at rest; the service refuses to start without it, and changing it makes stored keys unreadable:
a provider's test and refresh then answer 500 and the log says why, until its owner saves the key again with `PATCH`; keep the secret with the database backups),
`SITE_MODELS` (the models the site offers: a JSON array, default none; each entry has `id`, `label`, `tier` `free`|`paid`, `protocol`
`openai_chat`|`openai_responses`|`anthropic`|`gemini`, `baseUrl`, `apiKeyEnv` (the name of another variable that holds the upstream key, so the JSON carries
no secret; start-up fails naming it if unset), `model`, `inputMicroPerToken`, `outputMicroPerToken` (whole micro-points), `maxOutputTokens`, `contextTokens`,
`vision`, `pdf`, `reasoning` (levels from `low`..`max`)), `FREE_DAILY_POINTS` (free daily allowance of site-model use, whole points, default 200),
`SITE_TIMEZONE` (IANA name whose midnight starts a new allowance day, default `Asia/Shanghai`), `AGENT_TIERS` (JSON, Agents allowed per account tier, must
contain `free`, default `{"free":20}`),
`HOST` (the address to listen on: an IPv4/IPv6 address or `localhost`, default `0.0.0.0`, every interface; `127.0.0.1` for local-only),
`WEB_DIST` (optional: directory of the built web client to serve, see Deployment; unset serves none),
`S3_*` (optional, all-or-none), `REGISTRATION_MODE` (`invite` | `open`, default `invite`),
`MAIL_MODE` (`outbox`), `RATE_LIMIT_SCALE` (multiplier for every rate limit, default 1),
`CLIENT_IP_HEADER` / `TRUST_PROXY` (where the client's address comes from; see Deployment),
`ATTACHMENT_QUOTA_BYTES` (attachment bytes one principal may store, default 2 GiB),
`SWEEP_INTERVAL_MINUTES` (how often the server runs the attachment sweep, whole minutes, default 15, `0` turns it off, at most 1440),
`UPLOAD_IDLE_TIMEOUT_MS` / `UPLOAD_TOTAL_TIMEOUT_MS` (an upload is cut off after 45 s without body bytes or
15 min in all), `HTTP_BODY_TIMEOUT_MS` (the body deadline, default 30 s: a request with a body must have arrived
whole this long after its head, or its connection is closed without an answer — armed on the HTTP server's own
`request` event, so it holds whatever answers the request: a route, a refusal before any route (a foreign
`Origin`, an undecodable path, an over-long parameter), an unknown route, and also when the answer already went
out but the client is still sending; `src/body-deadline.ts`; the two uploads are lifted
out of it once they let a body in: an attachment upload when its checks have passed and its own deadlines start, an
avatar upload when its sender is signed in), and the server-wide `HTTP_CONNECTION_TIMEOUT_MS` (socket idle,
default 2 min), `HTTP_REQUEST_TIMEOUT_MS` (whole request, default the upload total + 1 min; with the body
deadline it only matters for the uploads) and `HTTP_KEEP_ALIVE_TIMEOUT_MS` (default 72 s). The server-wide ones
must be longer than the upload deadlines (checked at start-up), so attachment uploads are governed by their own
deadlines and a signed-in avatar upload by the server-wide ones; WebSockets are subject to none of them (an
upgrade has no body).
`DB_STATEMENT_TIMEOUT_MS` (default 30 s) is Postgres' `statement_timeout` on every connection of the app's
pool (and of the CLI's): a statement running longer, lock waits included, is cancelled and the request
answered 503 `busy`. Only statements count, not the time between them, so a long upload or a sweep deleting
blobs is not cut off; migrations run on their own connection and are not subject to it.
`SEARCH_STATEMENT_TIMEOUT_MS` (default 3 s) is the same for each search (see Search).
`DB_ACQUIRE_TIMEOUT_MS` (default 10 s): the pool has 10 connections; a request that cannot get one within
this long (or whose new connection takes longer to open) is answered 503 `busy`.
An invalid value stops the service at start-up with a message naming the variable.

`buildApp(deps?: Partial<Deps>, options?: { logStream, sweepInitialDelayMs, answerFloor, allowInsecureLocal, agentWorker })` takes `{ config, db }`;
anything omitted is built from the environment. Tests pass their own config (raised `RATE_LIMIT_SCALE`) and a pool
on `TEST_DATABASE_URL`. `answerFloor` (`{ ms, jitterMs }`, default 400 ms + up to 50 ms) is how long a
registration's and a reset request's success answer takes at least (see those routes); it is a build option, not
configuration, and only tests change it. So is `allowInsecureLocal` (default off; no variable can turn it on): with it,
providers may also be reached at loopback addresses, and over plain `http:` there, so tests can stand up a local stub.
`Deps.providerProbe` is how the provider test and refresh routes reach a provider (default: through the address guard).
`Deps.models` is how the service talks to a language model (default: the model gateway, see Calling a model); tests
inject a scripted one (`scriptedGateway()` in `tests/helpers/models.ts`). `agentWorker: false` (tests only) turns the
reply worker's background loop off: replies then run only when the test calls `app.agentWorker.runOnce()` (claims the
oldest queued reply and runs it to its end; false when none is queued) or `drain()` (see Agents and runs).

## Deployment

**Build and start.** See Commands: `npm run build`, `npm run migrate:prod`, `npm start`.

**Web client (`WEB_DIST`).** Unset (the default) the service serves only the API, and every other path is
the JSON 404. Set to the directory of the built web client (`app/web/dist`: `index.html` and `assets/`; start-up
fails naming `WEB_DIST` if the directory has no `index.html`), the service serves it from the same origin
(`src/web.ts`, `@fastify/static`):

- A `GET`/`HEAD` for a file in the directory returns it; any other extensionless `GET`/`HEAD` outside
  `/api/` and `/assets/` returns `index.html` (200), so the client's router can take `/signin`,
  `/some/deep/path`, …. A path that matches no file and is under `/assets/` or whose last segment has an
  extension (`/assets/old-chunk.js`, `/sw.js`) is `404 {"error":"not_found"}` with `Cache-Control: no-store`,
  never the page (a stale tab's `import()` of a removed chunk must fail plainly, and no proxy may keep HTML
  under a `.js` URL). Paths under `/api/` never fall back either. Other methods outside `/api/` are that JSON
  404 too. No directory listings, no dotfiles (`/.env`), nothing outside the directory (`..` in any
  encoding): such paths match no file (404 if they have an extension, else `index.html`).
- `Cache-Control`: `public, max-age=31536000, immutable` only for files under `/assets/` whose name carries
  Vite's content hash (`index-CdhHuwFq.js`: `-` and 8 base64url characters including a capital letter);
  `no-cache` for `index.html` and every other file, including the unhashed copies of `public/assets/`.
- Every file and page response carries `Content-Security-Policy: default-src 'self'; img-src 'self' data: blob:;
  style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self';
  form-action 'self'; frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`,
  `X-Frame-Options: DENY`, `Permissions-Policy: camera=(), microphone=(), geolocation=()` and, when
  `APP_ORIGIN` is `https`, `Strict-Transport-Security: max-age=15552000`. `connect-src` additionally names
  the WebSocket origin derived from `APP_ORIGIN` (`wss://host` for https, `ws://host` for http), because older
  Safari does not match a same-host WebSocket with `'self'`; the CSP string above shows it without that.
- Independent of `WEB_DIST`: every API response carries `X-Content-Type-Options: nosniff`, and API JSON
  `Cache-Control: no-store` unless the route sets its own (attachments `private, no-store`, avatars
  `private, max-age=60`).
- The file route is a single wildcard registered after the API and left out of the route reference above
  (and of `app.routeList`, which lists API routes only); the Origin check, rate limits and the WebSocket
  upgrade are unaffected.

**One instance.** Run exactly one instance of the service (one replica, no cluster mode); see Sync and
realtime for why and what scaling out would take.

**Client address.** Registration and the sign-in / reset-request limiters count requests per client
address (`clientIp` in `src/limits.ts`, which the request log shows as `remoteAddress` too). By default
that is the address of the TCP connection and nothing a client sends is believed. Behind a proxy every
request comes from the proxy, so tell the service where the real address is:

- `CLIENT_IP_HEADER=<header name>` — a header the proxy sets to the client's address, replacing any value
  the client sent. On Railway: `CLIENT_IP_HEADER=x-real-ip`. Used when it holds exactly one address;
  absent, empty, several values or not an address → the connection's address, and the first such request
  writes one warning to the log naming the header (once per process), so a proxy that does not set it shows.
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

**Sweeping.** The server sweeps unsent uploads and abandoned blobs itself (see Attachments, `SWEEP_INTERVAL_MINUTES`); no cron is needed. `npm run attachments:sweep:prod` remains for running it by hand.

## Tests

`vitest` global setup runs the migrations once on `TEST_DATABASE_URL`. `useApp()` in
`tests/helpers/harness.ts` builds the app once per file (without an answer floor unless the file asks for one,
`tests/answer-floor.test.ts`) and truncates every table except `pgmigrations` before each test. Its `env` is also put
in `process.env` while the file runs (a site model's key is read from there when called). Test files run
serially because they share one database. Tests never call a real model: rule tests inject `scriptedGateway()`, and
the gateway's own tests talk to `protocolStub()`, a local server speaking the four protocols' wire formats
(`tests/helpers/models.ts`). `useApp({ agentWorker: false })` drives the reply worker by hand (`app.agentWorker.runOnce()`);
files that insert queued runs themselves use it too, so no background worker picks them up.

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
  runs the `GET` handler). `HEAD /api/attachments/:id` and `HEAD /api/principals/:id/avatar` are their own routes (below): they do not read the whole file.
- **Order of checks.** Cross-site `Origin` (403) → shape of path, query and body (400) → session (401) →
  rate limit (429) → the route's own rules. Registration counts its rate limit before checking the shape,
  and so do the sign-in, reset-request and verification-link limiters in front of Better Auth.

### Errors

Every error body is `{"error": "<snake_case_code>"}`, sometimes with details next to it: strings (`reason`,
`resetsAt`), or for `provider_in_use` the list `agents`. Shared codes:

| Status | `error` | Meaning |
|---|---|---|
| 400 | `invalid_request` | Malformed or not acceptable input (also 414 for an over-long path parameter, 415 for an unsupported content type) |
| 401 | `unauthenticated` | No valid session (or a WebSocket ticket that is unknown, used or expired) |
| 402 | `no_quota` | A site-model call cannot start: nothing is left to pay for it (see Usage and points). `reason` `free_and_balance` (a free-tier model: today's free allowance and the balance are both used up; `resetsAt`, the next midnight in `SITE_TIMEZONE`, ISO instant) or `balance` (a paid-tier model: no balance) |
| 403 | `forbidden` | Cross-site request, or not allowed by the route's rule (e.g. only the creator renames) |
| 403 | `cannot_send` | With `reason`: `blocked` or `not_friends` (a direct chat whose pair cannot write to each other), or `agent_deleted` (an Agent's conversation after the Agent was deleted: sending, uploading, starting a new topic) |
| 403 | `agent_limit` | Creating an Agent with as many undeleted Agents as the account's tier allows |
| 409 | `agent_deleted` | Editing, pausing, resuming or changing the avatar of a deleted Agent, or retrying its reply |
| 409 | `agent_paused` | Retrying the reply of a paused Agent |
| 409 | `busy_run` | Retrying while a reply of that Agent is already queued or running |
| 409 | `provider_in_use` | Deleting a provider that Agents still use; `agents: [{"id", "name"}]` names them |
| 400 | `address_not_allowed` | A call to a provider refused by the address guard: not `https`, credentials in the URL, or an address that is not public (see Model providers) |
| 502 | `provider_rejected` | The provider refused the key (it answered 401 or 403) |
| 502 | `provider_unavailable` | The provider could not be reached or gave no usable answer: another status, a redirect, a timeout, a body over the limit, not JSON |
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
| `GET /api/auth/verify-email` | 10 per client address + the e-mail the link names, and 60 per client address (counters of its own) | address (+ e-mail) |
| `GET /api/principals/lookup` | 30 | principal |
| `PATCH /api/me` | 10 | principal |
| `PUT /api/me/avatar` | 10 | principal |
| `POST /api/agents`, `PATCH`, `DELETE` + `POST …/pause`, `…/resume` + `PUT …/avatar` of `/api/agents/:id`, `POST /api/conversations/:id/topic` | 30 together | principal |
| `POST /api/providers`, `PATCH` + `DELETE /api/providers/:id` | 20 together | principal |
| `POST /api/providers/:id/test` + `POST /api/providers/:id/models/refresh` (they call the provider) | 10 together | principal |
| `POST /api/friend-requests` | 20 | principal |
| `PUT` + `DELETE /api/blocks/:principalId` | 20 together | principal |
| `POST /api/conversations` | 10 | principal |
| `PATCH /api/conversations/:id`, `POST /api/conversations/:id/members`, `DELETE /api/conversations/:id/members/:principalId` | 20 together | principal |
| `POST /api/conversations/:id/messages` | 120 | principal |
| Replies started (each message that queues a reply of one of your Agents, and `POST …/runs/retry`) | 20 together, counted from the stored runs and not scaled by `RATE_LIMIT_SCALE`; over it a message queues no reply (the message is still sent) and a retry is 429 | owner |
| `GET /api/conversations/:id/run` | 120 | principal |
| `POST /api/conversations/:id/runs/:runId/stop`, `…/runs/retry`, `…/runs/dismiss` | 60 together | principal |
| `GET /api/conversations/:id/search` + `GET /api/search` | 30 together; at most 2 in progress per principal (429) and 4 site-wide (503 `busy`) | principal |
| `POST /api/conversations/:id/attachments` | 60 per hour; at most 3 in progress | principal |
| `GET /api/sync` | 60 | principal |
| `GET /api/conversations/:id` | 120 | principal |
| `POST /api/sync/catchup` | 60 | principal |
| `POST /api/ws-ticket` | 30 | principal |
| WebSockets | at most 5 open; a 6th closes the oldest (code 4002) | principal |

Everything else is not rate limited.

### Usage and points

Money is whole micro-points inside (1 point = 1 000 000) and a decimal string of points on the wire: `"12.5"`,
`"0.000001"`, `"-2"` (a balance may go below zero by one reply's cost). No floats. Points are given only by the
operator (`npm run credits:grant`, to a person's handle; an Agent's handle is refused): there is no route that
changes a balance or a tier, and `POST`/`PUT`/`PATCH`/`DELETE` on `/api/usage`, `/api/credits` and `/api/accounts`
are the JSON 404.

**What a model call costs** (`src/metering/`). A call on a provider model costs nothing and needs no points (it is
still recorded). A call on a site model is admitted before it starts and settled when it ends:

- **Admission** decides, once, the one source the call is charged to, and holds against that source the most the call
  can cost until it is settled: its input estimate (one token per character, high on purpose for Latin text; 1 500
  per image; 300 per KB of PDF) plus the model's whole output limit, at the model's prices. A free-tier model is
  charged to today's free allowance while what is left of it, less what your running calls hold against it, is above
  zero; otherwise to the balance, by the same rule; a paid-tier model only to the balance. With neither, the call does
  not start: `no_quota` (402) with `reason` `free_and_balance` and `resetsAt`, or `reason` `balance`. The run records
  the model it was admitted on with its source and hold, and settlement goes by that, whatever the Agent's model is by
  then.
- **Settlement** works out what the call cost: the tokens the upstream reported (reasoning counts as output), or, when
  it reported none, one token per character (images and PDFs at their estimate, as at admission), and the record says
  `estimated`, at the model's price. A call that failed
  without any output costs nothing, and so does a reply that could not be stored for the service's own reasons (run
  error `busy`): its record keeps the true cost, all of it forgiven. It charges that cost, but never more than the call held at admission: whatever is
  above the hold (an estimate that turned out low) is forgiven, charged to no one — neither the balance nor any day's
  allowance. A call on the allowance uses the allowance of the site day it ends in (one that starts before midnight and
  ends after it uses the new day's); whatever of its charge exceeds what is left of that day's allowance is forgiven
  too: charged neither to the balance nor to the next day. A call on the balance is charged in full (up to its hold)
  and may take the balance below zero; at or below zero nothing more starts on the balance until the operator's grants
  bring it above zero.
- So however many replies you start at once, the free overrun forgiven in a day and the debt on the balance are each
  less than one call's maximum cost (`tests/metering-concurrency.test.ts`, also with every call costing far more than it
  held).
- Every call appends one usage record (who, which Agent, which source and model, tokens, the true cost, and how much of
  it the allowance, the balance and forgiveness took, outcome; a run that ended before it was admitted leaves a record
  with neither source nor model, costing nothing); every change of a balance one ledger entry: `grant` and
  `adjust` (the operator giving points, or taking them back with a negative `credits:grant`) and `usage` (a call, linked
  to its record). A balance always equals the sum of its ledger.

#### `GET /api/usage`

*Session: required.* Your own account, and nothing else: the route takes no parameter (any query string is 400
`invalid_request`). → 200 `{"tier", "agentLimit", "agentCount", "balance", "free": {"allowance", "used", "resetsAt"},
"canStartFreeReply", "recent": [{"agentId", "model", "source", "points", "replies"}]}`.

- `tier` is the account's tier (`free` until the operator sets another); `agentLimit` is what `AGENT_TIERS` allows it
  (a tier the configuration no longer names gets the `free` limit); `agentCount` is your Agents that are not deleted.
- `balance` is the points balance. `free.allowance` is `FREE_DAILY_POINTS`, `free.used` what today's site-day has used,
  `free.resetsAt` the next midnight in `SITE_TIMEZONE` (ISO instant).
- `canStartFreeReply`: whether a reply on a free-tier model would be admitted now: what is left of today's free
  allowance, or of the balance, after what your running calls hold against it, is above zero (admission's own rule,
  read at that moment).
- `recent`: the last 7 site-days (today included) summed per Agent, model and source: `model` is the site model's `id`
  or the provider model's name, `points` what the calls cost (`"0"` for `provider`), `replies` how many were replies;
  `agentId` is `null` for persona drafts. Largest first. Runs that never reached a model (no model recorded) are not
  listed.
- An account that has never been touched reads as tier `free`, balance `"0"`; reading creates nothing.

### Agents

An Agent is a principal of kind `agent` owned by one person for good, with a dedicated conversation (type `agent`)
whose members are exactly the owner and the Agent. Everything here is the owner's: for anybody else every
`/api/agents/:id…` route, and the conversation routes of that conversation, answer the JSON 404 `not_found`
byte for byte as for an id that does not exist. An Agent's handle is unknown to `GET /api/principals/lookup` and
`POST /api/friend-requests` (also for its owner), and its id cannot be put into a group: refused exactly as the id of a non-friend or an unknown principal is (403 `forbidden`).

**Agent** (owner only): `{"id", "handle", "name", "intro", "field", "persona", "personaVersion", "replyMode":
"always" | "mention", "reasoning": "none" | "low" | "medium" | "high" | "xhigh" | "max", "model": {"source": "site", "id"} |
{"source": "provider", "providerId", "model"} | null, "paused", "deleted", "conversationId", "createdAt"}`.

#### `POST /api/agents`

*Session: required.* Body (no other key): `handle` (`^[a-z0-9_]{3,24}$`, never changes), `name` (1–20 characters,
the display-name rule), and optionally `intro` (≤ 40), `field` (≤ 20), `persona` (≤ 20 000 characters), `replyMode`
(default `always`), `reasoning` (default `none`), `model` (default `null`). → 201 Agent.

- 409 `handle_taken` (any person's or Agent's handle); 403 `agent_limit` when your Agents that are not deleted are
  as many as `AGENT_TIERS` gives your tier (a tier it no longer names gets the `free` number; counted under the
  account lock, so concurrent creates cannot pass it); 400 for a site `model` id that is not configured, a provider
  that is not yours or does not list that model name, or a `reasoning` the model does not allow (a site model: `none`
  and its own levels; a provider model: `none` only unless it is flagged `reasoning`; with no model any level).
- The conversation is created with the Agent: without a `persona` it holds one message from the Agent, the fixed
  greeting, which is unread for you like any message from someone else. `personaVersion` is 1 when a persona was given.

#### `GET /api/agents`

*Session: required.* → 200 `{"agents": [Agent]}`: yours, oldest first, deleted ones included (`deleted: true`).

#### `GET /api/agents/:id`

*Session: required.* → 200 Agent (also a deleted one); 404 `not_found` unless yours.

#### `PATCH /api/agents/:id`

*Session: required.* Body (no other key: `handle` and the owner are 400): any of `name`, `intro`, `field`,
`persona`, `replyMode`, `reasoning`, `model` (`null` clears it), under the rules of creation; the model and the
reasoning level are checked together when either is sent. A `persona` that differs from the stored one raises
`personaVersion` by one. → 200 Agent; 409 `agent_deleted`.

#### `POST /api/agents/:id/pause`

*Session: required.* Pauses the Agent (idempotent). → 200 Agent; 409 `agent_deleted`. You can still write to a paused Agent;
it does not reply. Its reply in progress ends for good, decided in the pause's own transaction: a queued one is
`cancelled` at once (`run` pushed), a running one is never posted — also if you resume before the model has finished —
and ends `cancelled`; once this answers, nothing more from the Agent is posted and no further `delta` of that reply
reaches you (see Agents and runs). Resuming starts nothing: what was written during the pause is not answered; your next
message is, with everything before it in what the Agent is shown.

#### `POST /api/agents/:id/resume`

*Session: required.* Resumes it (idempotent). → 200 Agent; 409 `agent_deleted`.

#### `DELETE /api/agents/:id`

*Session: required.* Deletes the Agent: irreversible and idempotent (a deleted Agent no longer counts toward the limit; its
conversation and history stay readable, sending there is 403 `cannot_send` `{"reason": "agent_deleted"}`; its reply in
progress ends as on a pause, with `agent_deleted`). → 200 Agent.

#### `PUT /api/agents/:id/avatar`

*Session: required.* The rules and limits of `PUT /api/me/avatar`, for the Agent. → 200 `{"ok": true}`; 409 `agent_deleted`.
Every avatar change (people's too) raises `principals.avatar_version`.

### Replies

An Agent's replies in its conversation, as runs (how they start, end and fail: Agents and runs below). Every route
here is the owner's and takes the conversation id: for anybody else, for a conversation that is not an Agent's, and
for a run of another conversation, it answers the JSON 404 `not_found` byte for byte as for an id that does not exist.
Failures are never messages: they live on the run, which the owner learns from the `run` push and from
`GET /api/conversations/:id/run`.

**Run**: `{"id", "status": "queued" | "running" | "done" | "failed" | "stopped" | "cancelled", "error"?, "retryable",
"resetsAt"?}`. `error`: for `failed` why (`provider_rejected`, `provider_unavailable`, `address_not_allowed`, `no_quota`,
or `busy`: the service's own trouble — the reply could not be started or stored, or there was nothing to answer — which
costs you nothing), for
`cancelled` `agent_paused` or `agent_deleted`. `retryable`: it failed and trying again as it is may work (false
after `provider_rejected` and `address_not_allowed`, and for every run that did not fail). `resetsAt` (ISO instant): for
`no_quota` on a free-tier model, the next midnight in `SITE_TIMEZONE`, when the free allowance starts again.

#### `GET /api/conversations/:id/run`

*Session: required.* → 200 `{"run": Run | null}`: the conversation's latest run — so a page loaded during a reply shows
"replying", and one loaded after a failure shows it — or null when there is none, or when the latest failed and you
dismissed it. Limit: 120 per minute.

#### `POST /api/conversations/:id/runs/:runId/stop`

*Session: required.* Body: none or `{}`. Stops the reply: a queued one at once (it never reaches the model; `run`
`stopped` is pushed); a running one as soon as the worker notices (within 50 ms): what it had said so far is posted
with `stopped: true` and the run ends `stopped` (nothing said: no message). A run that has ended is left as it is.
Idempotent. → 200 `{"ok": true}`. Limit: 60 per minute with retry and dismiss.

#### `POST /api/conversations/:id/runs/retry`

*Session: required.* Body: none or `{}`. When the latest run failed, queues a new reply answering up to your last
message. → 201 `{"run": Run}` (queued; also pushed). 409 `busy_run` while a reply is queued or running; 409
`agent_paused` / `agent_deleted`; 400 `invalid_request` when the latest run did not fail (or there is none) or the
Agent has no model; 429 `rate_limited` over the replies one may start a minute (20). Limit: 60 per minute with stop
and dismiss.

#### `POST /api/conversations/:id/runs/dismiss`

*Session: required.* Body: none or `{}`. You closed the failure notice: when the latest run failed,
`GET /api/conversations/:id/run` answers `null` from now on (until the next run). Otherwise nothing changes.
Idempotent. → 200 `{"ok": true}`. Limit: 60 per minute with stop and retry.

#### `POST /api/conversations/:id/topic`

*Session: required.* Body: none or `{}`. Starts a new topic (spec 6.2 "新话题"): a `topic_reset` notice from you is
appended (see System notices), and from then on the Agent's replies are given only what comes after the latest such
notice (Agents and runs). History, search and unread counts are unchanged; two in a row are fine. → 201
`{"message": WireMessage}` (the notice; it is also pushed). Allowed while the Agent is paused; 403 `cannot_send`
`{"reason": "agent_deleted"}` once it is deleted. It starts no reply, and a reply already under way goes on with what it
was given (the old topic). Limit: 30 per minute with the Agent writes.

### Model providers

A provider is a person's own account at a model service, which their Agents can answer with
(`"model": {"source": "provider", "providerId", "model"}`). Everything here is the owner's: for anybody else every
`/api/providers/:id…` route answers the JSON 404 `not_found` byte for byte as for an id that does not exist, and an
Agent cannot be pointed at their provider (400).

**Provider** (owner only): `{"id", "name", "protocol": "openai_chat" | "openai_responses" | "anthropic" | "gemini",
"baseUrl", "keyLast4", "models": [{"name", "vision", "pdf", "reasoning", "contextTokens"}]}`.

- **The API key** is sealed when saved (AES-256-GCM, a key derived from `PROVIDER_KEY_SECRET` with HKDF-SHA-256,
  `src/providers/crypto.ts`) and never shown again: no answer, push, error or log line carries it; `keyLast4` is its
  last four characters. It is opened only to make a call to that provider.
- **`baseUrl`** must be `https:`, without credentials (no `@` before the host), with a plain DNS name or an IP address as
  host and any port from 1 to 65535. It is stored without query, fragment or trailing slash (`https://API.example.com:443/v1/?x`
  is `https://api.example.com/v1`). Saving checks only that; the address is checked at every call (below).
- **Models**: at most 100; `name` 1–100 characters, one line, trimmed, unique within the provider; `vision`, `pdf` and
  `reasoning` default to false and `contextTokens` (1 000–2 000 000) to 16 000. An Agent may use only a listed model, and a
  reasoning level other than `none` only on a model flagged `reasoning`. Removing a model from the list does not change
  the Agents that use it.

**The address guard** (`src/providers/guard.ts`), at every call to a provider, before any connection: the URL must pass
the `baseUrl` rules; the host name is looked up once, and the call is refused with `address_not_allowed` if any address
it resolves to (or the address written in the URL) is not public: loopback, private (10/8, 172.16/12, 192.168/16,
fc00::/7), link-local (169.254/16, fe80::/10, fec0::/10), carrier-grade NAT (100.64/10), unspecified or `0/8`,
192.0.0/24, benchmarking (198.18/15), multicast (224/4, ff00::/8), reserved and broadcast (240/4), or an IPv4-mapped,
IPv4-compatible, NAT64 (`64:ff9b::/96`, `64:ff9b:1::/48`) or 6to4 form of one. The connection then goes to exactly an
address that was checked (the name stays the Host header and the TLS server name), so a name that resolves differently
a moment later changes nothing. Redirects are never followed (any 3xx is `provider_unavailable`), and a call is given up
(`provider_unavailable`) after a set time without progress (until the headers, from the headers to the first byte of
the body, then between body chunks) or once its answer passes a set size: for test and refresh below, 15 s (and 30 s
in all) and 2 MiB; for a model's answer, see Calling a model. At most 16 calls to providers and site models are in
flight at once in the whole service, from before the name lookup until the answer is read or abandoned; one more is
`provider_unavailable` at once. A call stopped by its caller closes its connection at once.

#### `POST /api/providers`

*Session: required.* Body (no other key): `name` (1–40 characters, one line, trimmed), `protocol`, `baseUrl` (at most
1000 characters), `apiKey` (trimmed, then 8–1000 printable ASCII characters without spaces), and optionally `models`
(`[{"name", "vision"?, "pdf"?, "reasoning"?, "contextTokens"?}]`). → 201 Provider.

- 400 `provider_limit` when you already have 10 providers (counted under the account lock, so concurrent creates
  cannot pass it); 409 `name_taken` when one of yours has that name.

#### `GET /api/providers`

*Session: required.* → 200 `{"providers": [Provider]}`: yours, oldest first.

#### `PATCH /api/providers/:id`

*Session: required.* Body (no other key; `protocol` cannot change and is 400 too): any of `name`, `baseUrl`, `apiKey` (sealed
anew; without it the stored key stays), `models` (replaces the list), under the rules of creation. → 200 Provider;
409 `name_taken`.

#### `DELETE /api/providers/:id`

*Session: required.* → 200 `{"ok": true}`; 409 `{"error": "provider_in_use", "agents": [{"id", "name"}]}` while Agents
of yours that are not deleted use it (deleted Agents that still name it lose their model). It is locked while checked,
so no Agent can take it in the meantime.

#### `POST /api/providers/:id/test`

*Session: required.* One authenticated `GET {baseUrl}/models` through the guard, the key in the protocol's own header
(`Authorization: Bearer` for the OpenAI protocols; `x-api-key` and `anthropic-version: 2023-06-01` for Anthropic;
`x-goog-api-key` for Gemini). → 200 `{"ok": true}`, or `{"ok": false, "error": "provider_rejected" | "provider_unavailable" |
"address_not_allowed"}`: 401 or 403 is `provider_rejected`; anything else that is not a 200 with a JSON body
`provider_unavailable`. Only the code is passed on: nothing of the provider's answer reaches you or the log, which
records the provider id, protocol, code and the provider's HTTP status.

#### `POST /api/providers/:id/models/refresh`

*Session: required.* The same request; the model names in its answer (`data[].id`, or `models[].name` without the
`models/` prefix for Gemini; the one page the endpoint returns) are merged into `models`: models already there keep
their flags, new names get the defaults, up to 100 in all. Only the first 1 000 entries of the list are looked at, so
`listed` holds at most 1 000 names; among them, names that would not be accepted as a model name, any containing the
key, and repeats are skipped. → 200 `{"listed": [the names it gave], "provider": Provider}`; 502 `provider_rejected`
or `provider_unavailable`, 400 `address_not_allowed` (then nothing changes).

### Calling a model

Every model call goes through one gateway (`src/models/gateway.ts`, `Deps.models`), for site models and providers
alike: `resolveModel` (`src/models/resolve.ts`) turns an Agent's choice into the call — for a site model its upstream,
model name, output limit, price and tier, the key read from the variable its `apiKeyEnv` names at that moment; for a
provider model the owner's provider with its key opened, the model's flags and the default output limit for provider
models (2048 tokens) — or into nothing to call (no model, a site model no longer configured or its key variable unset,
a provider or model gone).
The gateway uses the Vercel AI SDK 7 (`ai` with `@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/google`; `streamText`
only: no hosted gateway, telemetry off, no automatic retry, nothing printed by the SDK), every request through the
address guard.

**Where it goes.** The stored `baseUrl` is the SDK's base URL as it is; each protocol appends its own path, so a service
offering all four under `https://host/v1` is reached with `baseUrl` `https://host/v1` for each:

| Protocol | Request | Key |
|---|---|---|
| `openai_chat` | `POST {baseUrl}/chat/completions` (OpenAI Chat Completions, streamed) | `Authorization: Bearer` |
| `openai_responses` | `POST {baseUrl}/responses` (OpenAI Responses, streamed) | `Authorization: Bearer` |
| `anthropic` | `POST {baseUrl}/messages` (Anthropic Messages, streamed) | `x-api-key`, `anthropic-version: 2023-06-01` |
| `gemini` | `POST {baseUrl}/models/{model}:streamGenerateContent?alt=sse` | `x-goog-api-key` |

(The vendors' own base URLs: `https://api.openai.com/v1`, `https://api.anthropic.com/v1`,
`https://generativelanguage.googleapis.com/v1beta`.)

**What is sent.** The system text (left out when empty); the turns, a person's as `user` with their text, images and
PDFs (a PDF as a file with its name; what the model is shown is decided before the call), the Agent's as `assistant`
text (a file in one is sent as `[文件：{name}]`, an image as `[图片]`); the output limit. Every `openai_responses` call
also sends `store: false`, so OpenAI keeps no copy of the response (nothing here refers to an earlier one; with a
reasoning level the SDK then also asks for `include: ["reasoning.encrypted_content"]`). Reasoning, by level
(`REASONING_PARAMS`, one table), on the wire:

| Level | `openai_chat` | `openai_responses` | `anthropic` | `gemini` |
|---|---|---|---|---|
| `none` | nothing | nothing | `thinking: {type: "disabled"}` | nothing |
| `low` … `xhigh` | `reasoning_effort: <level>` | `reasoning: {effort: <level>, summary: "auto"}` | `thinking: {type: "adaptive", display: "summarized"}`, `output_config: {effort: <level>}` | `generationConfig.thinkingConfig: {thinkingLevel: <level>, includeThoughts: true}` |
| `max` | as `xhigh` | `effort: "max"` | `effort: "max"` | as `xhigh` |

A level a protocol cannot express is its nearest lower one. `none` turns thinking off where the protocol can, and is
left out otherwise: Gemini's thinking levels cannot turn it off, and OpenAI refuses `reasoning_effort` from models that
do not reason (which are the ones sent `none`). With any other level an OpenAI model is treated as one that reasons:
the system text goes as a `developer` message, and Chat Completions sends the limit as `max_completion_tokens`. For
models it recognises by name the SDK adapts further (an Anthropic model that cannot turn thinking off has `thinking`
dropped).

What follows for a person choosing a model and a level:

- Anthropic levels other than `none` ask for adaptive thinking, which Claude models before 4.6 refuse; Gemini levels
  other than `none` ask for a thinking level, which Gemini 2.5 models may refuse. The reply then fails as
  `provider_unavailable`; such a model works at `none`.
- On `openai_chat` the model's thinking is never shown (the protocol streams none that is read), though it is counted
  in the usage.
- A Gemini key that is wrong is answered 400 by Google, so it reads as `provider_unavailable`, not
  `provider_rejected` (the same in the provider test route).
- A model silent for 60 s (for example one thinking hard over Chat Completions, which streams nothing meanwhile) is
  given up on (`provider_unavailable`).

**What comes back.** The answer as text and reasoning deltas (Responses reasoning summaries, Anthropic thinking, Gemini
thought summaries; Chat Completions streams no reasoning the SDK reads, so there it is not shown, though its tokens are
counted), then one finish: the usage the upstream reported (reasoning tokens count as output; none reported: no usage)
and whether the model stopped for length. An answer may be up to 8 MiB on the wire and is given up after 60 s without a
byte (before or after the headers); how long it may take in all is the caller's to bound.

**Failures** are a `ModelError` with one of three codes and a fixed sentence: 401 or 403 is `provider_rejected`; any
other error status, a network failure, silence, a redirect, an oversized answer, and a stream that is malformed or ends
without the protocol's completion are `provider_unavailable`; the guard's refusal is `address_not_allowed`. Besides the
code it keeps only the upstream's HTTP status, for the log; nothing the upstream sent is kept, printed or logged.
Stopping a call (its abort signal) ends it at once and closes the upstream connection.

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
`mail_outbox` table (read it with `npm run inbox:list`). The mails are plain text in Simplified Chinese
(`src/auth/mail-copy.ts`): subject, a short body, the link on its own line, how long it is valid (24 hours for
verification, 1 hour for reset: the configured lifetimes) and a closing line — the verification mail asks a
reader who did not register not to click the link and to ignore the mail (someone else may have registered
their address), the reset mail to ignore it if it was not the reader's own doing. A third kind,
`registration_attempt`, is described under `POST /api/register`.

Sessions last 7 days from sign-in (the cookie's `Max-Age`; with `rememberMe: false` the cookie ends with the
browser session and the session after a day). Sign-out and a password reset end sessions at once: their
WebSockets close with 4001; an expired session's sockets close within 30 s.

#### `POST /api/register`

*Session: none.* Creates the account and its principal in one transaction and mails a verification link.

- Body: `inviteCode` (string, at most 100; required when `REGISTRATION_MODE=invite`, ignored when `open`),
  `email` (an e-mail address, at most 254), `password` (10–128 characters), `displayName` (see
  `PATCH /api/me`: 1–40 characters after removing format characters (not joiners) and trimming, one line), `handle`
  (`^[a-z0-9_]{3,24}$`: lower-case letters, digits, `_`).
- 201 `{"ok": true}` whether or not the e-mail already has an account, and the invite is used up either way: the
  answer, its timing and the invite afterwards are the same. What an invite holder can still learn, accepted:
  one answer per invite. After a 201 for an address, whether the chosen handle now exists (a handle lookup, a
  second registration with that handle — 409 —, or signing in with the chosen password — 403
  `email_not_verified` against 401) tells whether the address already had a verified account (then nothing was
  created). Each such probe uses up a single-use invite and, for a verified account, mails its owner a
  `registration_attempt` notice (at most hourly). Held back
  like the reset request's answer: at least 400 ms (plus up to 50 ms at random) after its whole body was in;
  errors are not held back. What happens depends on the e-mail (compared lower-cased):
  - No account: the account and its principal are created and a verification mail is sent (below).
  - A verified account: nothing is created or changed. Its owner gets a `registration_attempt` mail (someone
    tried to register this address and no account was created; sign in at `<APP_ORIGIN>/signin`, or reset the
    password at `<APP_ORIGIN>/forgot`; otherwise ignore it), at most one per address per hour.
  - An account whose e-mail is not verified yet (it has never signed in): this registration replaces it, in the
    same transaction. The old account's principal, auth user, sessions, credentials and reset links are
    deleted; friend requests to it and blocks of it are deleted too (whoever made them gets a `social` push);
    its handle is free again; the invite it was registered with stays used up. The new password, handle and
    display name apply and a fresh verification mail is sent. Links mailed for the old account stop working
    (its verification link redirects with `INVALID_TOKEN`, its reset links are `invalid_token`). An unverified
    account that holds anything only a signed-in person makes — messages, memberships, friendships, blocks it
    made, attachments, friend requests it sent — is never replaced or deleted: the registration fails with 500
    `internal` and changes nothing (this cannot happen unless something else is wrong).

  Registrations of one address are decided one at a time, and a verification link for that address waits
  until they are done (so a link mailed for a replaced account can never verify its replacement).
- Mail (`verify_email`): `<APP_ORIGIN>/api/auth/verify-email?token=…&callbackURL=<APP_ORIGIN>/verify` (the
  callback URL-encoded), valid 24 h; opening it lands on the client's `<APP_ORIGIN>/verify` (or
  `/verify?error=CODE`). A link only ever verifies the account it was mailed for.
  The e-mail must be verified before sign-in works.
- Errors: 400 `invalid_invite` (missing, unknown, expired or used invite; checked first, so without a usable
  invite nothing else — not even whether the handle is taken — is revealed), 409 `handle_taken` (any principal
  holds the handle, also an unverified account this registration would otherwise replace; the invite is not
  used up), 400 `invalid_request` (shape, or a value Better Auth refuses).
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

*Session: optional.* Query: none allowed. Body: none, empty (with or without `content-type: application/json`) or `{}`. → 200 `{"success": true}` and an expiring
`Set-Cookie`, with or without a session. The session ends: its WebSockets close with 4001.

#### `GET /api/auth/verify-email`

*Session: none.* The link from the verification mail.

- Query: `token` (at most 4096), `callbackURL` (optional redirect target). Nothing else.
- With `callbackURL`: 302 to `callbackURL` once verified (or already verified); a bad token redirects to
  `callbackURL?error=INVALID_TOKEN` (or `TOKEN_EXPIRED`, `USER_NOT_FOUND`, `INVALID_USER`).
- Without: 200 `{"status": true, "user": null}`, or 401 `invalid_token` / `token_expired` / `user_not_found` /
  `invalid_user`. Verifying does not sign in.
- A genuine, unexpired link is handled in a transaction holding its address's lock (see `POST /api/register`);
  its signature and expiry are checked before that, so a forged or expired link is answered without a
  transaction or a lock.
- Limit: 10 per minute per client address + the e-mail the link names, and 60 per minute per client address.

#### `POST /api/auth/request-password-reset`

*Session: none.* Query: none allowed. Body: `email` (at most 254), `redirectTo` (optional redirect target;
accepted but not used: the mail links to the web app).

- 200 `{"status": true, "message": "If this email exists in our system, check your email for the reset link"}`
  for every e-mail, registered or not (only a registered one gets mail). The answer is held back until at least
  400 ms (plus up to 50 ms at random) after its whole body was in (counted from the body, so a body sent late
  does not use the floor up), so its timing does not tell a registered address from an unregistered one either;
  work that takes longer is not padded further. Errors are not held back.
- Mail (`reset_password`): `<APP_ORIGIN>/reset-password?token=…`, valid 1 hour, usable once, and only until
  the password is reset through any link of the account. The web app's page at that path posts the token to
  `POST /api/auth/reset-password`.
- Limit: 10 per minute per client address + e-mail, and 60 per minute per client address.

#### `POST /api/auth/reset-password`

*Session: none.* Query: none allowed. Body: `newPassword` (string; 10–128 characters), `token` (at most 512).

- 200 `{"status": true}`. Every session of the account ends (sockets close with 4001); sign in again. Every
  other reset link of the account ends with it (each reset request mails its own link; after a reset through
  any of them, the rest are `invalid_token`). Resets of one account happen one at a time: of two links used at
  once, one resets the password and the other is `invalid_token`.
- Errors: 400 `invalid_token` (unknown, used or expired), 400 `password_too_short`, 400 `password_too_long`,
  400 `invalid_request`.

#### `GET /api/me`

*Session: required.* → 200 `{"id", "handle", "displayName", "email"}`: the signed-in principal.

### Profiles and principals

#### `PATCH /api/me`

*Session: required.* Changes your display name (only yours: no route takes a target id).

- Body: `displayName`: format characters (`\p{Cf}`: bidi overrides and isolates U+202A–202E, U+2066–2069,
  U+200E, U+200F, U+061C; zero-width space U+200B; word joiner U+2060; BOM U+FEFF; soft hyphen U+00AD; …)
  are removed, except the zero-width non-joiner and joiner (U+200C, U+200D: emoji sequences like 👩‍💻,
  Persian and Indic text) and the emoji tag characters (U+E0020–U+E007F: flags like 🏴󠁧󠁢󠁥󠁮󠁧󠁿), which stay.
  Then it is trimmed; the result must be 1–40 characters, one line (no control characters, no line or
  paragraph separators), contain no lone surrogates, and contain a visible character as defined for message
  text (`POST /api/conversations/:id/messages`: not white space, a control, a default-ignorable code point such
  as a joiner, variation selector or Hangul filler, or the Braille blank); otherwise 400 `invalid_request`. The
  same rule applies on registration and, with 1–60 characters, to group titles.
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
- A signed-in sender's body may take as long as the server-wide timeouts allow; anyone else's must arrive within
  the body deadline (`HTTP_BODY_TIMEOUT_MS`, see Configuration). The answers are unchanged.

#### `GET /api/principals/:id/avatar`

*Session: required.* Any existing principal's avatar: their image (`image/png`, `image/jpeg` or
`image/webp`), or a generated `image/svg+xml` with their initial when they have none. Headers:
`X-Content-Type-Options: nosniff`, `Cache-Control: private, max-age=60`,
`Content-Security-Policy: default-src 'none'; sandbox`. 404 `not_found` for an id that is no principal.

#### `HEAD /api/principals/:id/avatar`

*Session: required.* The same decision and headers as the `GET`, no body; only the first bytes of a stored image are
read (to tell its type), never the whole file. `Content-Length` is only sent for the generated SVG.

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

- Body: `title` (the display-name rule of `PATCH /api/me` with 1–60 characters: format characters removed
  except joiners and tag characters, trimmed, something visible, one line), `memberIds` (2–1000 principal ids, distinct, not
  you).
- 201 `{"id": "<conversation id>"}`. Everyone joins at once; the first message (seq 1) is the
  `group_created` notice.
- Errors: 400 `invalid_request` (duplicates, fewer than two, or you among them), 403 `forbidden` (someone
  is not your friend, a block in either direction, or more than 500 members including you).
- Limit: 10 per minute. Pushes: `conversation` and the notice to every member.

#### `GET /api/conversations/:id`

*Session: required.* → 200: exactly the element of `GET /api/sync`'s `conversations` for this id, as it is
now (shape under Wire shapes). 404 `not_found` unless you are a current member — the same answer as for an
id that does not exist. Fetch it on a `conversation` push instead of a full sync. Limit: 120 per minute.

#### `PATCH /api/conversations/:id`

*Session: required.* The group's creator renames it. Body: `title` (as on creation: the display-name rule with
1–60 characters).

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

- Body: `clientTxn` (required, `^[A-Za-z0-9_-]{1,64}$`: your retry key), `text` (stored as sent except that
  bidi overrides and isolates — U+202A–U+202E, U+2066–U+2069, which would reorder what others see — are
  removed; then trimmed; 0–8000 characters counted after that; line breaks allowed; no control character other
  than tab, line feed and carriage return — NUL included —, no lone surrogates: otherwise 400), `attachmentId`
  (optional: your own upload in this conversation that no message carries yet; makes a `file` message with
  `text` as its caption), `replyToSeq` (optional positive integer: a message of this conversation you can
  see). Without `attachmentId`, `text` must contain a visible character: one that is not white space, not a
  control character, not a default-ignorable code point (`\p{Default_Ignorable_Code_Point}`: format
  characters, joiners, variation selectors, tag characters, Hangul fillers U+115F/U+1160/U+3164/U+FFA0, the
  combining grapheme joiner, …) and not the Braille blank U+2800 (emoji sequences, keycaps, flags and
  right-to-left text all have one); a caption may be empty or invisible.
- 201 `{"message": WireMessage, "duplicate": false}`.
- Retries: the same `clientTxn` again (same sender, same conversation) stores nothing and answers 200
  `{"message": <the stored message>, "duplicate": true}` — even if you could no longer send there now (you
  must still be a member). The same
  `clientTxn` in another conversation is a new message there. 409 `client_txn_reused` when the message stored
  under it is no longer visible to you (you left and were added again).
- Errors: 404 `not_found` (not a current member, closed, unknown), 403 `cannot_send` with `reason`
  `blocked` or `not_friends` (direct chats), 400 `invalid_request` (empty text without attachment, a
  `replyToSeq` you cannot see, an attachment that is not your unsent upload here).
- In your Agent's conversation, a message (not a repeat) may start the Agent's reply in the same transaction, or be
  folded into the one in progress (see Agents and runs).
- Limit: 120 per minute. Pushes: `message` to every member who can see it; a reply it queues, `run` to you.

#### `GET /api/conversations/:id/messages`

*Session: required.* History, a page at a time.

- Query: `before` (optional positive integer: only seqs below it), `limit` (1–100, default 50).
- 200 `{"messages": WireMessage[], "nextBefore": number | null, "principals": { "<id>": { "id", "handle", "displayName", "kind" } }}`: up to `limit` messages you
  can see, the newest page first, each page ascending by seq; pass `nextBefore` as `before` for the next
  older page (`null`: nothing older you can see). `principals` names everyone these messages name — senders
  (also members who have since left), a visible quote's sender, the people in system notices — as
  `/api/sync`'s `principals` entries, by id; nobody else (see Client contract, Principals of a read).
- 404 `not_found` unless you are a current member.

#### `GET /api/conversations/:id/messages/:seq`

*Session: required.* → 200 `{"message": WireMessage, "principals": { "<id>": { "id", "handle", "displayName", "kind" } }}` (as above, for this one message); 404 `not_found` when you cannot see it (from before
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

*Session: required.* Query: `q` (1–100 characters, one line; see Search), `before` (optional positive integer),
`limit` (1–50, default 20). → 200 `{"messages": WireMessage[], "nextBefore": number | null, "principals": { "<id>": { "id", "handle", "displayName", "kind" } }}`,
newest first (`principals` as under message history); 404 `not_found` unless you are a current member; 429 / 503 `busy` as under Search.

#### `GET /api/search`

*Session: required.* Query: `q`, `limit` as above, `before` (optional: the `nextBefore` cursor of the previous
page, opaque; anything else is 400). → 200 `{"messages": WireMessage[], "nextBefore": string | null,
"principals": {…}}` (as above): hits in every conversation you are currently in, newest first; 429 / 503 `busy` as under Search.

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

*Session: required.* Body: none, empty (with or without `content-type: application/json`) or `{}`. → 200 `{"ticket": "…"}`: opens one socket, once, within 30 seconds,
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
  "id": "…", "type": "direct" | "group" | "agent", "title": "team" /* null in direct chats */,
  "creatorId": "…",                                // groups only: a direct chat has no creator role
  "myRole": "speaker" | "observer", "closed": false,
  "createdAt": "2026-11-16T01:02:03.000Z",       // when the conversation was created; /api/sync lists them in this order
  "peerId": "…",                                   // direct chats only: the other person of the pair
  "agentId": "…",                                  // Agent conversations only: the Agent (no peerId)
  "agent": { "paused": false, "deleted": false },  // Agent conversations only
  "canSend": { "ok": true } | { "ok": false, "reason": "blocked" | "not_friends" | "closed" | "agent_deleted" },
  "members": [{ "id": "…", "role": "speaker", "isCreator": true }],   // current members, join order; isCreator only in groups
  "lastSeq": 42,       // the conversation's newest seq (counts messages from before you joined too)
  "readSeq": 40,       // your read marker
  "unread": 2,         // visible messages from others, not system notices, after readSeq
  "peerReadSeq": 41    // direct chats: how far the other side has read; Agent conversations: how far the Agent has
                       // (it reads up to what a reply covers when the reply starts); absent in groups
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
  "reasoning": "…",                    // an Agent's reply: the model's reasoning, when it gave any (show it folded;
                                       // never in previews or search, never sent to a model again)
  "stopped": true,                     // an Agent's reply its owner stopped: text is what had been said by then
  "truncated": true,                   // an Agent's reply that was cut (model's output limit, time limit, 8 000 characters)
  "createdAt": "2026-11-16T01:02:03.000Z"
}
```

An Agent's reply is an ordinary `text` message from the Agent; `reasoning`, `stopped` and `truncated` appear only on
those, only when they apply. Render its text as Markdown (spec 6.6); people's text stays plain.

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
| `topic_reset` | `actorId` (the owner) | `POST /api/conversations/:id/topic`, in an Agent's conversation: what comes before it is no longer shown to the Agent's model |

Clients must ignore fields and events they do not know: later batches add more.

**Pushes** (WebSocket text frames, JSON):

```jsonc
{ "type": "message", "message": WireMessage }   // rendered for you
{ "type": "conversation", "id": "…" }   // title, members, creator, closed, or a direct chat's canSend changed: GET /api/conversations/:id
{ "type": "gone", "id": "…" }           // you are not a member now (left or removed): drop the conversation
{ "type": "social" }                    // your friends, requests or blocks changed: GET /api/social
{ "type": "agent", "id": "…" }          // one of your Agents changed (edit, pause, resume, delete, avatar): GET /api/agents/:id
{ "type": "run", "conversationId": "…", "run": Run }   // a reply of your Agent was queued, started or ended (Replies)
{ "type": "delta", "conversationId": "…", "runId": "…", "text"?: "…", "reasoning"?: "…" }
                                        // the next piece of the reply being generated: append it to the "replying"
                                        // bubble; the posted `message` replaces the bubble
{ "type": "read", "conversationId": "…", "principalId": "…", "seq": 41 }   // direct chats (either side); in your
                                        // Agent's conversation, the Agent's marker
{ "type": "pong" }                      // answer to your { "type": "ping" }
```

`run` and `delta` go to the Agent's owner only, in order with that conversation's other pushes (`running` after your
message, every `delta` before the reply's `message`, the `message` before `done`). Once a pause or delete of the Agent
has answered, no further `delta` of the reply it interrupted is sent (its `cancelled` follows). They are not stored and not
replayed: after a reconnect, `GET /api/conversations/:id/run` says whether a reply is still under way (its text so far
is not sent again; the posted message follows).

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

**Principals of a read.** A message can be sent by someone your client never saw (a member who left before
your first sync). So `GET /api/conversations/:id/messages`, `GET /api/conversations/:id/messages/:seq`
and both search routes add `"principals": { "<id>": { "id", "handle", "displayName", "kind" } }`: the same
entries as `/api/sync`'s `principals`, keyed by id, for everyone the returned messages name (sender, a
visible quote's sender, a system notice's participants). It is computed from the messages as rendered for
you, so a message you cannot see, or a quote shown as `{"visible": false}`, names nobody. An empty page has
`{}`. Merge it into the principals you hold.

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
conversations you were added to — `conversation`, `social`, `read`, `run` and `delta` events sent while you were
offline are not replayed; for an Agent's conversation you show, `GET /api/conversations/:id/run`. 4. Apply the
buffered pushes by the rules above.

## Agents and runs (`src/agents/`)

An Agent's reply is a row in `agent_runs` (purpose `reply`): a run. It is answered by a worker inside the service's
process and posted as an ordinary message from the Agent.

**Trigger** (`runs.ts` `maybeTrigger`). In the transaction that stores the owner's message in the Agent's conversation
(not a repeated `clientTxn`), under the send's locks: nothing happens when the Agent is paused, deleted or has no model,
or when its `replyMode` is `mention` and the text contains neither `@` + its handle nor `@` + its current name (case
ignored). Otherwise a `queued` run is inserted covering the message (`covers_seq`), unless the owner has started 20
replies in the last minute (then no run; the message is still sent). The `run` push and the worker's wake-up follow the
commit.

**Coalescing.** An Agent has at most one queued or running run (a unique index). A message that comes while one is
queued is covered by it; while one is running, it is noted (`pending_seq`), and when that run ends one follow-up run
answers everything noted — not one per message, and never two replies at once. A cancelled run, a paused or deleted
Agent, or one without a model by then, gets no follow-up.

**Pause and delete** end the Agent's active reply for good, in their own transaction (under the Agent's lock): a queued
run becomes `cancelled` (`agent_paused` / `agent_deleted`; it never reached a model, so it has no usage record); a
running one is marked `interrupted` with that reason. A marked run is never posted and ends `cancelled`, even if the
Agent is resumed before the worker notices; its call is abandoned and no further `delta` of it is pushed once the
request has answered. Nothing is queued while the Agent is paused, and resuming queues nothing: what was written during
the pause is answered only as part of the next reply the owner's next message starts.

**The worker** (`runtime/worker.ts`) claims the oldest queued reply whose owner has fewer than 2 replies running
(further ones wait queued), at most 8 at once in the service. It is woken after a trigger commits and also looks every
2 s. Per run:

1. `begin`, one transaction under the Agent's lock: a run marked `interrupted` (or a paused or deleted Agent) ends
   `cancelled`, a stop asked for meanwhile `stopped`, a model that no longer resolves `failed` (`provider_unavailable`),
   and a failure of the service's own here `failed` (`busy`). The run takes on what was
   noted meanwhile; what the model is shown is built (below; nothing to answer — say, everything is before a new topic
   — ends it `failed` `busy`, and no model is called); the call is admitted on its input estimate (Usage and points;
   `no_quota` ends it `failed` before any call); the Agent's read marker moves to what the run covers (`read` push,
   `peerReadSeq`).
2. The model call, with no transaction open: deltas go to the owner's sockets, at most one push per 50 ms. It is
   abandoned at once when the owner stops it or the Agent is paused or deleted (checked every 50 ms), after 2 minutes
   (`agentRunTimeoutMs`), and when the service closes.
3. `post` (`conversation.ts` `postAsAgent`): under the conversation row and the `agents` row — the locks pause and
   delete take — so once a pause or delete has answered, nothing more from the Agent is stored, the reply being
   generated included, whether or not the Agent has been resumed since (`tests/runs-pause-race.test.ts`,
   `tests/runs-pause.test.ts`). The message's `client_txn` is the run's id: a reply is never
   posted twice. Text follows the rules of message text (what a send would refuse is removed) and is cut at 8 000
   characters (`truncated`); reasoning follows the same rules, is cut at 32 000 characters (no mark) and is kept only
   when there is some.
4. `finish`, one transaction: the call is settled (one usage record; its hold released) in the same transaction that
   moves the run out of `running`, how it ended is recorded, and the follow-up is queued. What is recorded is what is
   true under the lock: a reply that was posted stands (`done`, or `stopped` by its owner), whatever happened to the
   Agent after; an interrupted run that posted nothing is `cancelled`.

**What the model is shown** (`context.ts` `buildContext`; its pure part, the plan, in `runtime/context.ts`; spec 6.5):

- The system text: who the Agent is and whose, the owner's name, today's date in `SITE_TIMEZONE`, that it has no tools
  and must not claim what it cannot do, then the persona (an Agent without one is told to ask its owner about it first).
- The conversation after the latest `topic_reset` notice (`POST /api/conversations/:id/topic`), as the Agent can see it
  (the one visibility rule, the Agent as reader): messages up to what the run covers, and the owner's after it. The
  owner's as `user`, the Agent's as `assistant`, in order; consecutive messages of one side are one turn (their parts
  in order), because several providers refuse two turns of one side in a row. The call starts and ends with the owner:
  the Agent's messages after the owner's newest are left out (a follow-up run, which answers what came while the
  previous reply was written, does not see that reply), and so is an Agent turn left first. System notices, the fixed greeting and the stored reasoning are never
  shown. A message that quotes another starts with `> ` lines holding the first 200 characters of the quoted one (its
  text, or its attachment's name), also when the quoted one is from before the new topic: the owner chose to show it.
- Attachments, read only through the download's own permission with the Agent as reader, and only after their stored
  size passed the limit: an image (PNG, JPEG, WebP, GIF) of at most 5 MB as the image when the model sees images, else
  `[图片：name]` (at most 10 images a call, the newest); a PDF of at most 10 MB as the file when the model reads PDFs,
  else `[文件：name]`; any other file as `[文件：name]` followed by its text when its bytes are text — valid UTF-8, no
  NUL, at most 1 in 100 characters a control character other than tab, line breaks and form feed; decided by the bytes,
  not the name or type — at most 100 000 characters a file and 200 000 a call (newest first), cut with `…（已截断）`, a
  byte-order mark dropped and what message text may not hold removed (bidi controls, control characters); else
  `[文件：name]` alone. A file is read at most 4 bytes per character it may still show, and its first 4 KB decide whether
  the rest is read. A message with only an attachment is a turn like any other. A missing blob is shown by name (and
  logged); a blob store that fails, or takes more than 15 s for one blob, fails the run `busy`. Blobs are read inside
  `begin`'s transaction, so a send to that conversation waits for them meanwhile.
- The budget: the model's context, less its output limit and the system text, counted as admission counts (a token per
  character, 1 500 an image, 300 per KB of PDF). What fits, in this order: the current turn (the owner's messages after
  the Agent's last) by name only, newest first — the owner's newest message is always there, cut from the front (`…`
  then its end) when it alone is over the budget; then the current turn's attachment contents, newest first, each if it
  fits; then older messages by name only, newest first, while they fit (nothing older than one that does not); then
  their attachment contents, newest first, each if it fits. So an older message's attachment goes (leaving its name)
  before older messages do, and what the owner has just sent is the last to go.
- The reasoning level is the Agent's when the model allows it, else `none`.

A reply's input estimate (what admission holds) and what settlement falls back on when no usage is reported both count
all of the above, attachments at their estimate.

| How a run ends | Message | Run |
|---|---|---|
| The model answered | the answer (`truncated` when the model stopped at its output limit or it was cut at 8 000 characters) | `done` |
| The owner stopped it | what had been said, `stopped: true` (nothing said: no message) | `stopped` (also when a pause or delete comes after the message was posted) |
| Paused or deleted while queued | none, no call made, no usage record | `cancelled`, `agent_paused` / `agent_deleted` |
| Paused or deleted while running, before it posted (resumed since or not) | none; what it had said is discarded, what it used is settled | `cancelled`, `agent_paused` / `agent_deleted` |
| The provider failed (key refused, unreachable, address refused) | none; what it had said is discarded | `failed` with that code |
| The reply could not be stored (or the run started) for the service's own reasons | none | `failed`, `busy`, retryable; charged nothing: the usage record keeps the true cost, all of it forgiven |
| Nothing left to pay for it | none, no call made | `failed`, `no_quota` |
| An empty answer (no visible text, no reasoning) | none | `failed`, `provider_unavailable` |
| Nothing to answer (everything is before a new topic), or an attachment that could not be read | none, no call made | `failed`, `busy`, retryable; charged nothing |
| 2 minutes passed | what had been said, `truncated: true` (nothing said: `failed`, `provider_unavailable`) | `done` |
| The service closed during the call | none | left `running` (recovery at start-up comes in a later task) |

Failures are never messages: no seq, not in search or unread counts, never shown to a model. The owner sees them on the
run. Every run the worker took is settled exactly once (its usage record's `outcome` is the run's status).

**The port boundary.** Everything under `src/agents/runtime/` — the worker, the stream (`stream.ts`), the system text
(`prompt.ts`) — reaches the rest of the service only through `AgentPort` (`runtime/port.ts`): `claimNext`, `begin`,
`emit`, `post`, `finish`, `shouldStop`. The SQL is in its implementation, `port-impl.ts`. `tests/agent-port-boundary.test.ts`
fails when a file there imports `db.ts`, `pg` or any `store.ts`. It is the shape an external Agent's connection would have.

Lock order of every write here: the conversation row → the `agents` row → the run row → the `accounts` row. Like the
hub, the worker and its stop flags live in this process (single instance only).

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
its partial upload deleted. Until the upload's checks have passed, its body is under the 30-second body deadline
every request starts with (see Configuration): a refused or signed-out upload cannot keep a connection busy.

**Send.** `POST /api/conversations/:id/messages {"attachmentId": "…", "text"?: "caption", "clientTxn": "…"}`
makes a `file` message (caption 0–8000 characters, the rules of message text — bidi overrides and isolates
removed, control characters other than tab and line breaks refused — except that it may be empty or invisible). The attachment must be your own upload in this
conversation that no message carries yet (400 otherwise); each upload can be sent once.

**Download.** `GET /api/attachments/:id` serves the bytes iff a message carrying the attachment is
visible to you now (the same rule as for reading the message); everything else — unknown, never sent
(also for the uploader), sent before you joined, after you left — is the same 404. Headers: the
server's `Content-Type` (markup such as HTML or SVG is always `application/octet-stream`),
`Content-Length`, `Content-Disposition: inline` only for `inline` attachments, else `attachment`, with an
ASCII `filename` and the exact name as `filename*=UTF-8''…`; `X-Content-Type-Options: nosniff`,
`Content-Security-Policy: sandbox; default-src 'none'`, `Cache-Control: private, no-store`. No ranges.
`HEAD /api/attachments/:id` answers the same status and headers without a body, and without reading the file.

**Unsent uploads** are deleted by the sweep once they are older than 60 minutes. The server runs it inside
its own process (the service is one process by design): once a minute after start, then every
`SWEEP_INTERVAL_MINUTES` (default 15; `0` disables it). Runs never overlap, a failing run is logged at warn
and the next one still happens, and one info line (counts) is logged per run that deleted something. The
timer stops on shutdown. `npm run attachments:sweep:prod -- [--older-than <minutes>]` runs the same sweep by
hand (default 60). Send an upload within that time. A blob that cannot be deleted keeps its
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

`GET /api/conversations/:id/search?q=&before=&limit=` → `{"messages": WireMessage[], "nextBefore": number | null, "principals": {…}}`:
hits in one conversation you are currently in, newest first; pass `nextBefore` as `before` for the next
page. Any conversation you are not in now is 404 `not_found`.
`GET /api/search?q=&before=&limit=` → `{"messages": WireMessage[], "nextBefore": string | null, "principals": {…}}`: hits in
every conversation you are currently in; `before` is the opaque cursor of the previous page (anything else
is 400). Each hit carries `conversationId` and `seq`, the place to jump to.

`q` is 1–100 characters after trimming, one line, matched as a substring (`%`, `_` and `\` are ordinary
characters) of a message's text (captions included) or a file message's name; system notices never match.
Bidi overrides and isolates are removed from `q` as they are from stored text, so a term copied with them still
matches (a term of nothing else is 400).
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
  for several rounds and checks each stated invariant against the database. `tests/registration.test.ts` races
  eight registrations on one invite (whatever their e-mails, exactly one uses it) and two registrations of one
  e-mail (one account remains).
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
| 7 | Sign-in time tells whether an account exists; no rate limit | `tests/auth.test.ts` "a wrong password takes about as long for an existing as for a non-existing e-mail", "the 11th sign-in attempt for one account from one address is 429 …", "one address cycling through many e-mails …", "password reset answers identically …"; `tests/answer-floor.test.ts` (reset request and registration take as long for an e-mail with an account as without) |
| 8 | The sync cursor is a site-wide counter (anyone sees site-wide activity); a late joiner sees how many messages came before them | site-wide: no global id or counter anywhere — `tests/sync.test.ts` "initial sync contains only my conversations …", `tests/search.test.ts` "the cursor does not reveal how many messages exist site-wide", `tests/enumeration.test.ts`. Per conversation, seqs are gapless and count messages from before you joined (`lastSeq`, the join notice's seq): kept by design, see the client contract |
| 9 | Approvals never expire; an old approval still works after removal | batch 1 has no join approvals (members add their friends directly; expansion approval is batch 3). Friend requests expire after 24 h — `tests/social.test.ts` "a request older than 24h cannot be accepted and reads as expired"; a removed member loses access at once — `tests/messages.test.ts` "removed member gets 404 on every read and write …", `tests/enumeration.test.ts`, `tests/concurrency.test.ts` "… racing removal of the sender from a group" |
| 10 | Several malformed parameters cause 500s | `tests/fuzz.test.ts` (the 500s it found are fixed and pinned in `tests/auth.test.ts` "inputs Better Auth answered with a 500 are refused with 400 first …" and `tests/health.test.ts`) |
