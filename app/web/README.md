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
`pgmigrations`, starts the model stub (`support/model-stub.mjs`: a local stand-in for a model service on 127.0.0.1,
speaking OpenAI Chat Completions and Anthropic Messages, streamed, scripted by the specs), then starts one service on
`http://127.0.0.1:8911` (`E2E_PORT`, bound with `HOST=127.0.0.1`, so it is not reachable from the network) that serves
`dist/` with a random `AUTH_SECRET`, a fixed fake `PROVIDER_KEY_SECRET`, a temporary `BLOB_DIR`, `RATE_LIMIT_SCALE=1000`,
`SWEEP_INTERVAL_MINUTES=0`, `FREE_DAILY_POINTS=1` and two site models (one free, one paid) that are the stub. That service
is the test-only entry `app/service/tests/helpers/e2e-server.ts`, run with `tsx` (`NODE_ENV=test`, and only on a
database named `…_e2e`): the production entry (`dist/server.js`) cannot call a plain-http loopback address, by design.
Invites, mail and points come from the service CLI (`invite:create`, `inbox:list`, `credits:grant`). The restart spec
stops and starts that process, and the specs script the stub, through a control endpoint of the runner (127.0.0.1, random
port and token). Teardown stops the service and the stub and deletes the temporary directory; a service left by a
crashed run is stopped by the next run. `E2E_SHOTS=1` also saves the acceptance screenshots
(`docs/acceptance/batch2a/shots/`, 1440×900 and 390×844) of this run's own seeded data. The service log is
`e2e/test-results/service.log`; failures keep traces and screenshots in `e2e/test-results/`, the HTML report is in
`e2e/playwright-report/` (`npx playwright show-report e2e/playwright-report`). All of these are git-ignored.

**Remote mode.** `E2E_BASE_URL=https://… E2E_INVITE_CMD="…" E2E_INBOX_CMD="… {email}" npm run e2e` starts nothing
and talks to that origin. The invite code is the last line of `E2E_INVITE_CMD`'s output that is a 20-character code;
`E2E_INBOX_CMD` must print what `inbox:list --to <email>` prints, `{email}` being replaced by a generated
`…@example.test` address. Example for the container: `E2E_INVITE_CMD="docker exec af node dist/cli.js invite:create"`,
`E2E_INBOX_CMD="docker exec af node dist/cli.js inbox:list --to {email}"`. Only the specs tagged `@remote` run
(§7.1, §7.2: the real registration limit is 10 a minute per address); `E2E_REMOTE_ALL=1` runs all of them, and the
restart spec and the specs that need the model stub (Agents, providers, Markdown) skip themselves.

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
- Agents' messages (only theirs) as safe Markdown, never parsed on the page's main thread:
  `src/ui/markdownWorker.js` runs the whole pipeline (`src/ui/markdownPipeline.js` `renderToTree`: the raw-text checks of
  `src/ui/markdownLimits.js`, micromark/remark, KaTeX, highlighting, the allow-list of `src/ui/markdownRules.js`, caps of
  600 table cells and 3 000 elements per text) in a module worker; `src/ui/markdownClient.js` sends one text at a time
  and ends the worker when an answer is 250 ms late (the text is then plain with a note, and remembered for the tab by a
  digest: `src/ui/slowTexts.jsx`); `src/ui/markdownTree.js` checks every tree that comes back; `src/ui/Markdown.jsx` (its
  own chunk, with KaTeX's styles) turns it into React elements. `src/ui/AgentText.jsx` shows the plain text until the
  tree has come; `src/ui/markdownView.jsx` renders only texts near the visible part of a conversation, within 30 000
  elements per conversation, and turns texts rich at most 3 000 elements per animation frame (also when the tree was
  already kept: a conversation opened again). No raw HTML, http(s) links only, images as links, nothing fetched; maths
  is `$$…$$` only. A link's content is one plain text, followed by its real host unless that text is exactly its
  address; bidirectional controls are removed from everything shown. A reply being written keeps and shows its first
  20 000 characters (`src/data/model.js` `STREAM_CHARS`).
