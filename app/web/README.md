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
- `src/data/store.jsx` - store provider and `useStore()`; starts empty (`emptyState`).
- `src/state/` - UI reducer (navigation, toast) and selectors; `src/pages/`, `src/ui/` - the approved prototype UI.
