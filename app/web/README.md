# Agent Family web client

React 19 + Vite. Talks to `app/service` over same-origin `/api` (cookie session) and one WebSocket.

## Develop

1. Start the service with `APP_ORIGIN=http://127.0.0.1:5273` (its default `.env` value must match, otherwise every
   POST/PUT/PATCH/DELETE and the WebSocket upgrade are refused with 403): `npm run dev` in `app/service`
   (listens on `127.0.0.1:8787`).
2. `npm install` then `npm run dev` here. Vite serves `http://127.0.0.1:5273` (port is fixed, `strictPort`) and proxies
   `/api`, WebSocket included, to the service with the Host and Origin headers unchanged.

## Test and build

- `npm test` runs vitest (`tests/`).
- `npm run build` writes `dist/` (git-ignored).

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
- `src/state/` - UI reducer (navigation, toast) and selectors; `src/pages/`, `src/ui/` - the approved prototype UI.
