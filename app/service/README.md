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
