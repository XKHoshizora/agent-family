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
npm run catalog:update [-- <models.json> <api.json>] # downloads models.dev (or reads saved copies) into src/providers/model-catalog.json; commit it
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
every call with such a key — a reply, a persona draft, a provider's test, model list and refresh — is then `provider_rejected`, as a key
the provider refused, and the log says why, until its owner saves the key again with `PATCH`; keep the secret with the database backups),
`SITE_MODELS` (the models the site offers: a JSON array, default none; each entry has `id`, `label`, `tier` `free`|`paid`, `protocol`
`openai_chat`|`openai_responses`|`anthropic`|`gemini`, `baseUrl` (a provider's `baseUrl` rule, Model providers: `https`, no
credentials, a plain host name or address, and no query or fragment, else start-up fails naming the model; used as a
provider's is stored: lower-case host, no default port, no trailing slash; its address is checked at every call),
`apiKeyEnv` (the name of another variable that holds the upstream key, so the JSON carries
no secret; start-up fails naming it if unset, and naming the model if it is one of the service's own `DATABASE_URL`,
`AUTH_SECRET`, `PROVIDER_KEY_SECRET`, `S3_SECRET_ACCESS_KEY`, `S3_ACCESS_KEY_ID` — case ignored; two models may share
one), `model`, `inputMicroPerToken`, `outputMicroPerToken` (whole micro-points), `maxOutputTokens`, `contextTokens` (larger than
`maxOutputTokens`, else start-up fails naming the model),
`vision`, `pdf`, `reasoning` (levels from `low`..`max`), and optionally `thinkingSwitch` (`true` for an `openai_chat`
upstream that thinks unless told not to, such as DeepSeek: it is then sent `thinking: {"type": ...}`, see Calling a
model; default false)), `FREE_DAILY_POINTS` (free daily allowance of site-model use, whole points, default 200),
`SITE_TIMEZONE` (IANA name whose midnight starts a new allowance day, default `Asia/Shanghai`), `AGENT_TIERS` (JSON, Agents allowed per account tier, must
contain `free`, default `{"free":20}`),
the protective limits on replies and model calls (spec 6.4; each a whole number in its range, empty for the default):
`AGENT_MAX_CONCURRENT_RUNS` (model calls one person may have running at once, replies and persona drafts together;
further replies wait queued, a further draft is refused; a draft and a reply that start at the same moment may briefly
exceed it by one, see Agents and runs; 1–100, default 4), `AGENT_MAX_CONCURRENT_OTHERS_RUNS` (of those, how many may be
replies someone other than the Agent's owner called for, so that the rest are kept for the owner's own; 1–100, default 3;
it may not be more than `AGENT_MAX_CONCURRENT_RUNS`, or the service refuses to start, naming both — so setting only
`AGENT_MAX_CONCURRENT_RUNS` below 3 is refused too),
`AGENT_RUNS_PER_MINUTE` (replies one owner may start a minute that they called for themselves, their own lane, see Rate
limits; counted from the stored runs and not scaled by `RATE_LIMIT_SCALE`; 1–10 000, default 20),
`AGENT_OTHERS_RUNS_PER_MINUTE` (replies one owner's Agents may start a minute that anyone else called for, all callers
together — and replies nobody called for, lane `proactive`, which nothing starts yet, would count with them —, counted
apart from the owner's own and likewise not scaled; 1–10 000, default 20),
`AGENT_CALLER_RUNS_PER_MINUTE` (calls one person, themselves or through an Agent's message they are behind, may make a
minute on other people's Agents; counted and not scaled likewise; 1–10 000, default 5),
`AGENT_RUN_TIMEOUT_MS` (how long a reply or a persona draft may take, and for a reply also the reading of its
attachments before the call, each in turn: so a reply may take up to about twice it in all; 1 000–3 600 000, default
120 000), `PROVIDER_DEFAULT_CONTEXT_TOKENS` (a provider model's
context when its owner gives none; 1 000–2 000 000, default 16 000), `PROVIDER_DEFAULT_MAX_OUTPUT_TOKENS` (the output
limit of every call to a provider model at reasoning `none`, and its reply's limit at any other level; 1–1 000 000,
default 2 048; it must be less than `PROVIDER_DEFAULT_CONTEXT_TOKENS`, else start-up fails naming both),
`REASONING_ALLOWANCE_TOKENS` (the thinking allowance of each reasoning level, JSON: `low`..`max`, each a whole number
0–200 000, a level left out keeps its default; default `{"low":2000,"medium":6000,"high":12000,"xhigh":24000,"max":48000}`;
at any level but `none` a call's output limit is its reply limit plus this, at most half of what the model's context
leaves beside the reply limit — Calling a model; a site-model call's hold covers it), `PROVIDER_MAX_CONCURRENT_CALLS` (calls to providers
and site models in flight at once in the whole service, see Model providers; 1–1 000, default 64),
`AGENT_MAX_RUNS_IN_FLIGHT` (replies the worker runs at once in the whole service, all owners together; further ones wait
queued; 1–64, default 16 — each holds up to 20 MiB of attachments in memory, see Agents and runs, so the worst case is
about this × 20 MiB × 5 copies: about 1.6 GiB at the default; lower it on a small container),
`AGENT_CHAIN_LIMIT` (in a group, once its last this many messages that are not notices were all sent by Agents, an
Agent's message calls no other Agent until a person writes, and the group is told once — Agents in a group; 2–500,
default 30), `AGENT_GROUP_CONTEXT_TOKENS` (the most a reply in a group is shown of the group: this many tokens of its
latest 80 messages, files included, by the service's estimate, plus the system text — Agents in a group, A reply there;
2 000–200 000, default 12 000),
`HOST` (the address to listen on: an IPv4/IPv6 address or `localhost`, default `0.0.0.0`, every interface; `127.0.0.1` for local-only),
`WEB_DIST` (optional: directory of the built web client to serve, see Deployment; unset serves none),
`S3_*` (optional, all-or-none), `REGISTRATION_MODE` (`invite` | `open`, default `invite`),
`MAIL_MODE` (`outbox`), `RATE_LIMIT_SCALE` (multiplier for every rate limit, default 1),
`CLIENT_IP_HEADER` / `TRUST_PROXY` (where the client's address comes from; see Deployment),
`ATTACHMENT_MAX_BYTES` (the largest file one upload may carry, default 1 GiB; 1 MiB to 5 GiB, and never more than
`ATTACHMENT_QUOTA_BYTES`, else start-up fails naming both), `ATTACHMENT_QUOTA_BYTES` (attachment bytes one principal
may store in all, default 20 GiB),
`SWEEP_INTERVAL_MINUTES` (how often the server runs the attachment sweep, whole minutes, default 15, `0` turns it off, at most 1440),
`UPLOAD_IDLE_TIMEOUT_MS` / `UPLOAD_TOTAL_TIMEOUT_MS` (an upload is cut off after this long without body bytes, default
45 s, or in all, default 60 minutes; see Attachments), `HTTP_BODY_TIMEOUT_MS` (the body deadline, default 30 s: a request with a body must have arrived
whole this long after its head, or its connection is closed without an answer — armed on the HTTP server's own
`request` event, so it holds whatever answers the request: a route, a refusal before any route (a foreign
`Origin`, an undecodable path, an over-long parameter), an unknown route, and also when the answer already went
out but the client is still sending; `src/body-deadline.ts`; the two uploads are lifted
out of it once they let a body in: an attachment upload when its checks have passed and its own deadlines start, an
avatar upload when its sender is signed in), and the server-wide `HTTP_CONNECTION_TIMEOUT_MS` (socket idle,
default 2 min), `HTTP_REQUEST_TIMEOUT_MS` (whole request, default the upload total + 1 min; with the body
deadline it only matters for the uploads) and `HTTP_KEEP_ALIVE_TIMEOUT_MS` (default 72 s). `HTTP_CONNECTION_TIMEOUT_MS`
must be at least 20 s (else start-up fails naming it): a persona draft's request waits for the model with nothing on the
wire, so its deadline is `AGENT_RUN_TIMEOUT_MS` but at most this less 10 s (110 s with the defaults). The server-wide ones
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

`buildApp(deps?: Partial<Deps>, options?: { logStream, sweepInitialDelayMs, answerFloor, allowInsecureLocal, agentWorker, staleRunSweep })` takes `{ config, db }`;
anything omitted is built from the environment. Tests pass their own config (raised `RATE_LIMIT_SCALE`) and a pool
on `TEST_DATABASE_URL`. `answerFloor` (`{ ms, jitterMs }`, default 400 ms + up to 50 ms) is how long a
registration's and a reset request's success answer takes at least (see those routes); it is a build option, not
configuration, and only tests change it. So is `allowInsecureLocal` (default off; no variable can turn it on): with it,
providers may also be reached at loopback addresses, and over plain `http:` there, so tests can stand up a local stub.
`Deps.providerProbe` is how the provider test, model list and refresh routes reach a provider (default: through the address guard).
`Deps.models` is how the service talks to a language model (default: the model gateway, see Calling a model); tests
inject a scripted one (`scriptedGateway()` in `tests/helpers/models.ts`). `agentWorker: false` (tests only) turns the
reply worker's background loop off: replies then run only when the test calls `app.agentWorker.runOnce()` (claims the
oldest queued reply and runs it to its end; false when none is queued) or `drain()` (see Agents and runs).
`staleRunSweep` (tests only): `false` turns the stale-run sweep's timer off, `{ initialDelayMs, intervalMs }` shortens
it; `app.staleRunSweep.run()` sweeps at once either way (see Agents and runs, Recovery).

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
files that insert queued runs themselves use it too, so no background worker picks them up. `useApp()` starts no
stale-run sweep timer unless asked (`staleRunSweep`); tests sweep with `app.staleRunSweep.run()`.

## HTTP API

### Conventions

- **Paths and ids.** Everything is under `/api`. Ids are UUIDs: a path id is accepted in any case and
  lower-cased; every id in a response is lower-case. A path id that is not a UUID is 400 `invalid_request`;
  a path parameter over 100 characters is 414 `invalid_request`. A message is identified by
  `conversationId` + `seq` (no global message id exists).
- **Bodies.** JSON (`Content-Type: application/json`), at most 1 MiB (413 `too_large`), except the avatar
  upload (raw image bytes) and attachment uploads (`multipart/form-data`). Another content type is 415
  `invalid_request`, and so is JSON that names a `charset` other than `utf-8`; malformed JSON is 400 `invalid_request`.
  A route that takes no fields and says "Body: none or `{}`" also takes `null`; any other body (an array, a string,
  text) is 400. Unknown body fields and unknown query parameters
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
  byte for byte. Two intended exceptions, for people only: any person has an avatar and can be blocked. An Agent
  has neither for anybody else: its id on the avatar route (unless it is your Agent, or you and it are both current
  members of one conversation) and on the block routes (also your own Agent's) is answered exactly as an id that does
  not exist.
- **HEAD.** Every `GET` route also answers `HEAD` with the same status and headers and no body (Fastify
  runs the `GET` handler). `HEAD /api/attachments/:id` and `HEAD /api/principals/:id/avatar` are their own routes (below): they do not read the whole file.
- **Order of checks.** Cross-site `Origin` (403) → shape of path, query and body (400) → session (401) →
  rate limit (429) → the route's own rules. Registration counts its rate limit before checking the shape,
  and so do the sign-in, reset-request and verification-link limiters in front of Better Auth.

### Errors

Every error body is `{"error": "<snake_case_code>"}`, sometimes with details next to it: strings (`reason`,
`resetsAt`), or — the one exception — for `provider_in_use` the list `agents`. Shared codes, by status:

| Status | `error` | Meaning |
|---|---|---|
| 400 | `invalid_request` | Malformed or not acceptable input (also 414 for an over-long path parameter, 415 for an unsupported content type) |
| 400 | `address_not_allowed` | A call to a provider refused by the address guard: not `https`, credentials in the URL, or an address that is not public (see Model providers) |
| 400 | `context_too_small` | A run's error (not an HTTP answer there): the model's context, less its output limit and the system text (the persona), cannot hold your newest message, or 200 tokens of it; no call was made. Not retryable: shorten the persona, choose a lower reasoning level (at a level the output limit includes its thinking allowance, so a long persona on a small-context model can fail so where `none` works) or a model with a larger context. As an HTTP answer only from `POST /api/agents/draft-persona`, when the model's context cannot hold the draft's instruction and data |
| 401 | `unauthenticated` | No valid session (or a WebSocket ticket that is unknown, used or expired) |
| 402 | `no_quota` | A site-model call cannot start: nothing is left to pay for it (see Metering). `reason` `free_and_balance` (a free-tier model: today's free allowance and the balance are both used up; `resetsAt`, the next midnight in `SITE_TIMEZONE`, ISO instant) or `balance` (a paid-tier model: no balance) |
| 403 | `forbidden` | Cross-site request, or not allowed by the route's rule (e.g. only the creator renames) |
| 403 | `cannot_send` | With `reason`: `blocked` or `not_friends` (a direct chat whose pair cannot write to each other), or `agent_deleted` (an Agent's conversation after the Agent was deleted: sending, uploading, starting a new topic) |
| 403 | `agent_limit` | Creating an Agent with as many undeleted Agents as the account's tier allows |
| 404 | `not_found` | Does not exist, or is not yours to see (identical answers) |
| 409 | `agent_deleted` | Editing, pausing, resuming or changing the avatar of a deleted Agent, retrying its reply, or confirming or discarding its persona proposals |
| 409 | `agent_paused` | Retrying the reply of a paused Agent |
| 409 | `busy_run` | Retrying while a reply of that Agent is already queued or running |
| 409 | `stale_proposal` | Confirming or discarding a persona proposal that can no longer be acted on: confirmed already, discarded (confirming), superseded by a newer one, or made against a persona that has changed since (see Persona proposals) |
| 409 | `provider_in_use` | Deleting a provider that Agents still use; `agents: [{"id", "name"}]` names them |
| 413 | `too_large` | Body over its limit; for uploads also `{"error":"too_large","reason":"quota"}` |
| 429 | `rate_limited` | Over a rate limit or a cap on work in progress (see Rate limits). Also a run's error (not an HTTP answer there): a reply over its owner's replies a minute in its lane (`AGENT_RUNS_PER_MINUTE`, `AGENT_OTHERS_RUNS_PER_MINUTE`), recorded failed and retryable (Replies) |
| 500 | `internal` | A bug (also any failure inside Better Auth); logged with the request |
| 502 | `provider_rejected` | The provider refused the key (it answered 401 or 403), or the provider's saved key cannot be opened (Model providers; save it again) |
| 502 | `provider_unavailable` | The provider could not be reached or gave no usable answer: another status, a redirect, a timeout, a body over the limit, not JSON |
| 502 | `thinking_exhausted` | A run's error (as an HTTP answer only from `POST /api/agents/draft-persona`): the model stopped at its output limit having only thought — no answer, though it reasoned. Retryable; charged what the upstream reported, as a failed answer is |
| 503 | `busy` | A database statement ran past its timeout (the pool's or a search's), no database connection was free in time (`DB_ACQUIRE_TIMEOUT_MS`), or the site-wide search cap is reached. Nothing was changed; try again later |

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
| `GET /api/usage` | 60 | principal |
| `GET /api/models` | 120 | principal |
| `PATCH /api/me` | 10 | principal |
| `PUT /api/me/avatar` + `PUT /api/agents/:id/avatar` (yours and your Agents' avatars) | 10 together | principal |
| `POST /api/agents`, `PATCH`, `DELETE` + `POST …/pause`, `…/resume` + `PUT …/avatar` + `POST …/proposals/:proposalId/confirm`, `…/discard` of `/api/agents/:id`, `POST /api/conversations/:id/topic` | 30 together | principal |
| `POST /api/agents/draft-persona` | 5 (a budget of its own); besides, it is one of the model calls you may have running at once (`AGENT_MAX_CONCURRENT_RUNS`, replies and drafts together: over it 429; a draft and a reply starting at the same moment may briefly exceed it by one) | principal |
| `POST /api/providers`, `PATCH` + `DELETE /api/providers/:id` | 20 together | principal |
| `POST /api/providers/:id/test` + `POST /api/providers/:id/models/list` + `POST /api/providers/:id/models/refresh` (they call the provider; a test with a model calls that model once) | 10 together | principal |
| `POST /api/friend-requests` | 20 | principal |
| `PUT` + `DELETE /api/blocks/:principalId` | 20 together | principal |
| `POST /api/conversations` | 10 | principal |
| `PATCH /api/conversations/:id`, `POST /api/conversations/:id/members`, `DELETE /api/conversations/:id/members/:principalId` | 20 together | principal |
| `POST /api/conversations/:id/messages` | 120 | principal |
| Replies started (each message that queues a reply of one of your Agents — yours, or anyone's or an Agent's in a group the Agent is in —, each follow-up in a group: the reply that answers what was noted while one of your Agents was replying there, and `POST …/runs/retry`) | Counted for you in two lanes, each from the stored runs under your account's lock (so exactly, also for messages to two of your Agents at the same moment) and not scaled by `RATE_LIMIT_SCALE`: 20 for the replies you called for yourself — your own lane: your messages to your Agents, in their conversations and in groups, your Agents' calls on each other that you are behind, retries, follow-ups that answer you (`AGENT_RUNS_PER_MINUTE`) — and 20 together for every reply someone else called for on your Agents (`AGENT_OTHERS_RUNS_PER_MINUTE`), so that others' mentions cannot use up your own minute. A run is `own` when you called for it — yourself, or through an Agent's message you are behind — else `others` (a third lane, `proactive`, is for replies nobody called for; nothing starts one yet, and it would count with `others` toward `AGENT_OTHERS_RUNS_PER_MINUTE`), and keeps its lane. An Agent's message is the call of whoever called for the reply that posted it, unless that reply was its owner's own: then its owner's (Agents and runs, In a group); so a member's call that one of your Agents relays to another of yours is the member's, not yours. Neither lane nor caller is ever on the wire. Over the count of its lane a message (or a follow-up in a group) starts no reply: the message is still sent, and a `failed` run with error `rate_limited` (retryable) is recorded instead, so you see it (`run` push, `GET …/run`, in a group `GET …/runs`) and can retry — it started nothing and is not counted; in a group one such run per Agent stands for every mention and follow-up over the limit while it is the Agent's latest there and you have not dismissed it; a retry over it is 429. A follow-up in your Agent's own conversation (it answers what you wrote while it replied) is queued whatever the count, and counts toward it; one in a group counts in the lane of what it answers (Agents and runs, In a group) | owner |
| Calls on other people's Agents (a mention in a group that would start a reply of an Agent whose owner is someone else, made by a person or by an Agent's message they are behind: their own Agent's, or one relaying their call) | 5 together per person (`AGENT_CALLER_RUNS_PER_MINUTE`), counted from the stored runs under the caller's account lock, so exactly, and not scaled by `RATE_LIMIT_SCALE`; calls on the caller's own Agents never count. Over it the mention starts nothing and nothing of it is recorded — no run, no `rate_limited` run, no notice to the group or to the Agent's owner (the message is sent as any), only one log line (Metrics in the log) and, when a person's own message made the call, a word to that person alone in the answer to their send (`notCalled`, `POST /api/conversations/:id/messages`). A mention folded into a reply already under way starts nothing, so it is neither counted nor refused. It is checked after the Agent's others' daily budget (Agents in a group) and before the owner's replies a minute | caller |
| `GET /api/agents`, `GET /api/agents/:id`, `GET /api/providers`, `GET /api/conversations/:id/run`, `GET /api/conversations/:id/runs` | 120 together | principal |
| `POST /api/conversations/:id/runs/:runId/stop`, `…/runs/retry`, `…/runs/dismiss` | 60 together | principal |
| `POST /api/conversations/:id/agents/halt` | 20 (a budget of its own) | principal |
| `GET /api/conversations/:id/search` + `GET /api/search` | 30 together; at most 2 in progress per principal (429) and 4 site-wide (503 `busy`) | principal |
| `POST /api/conversations/:id/attachments` | 60 per hour; at most 3 in progress | principal |
| `GET /api/sync` | 60 | principal |
| `GET /api/conversations/:id` | 120 | principal |
| `POST /api/sync/catchup` | 60 | principal |
| `POST /api/ws-ticket` | 30 | principal |
| WebSockets | at most 5 open; a 6th closes the oldest (code 4002) | principal |

Everything else is not rate limited.

**Metrics in the log.** The service writes three kinds of line at `info`, each a JSON log object with a `metric` field,
for an operator to tune the numbers above from (nothing else about them is recorded or exposed):

- `{ "metric": "run_wait_ms", "lane", "ms" }`, once for each reply the worker claims: how long it sat queued, in the lane
  (`own`, `others`, `proactive`) it ran in. Waits that grow mean the concurrency numbers (`AGENT_MAX_CONCURRENT_RUNS`,
  `AGENT_MAX_CONCURRENT_OTHERS_RUNS`, `AGENT_MAX_RUNS_IN_FLIGHT`) are too small for the traffic, or the upstream is slow.
- `{ "metric": "caller_rate_limited", "callerId", "agentId", "conversationId" }`, once for each call on someone else's
  Agent that `AGENT_CALLER_RUNS_PER_MINUTE` refused: how often the limit holds someone back (nobody else is told of it).
- `{ "metric": "upstream_refused", "status" }`, once for each reply that ended failed because the model's upstream
  answered 429 or 5xx: how often the upstream refuses, and which way. Other failures (a refused key, a timeout) are not
  counted here.

### Usage and points

Money is whole micro-points inside (1 point = 1 000 000) and a decimal string of points on the wire: `"12.5"`,
`"0.000001"`, `"-2"` (a balance may go below zero, by less than one call's maximum cost). No floats. Points are given only by the
operator (`npm run credits:grant`, to a person's handle; an Agent's handle is refused): there is no route that
changes a balance or a tier, and `POST`/`PUT`/`PATCH`/`DELETE` on `/api/usage`, `/api/credits` and `/api/accounts`
are the JSON 404.

How a model call is admitted, held, settled and forgiven, and the bound on what concurrent calls can overrun: Metering
(below the Agents and runs section). Each reply of your Agents also tells you what that one run was charged, the same
free-plus-balance figure (`via.points`, Wire shapes).

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
  or the provider model's name, `points` what you were charged for those calls — taken from the free allowance and the
  balance; what was forgiven is not in it, so it is not the true cost (`"0"` for `provider`, and for site calls that were
  forgiven in full) —, `replies` how many were
  replies; `agentId` is `null` for persona drafts. Largest first. Runs that never reached a model (no model recorded)
  are not listed.
- Limit: 60 per minute.
- An account that has never been touched reads as tier `free`, balance `"0"`; reading creates nothing.
- Everything in the answer is read in one snapshot (one read-only transaction on one connection): a call settled
  meanwhile is in it whole — its charge, its record and its released hold — or not at all.

### Agents

An Agent is a principal of kind `agent` owned by one person for good, with a dedicated conversation (type `agent`)
whose members are exactly the owner and the Agent. Everything here is the owner's: for anybody else every
`/api/agents/:id…` route, and the conversation routes of that conversation, answer the JSON 404 `not_found`
byte for byte as for an id that does not exist. An Agent's handle is unknown to `GET /api/principals/lookup` and
`POST /api/friend-requests` (also for its owner). Only its owner puts it into a group, and only one the owner is a member
of (`POST /api/conversations/:id/members`): for someone who is not a current member of that group the route is 404
`not_found`, as for a group that does not exist, whatever the id; for a member who is not its owner its id is refused
exactly as the id of a non-friend or an unknown principal is (403 `forbidden`). Among a new group's `memberIds`
(`POST /api/conversations`) it is refused so (403) for everyone, its owner included.
Its id is unknown to `GET`/`HEAD /api/principals/:id/avatar` for anybody but its owner and whoever shares a
conversation with it now (see below), and to `PUT`/`DELETE /api/blocks/:principalId` for everyone, its owner included
(an Agent cannot be blocked): the answer of an id that does not exist, byte for byte (`tests/enumeration.test.ts`).

An Agent is in a group only while its owner is: its owner adds it, the group's creator or its owner takes it out, and it
leaves with its owner — when the owner leaves or is removed — and when it is deleted (Conversations,
`DELETE /api/conversations/:id/members/:principalId`; `DELETE /api/agents/:id`). It counts toward the group's 500
members, never becomes its creator, and reads only what comes after it (last) joined, like anyone.
An Agent is invisible to everyone but its owner and, while they share a group, to its fellow members: name, avatar,
handle, intro, field, owner — nothing else. A member of a conversation the Agent is in finds it on the member list
(`GET /api/conversations/:id/members`) and in the `principals` of `/api/sync`, message reads and searches with
`ownerId`, `intro` and `field` (Wire shapes, Principal), and loads its avatar while both are current members of that
conversation. Like a person who left, an Agent that left a group stays named by its old messages there: whoever can
still read them (a member who has since left too) gets its entry in those reads' `principals` — name, handle, intro,
field, owner, the current ones. Only its avatar stops: once either membership ends, the avatar route answers as for an
id that does not exist (old messages then show the generated initial). Nobody but the owner ever receives its persona, persona version, model, reasoning
level, reply mode, `groupMentions`, `chainBudget`, `othersBudget`, `othersSpentToday`, provider, pause or persona proposals, or the reasoning of its replies there (A reply
there), or which model and reasoning level a reply of it used and what it cost (`via`, Wire shapes), in any response,
push or error. Fellow members see a changed name, intro or field the next time they load
principals, as for people; a changed avatar is pushed to them (`principal`).

**Agent** (owner only): `{"id", "handle", "name", "avatarVersion", "intro", "field", "persona", "personaVersion", "replyMode":
"always" | "mention", "groupMentions": "members" | "owner", "chainBudget", "othersBudget", "othersSpentToday", "reasoning": "none" | "low" | "medium" | "high" |
"xhigh" | "max", "model": {"source": "site", "id"} | {"source": "provider", "providerId", "model"} | null, "paused",
"deleted", "conversationId", "createdAt"}`. `conversationId` is the Agent's dedicated conversation. `groupMentions` says
who may call the Agent with `@` in a group it is in: `members` (any member, and other Agents there) or `owner` (you
only; never another Agent). `chainBudget` is the most you pay, in points (a decimal string as money is on the wire, `"1"`
to `"100000"`, default `"50"`), for its replies in a group that other Agents' messages called for between two messages
from people (Agents in a group). `othersBudget` is the most you pay, in points (a string as `chainBudget`, `"1"` to
`"100000"`, default `"20"`; `null`: no limit), in a site day, for its replies that other people called for;
`othersSpentToday` (a string of points) is what those were charged since the site day began: a reply being written
counts once it is settled, so the number does not move while one is under way (Agents in a group). Like everything
here, they are shown to nobody but you.

#### `POST /api/agents`

*Session: required.* Body (no other key): `handle` (`^[a-z0-9_]{3,24}$`, never changes), `name` (1–20 characters,
the display-name rule), and optionally `intro` (≤ 40), `field` (≤ 20), `persona` (≤ 20 000 characters), `replyMode`
(default `always`), `groupMentions` (`members` or `owner`, default `members`), `chainBudget` (a string of points from 1
to 100 000 with at most 6 decimals, no sign or exponent: `"50"`, `"12.5"`; default `"50"`), `othersBudget` (the same
string, or `null` for no limit; default `"20"`), `reasoning` (default
`none`), `model` (default `null`). → 201 Agent.

- 409 `handle_taken` (any person's or Agent's handle); 403 `agent_limit` when your Agents that are not deleted are
  as many as `AGENT_TIERS` gives your tier (a tier it no longer names gets the `free` number; counted under the
  account lock, so concurrent creates cannot pass it); 400 for a site `model` id that is not configured, a provider
  that is not yours or does not list that model name, a provider model whose `contextTokens` is not larger than the
  output limit its calls get (`PROVIDER_DEFAULT_MAX_OUTPUT_TOKENS`, default 2 048: nothing would be left for the conversation), or a `reasoning` the model does not
  allow (a site model: `none` and its own levels; a provider model: `none` only unless it is flagged `reasoning`, then
  `none` and its `reasoningLevels`, every level when it lists none; with no model any level).
- The conversation is created with the Agent: without a `persona` it holds one message from the Agent, the fixed
  greeting, which is unread for you like any message from someone else. `personaVersion` is 1 when a persona was given.
  Such an Agent interviews you about who it should be and proposes a persona (Persona proposals, below).

#### `POST /api/agents/draft-persona`

*Session: required.* Spec 6.7 "留空自动起草": the model writes a persona for an Agent you are about to create. Body (no
other key): `name` (the rule of an Agent's name), optionally `intro` (≤ 40) and `field` (≤ 20) as on creation, and
`model` (required, not `null`), checked exactly as on creation (a site model that is configured, or a provider of yours
that lists the model; 400 otherwise). → 200 `{"persona"}`: the model's text with every `<af-…>` and `</af-…>` tag removed
— again until none is left, so none forms from the pieces of others, and an unfinished one at the end too —, under the
rules of message text, trimmed, at most 20 000 characters. It is returned, never stored: put it in the persona box and
save the Agent to keep it.

- One model call (`src/agents/persona.ts` `draftPersona`), recorded as a run of purpose `draft` (no Agent, no
  conversation) and metered like a reply (Metering): admitted before the call, its maximum cost held, settled
  after; one usage record of purpose `draft` (`GET /api/usage` lists it with `agentId: null`). No transaction is open
  during the call.
- What the model is given: a fixed instruction in Chinese (write a persona in the second person: who it is, what it
  helps with, its tone; it has no tools and the persona grants no rights) as the system text, which nothing of yours
  enters; your `name`, `intro` and `field` only as data in the user turn — a fixed line, then them as JSON
  (`{"名称", "简介", "擅长领域"}`, empty strings for what you left out). Reasoning `none`; the model's output limit.
- Refused before any call, with nothing recorded: 400 for the model; 402 `no_quota` (as a reply); 400
  `context_too_small` when the model's context, less its output limit and the instruction, cannot hold the data; 429
  `rate_limited` when you already have `AGENT_MAX_CONCURRENT_RUNS` (4) model calls running (replies and drafts
  together); 502 `provider_unavailable` when the model cannot be called (a site model whose key variable is unset); 502
  `provider_rejected` when your provider's saved key cannot be opened (Model providers: save it again).
- The call failing: 502 `provider_rejected` / `provider_unavailable` / `thinking_exhausted`, 400
  `address_not_allowed`, charged as a failed reply is (only what the upstream reported). An answer with nothing usable in it is 502 `provider_unavailable`. After
  its deadline — `AGENT_RUN_TIMEOUT_MS`, but at most `HTTP_CONNECTION_TIMEOUT_MS` less 10 s, so it answers before the
  server closes the idle connection (110 s with the defaults) — the call is ended: what it had written is the answer
  (nothing: 502 `provider_unavailable`). When the service stops during the call, it is abandoned (503 `busy`) and the stopping
  service ends the run as recovery would (`failed`, `provider_unavailable`, nothing charged; Agents and runs, Recovery);
  if that cannot be written within its 5 s, the run is released by the stale-run sweep or the next start. When the run was ended elsewhere while the model was
  answering (another instance's recovery, or the stale-run sweep), nothing more is recorded and the answer is 503
  `busy` (logged at warn). When its settlement cannot be stored (500 `internal`), that is logged with the run's id and
  the run, still `running`, is released by the stale-run sweep or the next start.
- Limit: 5 a minute, a budget of its own.

#### `GET /api/agents`

*Session: required.* → 200 `{"agents": [Agent]}`: yours, oldest first, deleted ones included (`deleted: true`). Limit:
120 per minute, together with `GET /api/agents/:id`, `GET /api/providers`, `GET /api/conversations/:id/run` and
`GET /api/conversations/:id/runs`.

#### `GET /api/agents/:id`

*Session: required.* → 200 Agent (also a deleted one); 404 `not_found` unless yours. Limit: 120 per minute, shared as
for `GET /api/agents`.

#### `PATCH /api/agents/:id`

*Session: required.* Body (no other key: `handle` and the owner are 400): any of `name`, `intro`, `field`,
`persona`, `replyMode`, `groupMentions`, `chainBudget`, `othersBudget` (`null`: no limit), `reasoning`, `model` (`null` clears it), under the rules of creation; the
model and the reasoning level are checked together when either is sent. A `persona` that differs from the stored one
raises `personaVersion` by one. → 200 Agent; 400 `invalid_request` for a value, model or reasoning level that does not
fit; 409 `agent_deleted`; 404 `not_found` unless yours.

#### `POST /api/agents/:id/pause`

*Session: required.* Body: none or `{}`. Pauses the Agent (idempotent). → 200 Agent; 409 `agent_deleted`; 404 `not_found` unless yours. You can still write to a paused Agent;
it does not reply. Its reply in progress ends for good, decided in the pause's own transaction: a queued one is
`cancelled` at once (`run` pushed), a running one is never posted — also if you resume before the model has finished —
and ends `cancelled`; once this answers, nothing more from the Agent is posted and no further `delta` of that reply
reaches you (see Agents and runs). Resuming starts nothing: what was written during the pause is not answered; your next
message is, with everything before it in what the Agent is shown.

#### `POST /api/agents/:id/resume`

*Session: required.* Body: none or `{}`. Resumes it (idempotent). → 200 Agent; 409 `agent_deleted`; 404 `not_found` unless yours.
Resuming a paused Agent first ends, in its own transaction, what its pause could not see — a reply another Agent's
message in a group queued for it, or a mention noted, as the pause committed (Agents and runs, Pause and delete): such
a queued reply is `cancelled` `agent_paused` (`run` pushed), a running one is never posted and ends `cancelled`
`agent_paused`, and nothing noted on it is followed up. So nothing written before the resume is answered by it.

#### `DELETE /api/agents/:id`

*Session: required.* Body: none or `{}`. Deletes the Agent: irreversible and idempotent (a deleted Agent no longer counts toward the limit; its
conversation and history stay readable, sending there is 403 `cannot_send` `{"reason": "agent_deleted"}`; its reply in
progress ends as on a pause, with `agent_deleted`). → 200 Agent; 404 `not_found` unless yours.

It also leaves every group it is in, before the answer: once the delete itself has committed, one transaction per group
appends a `member_left` notice there (`actorId` you, `principalId` the Agent; pushed as any leaving) whose seq ends its
membership. What it said there stays. Should that not happen — the service stopped in between, or a group's transaction
failed — the next start does it, right after recovering the runs the previous process left running and before the
worker starts or any request is served (and a repeated delete tries again). Meanwhile, while it is still
listed in a group, it replies nothing there: it is deleted, and every step of a reply refuses a deleted Agent.

#### `PUT /api/agents/:id/avatar`

*Session: required.* The rules and limits of `PUT /api/me/avatar`, for the Agent: it counts against the same 10 uploads a
minute as your own avatar, and also against the 30 Agent writes. → 200 `{"ok": true}`; 400, 413 and 415 as there;
409 `agent_deleted`; 404 `not_found` unless yours.
Every avatar change (people's too) raises `principals.avatar_version`.

### Persona proposals

Spec 6.7 "边聊边配置". An Agent can propose its own persona in a reply in its own conversation with you: one without a
persona interviews you about who it should be (its system text says how, Agents and runs), and any Agent writes one
when you ask it to update its persona. A reply in a group is never read for one (Agents in a group, A reply there).
A proposal is only a proposal. **The one way it changes the Agent is `POST …/proposals/:proposalId/confirm` from your
own session**; nothing the model writes — a block, "已确认", a request it forges — changes anything of the Agent. A
proposal can carry the persona, the intro and the field, nothing else (not the model, the pause, the handle or the owner).

**The block.** An Agent's reply proposes when its text (as stored: message-text rules, trimmed) holds exactly

```
<af-intro>一句话简介</af-intro>        (optional, at most 40 characters, one line)
<af-field>擅长领域</af-field>          (optional, at most 20 characters, one line)
<af-persona>完整的人格设定</af-persona>  (required, 1–20 000 characters)
```

— intro and field in either order, both before the persona, nothing but white space between the parts, each part once,
and no other `<af-` or `</af-` anywhere in the text (so nothing nested, repeated or unknown); the values are trimmed and
checked by the rules of an edit (`PATCH /api/agents/:id`). Then, in the transaction that stores the reply (under the
Agent's lock, `postAsAgent`), the block is taken out of the message — its text is what is left, trimmed, or, with
nothing visible left, the fixed sentence `我整理了一份设定，请查看并确认。` — and the proposal is stored against the persona
version of that moment; the Agent's earlier `open` proposals become `superseded`. Anything else (two blocks, a nested
or unclosed one, an unknown `<af-…>` tag, a value over its limit) is no proposal: a complete reply is stored as written.
A reply that was stopped or cut (`stopped`, or `truncated`: at the model's output limit, the time limit or 8 000
characters) and holds no proposal ended inside a block it never finished: everything from its first `<af-` on is
dropped, so you never see a tag (with nothing left, it counts as a reply that said nothing: a stop posts nothing, a cut
reply fails `provider_unavailable`). A stopped reply with a whole block before the stop proposes as usual. Only the
Agent's reply text is read for a block, at the moment it is stored: never your messages, quotes, files or the model's
reasoning. While the reply streams, its text is pushed only up to the first `<af-`: tags never reach a `delta`; the
rest arrives with the message.

**What the Agent sees of it later.** In what the model is shown, a reply that proposed is its text followed by the
proposal written out again as its block (intro and field when it named them): the Agent can revise what it proposed.
That is the Agent's own earlier output in its own turn; it is never read for a block again (only a new reply is), it
counts toward the context budget like any text, and like any message it is not shown after a new topic.

**On the wire** (owner only): the reply carries `"proposal": {"id", "status", "persona", "intro"?, "field"?}` (Wire
shapes); `intro` / `field` only when the proposal names them. `status`: `open`; `confirmed`; `discarded`; `superseded`
(a newer proposal of the Agent came); `stale` (your persona changed since the proposal was made — by an edit or by
confirming another — so it would overwrite what you have now: shown so at once, stored so once a confirmation runs into
it; the card should say "配置已变更，请重新生成提议"). Anybody else reading the message (there is nobody but you and the
Agent in its conversation) gets it without `proposal`.

**Keeping cards current.** A proposal made, confirmed or discarded sends you the `agent` push: fetch the Agent
(`GET /api/agents/:id`) and the messages you show with a proposal card (`GET /api/conversations/:id/messages/:seq`)
again; their `proposal.status` may have changed. (A persona edit sends `agent` too, and can make a card `stale`.)

#### `POST /api/agents/:id/proposals/:proposalId/confirm`

*Session: required.* Body: none, `{}`, or your edits before confirming: any of `persona` (1–20 000 characters),
`intro` (≤ 40), `field` (≤ 20), under the rules of `PATCH` — and no other key (400: a confirmation can change nothing
else). Under the Agent's lock: the persona, intro and field become your edit where given, else the proposal's (an intro
or field the proposal does not name stays as it is); `personaVersion` rises by one (also when the persona text is the
same); the proposal is `confirmed`. The next reply is given the new persona. → 200 Agent. Allowed while the Agent is
paused. 404 `not_found` exactly as for an id that does not exist unless the Agent is yours and the proposal is that
Agent's; 409 `agent_deleted`; 409 `stale_proposal` when the proposal is not `open`, or when your persona has changed
since it was made (the proposal is then marked `stale`); your persona stays as it is. Limit: 30 per minute with the
Agent writes.

#### `POST /api/agents/:id/proposals/:proposalId/discard`

*Session: required.* Body: none or `{}`. The proposal becomes `discarded`; the Agent does not change. Idempotent for one
already discarded. → 200 `{"ok": true}`. 404 as for confirm; 409 `agent_deleted`; 409 `stale_proposal` for a proposal
that is `confirmed`, `superseded` or `stale` (an open one whose persona has moved on is marked `stale`). Limit: 30 per
minute with the Agent writes.

### Replies

An Agent's replies, as runs (how they start, end and fail: Agents and runs below). In the Agent's own conversation
every route here is the owner's and takes the conversation id: for anybody else, for a conversation that is not an
Agent's or a group, and for a run of another conversation, it answers the JSON 404 `not_found` byte for byte as for an
id that does not exist. In a group (In a group, below) the Agent's owner sees and acts on its runs there, and every
other current member learns only whether it is replying. Failures are never messages: they live on the run, which the
owner learns from the `run` push and from `GET /api/conversations/:id/run` (in a group, `GET …/runs`).

**Run**: `{"id", "status": "queued" | "running" | "done" | "failed" | "stopped" | "cancelled", "error"?, "retryable",
"resetsAt"?}`. `error`: for `failed` why (`provider_rejected`, `provider_unavailable`, `address_not_allowed`, `no_quota`,
`context_too_small` — the model's context cannot hold your newest message, or 200 tokens of it, after the persona —,
`thinking_exhausted` — the model used its whole output limit thinking and gave no answer; charged what the upstream
reported; retry, or choose a lower reasoning level — or
`busy`: the service's own trouble — the reply could not be started or stored, its attachments could not be read, or
there was nothing to answer — which costs you nothing; `provider_unavailable` is also what a reply that was under way
when the service restarted ends with, and one the stale-run sweep released; `rate_limited`: you had started
as many replies in the last minute as its lane allows (`AGENT_RUNS_PER_MINUTE`, 20, of your own; `AGENT_OTHERS_RUNS_PER_MINUTE`,
20, of those others called for), so this one was not started — no call, nothing held or charged; retry once the minute
has passed), for
`cancelled` `agent_paused` or `agent_deleted`, `agent_removed` (the Agent left the run's group: the group's creator or you
took it out, or it left with you when you left or were removed), `halted` (in a group: another Agent's message had called for it and a
member halted Agents calling each other, Agents in a group; show it as “已被群成员叫停”), or none (everything it was to
answer is before a new topic you started, or — a reply someone else called for in a group — the Agent's others' daily
budget was spent by the time it was to start: nothing was called or charged, and the group was told, Agents in a group).
`retryable`: it failed and trying again as it is may work (false
after `provider_rejected`, `address_not_allowed` and `context_too_small`, and for every run that did not fail; true
after `rate_limited`, which a retry within the same minute meets again as 429). `resetsAt` (ISO instant): for
`no_quota` on a free-tier model, the next midnight in `SITE_TIMEZONE`, when the free allowance starts again.

**In a group.** What an Agent's replies there show is decided per reader from its **latest run in the group during its
current stay** (a run covering a message after it last joined; nothing is stored per member). Its owner sees that Run.
Every other current member sees only a **state**: `"replying"` (the run is `queued` or `running`), `"unavailable"`
(`failed`, and its owner has not dismissed it — never why, nor the run, its id, `error`, `retryable` or `resetsAt`), or
`null` (nothing to show: `done`, `stopped`, `cancelled`, a failure its owner dismissed, no run in this stay, or the
Agent is no longer in the group). Show `"replying"` as “某某正在回复…” and `"unavailable"` as “某某暂时无法回复”. Stop,
retry and dismiss of a group run are its Agent's owner's; for anybody else they answer exactly as for a run (or an
Agent) that does not exist. `GET …/run` is not a group's: there it is the 404 of an unknown id.

#### `GET /api/conversations/:id/run`

*Session: required.* → 200 `{"run": Run | null}`: the conversation's latest run — so a page loaded during a reply shows
"replying", and one loaded after a failure shows it — or null when there is none, or when the latest failed and you
dismissed it. Limit: 120 per minute, shared as for `GET /api/agents`.

#### `GET /api/conversations/:id/runs`

*Session: required.* A group's Agent replies as you may see them (In a group, above) → 200 `{"runs": [{"agentId",
"state": "replying" | "unavailable", "run"?: Run}]}`: one entry per Agent that is a current member of the group and whose
state is not null, in `agentId` order; `run` (that latest Run) only on the entries of your own Agents. A page loaded
during a reply shows it, and one loaded after a failure shows it to everyone (its reason to its owner only); fetch it
when you open a group and after a reconnect. 404 `not_found`, byte for byte as for an id that does not exist, unless it
is a group you are a current member of: a direct chat and an Agent's own conversation (yours too: it has
`GET …/run`) answer that same 404. Limit: 120 per minute, shared as for `GET /api/agents`.

#### `POST /api/conversations/:id/runs/:runId/stop`

*Session: required.* Body: none or `{}`. Stops the reply: a queued one at once (it never reaches the model; `run`
`stopped` is pushed); a running one as soon as the worker notices (within 50 ms): what it had said so far is posted
with `stopped: true` and the run ends `stopped` (nothing said: no message). A running one that no worker of this
instance is working on — another instance's during a deploy, or one left by a process that is gone — is released at
once, exactly as recovery releases one (Agents and runs, Recovery): `failed`, `provider_unavailable`, retryable, its
hold released at no charge (or, when its reply had been posted, `done` / `stopped` as its message says; `cancelled`
when a pause had interrupted it); `run` is pushed. A run that has ended is left as it is. Idempotent. → 200
`{"ok": true}`. In a group: a run of one of your Agents in that group, while you are a current member of it (the other
members are pushed its state: `null` once it is stopped, `"unavailable"` when it was released as `failed`); a run of another member's Agent, of another conversation, or
an unknown id is the 404 of a run that does not exist, and a group you are not in that of a conversation that does not
exist. Limit: 60 per minute with retry and dismiss.

#### `POST /api/conversations/:id/runs/retry`

*Session: required.* Body: none or `{}` in an Agent's own conversation (an `agentId` there plays no part: the
conversation names its Agent); in a group `{"agentId"}`, one of your Agents (required there: 400 `invalid_request`
without it). When the latest run failed, queues a new reply answering up to your last message — in a group, answering
again exactly what the failed run was to answer (its messages and what was noted on it while it ran, not your last
one), called for by whoever called the failed run: one that another Agent's message called for (`triggered_by`
`agent`) stays an Agent's, so a member's halt still ends it (Agents in a group). → 201 `{"run": Run}` (queued; also pushed). 409 `busy_run` while a reply is queued or
running; 409 `agent_paused` / `agent_deleted`; 400 `invalid_request` when the latest run did not fail (or there is
none) or the Agent has no model — in a group also when the Agent is not in the group now or its latest run there is
from an earlier stay; so a reply cancelled by a halt (`halted`) or by the Agent's leaving (`agent_removed`) is not
retried; 429 `rate_limited` over the replies one may start a minute (a retry is your own lane: 20). In a group, an `agentId` that is not one of
your Agents is 404 `not_found` as for an Agent that does not exist, and a group you are not a current member of as for
a conversation that does not exist. Limit: 60 per minute with stop and dismiss.

#### `POST /api/conversations/:id/runs/dismiss`

*Session: required.* Body as for retry. You closed the failure notice: when the latest run failed,
`GET /api/conversations/:id/run` answers `null` from now on (until the next run). Otherwise nothing changes.
Idempotent. → 200 `{"ok": true}`. In a group: the latest run of that Agent there — also when the Agent has left the
group since — when it failed: it leaves `GET …/runs`, and every other current member is pushed `"state": null` for that
Agent (you are told nothing: you closed it). 400 and 404 as for retry. Limit: 60 per minute with stop and retry.

#### `POST /api/conversations/:id/topic`

*Session: required.* Body: none or `{}`. Starts a new topic (spec 6.2 "新话题"): a `topic_reset` notice from you is
appended (see System notices), and from then on the Agent's replies are given only what comes after the latest such
notice (Agents and runs). History, search and unread counts are unchanged; two in a row are fine. → 201
`{"message": WireMessage}` (the notice; it is also pushed). Allowed while the Agent is paused; 403 `cannot_send`
`{"reason": "agent_deleted"}` once it is deleted. It starts no reply, and a reply already under way goes on with what it
was given (the old topic); a reply still queued is given the new topic, so one with nothing after the notice to answer
ends `cancelled` with no error. Limit: 30 per minute with the Agent writes.

### Agents in a group

An Agent in a group (an owner puts their own Agent into a group they are in) replies when a message there calls it by
`@handle` (Agents and runs, In a group); the run is its owner's and so is the cost. Other Agents there may call it too,
under three brakes, each about Agents calling Agents — a person's mention is never refused by them:

- **The chain limit** (`AGENT_CHAIN_LIMIT`, 30): once the group's last that many messages that are not notices were all
  sent by Agents, an Agent's message calls nobody until a person writes; the first such message appends the
  `agent_chain_paused` notice (System notices), once per pause.
- **The halt** (below): any member stops it at once; until a person writes again, Agents' messages call nobody, and
  what Agents' messages asked of a reply before the halt is never answered by a follow-up, even once a person has
  written since.
- **The chain budget** (`chainBudget`, per Agent, its owner's setting): once what its owner was charged for its replies
  in the group covering messages after the latest from a person reaches it, Agents' messages do not call it until a
  person writes; the group is told once per chain (`agent_budget_reached`). It is checked when an Agent's message would
  call it and again as each of its replies ends, before a follow-up that only Agents' messages asked for (a reply is
  charged only once it has ended): so a chain passes its budget by at most the reply that was under way. A reply on a
  provider model costs no points, so for such an Agent only the chain limit and the halt apply.

**The others' daily budget** (`othersBudget`, per Agent, its owner's setting) is of another kind: it is about whose
points are spent, and it holds against people's mentions too. A call on an Agent by anyone but its owner — a member, or
an Agent's message a member is behind (the member's own Agent's, or one of the owner's Agents relaying the member's
call), whose call is that member's — spends the owner's points. Once what those replies were charged today (free
allowance and balance, settled charges only: a reply being written counts once it is settled, since what it holds is
the most it can cost — its whole output limit — which on a paid model can alone be more than the budget) has reached
`othersBudget` (default 20
points; `null`: no limit, which the owner is warned of: anyone in the group can have the Agent reply on their points),
the next such call is not answered: no model call, nothing held or charged, and not even a fold into a reply of the
Agent's under way. The group is told by one `agent_daily_budget_reached` notice, once per site day (midnight in
`SITE_TIMEZONE`) for each conversation and Agent, and the owner is pushed their Agent again (`agent`), so the
`othersSpentToday` they see is current. The owner's own calls, in groups and in the Agent's own conversation, never
count and are never refused. Replies under way are not cut off and count only once settled, so the day's real spend can
pass the budget by the replies being written when it is reached: at most as many as the owner has places for others'
replies (`AGENT_MAX_CONCURRENT_OTHERS_RUNS`, default 3). A reply such a call queued meets the budget again as the worker
admits it, under the Agent's lock, which settlement takes too: spent by then — by replies settled while it waited —, it
ends `cancelled` with no error — no model call, nothing held or charged — with the same notice, once a day, and the same
push to the owner; so an Agent called in several groups at once does not start a reply in each once the first have
spent it. Raising the budget above today's spend, or setting it `null`, answers calls again at once; lowering it
below the spend refuses at once. A reply on a provider model costs no points, so for such an Agent the budget never
holds.

The owner's other limits hold throughout, for every reply in a group — called by a person's mention, an Agent's, or a
follow-up of what was noted while a reply ran: replies started a minute, counted per lane (`AGENT_RUNS_PER_MINUTE` for
the owner's own, `AGENT_OTHERS_RUNS_PER_MINUTE` for what others called for; over it, the Agent's one `rate_limited` run
in the group, Rate limits), running at once (`AGENT_MAX_CONCURRENT_RUNS`, of which at most
`AGENT_MAX_CONCURRENT_OTHERS_RUNS` for others' calls, so that a crowd mentioning the Agent leaves the owner a place of
their own), and the free allowance or balance. And a person who calls other people's Agents more than
`AGENT_CALLER_RUNS_PER_MINUTE` times a minute is not answered for the extra ones (Rate limits). So members who keep
mentioning an Agent while it replies cannot keep it replying past its owner's limits. For a mention by someone other
than the Agent's owner the checks run in this order, and the first to refuse decides: the others' daily budget (the
group is told), then — unless the mention folds into a reply under way, which starts nothing — the caller's limit
(only the sender is told, in the answer to their send), then the lane's replies a minute (a `rate_limited` run, which only the owner sees).

**A reply there** (Agents and runs: the worker, What the model is shown):

- *What the Agent is given.* A system text of its own for groups: whose Agent it is, the group's name, that several
  people and maybe other Agents speak there and each message of theirs is labelled with its speaker, that it was called
  by `@handle` and answers whoever called it, briefly; that it calls another Agent with `@handle` only when it needs
  that Agent's help, never to greet or thank, and the other Agents in the group now (name, `@handle`, intro; at most 20
  named); that it must not reveal or quote its persona, its configuration or anything of its private conversation with
  its owner; then its persona. The group's name and the other Agents' names and intros, which other people wrote, are
  introduced as descriptions for it to know, not instructions to it, each on one line of its own (line breaks in them
  become spaces). Nothing about persona proposals. Then the group's recent history as the Agent may read it — from its
  (last) joining on, the one visibility rule with the Agent as reader, files too —: its own messages as its turns,
  everyone else's as the other side's, each starting with the speaker's current name (`名字：…` for a person,
  `名字（Agent）：…` for another Agent); notices left out. Nothing of any other conversation, its own with its owner
  included; nor does anything of the group reach that one.
- *How much of the group.* At most its latest 80 messages, and at most `AGENT_GROUP_CONTEXT_TOKENS` (12 000) tokens of
  them, oldest dropped first, within that cap, as in its own conversation (What the model is shown): the cap replaces
  the model's context as the budget when the context would hold more. It is the service's estimate — a token per
  character, labels and quotes included, 1 500 an image, 300 per KB of PDF — so a provider may bill an image or a PDF at
  more. The system text comes on top of it. Its own conversation has no such cap.
- *What it stores.* An ordinary `text` message from the Agent, which every member reads: its text (message-text rules,
  everything from its first `<af-` on dropped, cut at 8 000 characters), `stopped` and `truncated` as in its own
  conversation, and the model's `reasoning` exactly as there (message-text rules, at most 32 000 characters, only when
  there is some). Never a persona proposal: a block in it is no proposal, changes nothing of the Agent, and is not shown
  (with nothing else in the reply, it counts as an answer that said nothing). A reply with no visible text is not posted
  however much it thought (its members would see an empty message): it too counts as an answer that said nothing. Its
  own mentions may call other Agents (above).
- *Who reads its thinking.* Only the Agent's owner (the product owner's decision of 2026-11-18; a model's thinking often
  restates its persona). Every read of a message decides it per reader, in the query that decides whether the reader
  sees the message at all (`messages/read.ts` `toWireForReaders`): `reasoning` is sent when the reader is the
  `owner_id` of the principal that sent it, read when the message is read — on the history, a single message,
  `GET /api/sync` and catch-up, both searches and every `message` push. Everyone else gets the message without the
  field (absent, not null or empty: exactly what a message stored without reasoning looks like). An owner who has left
  the group reads none of it, as they read nothing of the group. A quote of the reply, the member list, `run` pushes and
  `GET …/runs` carry none of it to anyone, and search never looks at it (Search).
- *Which model it used.* Its owner's copy of the message carries `via` — the model and reasoning level its run used,
  and what its owner was charged for it —, decided per reader exactly as its thinking is; nobody else's carries the key
  (Wire shapes, `via`).
- *Nothing is streamed*: no `delta` is pushed for a reply in a group, to anyone, its owner included; it arrives whole,
  as its message (its owner's with its thinking, then once more with its `via` when its run is charged).
- *Who pays.* The Agent's owner, exactly as in its own conversation (Metering): admitted against the owner's free
  allowance or balance and settled there. Whoever called it is charged nothing and sees nothing of it in their
  `GET /api/usage`; on its owner's provider model it costs no points.
- *Still a member?* Checked under the group's row when the reply begins and again when it is posted: an Agent no longer
  in the group calls nothing and posts nothing there, and the run ends `cancelled`, `agent_removed`.

#### `POST /api/conversations/:id/agents/halt`

*Session: required.* Body: none or `{}`. Any current member of a group stops Agents calling each other there (“让 Agent
停下”): from now on, until a person sends a message (any message, later than this), an Agent's message calls no other
Agent. Replies that Agents' messages called for end at once: a queued one is `cancelled` with error `halted` (`run`
pushed to its owner), a running one is never posted and ends `cancelled`, `halted` (what it had said is discarded; what
it used is settled; a reply already posted stays); what a person asked of such a reply meanwhile is still answered. Replies
a person called for are left alone, but what Agents' messages asked of one before the halt (noted while it ran) gets no
follow-up when it ends, even if a person has written since. An `agents_halted` notice from you is appended (and pushed). Idempotent: while the
group is still halted (nobody has written since the last halt) it changes nothing and appends nothing. → 200
`{"ok": true}`. 404 `not_found`, byte for byte as for an id that does not exist, unless it is a group you are a current
member of (a direct chat and an Agent's own conversation too). Limit: 20 per minute, a budget of its own.

### Model providers

A provider is a person's own account at a model service, which their Agents can answer with
(`"model": {"source": "provider", "providerId", "model"}`). Everything here is the owner's: for anybody else every
`/api/providers/:id…` route answers the JSON 404 `not_found` byte for byte as for an id that does not exist, and an
Agent cannot be pointed at their provider (400).

**Provider** (owner only): `{"id", "name", "protocol": "openai_chat" | "openai_responses" | "anthropic" | "gemini",
"baseUrl", "keyLast4", "models": [{"name", "vision", "pdf", "reasoning", "contextTokens", "reasoningLevels"?}]}`.

- **The API key** is sealed when saved (AES-256-GCM, a key derived from `PROVIDER_KEY_SECRET` with HKDF-SHA-256,
  `src/providers/crypto.ts`) and never shown again: no answer, push, error or log line carries it; `keyLast4` is its
  last four characters. It is opened only to make a call to that provider. The sealed value is bound to its provider
  row — its owner and its id are authenticated with it (layout version 2) — so a value copied into another provider's
  row, of the same owner or another, does not open there: a call with a key that cannot be opened (that, or a changed
  `PROVIDER_KEY_SECRET`) is `provider_rejected`, nothing is sent, and the log says why; the owner saves the key again.
  No provider keys had been stored anywhere before this layout, so no stored data needed migrating (a value in the
  earlier layout, version 1, would read as one that cannot be opened).
- **`baseUrl`** must be `https:`, without credentials (no `@` before the host), with a plain DNS name or an IP address as
  host and any port from 1 to 65535. It is stored without query, fragment or trailing slash (`https://API.example.com:443/v1/?x`
  is `https://api.example.com/v1`), and with an API version: unless a segment of its path already names one (`/v1`,
  `/v2`, `/v4`, `/v1beta`…: `v`, digits, then letters, the whole segment, anywhere in the path), the protocol's own is
  appended — `/v1` for the OpenAI protocols and Anthropic, `/v1beta` for Gemini (`https://api.deepseek.com` is
  `https://api.deepseek.com/v1`; `https://open.bigmodel.cn/api/paas/v4` stays as it is). An address typed with a
  trailing `#` is stored as typed instead: the `#` taken off, nothing added (`https://api.longcat.chat/openai#` is
  `https://api.longcat.chat/openai`). One function makes it (`providerBaseUrl`, `src/providers/base-url.ts`); the web
  form previews the same rule (`storedBaseUrl`, `app/web/src/pages/Providers.jsx`), and both test files hold one table
  of cases. A provider saved before this rule keeps its address as it was, until its address is edited. Saving checks
  only that; the address is checked at every call (below).
- **Models**: at most 100; `name` 1–100 characters, one line, trimmed, unique within the provider; `vision`, `pdf` and
  `reasoning` default to false and `contextTokens` (1 000–2 000 000) to `PROVIDER_DEFAULT_CONTEXT_TOKENS` (default 16 000).
  `reasoningLevels` (optional, only on a model flagged `reasoning`): the thinking levels it supports, 1–5 distinct ones of
  `low`, `medium`, `high`, `xhigh`, `max`, in that order; without it the model takes every level. (Stored with the
  models, in the provider's `models` JSON: nothing to migrate.) An Agent may use only a listed model, and a
  reasoning level other than `none` only on a model flagged `reasoning`, and one of its `reasoningLevels` when it lists
  them (checked when the Agent is created or edited; a run sends the saved level, see Replies). Removing a model from the
  list, or narrowing its levels, does not change the Agents that use it.

**The address guard** (`src/providers/guard.ts`), at every call to a provider, before any connection: the URL must pass
the `baseUrl` rules; the host name is looked up once, and the call is refused with `address_not_allowed` if any address
it resolves to (or the address written in the URL) is not public: loopback (127/8), private (10/8, 172.16/12,
192.168/16, fc00::/7), link-local (169.254/16, fe80::/10, fec0::/10), carrier-grade NAT (100.64/10), unspecified or
`0/8`, IETF protocol assignments (192.0.0/24), documentation (192.0.2/24, 198.51.100/24, 203.0.113/24), the retired
6to4 relay range (192.88.99/24), benchmarking (198.18/15), multicast (224/4, ff00::/8), reserved and broadcast
(240/4), an IPv4-mapped form of one, or any IPv6 address that is not ordinary global unicast (only `2000::/3` is allowed, less Teredo
`2001::/32`, 6to4 `2002::/16`, documentation `2001:db8::/32`, ORCHID `2001:10::/28` and `2001:20::/28` and
benchmarking `2001:2::/48`; so NAT64, IPv4-translated, IPv4-compatible and discard `100::/64` are refused too). The connection then goes to exactly an
address that was checked (the name stays the Host header and the TLS server name), so a name that resolves differently
a moment later changes nothing. Redirects are never followed (any 3xx is `provider_unavailable`), and a call is given up
(`provider_unavailable`) after a set time without progress (until the headers, from the headers to the first byte of
the body, then between body chunks) or once its answer passes a set size: for test, model list and refresh below, 15 s (and 30 s
in all) and 2 MiB; for a model's answer, see Calling a model. At most `PROVIDER_MAX_CONCURRENT_CALLS` (default 64) calls
to providers and site models are in flight at once in the whole service — one count for these routes and every model
call — from before the name lookup until the answer is read or abandoned; one more is `provider_unavailable` at once. A
call stopped by its caller closes its connection at once.

#### `POST /api/providers`

*Session: required.* Body (no other key): `name` (1–40 characters, one line, trimmed), `protocol`, `baseUrl` (at most
1000 characters), `apiKey` (trimmed, then 8–1000 printable ASCII characters without spaces), and optionally `models`
(`[{"name", "vision"?, "pdf"?, "reasoning"?, "contextTokens"?, "reasoningLevels"?}]`). → 201 Provider.

- 400 `provider_limit` when you already have 10 providers (counted under the account lock, so concurrent creates
  cannot pass it); 409 `name_taken` when one of yours has that name.

#### `GET /api/providers`

*Session: required.* → 200 `{"providers": [Provider]}`: yours, oldest first. Limit: 120 per minute, shared as for
`GET /api/agents`.

#### `PATCH /api/providers/:id`

*Session: required.* Body (no other key; `protocol` cannot change and is 400 too): any of `name`, `baseUrl`, `apiKey` (sealed
anew; without it the stored key stays), `models` (replaces the list), under the rules of creation (a new `baseUrl` is
stored for the provider's own protocol). → 200 Provider;
409 `name_taken`; 400 `invalid_request` for a `baseUrl` on another origin — scheme, host or port — than the stored one
without `apiKey` in the same request: the stored key is never sent to an address it was not saved for (another path on
the same origin keeps it). 404 comes first: someone else's provider is 404 whatever the body.

#### `DELETE /api/providers/:id`

*Session: required.* Body: none or `{}`. → 200 `{"ok": true}`; 409 `{"error": "provider_in_use", "agents": [{"id", "name"}]}` while Agents
of yours that are not deleted use it (deleted Agents that still name it lose their model). It is locked while checked,
so no Agent can take it in the meantime.

#### `POST /api/providers/:id/test`

*Session: required.* Body: none, `{}` or `{"model"}` (other keys are ignored). Without `model`, the model list is asked
for: one authenticated `GET {baseUrl}/models` through the guard, the key in the protocol's own header (`Authorization:
Bearer` for the OpenAI protocols; `x-api-key` and `anthropic-version: 2023-06-01` for Anthropic; `x-goog-api-key` for
Gemini) → 200 `{"ok": true, "mode": "list", "latencyMs"}`. With `model` — one of the provider's saved models (another
name is 400 `invalid_request`, and nothing is sent), or, while it has none, any name a model may have — one tiny real
call to that model through the gateway, the way a reply goes (Calling a model): no system text, one user message `hi`,
reasoning `none` (with the thinking switch when the saved model is flagged `reasoning`), an output limit of 16 tokens,
given up after 15 s → 200 `{"ok": true, "mode": "chat", "latencyMs"}` (a model that spent those 16 tokens thinking did
answer: that is a success too). `latencyMs`: how long the call took, whole milliseconds. The call costs no points, as
any provider model's: nothing is admitted, held, metered or recorded (no usage record, no run).

A failure, either way: `{"ok": false, "error": "provider_rejected" | "provider_unavailable" | "address_not_allowed",
"upstreamStatus"?: "<HTTP status>", "detail"?}`: 401 or 403 is `provider_rejected`; anything else that is not a good
answer is `provider_unavailable` (for the model list: anything but a 200 with a JSON body). `upstreamStatus` is the
provider's HTTP status as a string (`"404"`), present when it answered with one (not for a refused address, an
unreachable host, a timeout or a redirect): without `model`, a 404 or 405 means the provider has no model list there —
a client can say so, as chat may still work (the model list then has to be typed in, or taken from the catalogue, see
`…/models/list`). `detail`, present when the provider answered: what it said (below). The log records the provider id,
protocol, code and the provider's HTTP status, and nothing else.

**What the provider said** (`detail`, `src/providers/upstream-detail.ts`): `{"upstreamStatus", "message"?}`. A
deliberate, narrow exception to the rule that nothing an upstream sends is passed on: only in the failures of this route
and of `…/models/list`, which only the provider's owner can call about their own provider; never for a site model, in a
run, a push, a refresh's error or a log line. `message` is the provider's own error text, read from the first 64 KiB of
its answer: its JSON `error.message`, `message` or `error` when that is a string (also in a list of one), else the text
itself; with control and format characters taken out (line breaks and tabs as spaces), white space collapsed, and at
most 300 characters. When the answer — anywhere in it, not only that text, ignoring case — holds the key or any 6
characters of it in a row, as an upstream echoing the request's headers does, the text is dropped and the answer says
so: `{"upstreamStatus", "message": null, "redacted": true}`. A test with a model keeps no text: the gateway keeps
nothing of an upstream's answer but its status (Calling a model), so there `detail` is `{"upstreamStatus"}`.

#### `POST /api/providers/:id/models/list`

*Session: required.* Body: none or `{}`. The provider's model list for its owner to choose from: the same request as the
test without a model, and the names in its answer read as refresh reads them (below: the first 1 000 entries; names
that would not be accepted as a model name — trimmed first —, any containing the key, and repeats skipped). **Nothing
is stored.** → 200 `{"ok": true, "listed": [{"name", "vision", "pdf", "reasoning", "chat", "known", "label"?,
"contextTokens"?, "reasoningLevels"?, "added"}], "source": "upstream"}` in the provider's order, at most 500 entries;
or a failure exactly as the test answers it, `detail` included: `{"ok": false, "error", "upstreamStatus"?, "detail"?}`,
with the code refresh would answer. `added`: the provider's saved `models` already has that name.

**No model list there** (the provider answered 404 or 405): when the provider's host — the exact host name; port and
path aside — is the API host of a provider in the catalogue (`src/providers/provider-catalog.json`, written with the
model catalogue below from models.dev's `api.json`: each catalogue provider that names its `api` address, with that
address's host and its model ids; `catalogueModels`, `src/providers/catalogue.ts`), the answer is `{"ok": true,
"listed", "source": "catalogue"}`: that provider's model ids, read and hinted as above (several catalogue providers at
one host: all their ids, each once). They are what the public catalogue says the host offers, not what this key may use,
and a client says so. At a host the catalogue does not know, the answer is the failure, as before (its models are typed
in by hand). The test and the refresh never use the catalogue.

The rest are hints (`modelHints`, `src/providers/hints.ts`), for a client to suggest a model's flags when its owner adds
it — hints, the owner can change them; nothing here checks them. `chat` false: probably not a chat model (an embedding,
speech, image or video model…).

- **From the catalogue** (`known: true`): a vendored snapshot of the [models.dev](https://models.dev) catalogue (MIT),
  `src/providers/model-catalog.json`, written by `npm run catalog:update` (`scripts/update-model-catalog.mjs`, run by hand:
  it downloads the catalogue and keeps per model only its id, lab, display name, what it takes and answers, its context and
  its lab's thinking levels — and, in `provider-catalog.json`, per catalogue provider its API host and model ids;
  `model-catalog.README.md` says when). The service never fetches the catalogue. The name is
  trimmed and lower-cased and only its last `/` part counts (`openai/gpt-6-sol`); it is looked up as it is, then without a
  trailing `-latest` and date (`-20251101`, `-2025-11-01`; the catalogue's own dated ids are found without their date too),
  then as the longest catalogue id it starts with followed by `-` (`claude-sonnet-5-5-thinking` is `claude-sonnet-5-5`) —
  but not when the name rules below call the name no chat model (`gpt-4o-mini-tts` is not `gpt-4o-mini`). Then `vision`
  (it takes images), `pdf` (PDFs), `reasoning`, `chat` (it takes and answers text and is not an embedding, reranking,
  speech, transcription, image, video or realtime model) are the catalogue's; `label` is its display name;
  `contextTokens` its context when it gives one (it may lie outside what a model can be saved with, 1 000–2 000 000);
  `reasoningLevels` the levels of the model's `effort` option in its lab's own entry, among ours (absent when the lab
  turns thinking on and off or sets a token budget instead: then every level is right).
- **From the name** (`known: false`, no `label`, `contextTokens` or `reasoningLevels`): ignoring case, by substrings:

| Hint | `true` when the name contains |
|---|---|
| `chat` | none of `embed`, `rerank`, `bge-`, `tts`, `whisper`, `speech`, `audio`, `voice`, `transcribe`, `realtime`, `image`, `dall-e`, `flux`, `stable-diffusion`, `sd-`, `imagen`, `midjourney`, `video`, `sora`, `veo`, `hailuo`, `kling`, `moderation`, `music`; when `chat` is false, so are the other three |
| `vision` | `gpt-4o`, `gpt-4.1`, `gpt-5`, `gpt-6`, `claude`, `gemini`, `vision`, `-vl`, `llava`, `pixtral`, `glm-4v` or `qvq` |
| `pdf` | `gpt-4o`, `gpt-4.1`, `gpt-5`, `gpt-6`, `claude` or `gemini` |
| `reasoning` | `gpt-5`, `gpt-6`, `gemini-2.5`, `gemini-3`, `thinking`, `reason`, `deepseek-r`, `qwq`, `-m2` or `-m3` (MiniMax's M series); or it starts with `o1`, `o3` or `o4` (so does its last `/` part: `openai/o3`); or `claude`, except `claude-2`, `claude-3-haiku`, `claude-3-opus`, `claude-3-sonnet`, `claude-3-5`, `claude-3.5` and `claude-instant` |

#### `POST /api/providers/:id/models/refresh`

*Session: required.* Body: none or `{}`. The same request; the model names in its answer (`data[].id`, or `models[].name` without the
`models/` prefix for Gemini; the one page the endpoint returns) are merged into `models`: models already there keep
their flags and levels, new names get the defaults, up to 100 in all. Only the first 1 000 entries of the list are looked at, so
`listed` holds at most 1 000 names; among them, names that would not be accepted as a model name, any containing the
key, and repeats are skipped. → 200 `{"listed": [the names it gave], "provider": Provider}`; 502 `provider_rejected`
or `provider_unavailable`, 400 `address_not_allowed` (then nothing changes).

### Calling a model

Every model call goes through one gateway (`src/models/gateway.ts`, `Deps.models`), for site models and providers
alike: `resolveModel` (`src/models/resolve.ts`) turns an Agent's choice into the call — for a site model its upstream,
model name, output limit, price and tier, the key read from the variable its `apiKeyEnv` names at that moment; for a
provider model the owner's provider with its key opened, the model's flags and the output limit for provider
models (`PROVIDER_DEFAULT_MAX_OUTPUT_TOKENS`, default 2048 tokens) — or into nothing to call (no model, a site model no longer configured or its key variable unset,
a provider or model gone).
The gateway uses the Vercel AI SDK 7 (`ai` with `@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/google`; `streamText`
only: no hosted gateway, telemetry off, no automatic retry, nothing printed by the SDK), every request through the
address guard.

The output limit is the call's own: at `none` the model's (`maxOutputTokens`, or `PROVIDER_DEFAULT_MAX_OUTPUT_TOKENS`
for a provider model); at any other level that plus the level's thinking allowance (`REASONING_ALLOWANCE_TOKENS`), at
most half of what the model's context leaves beside it, since upstreams count thinking inside the output limit
(`outputLimit`). That one number is what is sent, what admission holds for (Metering), and what the conversation's
budget leaves room for (so at a level the model is shown less of it). It is sized when the reply begins, for the level
the Agent has then, and the call is sent that level: a level changed while the reply reads its files applies from the
next reply. The half is of the context less the reply's limit, the system text not counted: so a long persona on a
model with a small context may leave too little room at a level (`context_too_small`) where `none` works.

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

With `thinkingSwitch` (a site model's configuration, or a provider model its owner marked as one that reasons) an
`openai_chat` call also carries `thinking: {"type": "disabled"}` at `none` and `thinking: {"type": "enabled"}` at any
other level, next to `reasoning_effort`: the switch that upstreams thinking by default (DeepSeek and others) read —
without it `none` does not stop them. An upstream that answers 400 or 422 naming `thinking`, or a Responses upstream
naming the reasoning summary, before anything streamed, is asked once more without it; once that request is answered,
that site model's later calls, or that provider's at that address, leave it out until the service restarts (at most
1 000 upstreams remembered; a provider given a new address is asked with it again). A refusal for another reason fails
the second request too, and nothing is remembered.

What follows for a person choosing a model and a level:

- Anthropic levels other than `none` ask for adaptive thinking, which Claude models before 4.6 refuse; Gemini levels
  other than `none` ask for a thinking level, which Gemini 2.5 models may refuse. The reply then fails as
  `provider_unavailable`; such a model works at `none`.
- On `openai_chat` thinking is shown when the upstream streams it in a delta's `reasoning_content` (or `reasoning` as
  a string), as most OpenAI-compatible servers that think do, or when the answer opens with `<think>…</think>` and no
  such field came first (unclosed: all of it is thinking; a `<think>` later in the answer, or after more than 256
  characters of white space, is text); otherwise it is not shown, though it is counted.
- A Gemini key that is wrong is answered 400 by Google, so it reads as `provider_unavailable`, not
  `provider_rejected` (the same in the provider test route).
- A model silent for 60 s (for example one thinking hard without streaming its thinking) is given up on
  (`provider_unavailable`).

**What comes back.** The answer as text and reasoning deltas (Responses reasoning summaries, Anthropic thinking, Gemini
thought summaries; Chat Completions' `reasoning_content` / `reasoning`, which the SDK drops and the gateway reads off
the stream, or a leading `<think>` block; reasoning comes out in its place among the text as it arrives, and never
becomes text. The gateway reads the stream in time proportional to its bytes however they are cut, and stops reading
it — the SDK still reads all of it, so the answer is whole — at a line, or an event's data, over 1 048 576
characters), then one finish: the usage the upstream reported (reasoning tokens count as output; none reported: no usage)
and whether the model stopped for length. An answer may be up to 8 MiB on the wire and is given up after 60 s without a
byte (before or after the headers); how long it may take in all is the caller's to bound.

**Failures** are a `ModelError` with one of four codes and a fixed sentence: 401 or 403 is `provider_rejected`; any
other error status, a network failure, silence, a redirect, an oversized answer, and a stream that is malformed or ends
without the protocol's completion are `provider_unavailable`; the guard's refusal is `address_not_allowed`; an answer
cut off at its output limit with no visible text, having reasoned (reasoning came, or the upstream reported reasoning
tokens), is `thinking_exhausted` and carries the usage the upstream reported, which the call is charged. Besides the
code it keeps only the upstream's HTTP status, for the log; nothing the upstream sent is kept, printed or logged.
Stopping a call (its abort signal) ends it at once and closes the upstream connection.

#### `GET /api/models`

*Session: required.* What a client's model picker reads: the models the site offers and the defaults a provider model
gets. → 200 `{"siteModels": [{"id", "label", "tier": "free" | "paid", "vision", "pdf", "reasoning": [levels],
"contextTokens"}], "providerDefaults": {"contextTokens", "maxOutputTokens"}}`.

- `siteModels`: `SITE_MODELS` in configuration order (`[]` when none is configured). `id` is what an Agent's
  `{"source": "site", "id"}` names; `reasoning` the levels the model takes besides `none`, which every model takes (an
  empty list: `none` only). Nothing else of a site model is shown: never where it is called (`baseUrl`, `protocol`), the
  upstream model name, its key or the name of the variable holding it, or its prices.
- `providerDefaults`: `PROVIDER_DEFAULT_CONTEXT_TOKENS` (a provider model's context when its owner gives none) and
  `PROVIDER_DEFAULT_MAX_OUTPUT_TOKENS` (the output limit of every call to a provider model at reasoning `none`, to which
  a level adds its thinking allowance, Calling a model; a provider model's context must be larger).
- Limit: 120 per minute, a budget of its own.

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

*Session: required.* → 200 `{"id", "handle", "displayName", "avatarVersion", "email"}`: the signed-in principal.

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
- 200 `{"id", "handle", "displayName", "avatarVersion"}` with the name as stored. Other members see it the next time they
  load principals (`/api/sync`); system notices keep the name they were written with.
- Limit: 10 per minute.

#### `PUT /api/me/avatar`

*Session: required.* Replaces your avatar.

- Body: the raw image bytes, `Content-Type` `image/*` or `application/octet-stream` (anything else 415
  `invalid_request`), at most 2 MiB (413 `too_large`). The bytes decide: PNG, JPEG or WebP; anything else
  (GIF, SVG, …) is 400 `invalid_request`. The declared type is ignored.
- 200 `{"ok": true}`.
- Limit: 10 per minute together with your Agents' avatars (refused uploads count).
- A signed-in sender's body may take as long as the server-wide timeouts allow; anyone else's must arrive within
  the body deadline (`HTTP_BODY_TIMEOUT_MS`, see Configuration). The answers are unchanged.

#### `GET /api/principals/:id/avatar`

*Session: required.* Any person's avatar, your own Agents', and an Agent's that is a current member of a conversation
you are a current member of (a group you share with it now): their image (`image/png`, `image/jpeg` or
`image/webp`), or a generated `image/svg+xml` with their initial when they have none. Headers:
`X-Content-Type-Options: nosniff`, `Cache-Control: private, max-age=60`,
`Content-Security-Policy: default-src 'none'; sandbox`. 404 `not_found` for an id that is no principal, and exactly
the same for any other Agent — one you share no conversation with, or no longer (you left, or it did).

#### `HEAD /api/principals/:id/avatar`

*Session: required.* The same decision and headers as the `GET`, no body; only the first bytes of a stored image are
read (to tell its type), never the whole file. `Content-Length` is only sent for the generated SVG.

#### `GET /api/principals/lookup`

*Session: required.* Finds a principal by exact handle — the way to get someone's id to befriend them.

- Query: `handle` (at most 100, lower-cased, then `^[a-z0-9_]{3,24}$`). No prefix or partial matches.
- 200 `{"id", "handle", "displayName", "avatarVersion"}` (also for yourself); 404 `not_found`.
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
  "friends":   [{ "id": "…", "handle": "bob", "displayName": "Bob", "avatarVersion": 0 }],   // by handle
  "incoming":  [{ "id": "<request id>", "principal": { "id", "handle", "displayName", "avatarVersion" }, "createdAt": "…", "expiresAt": "…" }],
  "outgoing":  [ /* the same shape; principal is the recipient */ ],             // both newest first, live pending only
  "blocked":   [{ "id", "handle", "displayName", "avatarVersion" }],                              // whom you blocked, by handle
  "blockedBy": [{ "id", "handle", "displayName", "avatarVersion" }]                               // who blocked you, by handle
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
- Errors: 400 `invalid_request` (yourself), 404 `not_found` (no such person: any existing person can be
  blocked; an Agent's id, also your own Agent's, is answered exactly as an id that does not exist — an Agent cannot be
  blocked).
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
  is not your friend — an Agent never is, yours included: it joins a group only by `POST /api/conversations/:id/members`
  —, a block in either direction, or more than 500 members including you).
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

*Session: required.* → 200 `{"members": [{"id", "handle", "displayName", "avatarVersion", "kind", "role", "isCreator",
"ownerId"?, "intro"?, "field"?}]}`: current members in join order; `kind` `human` | `agent`; `isCreator` only ever true
in groups; an Agent also carries `ownerId`, `intro` and `field` as in the Principal shape (Wire shapes), a person none
of them. 404 `not_found` unless you are a current member.

#### `POST /api/conversations/:id/members`

*Session: required.* Any member adds one of their friends to a group, or their own Agent (one that is not deleted;
paused is fine). Body: `principalId`.

- 201 `{"ok": true}`. The newcomer sees the `member_joined` notice and everything after it, nothing before; an
  Agent too (what its replies may be shown: Agents and runs).
- Errors: 404 `not_found` (you are not a current member, a direct chat, closed, unknown), 409
  `already_member`, 403 `forbidden` (not your friend, a block in either direction, or the group has 500
  members; an Agent that is not yours, or is deleted — answered exactly as an unknown id, so nobody learns from it
  whose Agent an id is).
- Limit: 20 per minute together with renaming and removing. Pushes: `conversation` to every member (the
  newcomer included), the notice.

#### `DELETE /api/conversations/:id/members/:principalId`

*Session: required.* With your own id: you leave (anyone). With someone else's: the creator removes them; an Agent's
owner also removes their Agent.

- 200 `{"ok": true}`. Leaving appends `member_left` (when the creator leaves, the person who joined earliest
  becomes creator: `newCreatorId`; never an Agent); removing appends `member_removed`. Whoever leaves or is removed
  loses the whole conversation at once (404 everywhere, no history; the notice is not theirs to see). A person who
  leaves or is removed takes their Agents in the group along, in the same transaction: each Agent first, with a
  `member_left` of its own (`actorId` the owner, `principalId` the Agent), then the person's own notice. An Agent that
  leaves — removed, or along with its owner — has its reply in that group ended (`cancelled`, `agent_removed`; a
  running one is never posted; Agents and runs). When no person is left, the group closes (no Agent is left either).
- Errors: 404 `not_found` (you are not a current member, a direct chat — those cannot be left —, closed,
  unknown, or the one to remove is not a current member), 403 `forbidden` (removing someone without being the
  creator, or an Agent without being the creator or its owner: as for any id).
- Limit: 20 per minute together with renaming and adding. Pushes: `gone` to whoever left or was removed;
  `conversation` and the notices to the others; `run` to an Agent's owner for each of its replies cancelled.

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
- 201 `{"message": WireMessage, "duplicate": false}`, and, only when the message called someone else's Agent in a group
  and your own calls a minute on other people's Agents refused it (`AGENT_CALLER_RUNS_PER_MINUTE`, Rate limits),
  `"notCalled": [{"agentId", "reason": "caller_rate_limited"}]`, one entry per Agent it did not reach, in id order
  (absent otherwise, never empty). It is yours alone, in this answer: it is not stored with the message, nor in what
  anyone receives of it (push, history, sync), nor said of a call relayed through an Agent's message (those are only
  logged); a call another limit refused (the Agent's others' daily budget: its group is told) is not in it.
- Retries: the same `clientTxn` again (same sender, same conversation) stores nothing and answers 200
  `{"message": <the stored message>, "duplicate": true}` (no `notCalled`) — even if you could no longer send there now (you
  must still be a member). The same
  `clientTxn` in another conversation is a new message there. 409 `client_txn_reused` when the message stored
  under it is no longer visible to you (you left and were added again).
- Errors: 404 `not_found` (not a current member, closed, unknown), 403 `cannot_send` with `reason`
  `blocked` or `not_friends` (direct chats), 400 `invalid_request` (empty text without attachment, a
  `replyToSeq` you cannot see, an attachment that is not your unsent upload here).
- In your Agent's conversation, a message (not a repeat) may start the Agent's reply in the same transaction, or be
  folded into the one in progress (see Agents and runs). In a group, so may a message that calls an Agent member by
  `@handle` (Agents and runs, In a group).
- Limit: 120 per minute. Pushes: `message` to every member who can see it; a reply it queues, `run` to that Agent's
  owner.

#### `GET /api/conversations/:id/messages`

*Session: required.* History, a page at a time.

- Query: `before` (optional positive integer: only seqs below it), `limit` (1–100, default 50).
- 200 `{"messages": WireMessage[], "nextBefore": number | null, "principals": { "<id>": Principal }}`: up to `limit` messages you
  can see, the newest page first, each page ascending by seq; pass `nextBefore` as `before` for the next
  older page (`null`: nothing older you can see). `principals` names everyone these messages name — senders
  (also members who have since left), a visible quote's sender, the people in system notices — as
  `/api/sync`'s `principals` entries, by id; nobody else (see Client contract, Principals of a read).
- 404 `not_found` unless you are a current member.

#### `GET /api/conversations/:id/messages/:seq`

*Session: required.* → 200 `{"message": WireMessage, "principals": { "<id>": Principal }}` (as above, for this one message); 404 `not_found` when you cannot see it (from before
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
`limit` (1–50, default 20). → 200 `{"messages": WireMessage[], "nextBefore": number | null, "principals": { "<id>": Principal }}`,
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
`too_large` (over `ATTACHMENT_MAX_BYTES`, default 1 GiB) or `{"error":"too_large","reason":"quota"}` (over
`ATTACHMENT_QUOTA_BYTES` stored, default 20 GiB), 429 `rate_limited` (60 per hour, 3 at once).

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

**Principal** (in `/api/sync`'s `principals`, and the `principals` of message reads and searches): `{"id", "handle", "displayName", "avatarVersion", "kind": "human" | "agent", "ownerId"?, "intro"?, "field"?}`.
`ownerId`, `intro` and `field` are an Agent's, and every Agent entry has all three (a person's has none): `ownerId` is
its owner's principal id, `intro` and `field` its public profile as its owner set it, strings, `""` when not set. They
come to whoever the entry is listed for (its owner, and the members of a conversation it is in, see Agents); nothing
else of the Agent ever does. The member list (`GET /api/conversations/:id/members`) carries the same three.
`avatarVersion` counts the principal's avatar changes (0 until the first). A client puts it in the avatar URL, `GET /api/principals/:id/avatar?v=<avatarVersion>`, so a changed avatar is a new URL and is fetched again at once (the route ignores `v`, and still answers `Cache-Control: private, max-age=60`); on a `principal` push it updates the version it shows. The smaller shapes that name a principal (`me`, the lookup, `friends` and the other `/api/social` lists, members) carry `avatarVersion` too.

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
  "reasoning": "…",                    // an Agent's reply: the model's reasoning, when it gave any — in its own
                                       // conversation; in a group only when you own the Agent that sent it (absent
                                       // for every other member, so their message is shaped as one without any);
                                       // nowhere else. Show it folded; never in previews, quotes or search, never
                                       // sent to a model again
  "stopped": true,                     // an Agent's reply its owner stopped: text is what had been said by then
  "truncated": true,                   // an Agent's reply that was cut (model's output limit, time limit, 8 000 characters)
  "proposal": { "id": "…", "status": "open" | "confirmed" | "discarded" | "superseded" | "stale",
                "persona": "…", "intro": "…", "field": "…" },
                                       // an Agent's reply that proposed a persona, for the Agent's owner only; intro and
                                       // field only when proposed (Persona proposals)
  "via": { "model": { "source": "site", "id": "…", "label": "…" } | { "source": "provider", "model": "…" },
           "reasoning": "none" | "low" | "medium" | "high" | "xhigh" | "max", "points": "6.9" },
                                       // an Agent's reply, for the Agent's owner only (absent for everyone else): the
                                       // model and reasoning level its run used, and what you were charged for it (below)
  "createdAt": "2026-11-16T01:02:03.000Z"
}
```

An Agent's reply is an ordinary `text` message from the Agent; `reasoning`, `stopped`, `truncated`, `proposal` and `via`
appear only on those, only when they apply. Render its text as Markdown (spec 6.6); people's text stays plain.

**`via`** (the product owner's decision of 2026-11-18): which model and reasoning level an Agent's reply used, and what it
cost its owner. Only the owner of the Agent that sent it receives it — the sender principal's `owner_id` when the message
is read —, decided per reader in the query that decides whether the reader sees the message at all, as `reasoning` and
`proposal` are (`messages/read.ts` `toWireForReaders`): on the history, a single message, `GET /api/sync` and catch-up,
both searches and every `message` push, in the Agent's own conversation and in a group alike. Everyone else — a fellow
member of the group, the owner of another Agent there, anybody — gets the message without the key (absent, never null or
`{}`). It is read from the run that posted the reply (the message's `client_txn` is the run's id):

- `model`: what the run was admitted on. A site model is `{"source": "site", "id", "label"}`, `label` its label in
  `SITE_MODELS` when the message is read, its `id` when it is no longer configured; never its upstream model name,
  address, key variable or prices. A provider model is `{"source": "provider", "model"}`: the model name you saved (no
  provider id, no address).
- `reasoning`: the level the call was sent at — the Agent's when the model took it, else `none` (Calling a model) —,
  recorded on the run when the call was admitted, so a later change to the Agent does not change it.
- `points`: what you were charged for that run, a decimal string of points as money is on the wire: from the free
  allowance plus the balance, as `GET /api/usage` counts it (not what was forgiven); `"0"` on a provider model.

A message no run posted (the fixed greeting), a reply whose run was admitted before runs recorded their level, and one
whose run or usage record is gone have no `via`. A run is charged when it ends, just after its reply was posted and
pushed, so that first push may come without `via`: the owner's sockets are pushed the reply once more when its run has
ended, before its `run` (`done` or `stopped`), now with `via` — replace the copy you hold (Ordering and gaps). Nobody
else is pushed that second copy.

**System notices** (`kind: "system"`) are written by the service when something happens in a conversation;
nobody sends them, every member who can see that seq sees them, and they are never unread. `text` is a
sentence in Chinese with the display names of that moment; `system` carries the event and its ids so a
client can render its own:

| `system.event` | Fields besides `event` | Written when |
|---|---|---|
| `group_created` | `actorId` (creator), `title`, `memberIds` (the invited members, without the creator) | a group is created (its seq 1) |
| `member_joined` | `actorId` (who added; for an Agent, its owner), `principalId` (who joined) | `POST /api/conversations/:id/members` |
| `member_left` | `actorId` = `principalId` (who left), `newCreatorId` (id, or null when the creator did not leave or no person is left); for an Agent: `actorId` its owner, `principalId` the Agent, `newCreatorId` null | leaving; an Agent leaving with its owner (just before its owner's notice), or after it was deleted |
| `member_removed` | `actorId` (the creator, or the owner of the Agent removed), `principalId` (who was removed) | removal |
| `group_renamed` | `actorId`, `title` (the new one) | a rename that changes the title |
| `friendship_ended` | `actorId` (who ended it), `principalId` (the other) | `DELETE /api/friends/:principalId`, in the pair's direct chat |
| `friendship_restored` | `actorId` (who accepted), `principalId` (who asked) | accepting a request when the pair already has a direct chat |
| `blocked` | `actorId` (who blocked), `principalId` (who is blocked) | a new block, in the pair's direct chat if any |
| `unblocked` | `actorId`, `principalId` | lifting a block, in the pair's direct chat if any |
| `topic_reset` | `actorId` (the owner) | `POST /api/conversations/:id/topic`, in an Agent's conversation: what comes before it is no longer shown to the Agent's model |
| `agents_halted` | `actorId` (who halted) | `POST /api/conversations/:id/agents/halt`, in a group that was not halted already: “{名字} 让 Agent 停止了接话” |
| `agent_chain_paused` | `actorId` (the Agent whose message it was), `limit` (`AGENT_CHAIN_LIMIT`) | in a group, the first Agent's message that would call another Agent after the last `limit` messages that are not notices were all Agents'; once until a person writes: “Agent 已连续对话 {limit} 条，已暂停互相接话，有人发言后继续。” |
| `agent_budget_reached` | `actorId` = `agentId` (the Agent whose `chainBudget` is reached) | in a group, the first Agent's message that would call it once its chain budget is reached — or the end of its reply that reached it, when only Agents' messages were noted on that reply for a follow-up (pushed after that reply's `run`); once per Agent until a person writes: “{Agent 名} 已达到本次接话的点数上限，有人发言后继续。” |
| `agent_daily_budget_reached` | `actorId` = `agentId` (the Agent whose others' daily budget is spent) | in a group, the first call on the Agent by someone other than its owner that finds the budget spent — a mention, a follow-up of one, or a reply such a call queued as it is about to start; once per site day for each conversation and Agent, whoever calls; nothing of lane or caller goes with it: “「{Agent 名}」今天的额度已用完” |

Clients must ignore fields and events they do not know: later batches add more.

**Pushes** (WebSocket text frames, JSON):

```jsonc
{ "type": "message", "message": WireMessage }   // rendered for you (your Agent's reply comes once more when its run is
                                                //  charged, with `via`: Wire shapes)
{ "type": "conversation", "id": "…" }   // title, members, creator, closed, or a direct chat's canSend changed: GET /api/conversations/:id
{ "type": "gone", "id": "…" }           // you are not a member now (left or removed): drop the conversation
{ "type": "social" }                    // your friends, requests or blocks changed: GET /api/social
{ "type": "agent", "id": "…" }          // one of your Agents changed (edit, pause, resume, delete, avatar), or one of its
                                        // persona proposals was made, confirmed or discarded: GET /api/agents/:id, and
                                        // the messages you show with a proposal card (Persona proposals)
{ "type": "principal", "id": "…", "avatarVersion": 3 }   // someone's avatar changed (yours, a friend's, anyone who shares a
                                        // conversation with you; for your Agent, to you only): show the new version
                                        // (Principal). Not replayed: /api/sync carries the current one
{ "type": "run", "conversationId": "…", "run": Run }   // your Agent's own conversation: a reply of it was queued,
                                        // started or ended (Replies)
{ "type": "run", "conversationId": "…", "agentId": "…", "run": Run }   // a group: the same, for a reply there of
                                        // your Agent `agentId` (Replies, In a group)
{ "type": "run", "conversationId": "…", "agentId": "…", "state": "replying" | "unavailable" | null }
                                        // a group: another member's Agent `agentId` is replying, cannot reply now, or
                                        // shows nothing (Replies, In a group)
{ "type": "delta", "conversationId": "…", "runId": "…", "text"?: "…", "reasoning"?: "…" }
                                        // the next piece of the reply being generated: append it to the "replying"
                                        // bubble; the posted `message` replaces the bubble
{ "type": "read", "conversationId": "…", "principalId": "…", "seq": 41 }   // direct chats (either side); in your
                                        // Agent's conversation, the Agent's marker
{ "type": "pong" }                      // answer to your { "type": "ping" }
```

In an Agent's own conversation `run` and `delta` go to the Agent's owner only, in order with that conversation's other
pushes (`running` after your message, every `delta` before the reply's `message`, the `message` before `done`). Once a
pause or delete of the Agent has answered, no further `delta` of the reply it interrupted is sent (its `cancelled`
follows). In a group no `delta` is sent, and who gets what of a `run` is decided when it is delivered, against the
database (`src/sync/hub.ts`, one read per delivery however many members): the Agent's owner — the one the run's row
names, as in an Agent's own conversation — gets the Run with `agentId`, every time it is announced, also when they have
just left the group with their Agent, so its last run there (`cancelled`, `agent_removed`) still ends what their client
showed (usually one frame after their `gone`; their client drops the group at its `gone` anyway), and every other
current member gets `agentId` and `state` only: the state of that Agent's latest run there now (Replies, In a group:
`queued` or `running` → `"replying"`, `failed` → `"unavailable"`; `done`, `stopped`, `cancelled`, a failure its owner
dismissed, or an Agent no longer in the group → `null`), never the Run, its id, `error`, `retryable` or `resetsAt`.
Anybody else, a former member included, gets nothing. When its owner dismisses a failure the others are pushed
`"state": null` (the owner is not told). The same state may come again unchanged (an Agent over its owner's replies a
minute keeps one `rate_limited` run in a group, announced again at each mention): apply it as a state. That read is
tried once more when it fails; failing again, that one delivery is dropped for everyone (and logged), so a line may
stay as it was until the next `run` of that Agent there or a reload. None of this is stored or replayed: after a
reconnect, `GET /api/conversations/:id/run` (an Agent's own conversation) says whether a reply is still under way (its
text so far is not sent again; the posted message follows), and `GET /api/conversations/:id/runs` what a group shows.

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
  "me": { "id": "…", "handle": "alice", "displayName": "Alice", "avatarVersion": 0, "email": "alice@example.test" },
  "conversations": [ /* Conversation, see Wire shapes; the ones you are a current member of */ ],
  "principals": [{ "id": "…", "handle": "bob", "displayName": "Bob", "avatarVersion": 0, "kind": "human" | "agent" }],   // Principal, by handle; an Agent adds "ownerId", "intro", "field"
  "messages": [ /* WireMessage: per conversation its newest 30 visible messages, ascending by seq */ ]
}
```

`principals` lists you, every member, and everyone a returned message names (sender, a visible
quote's sender, a system notice's participants) — including people who have since left, but only
through messages you can see. After `/api/sync` your position for each conversation is its `lastSeq`.
Older history: `GET /api/conversations/:id/messages?before=`.

**Principals of a read.** A message can be sent by someone your client never saw (a member who left before
your first sync). So `GET /api/conversations/:id/messages`, `GET /api/conversations/:id/messages/:seq`
and both search routes add `"principals": { "<id>": Principal }`: the same
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
(messages are read back from the table by seq range, not taken from the announcement) — except one repeat: your own
Agent's reply, pushed to you once more when its run has been charged, now carrying its `via` (Wire shapes). Who receives
what is decided against the database at delivery time. Across conversations, and for `social`, there
is no order. Messages from before you joined are never pushed, so after joining the first `message` is the
join notice. Apply a `message` like this: `seq ≤ position` → duplicate, ignore (but when it is a copy of a message
you hold that brings a `via` your copy lacks, replace your copy with it); `seq = position + 1`
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
offline are not replayed; for an Agent's conversation you show, `GET /api/conversations/:id/run`, and for a group,
`GET /api/conversations/:id/runs`. 4. Apply the
buffered pushes by the rules above.

## Agents and runs (`src/agents/`)

An Agent's reply is a row in `agent_runs` (purpose `reply`): a run. It is answered by a worker inside the service's
process and posted as an ordinary message from the Agent. (A persona draft is a run too, of purpose `draft`, without
Agent or conversation: its route makes the call itself, `POST /api/agents/draft-persona`; the worker never takes one.)

**Trigger** (`runs.ts` `maybeTrigger`). In the transaction that stores the owner's message in the Agent's conversation
(not a repeated `clientTxn`), under the send's locks: nothing happens when the Agent is paused, deleted or has no model,
or when its `replyMode` is `mention` and the text contains neither `@` + its handle nor `@` + its current name (case
ignored). A message that comes while a run of the Agent is active in that conversation is folded into it (Coalescing,
below). Otherwise a `queued` run is inserted in that conversation covering the message (`covers_seq`), unless the owner
has started `AGENT_RUNS_PER_MINUTE` (20) replies of their own lane in the last minute (a reply in the Agent's own
conversation is always the owner's own, the owner its caller): then the run is inserted already `failed`, error
`rate_limited` (retryable), covering the message — the message is still sent, nothing is called, held or charged (no
usage record), the run is never active (it takes no concurrency slot and leaves the Agent free for the next message)
and, having started nothing, it is not counted toward the limit itself. That count is taken under the owner's
`accounts` row lock, the last of the lock order, so two messages to two of the owner's Agents at the same moment are
counted one after the other and the limit is exact. The `run` push and (for a queued run) the worker's wake-up follow
the commit.

**In a group** (`runs.ts` `triggerInGroup`, `triggerFromAgent`; `mentions.ts`). An Agent there replies only when a
message calls it: `@` + its handle on a token boundary — not preceded or followed by a letter, digit or `_` of
`[A-Za-z0-9_]`, so `@anna` does not call `anna_2` and `mail@anna` calls nobody — case ignored (its name does not call
it: names are not unique in a group). At most the first 20 distinct handles of a message count; a file's caption is its
text. `replyMode` plays no part. A message that names no handle costs nothing, not even a query.
- *A person's message* (the send's transaction): the group's current Agent members it names, each in id order under its
  `agents` row lock (the group's row is the send's): nothing for one that is paused, deleted or has no model, nor for
  one whose `groupMentions` is `owner` unless its owner wrote the message, nor for one with a block between its owner
  and the sender, in either direction (as in a direct chat: neither of the two calls the other's Agents, nor spends
  the other's points; lifting the block restores it at once). When the sender is not the Agent's owner, the Agent's
  others' daily budget (read under the Agent's row lock) is then checked: spent, nothing is done — not even a fold —
  and the group is told once a day (Agents in a group). Then as in its own conversation: folded into
  its active run in the group (a queued run a person's message is folded into is a person's from then on, and the
  owner's own — the owner its caller — when the message is the owner's; another member's leaves its lane and first
  caller), else, for a call on someone else's Agent, the caller's limit (`AGENT_CALLER_RUNS_PER_MINUTE`: over it,
  nothing is recorded, one `caller_rate_limited` line is logged and the sender's answer names the Agent, `notCalled`), else a queued run (`triggered_by` `human`, with its
  caller and lane) — or, over its owner's replies a minute in the call's lane, a `failed` `rate_limited` run, of which
  there is one per Agent in the group: while it is the Agent's latest run there and its owner has not dismissed it, it
  covers every further mention over the limit (announced again) instead of a new one being recorded. The owners'
  `accounts` rows are locked last, all in id order.
- *An Agent's message* (`postAsAgent`'s transaction): the same, as an Agent's (`triggered_by` `agent`), called for by
  the person behind the message (`runs.ts` `behindAgentMessage`): the caller of the run that posted it (the run whose id
  is the message's `client_txn`) when that run is not its owner's own, else the Agent's owner — so a member's call that
  the owner's Agent relays, to another of the owner's Agents or to someone else's, stays the member's, and what a reply
  nobody called for relays is nobody's (`others`, no caller). A call on an Agent of someone other than the person behind
  it meets that Agent's others' daily budget, that person's caller limit (none without a caller) and the lane's
  replies a minute as a person's does; a call the Agent's owner is behind is their own. The message calls the Agent
  members it names other than itself whose `groupMentions` is `members` and whose owner has no block, in either direction, with the
  posting Agent's owner nor with the person behind the message (none to match when nobody is behind it): a member's
  call relayed through the owner's Agent to an Agent whose owner and the member have a block between them reaches
  nothing — no run, no notice, nothing spent — as the member's own mention would; lifting the block restores it at
  once. Unless a brake holds (Agents in a group, under
  HTTP API): the group is halted (its latest message from a person is at or before `conversations.agents_halted_seq`);
  the chain limit (the group's last `AGENT_CHAIN_LIMIT` messages that are not notices — this one included — were all
  Agents'), when one `agent_chain_paused` notice is appended unless one was since a person last wrote; or, per Agent,
  its chain budget (what its owner was charged — free allowance and balance, not what was forgiven — for its runs in the
  group whose `covers_seq` is after the latest message from a person has reached `chainBudget`), when one
  `agent_budget_reached` notice about it is appended unless one was since a person last wrote. The called Agents'
  `agents` rows are read, not locked (the poster's is held already, and another's taken after it could be out of id
  order: two Agents calling each other from two groups at once would deadlock). The fold-or-insert decision needs no
  target's row: the group's row, which this transaction holds, orders it with every other trigger, retry, follow-up
  and halt there. A pause or delete of a called Agent that commits meanwhile takes that Agent's row, not the group's,
  and cannot see the run this inserts or the mention it notes: a deleted Agent's run is ended by the worker without a
  call (`begin`), and a paused one's by the worker while the Agent is still paused, or else by the resume, before the
  Agent answers again (`runs.ts` `endWhatPauseMissed`; Pause and delete, below).
- A follow-up (Coalescing) in a group (`runs.ts` `followUp`, from the worker's `finish` and from recovery) is a
  person's when a person's message among what it answers calls the Agent (one its `groupMentions` lets call it, from a
  person with no block between them and its owner, in either direction; an Agent's message among them counts only with
  no block, either way, between the Agent's owner and that Agent's owner or the person behind that message, as above).
  Otherwise only Agents' messages called for it: it is an Agent's, and is not queued when the latest of them came at
  or before the group's latest halt (`pending_seq` ≤ `agents_halted_seq`), even if a person has written since — what
  Agents asked before a halt is not answered after it; nor once the Agent's chain budget is spent, which is checked
  again here because the reply that just ended was settled after it was called (the `agent_budget_reached` notice is
  appended unless one was since a person last wrote, and pushed after that reply's `run`). Either way it is a reply
  started like any other: counted toward its owner's replies a minute in its lane under the owner's `accounts` row (the
  last lock, after `settle`'s), and over it recorded on the Agent's reusable `rate_limited` run in the group instead of
  queued. Its lane and caller come from the messages it answers, not from the run that ended: the owner's own when the
  owner is behind one of those that called the Agent (their own message, or an Agent's message they are behind by the
  rule above, read from the run its `client_txn` names), else `others` with the earliest caller (the earliest that
  names one); when none of them can call it any more (a block since, or `groupMentions` changed) it is `others` with no
  caller, so a call its owner no longer allows does not ride the owner's own lane. An Agent's mention of it that was
  refused when it was posted — the group halted, the chain limit, its chain budget, its others' daily budget, a block —
  is no call at all: the refusal is recorded with the message (`refused_agent_calls`, migrations 022–023, referring to
  the Agent's principal, so writing it locks no `agents` row; never on the wire), so although nothing was noted for it,
  it does not count when it lies among what the follow-up answers. A follow-up in lane `others` is not queued once the
  Agent's others' daily budget is spent, checked again here because the reply that just ended is settled by now (the
  notice, once a day, and the owner pushed their Agent); the caller's limit does not apply to it: what it answers was
  folded into a reply under way, which is never refused.
- A halt (`POST /api/conversations/:id/agents/halt`) cancels the group's queued runs Agents called for (`halted`) and
  marks the running ones `interrupted` `halted`: never posted, they end `cancelled`, `halted`, settled as any.
- What the group sees of it (`runs.ts` `groupRuns`, `runAudience`; Replies, In a group): nothing is stored per member.
  Every member's view is derived from the Agent's latest run in the group during its current stay (`covers_seq` after
  its `joined_seq`): its owner sees the run, everyone else its state. A retry in a group answers again what the failed
  run was to answer (the greater of its `covers_seq` and `pending_seq`: one that recovery or a release failed is not
  followed up) and keeps its `triggered_by`; stop, retry and dismiss there lock the group's row first, as every writer
  of runs there does.

**Coalescing.** Per Agent per conversation: an Agent has at most one queued or running run in each conversation (a
unique index on the Agent and the run's conversation, migration `016_agents_in_groups.sql`), and a run's `covers_seq`
and `pending_seq` are seqs of its own conversation. A message that comes while one is queued in that conversation is
covered by it; while one is running there, it is noted (`pending_seq`), and when that run ends one follow-up run, in the
same conversation, answers everything noted — not one per message, and never two replies at once in one conversation. A
run of the Agent in another conversation is not touched (so an Agent could answer in its own conversation and in a group
at once; the owner's limits on replies running and started bound them together). The one rule: a run that has ended is
followed when something was noted on it and its Agent can still answer (not paused, not deleted, has a model) — however
the run itself ended, except `cancelled` `agent_removed`, which is followed by nothing (what was noted on it is
dropped) — and, at start-up recovery or a release, except a run that ends `failed` (its retry answers what was noted
too). (A pause or delete drops what was noted, below, so what an interrupted run has noted came after a resume.) In
the Agent's own conversation the follow-up is its owner's and is queued whatever the owner's replies a minute (it
answers what they wrote meanwhile). In a group it is decided as In a group (above) says: whose it is, the halt and the
chain budget, the others' daily budget, and the owner's replies a minute in its lane — over it, the Agent's reusable
`rate_limited` run there records it. A mention folded into a queued run turns it the owner's own (the owner its caller)
when it is the owner's call (their message, or an Agent's message they are behind); another person's — also one relayed
through one of the owner's Agents — leaves its lane and first caller.

**Pause and delete** end the Agent's active replies, in every conversation, for good, in their own transaction (under
the Agent's lock): a queued run becomes `cancelled` (`agent_paused` / `agent_deleted`; it never reached a model, so it
has no usage record), announced with its own conversation; a running one is marked `interrupted` with that reason, and
what was noted on it is dropped. A marked run is never posted and ends `cancelled`, even if the Agent is resumed before
the worker notices; its call is abandoned and no further `delta` of it is pushed once the request has answered — not
even one that was already waiting to be delivered, however late it would be. Nothing is queued or noted while the Agent
is paused, and resuming queues nothing: what was written during the pause is answered only as part of the next reply a
later message of the owner's starts. A message written after the resume while the interrupted reply is still ending is
noted on it, and its follow-up answers it.

One thing a pause cannot see: an Agent's message in a group reads the Agents it calls without locking them (In a
group, above), so a pause that commits inside that message's transaction misses the run it then queues for the paused
Agent and the mention its fold notes on a reply the pause interrupted. The worker ends such a run without a call while
the Agent is still paused (`begin`). A resume ends the rest, in its own transaction under the Agent's lock
(`runs.ts` `endWhatPauseMissed`), only when the Agent was paused: every queued run of it, in every conversation,
becomes `cancelled` `agent_paused` (none can legitimately be queued while it is paused: a mention, a retry, a follow-up
and recovery all refuse a paused Agent), announced; a running one the pause did not mark (the worker claimed it during
the pause) is marked `interrupted` `agent_paused` and its call abandoned, so it ends `cancelled` `agent_paused`
without posting; and nothing noted on a running run is followed up. Only a pause and a resume that both commit inside
that one message's transaction (a few queries, against two requests of the owner's) could still let such a run
through.

**Leaving a group** (`group-leave.ts` `endRunsInGroup`, called by `conversations/groups.ts` `removeMember`) ends the
Agent's active reply in that group, and only there, the same way, in the transaction that takes it out — removed by the
group's creator or its owner, or along with its owner — under the group's row: a queued run becomes `cancelled`
(`agent_removed`, announced to its owner), a running one is marked `interrupted` (`agent_removed`, unless a pause or
delete marked it first) and what was noted on it is dropped, so nothing follows it up in a group it is no longer in; it
is never posted (`postAsAgent` locks the group's row first, so it either posted before the removal or finds the run
marked), its call is abandoned, and it ends `cancelled`, settled on what it used. No `agents` row is locked: the group's
row orders it with the sends there and with the worker. A deleted Agent's leaving (`DELETE /api/agents/:id`) ends
nothing more: its delete did.

**The worker** (`runtime/worker.ts`) claims the oldest queued reply whose owner has fewer than `AGENT_MAX_CONCURRENT_RUNS`
(4) runs running, replies and persona drafts together, and — unless it is of the owner's own lane — fewer than
`AGENT_MAX_CONCURRENT_OTHERS_RUNS` (3) running in the other lanes (further replies wait queued: a crowd calling the
owner's Agents fills at most 3 of the 4 places, so the owner's own reply finds one), at most `AGENT_MAX_RUNS_IN_FLIGHT`
(16) at once in the service. Each claim logs how long the reply waited (`run_wait_ms`, Rate limits, Metrics in the log).
A draft counts the owner's running calls under the account's lock, the worker's claim does not take that lock: so a
draft and a reply that start at the same moment may briefly run one over the limit (never more: the worker claims one
run at a time, and drafts wait for each other on the lock). It is woken after a trigger commits and also looks every
2 s. Per run:

1. `begin`, in three steps so that no transaction is open while attachments are read (a failure of the service's own
   in any of them ends the run `failed`, `busy`):
   1. A short transaction under the Agent's lock: a run marked `interrupted` (or a paused or deleted Agent) ends
      `cancelled`, a stop asked for meanwhile `stopped`, a run in a group its Agent is no longer a current member of
      `cancelled`, `agent_removed`, a model that no longer resolves `failed`
      (`provider_unavailable`; `provider_rejected`, not retryable, when its provider's saved key cannot be opened). The
      run takes on what was noted meanwhile, and what the model may be shown is read from
      the database (`loadContext`: the messages, and the records of the attachments it could show). With no message of
      the owner's in it (in a group: of anyone else's), no model is called: when everything the run was to answer is
      before a new topic, it ends
      `cancelled` with no error (the owner started over: nothing failed, nothing to retry); otherwise `failed`, `busy`.
      Nor is it called when the conversation's budget (below) holds neither the owner's newest message whole nor 200
      tokens of it: `failed`, `context_too_small`, not retryable (the persona is too long for the model's context, or the
      context too small, or at a reasoning level its thinking allowance leaves too little room): nothing is admitted
      or charged. The model resolved here sizes the call — its level, output limit (Calling a model) and so what is
      shown and held — and the call is sent that level, whatever the Agent's is by step 3. A run in a group is marked
      here, in this process, as one that streams nothing (step 2).
   2. No transaction: the attachments' bytes are read and the call is assembled (`buildContext`). A send to the
      conversation, a pause or a delete meanwhile does not wait for it (`tests/context.test.ts`). It is interruptible and
      bounded (`tests/runs-faults.test.ts`): once the owner stops the reply or the Agent is paused or deleted, no further
      file is read (the next step ends the run); the whole step may take at most `AGENT_RUN_TIMEOUT_MS`, after which
      the run fails `busy`; and when the service is closing the read under way is abandoned and nothing is admitted:
      the closing service ends the run (Shutdown, below; `tests/runs-restart.test.ts`).
   3. A short transaction under the Agent's lock again: a run interrupted, paused, deleted or stopped meanwhile ends as in
      the first step, with no call; when the service has started closing by the time the locks are held, the
      transaction rolls back and nothing is admitted (the closing service ends the run, Shutdown below;
      `tests/runs-restart.test.ts`). A reply someone else called for (lane `others`) then meets the Agent's others'
      daily budget once more (`runs.ts` `othersBudgetRefusesAdmission`: what replies settled while it waited were
      charged counts now; settlement takes the Agent's lock too): spent, it ends `cancelled` with no error,
      with no call and nothing held or charged, the group told by `agent_daily_budget_reached` once a day (published
      after commit) and the owner pushed their Agent (Agents in a group). What the first step took on (mentions noted
      on the run after its claim) is handed back as noted, so the run's end follows it up as any (Coalescing): the
      owner's own mention is answered — the owner's calls are never refused by this budget — and someone else's meets
      the budget again and is not queued (no second notice that day); nothing loops. Otherwise the call is admitted on its input
      estimate (Metering; `no_quota` ends it `failed` before any call) and the Agent's read marker moves to what the run
      covers (`read` push, `peerReadSeq`).
2. The model call, with no transaction open: deltas go to the owner's sockets, at most one push per 50 ms (`stream.ts`)
   — except for a reply in a group, of which no delta goes to anyone, its owner included (plan ruling 2; decided at
   `begin` and kept on the run's in-process flags, so nothing is read per delta): it arrives whole, as its message.
   The text is pushed only up to the first `<af-` (a persona proposal's block, Persona proposals; looked for in the text
   as cleaned): from there on no more text delta goes out for that reply, and the rest arrives with the message. A `<`
   that may begin one waits for the next piece and goes out in its place once it turns out not to. Reasoning deltas are
   pushed as they come. It is abandoned at once when the owner stops it or the Agent is paused or deleted (checked every
   50 ms), after `AGENT_RUN_TIMEOUT_MS` (2 minutes), and when the service closes (then the run is ended as Shutdown,
   below, says).
3. `post` (`conversation.ts` `postAsAgent`): under the conversation row and the `agents` row — the locks pause and
   delete take — so once a pause or delete has answered, nothing more from the Agent is stored, the reply being
   generated included, whether or not the Agent has been resumed since (`tests/runs-pause-race.test.ts`,
   `tests/runs-pause.test.ts`). The message's `client_txn` is the run's id: a reply is never
   posted twice. Text follows the rules of message text (what a send would refuse is removed); a persona proposal's
   block in it is taken out and stored as the proposal in this same transaction (Persona proposals); then the text is
   cut at 8 000 characters (`truncated`), and a stopped or cut reply without a proposal loses what follows its first
   `<af-`; reasoning follows the same rules (and is never read for a block), is cut at 32 000 characters (no mark) and
   is kept only when there is some. In a group (Agents in a group, A reply there), the Agent must still be a current
   member there, read under the group's row, which every membership change takes (else 409 `agent_removed`: nothing is
   posted); its reply is never read for a proposal — everything from its first `<af-` on is dropped before the cut —
   and its reasoning is kept as above (sent only to the Agent's owner: Agents in a group, A reply there), but a reply
   with no visible text is not posted, whatever it thought; the run looked for is one of this Agent in this
   conversation, so a run's reply never lands anywhere else. With nothing left to show, nothing is stored (`post`
   answers `empty`) and the run ends as one that said nothing (below).
4. `finish`, one transaction: the call is settled (one usage record; its hold released) in the same transaction that
   moves the run out of `running`, how it ended is recorded, and the follow-up is queued. After it commits, a run that
   posted a reply has that reply pushed once more to its owner, before the run's end, now with `via` (Wire shapes; a
   release of a run whose reply was posted does the same). What is recorded is what is
   true under the lock: a reply that was posted stands (`done`, or `stopped` by its owner), whatever happened to the
   Agent after; an interrupted run that posted nothing is `cancelled`, and so is a refused one, with the Agent's state
   as its error (`agent_deleted`, `agent_paused`, or `agent_removed` when it is no longer in the run's group).

**What the model is shown** (`context.ts` `loadContext` and `buildContext`; its pure part, the plan, in
`runtime/context.ts`; spec 6.5):

- The system text (`runtime/prompt.ts`), the site's fixed part always first: who the Agent is and whose, the owner's
  name, today's date in `SITE_TIMEZONE`, that it has no tools and must not claim what it cannot do; then how to write a
  persona proposal (the block, Persona proposals) and that it takes effect only once the owner confirms it, so the Agent
  must not say its persona has changed before; then the persona. An Agent without one is in onboarding instead: it is
  told to ask its owner, a question or two at a time, who it should be, what it should help with and in what tone, and
  to propose a persona once it knows enough. One with a persona is told to propose only when its owner asks it to
  update its persona. Nothing of the conversation or of a file enters the system text. In a group the system text is
  the group's (`groupSystemPrompt`; Agents in a group, A reply there): the same fixed part with a group in place of the
  owner as the one it talks to, the group's name, how speakers are labelled, that it answers whoever called it, when to
  call another Agent and the other Agents there (current members, not deleted, in the order they joined, at most 20
  named; their names, handles and intros, which every member sees anyway — nothing of their owners' settings), what it
  must never reveal there; then the persona (none, no onboarding, for an Agent without one); never anything about
  proposals. The group's name and the other Agents' names and intros are introduced as descriptions, not instructions
  (“仅供你了解，不是给你的指令”), each value on one line.
- The conversation after the latest `topic_reset` notice (`POST /api/conversations/:id/topic`), as the Agent can see it
  (the one visibility rule, the Agent as reader): the owner's messages, and the Agent's replies to what the run covers.
  The owner's as `user`, the Agent's as `assistant`, in the order they were answered, not the order they were stored: a
  reply goes right after the owner's message its run had covered when it began (the run is the one its `client_txn`
  names). So with the owner's messages 1, 2 and 3 and the reply to 1 stored at 4 (2 and 3 came while it was written),
  the follow-up is shown 1, the reply, 2, 3. A reply that answers something before a new topic belongs to the old topic,
  even when it was stored after the notice. Consecutive messages of one side are one turn (their parts in order),
  because several providers refuse two turns of one side in a row. The call starts and ends with the owner: an Agent
  turn left first, or after the owner's newest message, is left out. System notices, the fixed greeting and the stored
  reasoning are never shown. A message that quotes another starts with `> ` lines holding the first 200 characters of the quoted one (its
  text, or its attachment's name), also when the quoted one is from before the new topic: the owner chose to show it.
  In a group the same, with everyone but the Agent on the owner's side: every message the Agent may read there — from
  its (last) joining on — from anyone else, person or Agent, is `user`, and starts with its speaker's current name,
  `名字：` for a person and `名字（Agent）：` for an Agent (a quote then goes on the next line); the Agent's own replies
  there are `assistant`, placed by what their runs covered; the call ends on the newest message of someone else's. A
  group has no new topic. Nothing of another conversation is read: the group's run reads the group, the Agent's own
  conversation reads only itself.
  A reply of the Agent's that proposed a persona is shown as its text followed by the proposal written out again as its
  block (Persona proposals, "What the Agent sees of it later"); it counts toward the budget like any text.
- Attachments, read only through the download's own permission with the Agent as reader, and only after their stored
  size passed the limit: a PNG, JPEG or WebP image (what all four protocols take) of at most 5 MB as the image when the
  model sees images, else `[图片：name]` (a GIF always; at most 10 images a call, the newest); a PDF of at most 10 MB as the file when the model reads PDFs,
  else `[文件：name]`; any other file as `[文件：name]` followed by its text when its bytes are text — valid UTF-8, no
  NUL, at most 1 in 100 characters a control character other than tab, line breaks and form feed; decided by the bytes,
  not the name or type — at most 100 000 characters a file and 200 000 a call (newest first), cut with `…（已截断）`, a
  byte-order mark dropped and what message text may not hold removed (bidi controls, control characters); else
  `[文件：name]` alone. A file is read at most 4 bytes per character it may still show, and its first 4 KB decide whether
  the rest is read. A message with only an attachment is a turn like any other. At most 20 MiB of attachments are
  held for one call, whatever their kind (four images of 5 MiB, or two PDFs of 10 MiB, fill it; an attachment that would
  pass it is named), each checked on its stored size before a byte is read. **Memory:** the worst case for one reply is
  20 MiB of attachment bytes, held in up to about five copies at its peak (the bytes, the model library's base64 text of
  them, a third larger, the request body holding that text, and its encoded bytes), and at most
  `AGENT_MAX_RUNS_IN_FLIGHT` (16) replies run at once: about 16 × 20 MiB × 5 = 1.6 GiB for the whole service at the
  default (lower `AGENT_MAX_RUNS_IN_FLIGHT` on a small container). Blobs are read with no transaction open. A missing blob is shown by name (and logged), and so is one whose read
  fails or takes more than 15 s (logged once): an unreadable file does not fail the reply. Only when two reads have
  failed and none of this reply's has succeeded (a missing blob counts as an answer of the store) is the store down: the
  run fails `busy`, as it does when reading takes longer than `AGENT_RUN_TIMEOUT_MS`; once one read has succeeded, every
  later failure is shown by its name (`tests/runs-faults.test.ts`).
- The budget: the model's context, less the call's output limit (at a reasoning level, its thinking allowance included)
  and the system text, counted as admission counts (a token per
  character, 1 500 an image, 300 per KB of PDF). What fits, in this order: the current turn (the owner's messages after
  the Agent's last) by name only, newest first — the owner's newest message is always there, cut from the front (`…`
  then its end) when it alone is over the budget (which then holds at least 200 tokens: with less the run fails
  `context_too_small`, see `begin`); then the current turn's attachment contents, newest first, each if it
  fits; then older messages by name only, newest first, while they fit (nothing older than one that does not); then
  their attachment contents, newest first, each if it fits. So an older message's attachment goes (leaving its name)
  before older messages do, and what the owner has just sent is the last to go. In a group (where the current turn is
  everyone else's messages after the Agent's last) the budget is at most `AGENT_GROUP_CONTEXT_TOKENS` (12 000; the
  system text is outside it), and only the group's latest 80 messages are read at all: the same order, within that cap
  (Agents in a group, A reply there). The Agent's own conversation has no such cap.
- The reasoning level is the Agent's when the model allows it, else `none`. A provider model flagged `reasoning`
  allows every level here, whatever its `reasoningLevels`: an Agent saved with a level its model has since stopped
  listing keeps answering with that level (the run is not failed) until the Agent is edited, when the level is checked
  again.

A reply's input estimate (what admission holds) and what settlement falls back on when no usage is reported both count
all of the above, attachments at their estimate.

**Outcomes.** How a run ends — the message it leaves, its `status` and `error` code (`Run`, Replies), what it is charged
(Metering):

| How a run ends | Message | Run |
|---|---|---|
| The model answered | the answer (`truncated` when the model stopped at its output limit or it was cut at 8 000 characters; then without what follows an unfinished proposal block's `<af-`, and with nothing left: `failed`, `provider_unavailable`, no message) | `done` |
| The owner stopped it | what had been said, `stopped: true`, without what follows an unfinished proposal block's `<af-` (nothing said, or nothing before that: no message) | `stopped` (also when a pause or delete comes after the message was posted) |
| Paused or deleted while queued | none, no call made, no usage record | `cancelled`, `agent_paused` / `agent_deleted` |
| In a group, another Agent's message called for it and a member halted Agents (Agents in a group) | queued: none, no call made, no usage record; running and not yet posted: none, what it had said is discarded, what it used is settled | `cancelled`, `halted` |
| Paused or deleted while running, before it posted (resumed since or not) | none; what it had said is discarded, what it used is settled | `cancelled`, `agent_paused` / `agent_deleted` |
| The Agent left the run's group (taken out by the creator or its owner, or along with its owner), or is otherwise no longer a member there when the run begins or posts | queued: none, no call made, no usage record; running and not yet posted (added back since or not): none, what it had said is discarded, what it used is settled | `cancelled`, `agent_removed`; never followed up: a mention noted on it meanwhile is dropped |
| The provider failed (key refused, unreachable, address refused), or cut the stream off midway | none; what it had said is discarded | `failed` with that code (a cut-off stream: `provider_unavailable`); charged only what the upstream reported, so as a rule nothing |
| The model stopped at its output limit having only thought (no visible text; reasoning came, or the upstream reported reasoning tokens) | none; the reasoning streamed meanwhile is discarded | `failed`, `thinking_exhausted`, retryable; charged what the upstream reported |
| The reply could not be stored (or the run started) for the service's own reasons | none | `failed`, `busy`, retryable; charged nothing: the usage record keeps the true cost, all of it forgiven |
| Nothing left to pay for it | none, no call made | `failed`, `no_quota` |
| The owner had started `AGENT_RUNS_PER_MINUTE` replies in the last minute (recorded by the trigger, or in a group by a follow-up; never queued) | none, no call made, no usage record | `failed`, `rate_limited`, retryable; charged nothing |
| An empty answer (no visible text, no reasoning; in a group, no visible text) | none | `failed`, `provider_unavailable`; charged only what the upstream reported |
| Everything it was to answer is before a new topic (started while it was queued, or a retry after one) | none, no call made | `cancelled` with no error, not retryable; charged nothing; what the owner wrote meanwhile gets the follow-up |
| The model's context cannot hold the owner's newest message (or 200 tokens of it) after the system text | none, no call made | `failed`, `context_too_small`, not retryable; charged nothing |
| Nothing to answer otherwise, or its attachments could not be read (two reads failed before any succeeded, or reading took longer than `AGENT_RUN_TIMEOUT_MS`) | none, no call made | `failed`, `busy`, retryable; charged nothing |
| `AGENT_RUN_TIMEOUT_MS` (2 minutes) passed | what had been said, `truncated: true`, without what follows an unfinished proposal block's `<af-` (nothing said, or nothing before that: `failed`, `provider_unavailable`, charged only what the upstream reported) | `done` |
| The service closed during the call, or while its attachments were read | none | ended by the closing service itself as recovery ends one (Shutdown, below): `failed`, `provider_unavailable`, retryable; charged nothing. Only if that cannot be written (or the process died): left `running`, then recovered at the next start, or by the stale-run sweep of an instance still running |

Failures are never messages: no seq, not in search or unread counts, never shown to a model. The owner sees them on the
run. Every run the worker took is settled exactly once (its usage record's `outcome` is the run's status; the database
holds at most one record per run).

**Recovery at start-up** (`port-impl.ts` `recoverRuns`; review focus 5, spec 6.4 and 6.5; `tests/runs-restart.test.ts`).
When the app is ready, before the worker starts, every run the previous process left `running` — its call, if it had one,
died with that process — is ended without any model call, each in one transaction under the locks `finish` takes:

- its reply had been posted in its conversation (the service stopped between post and finish): `done` (`stopped`
  when the message is marked so), with that one message;
- else, its Agent's pause or delete had interrupted it: `cancelled` with that reason;
- else `failed`, `provider_unavailable`, retryable: nothing is called again on its own (spec 6.5); the owner retries.
  A persona draft (`POST /api/agents/draft-persona`; no Agent, so locked from its run row) always ends so.

In the same transaction its hold is released by a settlement on no tokens at all, which costs nothing (whatever the
upstream reported died with the process); a run that already has its usage record gets no second one. A posted or
cancelled run is followed up by the one rule above (the follow-up is queued for the worker; in a group under the same
rules as at a reply's end, so a notice it appends is stored and read at the next sync); a failed one is not, since a
retry answers everything. Queued runs stay queued and are answered once the worker starts. Nothing is pushed — no socket
can be open yet — so a client learns the state from `GET /api/conversations/:id/run`. The worker's stop and pause flags
live in the process: a new start has none. A run that cannot be recovered is logged and left for the stale-run sweep
or the next start.

**Shutdown** (`app.close()`, which `SIGTERM` and `SIGINT` call; `tests/runs-restart.test.ts`). A graceful stop ends what
this process was working on itself, so a run is left `running` only by a process that died (or whose writes failed): the
worker claims nothing more; every call in flight, and every reply still reading its attachments, is abandoned without
posting or admitting anything, and its run is ended exactly as recovery ends one (above: `failed`, `provider_unavailable`,
retryable, its hold released at no charge — or `cancelled` when a pause or delete had interrupted it), each in its own
transaction, and its owner is told (`run`; sockets already closing may miss it, and a client reads `GET …/run` when it
reconnects). A reply already being posted finishes as usual. Persona drafts under way are abandoned and ended the same
way (their requests answer 503 `busy`). All of this gets at most 5 s together (`SHUTDOWN_GRACE_MS`): what could not be
written by then — the database not answering — stays `running` and is logged, for the stale-run sweep of another
instance or the next start. Queued replies stay queued for the next start.

A deploy may start the new instance while the old one is still answering (`tests/runs-restart.test.ts`, "a second
instance"). The new one's recovery then ends the old one's runs as above; when the old one's call finishes, `post` finds
its run no longer `running` (read under the same locks recovery takes) and stores nothing, and `finish` leaves the run as
recovery recorded it: no message, no second usage record (logged at warn) — and pushes the run as it now stands (`run`)
to the owner's sockets on the old instance, which were told it was running, so no "replying" stays shown there. (The
same holds for a run the stale-run sweep or a stop released meanwhile.) A run's in-process stop and silence flags are
forgotten when it ends, when it is released, and when its `finish` fails. While both run, both workers take queued
runs; a reply the old instance takes after the new one has started is ended by the old instance's own stop (Shutdown,
above) when it is stopped in the middle of it, or, if the old instance is killed before that, left `running` with
nobody working on it: the stale-run sweep (below) releases it.

**The stale-run sweep** (`port-impl.ts` `sweepStaleRuns`; `tests/runs-restart.test.ts`). Once a minute while the service
runs (first a minute after start), every run — reply or persona draft — that has been `running` for longer than twice
`AGENT_RUN_TIMEOUT_MS` and a minute (the most attachments and then a call may take, and a minute to post and record;
5 minutes with the default) is released exactly as start-up recovery releases one, each in a transaction of its own
under the same locks — unless this process is working on it (a run its worker has claimed and not yet finished, a draft
whose request is under way): those are never touched, however old. Unlike at start-up, the owner's sockets are told
(`run`), and a follow-up queued by the one rule wakes the worker. An instance still working on a run that old elsewhere
is past its own limits: its `post` is refused (the run is no longer `running`) and nothing is recorded twice. So a run
left behind by a process that is gone — a deploy's old instance killed mid-call, or whose stop could not write its runs'
end, a `finish` that failed — is released
within about twice `AGENT_RUN_TIMEOUT_MS` and two minutes (6 minutes with the default). Until then it is stuck: its
conversation shows it replying and the Agent answers nothing more there (an Agent has one queued or running run per
conversation at most), it occupies one of the owner's `AGENT_MAX_CONCURRENT_RUNS` slots, and, if it was admitted, its
hold still counts against the owner's allowance or balance.

**The port boundary.** Everything under `src/agents/runtime/` — the worker, the stream (`stream.ts`), the system text
(`prompt.ts`) — reaches the rest of the service only through `AgentPort` (`runtime/port.ts`): `claimNext`, `begin`,
`emit`, `post`, `finish`, `release`, `shouldStop`. The SQL is in its implementation, `port-impl.ts`. `tests/agent-port-boundary.test.ts`
fails when a file there imports `db.ts`, `pg` or any `store.ts`. It is the shape an external Agent's connection would have.

Lock order of every write here: one conversation row → the `agents` row → the run row → the `accounts` row
(`store.ts` `lockAgent`). The conversation is the one the write acts in: whatever acts for a run — the trigger, a
retry, the worker's `begin`, `post` and `finish`, a follow-up, recovery, the stale-run sweep, a stop's release — locks
the run's own conversation (`agent_runs.conversation_id`, which never changes), never another; the owner's writes to
the Agent itself (edit, pause, resume, delete, avatar, proposals) lock its dedicated conversation. Where several
`agents` or `accounts` rows are locked at once (a person's message in a group naming several Agents) they are taken in
id order, the `accounts` rows after every run row; a run's end (`finish`, recovery) takes its owner's `accounts` row
to settle and, for a follow-up in a group, to count the owner's replies a minute — the same row, last; an Agent's
message in a group holds only its own `agents` row and reads the others' (In a group, above); a halt locks the group's
row and run rows only; a resume, the dedicated conversation's row, the `agents` row and the Agent's run rows. Like the hub, the worker and its
stop flags live in this process: run one instance. Two overlap only during a deploy, which is safe (Recovery, above).

A group's membership changes keep to the same order (`conversations/groups.ts`): adding an Agent locks the group's row,
then the Agent's `agents` row (so a delete either committed before — the add is refused — or waits for the add, and its
leaving then finds the Agent there); taking Agents out — removed, or along with their owner — locks the group's row,
then their run rows in that group, and no `agents` row. A delete's leaving of its groups runs after the delete's own
transaction (the dedicated conversation's row, then the `agents` row) has committed, one transaction per group, each
locking that group's row only: no transaction holds two conversation rows.

## Metering (`src/metering/`)

Spec 6.3 and 6.4. A model call is a reply of an Agent or a persona draft (`POST /api/agents/draft-persona`): both are
runs, admitted, held and settled alike (`admit.ts`, `settle.ts`; prices and estimates in `prices.ts`). A call on a
provider model costs nothing and needs no points (it is still recorded). A call on a site model is admitted before it
starts and settled when it ends, each in one transaction under the owner's `accounts` row lock (after the run's row), and
never with a transaction open across the call.

**Units.** Money is whole micro-points (`bigint`, 1 point = 1 000 000 micro-points); no floats in storage or arithmetic.
Prices are micro-points per token (`inputMicroPerToken`, `outputMicroPerToken` of `SITE_MODELS`), the daily allowance
`FREE_DAILY_POINTS` whole points, a day the calendar day of `SITE_TIMEZONE`. On the wire every amount is a decimal string
of points (Usage and points).

**Admission** decides, once, the one source the call is charged to, and holds against that source the most the call can
cost until it is settled: its input estimate (one token per character, high on purpose for Latin text; 1 500 per image;
300 per KB of PDF) plus the call's whole output limit (at a reasoning level, its thinking allowance included: Calling a
model), at the model's prices. A free-tier model is charged to today's
free allowance while what is left of it, less what your running calls hold against it, is above zero; otherwise to the
balance, by the same rule; a paid-tier model only to the balance. With neither, the call does not start: `no_quota`
(402) with `reason` `free_and_balance` and `resetsAt`, or `reason` `balance` (a reply's run fails so; a draft answers
so). The run records the model it was admitted on with its source and hold, and settlement goes by that, whatever the
Agent's model is by then; it records the reasoning level the call is sent at too (migration 018), for its reply's `via`.

**Settlement** works out what the call cost: the tokens the upstream reported (reasoning counts as output), or, when it
reported none, one token per character (images and PDFs at their estimate, as at admission), and the record says
`estimated`, at the model's price — unless the operator has removed that site model from `SITE_MODELS` while the call
ran: then it cannot be priced, its true cost is recorded as 0 and `estimated`, nothing is charged, and the log says so
(warn, with the run and the model). A call that failed (the provider's error, a stream it cut off midway, an answer
with nothing in it, nothing said before the time limit) is charged only what the upstream reported: what it streamed
before it failed is discarded and not counted, so with no usage reported it costs nothing. A run that never reached
admission costs nothing either, and nor does one admitted whose model was never called (a stop, pause or delete that
landed between its admission and the call: settled on no tokens at all, not on its input estimate; `tests/runs.test.ts`). The charge goes to the source admission chose, never more than the call held: a call on
the allowance uses the allowance of the site day it ends in (one that starts before midnight and ends after it uses
the new day's); a call on the balance is charged in full (up to its hold) and may take the balance below zero; at or
below zero nothing more starts on the balance until the operator's grants bring it above zero. Settlement releases the
hold in the transaction that moves the run out of `running` (Agents and runs, `finish`), so a hold never stops counting
before its cost lands.

**Forgiveness.** What is not charged of the true cost is forgiven, charged to no one — neither the balance nor any day's
allowance — and recorded as such (`forgiven_micro`):

- whatever is above the call's hold (an estimate that turned out low);
- whatever of an allowance charge exceeds what is left of that day's allowance (not moved to the balance, nor to the
  next day);
- all of it when the reply could not be stored for the service's own reasons (run error `busy`: the record keeps the
  true cost), and for a run recovered at start-up (settled on no tokens at all: whatever the upstream reported died with
  the process).

**The debt bound.** However many replies and drafts you start at once, the free overrun forgiven in a day and the debt on
the balance are each less than one call's maximum cost: admission holds a call's maximum cost against its source
before the call, under the account lock, and admits only while what is left after the holds is above zero
(`tests/metering-concurrency.test.ts`: twenty at once, also with every call costing far more than it held).

**Records.** Every call appends one usage record (who, which Agent, which source and model, tokens, whether
`estimated`, the true cost, and how much of it the allowance, the balance and forgiveness took — the three always add up
to the cost —, outcome; a run that ended before it was admitted leaves a record with neither source nor model, costing
nothing); the database holds at most one per run. Every change of a balance is one ledger entry: `grant` and `adjust`
(the operator giving points, or taking them back with a negative `credits:grant`) and `usage` (a call, linked to its
record). A balance always equals the sum of its ledger. `GET /api/usage` shows what you were charged, not the true cost.

## Attachments (`src/attachments/`)

**Upload.** `POST /api/conversations/:id/attachments`, `multipart/form-data` with exactly one part: a file
named `file` (any other part or field, or none, is 400). → 201 `{"id", "name", "size", "inline"}`. Only a
current member who may send there can upload; the refusals are exactly a send's (404 `not_found`, 403
`cannot_send` with `reason`), checked before the body is read and again, under the send locks, after it
was stored — an upload that finishes after you were unfriended or removed is refused and deleted. The
server decides the type from the first bytes (the declared `Content-Type` and file name are ignored):
`inline: true` only for PNG, JPEG, WebP and GIF. The name is for display only (NFC; path, control,
bidi and zero-width characters removed; at most 120 characters; `file` when empty). Limits per
principal: 60 uploads per hour and 3 at a time (429 `rate_limited`). The largest file one upload may carry is
`ATTACHMENT_MAX_BYTES` (default 1 GiB; allowed 1 MiB to 5 GiB, and never more than `ATTACHMENT_QUOTA_BYTES`): over
it 413 `too_large`, enforced while streaming. Each person may store `ATTACHMENT_QUOTA_BYTES` of attachments in all
(default 20 GiB), sent or not (413 `{"error": "too_large", "reason": "quota"}`). An upload is cut off after
`UPLOAD_IDLE_TIMEOUT_MS` without body bytes (default 45 s) or `UPLOAD_TOTAL_TIMEOUT_MS` in all (default 60 minutes),
and its partial upload deleted; the server-wide request timeout defaults to the upload total plus one minute. Uploads
and downloads are streamed end to end (S3: multipart upload of 5 MiB parts, one in flight, about 10 MiB of memory per
upload); downloads have no range support, so an interrupted one starts over. A blob an upload left behind is swept
only after the upload total timeout plus a minute (Blobs nothing references, below). Until the upload's checks have
passed, its body is under the 30-second body deadline every request starts with (see Configuration): a refused or
signed-out upload cannot keep a connection busy.

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
characters) of a message's text (captions included) or a file message's name; system notices never match, and an
Agent's reasoning is never looked at (whoever may read it), so a word only in it finds nothing.
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
  types, signed in and signed out; plus the Better Auth mount, malformed multipart, the avatar routes (yours and your
  Agent's) and WebSocket handshakes. Every answer must be < 500, every 4xx a `{"error": "<snake_case>"}` JSON body whose
  other fields are strings (the one exception, `provider_in_use`'s `agents` list, is named in the test), and
  `/api/health` must answer afterwards. The routes of Agents, providers, usage and replies are walked with the real ids
  of an Agent with a run and a persona proposal and of a provider in use (a local model and provider answer without a
  network): a malformed path parameter there is always a 4xx, and every one of them answers a probe beyond its checks of
  shape, session and existence.
- `tests/concurrency.test.ts` races real HTTP requests on the 10-connection pool (sends against an unfriend,
  a block and a removal; 20 adds of one person; two senders; accept against withdraw; a block against a
  group add; the last two members leaving; read markers; uploads at the quota; a request against a block)
  for several rounds and checks each stated invariant against the database. `tests/registration.test.ts` races
  eight registrations on one invite (whatever their e-mails, exactly one uses it) and two registrations of one
  e-mail (one account remains). `tests/agents-group-membership.test.ts` races an owner's leave (or removal) against
  their own add of their Agent (never an Agent left without its owner), and an Agent's removal against the posting of
  its reply (the post waits for the removal and stores nothing; bounded, no deadlock).
- `tests/enumeration.test.ts`: on every route taking a conversation id, a seq, an attachment, request or
  principal id, an id that exists but is not yours gets byte for byte the answer a random id gets — and on every route
  taking an Agent, provider, run or persona-proposal id (or naming a provider in a body), for a stranger and for the
  owner of a different Agent, with every mix of real and random ids; the two
  intended differences (any existing person can be blocked and has an avatar) are asserted, and that an Agent's id
  has neither (as a random id: its avatar for anybody but its owner and whoever shares a conversation with it now — so
  also for a member who left, or once the Agent left — blocking and unblocking it for everyone). Catch-up
  and downloads also take about as long for both (medians within a factor of 2).
- `tests/readme.test.ts`: the route headings of this README are exactly the routes the app serves.
- `tests/logging.test.ts`: no log line holds a WebSocket ticket, a verification token or a search term (the query
  string is never logged), nor — over a whole reply through a provider, and one the provider refuses — the persona, the
  owner's message, the reply, its reasoning, a proposed persona or the provider's key.

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
