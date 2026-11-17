# Deploying Agent Family (one container: service + web client)

The image holds the service (`app/service`) and the built web client (`app/web`), which the service serves
from the same origin (`WEB_DIST`, see `app/service/README.md`, Deployment). Postgres is not part of it.

## Build

The build context is the **repository root**, not this directory:

```
docker build -f app/deploy/Dockerfile -t agent-family .
```

`app/deploy/Dockerfile.dockerignore` (BuildKit picks it up next to the Dockerfile and prefers it to the root
`.dockerignore`, which belongs to the old app) lets only `app/web` and `app/service` into the context, minus
`node_modules`, `.env*`, `dist`, `app/service/data` and the tests. `spikes/`, `prototype-v2/`, `.git`, `.claude`
and `.superpowers` never enter.

Stages: (1) `app/web`: `npm ci && npm run build`; (2) `app/service`: `npm ci && npm run build`; (3) the
runtime image on `node:24-slim`: `npm ci --omit=dev` for the service, `dist/`, `migrations/`, and the web
build at `/app/web` (`WEB_DIST=/app/web`). It runs as the unprivileged `node` user.

## Run

```
docker run --rm -p 3000:3000 --env-file agent-family.env agent-family
```

On start the container runs the migrations (`node dist/cli.js migrate`, safe to repeat) and then the server
(`node dist/server.js`); a failed migration stops the container before anything is served. `PORT` (default
3000) is honoured; the server listens on all interfaces. `HEALTHCHECK` calls `GET /api/health` (it also
touches the database) on the `PORT` the container runs with.

Other commands run in the same image, e.g. the first invitation, the mail outbox, the attachment sweep:

```
docker exec <container> node dist/cli.js invite:create --ttl-hours 72
docker exec <container> node dist/cli.js inbox:list --to someone@example.com
docker exec <container> node dist/cli.js attachments:sweep      # by hand only; the server sweeps by itself
```

## Environment

Required: `DATABASE_URL`, `APP_ORIGIN`, `AUTH_SECRET`, `PROVIDER_KEY_SECRET`. An invalid value stops the service at
start-up with a message naming the variable. Values in the right column are for the acceptance environment.

| Variable | Meaning | Acceptance value |
| --- | --- | --- |
| `DATABASE_URL` | Postgres connection string. Needs the extensions `citext`, `pgcrypto`, `pg_trgm`. | the acceptance database |
| `APP_ORIGIN` | The public origin users type, no path (`https://…`). Used for the Origin check, cookies (`Secure` when https), mail links, HSTS (https only). | the public https URL |
| `AUTH_SECRET` | Signs sessions and tokens; at least 32 characters; keep it stable (changing it signs everyone out). | a long random string |
| `PROVIDER_KEY_SECRET` | Encrypts the API keys people save for their own model providers; at least 32 characters. **Back it up with the database**: a database restored without it (or with another value) cannot open those keys — each provider then fails until its owner saves the key again. Keep it stable. | a long random string, other than `AUTH_SECRET` |
| `SITE_MODELS` | The models the site offers (JSON array; see `app/service/README.md`, Configuration). Each names in `apiKeyEnv` another variable that holds its upstream key — set that variable too; it may not be `DATABASE_URL`, `AUTH_SECRET`, `PROVIDER_KEY_SECRET`, `S3_ACCESS_KEY_ID` or `S3_SECRET_ACCESS_KEY` (start-up fails naming the model). Two models may share one. Default: none. | the acceptance models, each with its key variable |
| `FREE_DAILY_POINTS`, `SITE_TIMEZONE` | The free daily allowance of site-model use in whole points (default 200), and the time zone whose midnight starts a new day of it (default `Asia/Shanghai`). | defaults |
| `AGENT_TIERS` | JSON: how many Agents each account tier may own; must contain `free`. Default `{"free":20}`. | default |
| `HOST` | The address the server listens on (default `0.0.0.0`, every interface). | default |
| `PORT` | Listening port. Image default `3000`. | what the platform routes to (often injected) |
| `WEB_DIST` | Directory of the web build. Image default `/app/web`; leave it. Unset serves only the API. | `/app/web` |
| `CLIENT_IP_HEADER` | Header your proxy sets to the real client address, replacing any client value. Rate limits count per address; without it every request looks like the proxy. | `x-real-ip` |
| `TRUST_PROXY` | Alternative to the above: the proxies' addresses/CIDRs whose `X-Forwarded-For` is read. Never `true` or a number (refused). | unset |
| `REGISTRATION_MODE` | `invite` (an invite code is required) or `open`. | `invite` |
| `MAIL_MODE` | `outbox` is the only mode: mail is written to the `mail_outbox` table and read with `inbox:list`; nothing is sent. | `outbox` |
| `BLOB_DIR` | Where avatars and attachments live when `S3_*` is not set. Image default `/data/blobs` (mount a volume there or it is lost with the container; the container runs as the unprivileged `node` user, uid 1000, so a bind-mounted host directory must be writable by uid 1000, e.g. `chown 1000:1000 <dir>`). | unused if S3 is set |
| `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | S3-compatible object storage; all five or none. | all five (container disks are not durable) |
| `RATE_LIMIT_SCALE` | Multiplier on every rate limit. | `1` |
| `SWEEP_INTERVAL_MINUTES` | Minutes between the server's own sweeps of unsent uploads and abandoned blobs (first run a minute after start). `0` disables; at most `1440`. No cron needed. | `15` (default) |
| `ATTACHMENT_QUOTA_BYTES` | Attachment bytes one user may store. | `2147483648` (default) |
| `UPLOAD_IDLE_TIMEOUT_MS`, `UPLOAD_TOTAL_TIMEOUT_MS` | An upload is cut off after this long without body bytes (default 45000) / in all (default 900000). | defaults |
| `HTTP_BODY_TIMEOUT_MS` | A request with a body must have arrived whole within this long (default 30000); an upload is released from it once it is admitted and then follows the upload deadlines. | default |
| `HTTP_CONNECTION_TIMEOUT_MS`, `HTTP_REQUEST_TIMEOUT_MS`, `HTTP_KEEP_ALIVE_TIMEOUT_MS` | Server-wide socket idle (120000), whole request (upload total + 60000), keep-alive idle (72000). Must exceed the upload deadlines. Keep the proxy's idle timeout above the keep-alive value. | defaults |
| `DB_STATEMENT_TIMEOUT_MS`, `DB_ACQUIRE_TIMEOUT_MS`, `SEARCH_STATEMENT_TIMEOUT_MS` | Database limits: statement (30000), wait for a pool connection (10000), one search (3000). Past them: 503 `busy`. | defaults |
| `AGENT_MAX_CONCURRENT_RUNS`, `AGENT_RUNS_PER_MINUTE`, `AGENT_RUN_TIMEOUT_MS` | Model calls per person: running at once, replies and persona drafts together — further replies wait, a further draft is refused; a draft and a reply that start at the same moment may briefly run one over (1–100, default 2); replies started a minute (1–10000, default 20); how long a call may take, in ms (1000–3600000, default 120000) — a reply first reads its attachments, which may take that long too, then calls the model, so one reply can take up to about twice the value; a run still `running` after twice the value and a minute, with no instance working on it, is released by the stale-run sweep. | defaults |
| `PROVIDER_DEFAULT_CONTEXT_TOKENS`, `PROVIDER_DEFAULT_MAX_OUTPUT_TOKENS` | A provider model's context when its owner gives none (1000–2000000, default 16000) and the output limit of every call to a provider model (1–1000000, default 2048); the first must be larger than the second. | defaults |
| `PROVIDER_MAX_CONCURRENT_CALLS` | Calls to model providers and site models in flight at once in the whole service (1–1000, default 64); one more is refused as `provider_unavailable`. | default |

## Must hold

- **One replica.** Realtime delivery and several limits live in one process's memory; a second instance
  would not see the first one's sockets (see `app/service/README.md`, Sync and realtime). No cluster mode.
  A deploy that starts the new container while the old one still runs posts and charges nothing twice: the new one's
  start-up ends the old one's Agent replies in progress (they fail retryable, the owner retries), and when the old
  one's model call finishes it posts and charges nothing more (`app/service/README.md`, Agents and runs, Recovery).
  While both run, the old container's worker may still take up a queued reply; if it is stopped in the middle of that
  one, the running container's stale-run sweep releases it (failed, retryable) within about twice
  `AGENT_RUN_TIMEOUT_MS` and two minutes (6 minutes with the default). Until then that Agent shows "replying" and
  answers nothing more, the reply takes one of its owner's `AGENT_MAX_CONCURRENT_RUNS` slots and, if it was admitted,
  its hold still counts against the owner's points. Keep the overlap short.
- **TLS terminates at the proxy** in front; the service speaks plain HTTP on `PORT` and must be reachable
  only through that proxy (otherwise a client could forge `CLIENT_IP_HEADER`). The proxy must pass WebSocket
  upgrades on `/api/ws`.
- **Same origin.** Users reach both the pages and `/api` at `APP_ORIGIN`; the Content-Security-Policy of the
  pages allows nothing else.
- The server sweeps unsent uploads itself (`SWEEP_INTERVAL_MINUTES`); `attachments:sweep` is only for running it by hand. Back up the database (and the bucket), and keep `PROVIDER_KEY_SECRET` with the backups.

## Backup and restore

Two things hold all state: the Postgres database and the attachment store (the bucket, or `BLOB_DIR`); a third
must travel with them: `PROVIDER_KEY_SECRET`, which the providers' saved keys in the database are encrypted under.

- Database: `pg_dump -Fc -d <db> -f af.dump`, restore into an empty database with
  `pg_restore --no-owner -d <newdb> af.dump` (the dump carries the three extensions).
- Attachments: copy every object to the new bucket under the same key (or copy `BLOB_DIR`).
- Start the service against the restored pair with the **same `AUTH_SECRET`** and **the same `PROVIDER_KEY_SECRET`**
  (without it the providers' saved keys cannot be opened) and the new `APP_ORIGIN`.

Take the database dump first and the objects second: an object without a row is swept later, a row without an
object is a broken attachment. Rehearsed on the acceptance environment on 2026-11-16
(`docs/acceptance/batch1/README.md`); nothing is scheduled yet.

## Not covered here

The image is built for real by Railway on every deploy of the acceptance environment; it has not been built
with a local `docker build` (the development machine has no Docker).
