# Agent Family web client

React 19 + Vite. Talks to `app/service` over same-origin `/api` (cookie session) and one WebSocket.

## Develop

1. Start the service with `APP_ORIGIN=http://127.0.0.1:5273` (its default `.env` value must match, otherwise every
   POST/PUT/PATCH/DELETE and the WebSocket upgrade are refused with 403): `npm run dev` in `app/service`
   (listens on `127.0.0.1:8787`).
2. `npm install` then `npm run dev` here. Vite serves `http://127.0.0.1:5273` (port is fixed, `strictPort`) and proxies
   `/api`, WebSocket included, to the service with the Host and Origin headers unchanged.

## Test and build

- `npm test` runs ESLint and vitest (`tests/`).
- `npm run build` writes `dist/` (git-ignored).
- `npm run e2e` runs the browser end-to-end suite (`e2e/`, Playwright, Chromium; not part of `npm test`). Needs
  Playwright's Chromium once per machine: `npx playwright install chromium`.

## End-to-end suite (`e2e/`)

Each spec creates its own people (one browser context each, random e-mails, handles and passwords), so the specs
run in any order; one worker, because they share one service. Every page is watched for CSP violations, uncaught
errors and the XSS probe (`support/fixtures.mjs`).

**Local mode** (default). Global setup builds this client and the service (`npm run build` in both;
`E2E_SKIP_BUILD=1` reuses the last builds), runs the migrations on the database `af_e2e` (server, role and password of
`TEST_DATABASE_URL`, from the environment or `app/service/.env`, with the name replaced) and empties every table but
`pgmigrations`, then starts one service (`node dist/server.js`) on `http://127.0.0.1:8911` (`E2E_PORT`, bound with `HOST=127.0.0.1`, so it is not reachable from the network) that serves
`dist/` with a random `AUTH_SECRET`, a temporary `BLOB_DIR`, `RATE_LIMIT_SCALE=1000` and `SWEEP_INTERVAL_MINUTES=0`.
Invites and mail come from the service CLI (`invite:create`, `inbox:list`). The restart spec stops and starts that
process through a control endpoint of the runner (127.0.0.1, random port and token). Teardown stops the service and
deletes the temporary directory; a service left by a crashed run is stopped by the next run. The service log is
`e2e/test-results/service.log`; failures keep traces and screenshots in `e2e/test-results/`, the HTML report is in
`e2e/playwright-report/` (`npx playwright show-report e2e/playwright-report`). All of these are git-ignored.

**Remote mode.** `E2E_BASE_URL=https://… E2E_INVITE_CMD="…" E2E_INBOX_CMD="… {email}" npm run e2e` starts nothing
and talks to that origin. The invite code is the last line of `E2E_INVITE_CMD`'s output that is a 20-character code;
`E2E_INBOX_CMD` must print what `inbox:list --to <email>` prints, `{email}` being replaced by a generated
`…@example.test` address. Example for the container: `E2E_INVITE_CMD="docker exec af node dist/cli.js invite:create"`,
`E2E_INBOX_CMD="docker exec af node dist/cli.js inbox:list --to {email}"`. Only the specs tagged `@remote` run
(§7.1, §7.2: the real registration limit is 10 a minute per address); `E2E_REMOTE_ALL=1` runs all of them, and the
restart spec skips itself.

## Layout

- `src/api/http.js` - `request`, `ApiError`, `setUnauthenticatedHandler`.
- `src/api/routes.js` - one function per service endpoint, plus attachment/avatar URL builders and `socketUrl`.
- `src/api/socket.js` - ticket → WebSocket, ping every 25 s, `onEvent` / `onClose(code)`.
- `src/data/model.js` - the client's copy of the service's data as pure functions (seq rule, catch-up, optimistic sends).
- `src/data/sync.js` - first load, push buffering, gap repair, reconnect with backoff (1 s → 30 s).
- `src/data/actions.js` - async actions (send, retry, read, older history, social and group routes).
- `src/data/viewmodel.js` - model → the prototype's state shape (signed-in user under the alias id `"me"`).
- `src/data/store.jsx` - `createDataLayer()`, store provider and `useStore()` → `{state, dispatch, actions, start, stop, onSignedOut}`.
  Nothing talks to the service until `start()`.
- `src/auth/` - account screens (`screens.jsx`), the session gate (`AuthRoot.jsx`: one `GET /api/me` at start, runs the data layer while
  signed in, stops it on sign-out / 401 / close 4001), the path router (`router.js`), field rules, error-code texts.
- `src/App.jsx` - the sign-in gate and the lazy application (`src/AppShell.jsx`: rail, lists, chat; its own chunk, so the account screens never download it).
- `src/state/` - UI reducer (navigation, toast) and selectors; `src/pages/`, `src/ui/` - the approved prototype UI.
- `src/ui/Markdown.jsx` - the safe Markdown renderer for Agents' messages only (its own chunk, loaded with the first Agent message;
  `AgentText` in `src/pages/AgentChatBits.jsx` shows the plain text until then, on any failure, and for a text beyond
  `src/ui/markdownLimits.js`). No raw HTML, http(s) links only, images as links, nothing fetched.
