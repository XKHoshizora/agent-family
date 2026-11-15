# Unified login: Agent Family as OIDC provider for Synapse — integration notes

Status: implemented behind `AF_UNIFIED_LOGIN=true` (off by default).
Code: `server/unified-auth.ts`, `server/auth.ts`, `deploy/synapse/bootstrap.py`.
Tests: `tests/unified-auth.test.ts` (in-process, throwaway SQLite, generated secrets).

All OAuth/OIDC protocol logic comes from the official Better Auth plugins
(`@better-auth/oauth-provider` 1.7.x + `better-auth/plugins` `jwt`). AF only
configures them, persists the one trusted client, and forwards an exact
allowlist of endpoints.

## Flow

1. Element → Synapse `/_matrix/client/v3/login/sso/redirect/oidc-agent-family`
   (Synapse prefixes `idp_id: agent-family` with `oidc-`).
2. Synapse → `GET {APP_URL}/api/auth/oauth2/authorize` (code + PKCE S256, state, nonce).
3. No AF session → provider redirects to `/af-login.html?<provider-signed query>`.
   AF session already present → consent is skipped and it redirects straight to the callback.
4. Login page calls `signIn.email` with `oauthProviderClient()`. That client plugin adds
   `oauth_query` (the signed query) to the JSON body. The provider's before-hook checks
   the signature. Its after-hook resumes authorization and returns `{redirect:true,url}`
   pointing at the Synapse callback with `code`.
5. Synapse → `POST /api/auth/oauth2/token` (`client_secret_basic`, PKCE verifier), and
   reads `id_token`, JWKS and optionally `userinfo`.
6. Synapse maps `sub` (the AF user id) to `@{af_localpart}:{server}`.

## Identity: original Matrix IDs are kept

- `sub` = the immutable AF user id. `af_localpart` = `matrixLocalpart(user.id)`, the
  same function that shared-secret provisioning already uses. So every existing
  `@af_…:server` account maps to itself. Email is never requested or consulted, so
  changing email does not change the identity (this is tested).
- If `matrix_accounts` has a row for the user that differs from the deterministic ID,
  the token/userinfo call is refused (403, `access_denied`). The row is **never
  rewritten**: an admin has to resolve it. The flow never creates or changes
  `matrix_accounts` rows (tested).
- Synapse needs `allow_existing_users: true` to attach the subject to the existing
  account. This is safe only because the localpart is never user-chosen. On the first
  SSO login Synapse writes `(oidc-agent-family, sub)` into `user_external_ids`. After
  that it matches by `sub`.
- `enable_registration` defaults to false (`SYNAPSE_OIDC_ENABLE_REGISTRATION`). Users
  without an existing Matrix account cannot SSO in until it is provisioned (or until
  this is set to true).
- Nothing touches passwords, Matrix access tokens, device keys or cross-signing.
  Password login and shared-secret provisioning keep working. **E2EE gotcha:** an SSO
  login is a *new device*. To read encrypted history the user has to verify it (from
  another session or with the recovery key), as with any new login.

## Exact integration gotchas

1. **Issuer must match exactly.** The AF issuer is `${APP_URL}/api/auth` (no trailing
   slash) and must equal `SYNAPSE_OIDC_ISSUER`. Synapse fetches
   `${issuer}/.well-known/openid-configuration` and compares `issuer` byte for byte.
   `APP_URL` must be the public origin that Synapse can reach over HTTPS from inside its
   container (DNS, hairpin NAT, TLS trust). Using an internal URL instead breaks the
   issuer match.
2. **Redirect URI.** AF registers `${MATRIX_HOMESERVER_URL}/_synapse/client/oidc/callback`.
   `MATRIX_HOMESERVER_URL` must equal Synapse `public_baseurl`. You can set
   `SYNAPSE_OIDC_EXPECTED_REDIRECT_URI` so that bootstrap fails on a mismatch.
3. **Client secret.** `AF_OIDC_CLIENT_SECRET` must equal `SYNAPSE_OIDC_CLIENT_SECRET`,
   be 32–256 chars, and use **only `[A-Za-z0-9._~-]`**. authlib (inside Synapse)
   percent-encodes id/secret in `client_secret_basic`, so other characters would not
   round-trip. Generate it with e.g. `openssl rand -hex 32`. AF stores only a SHA-256
   hash (`oauthClient.clientSecret`).
4. **Drift fails closed.** On startup `ensureTrustedClient` creates the client once. If
   the stored row later differs from config (secret, redirect URI, scopes, grant types,
   PKCE, consent, disabled, owner), startup throws and lists only the field names. To
   rotate the secret or change the redirect URI on purpose: stop AF, delete the single
   `oauthClient` row (this does not affect users, sessions or Matrix), set both envs,
   then restart. The row is never rewritten silently.
5. **`AUTH_SECRET` is load-bearing.** It encrypts the JWKS private keys (`jwks` table)
   and signs `oauth_query`. Rotating it breaks id_token signing and any login page in
   flight. Keys survive restarts as long as it does not change (tested).
6. **CSRF.** app.ts exempts from its Origin check exactly
   `unifiedAuthRoute(method,url)?.kind === "client"` for POST, which today means only
   `POST /api/auth/oauth2/token`. That request is server-to-server: cookies are
   stripped and client credentials are required. Sign-in and every other POST keep the
   Origin check. Better Auth's own origin/CSRF checks are **disabled when
   `NODE_ENV=test` or `TEST=true`**. Never run production with either. The tests force
   `advanced.disableOriginCheck: false` so they exercise the production behaviour.
7. **Body parsing.** `registerUnifiedAuthBodyParser(app)` must be registered before
   the routes. It accepts `application/x-www-form-urlencoded` only on the token path
   (raw string, 16 KiB) and returns 415 everywhere else, so JSON routes are unchanged.
8. **Allowlist.** Only five endpoints can be reached: discovery, `jwks`, `authorize`
   (GET), `token` (POST) and `userinfo` (GET). Registration, create-client, consent,
   continue, introspect, end-session and the jwt plugin's `/token` all return 404.
   Every `Location`/JSON `url` from the provider is re-checked: only `/af-login.html` on
   `APP_URL` and the exact Synapse callback pass. Error redirects to the callback are
   allowed.
9. **Login page (`/af-login.html`).**
   - Serve it on the `APP_URL` origin.
   - Use `createAuthClient({ plugins: [oauthProviderClient()] })` and call
     `signIn.email` from the page whose `location.search` still holds the signed query.
     Do not strip or replace the query (`history.replaceState`) before sign-in.
   - The response is `{redirect:true,url}`. The Better Auth client follows it on its
     own. If you use raw `fetch`, set `location.href = data.url` once.
   - The signed query expires. `400 invalid_signature` means "go back to Element and
     start again".
   - `oauth_query` reaches the provider through the existing JSON sign-in route
     (`JSON.stringify(req.body)`), so `/api/auth/sign-in/email` must stay in that
     allowlist.
   - nginx `location /api/` must keep proxying `/api/auth/.well-known/...` (no dotfile
     deny rule ahead of it).
10. **Synapse settings** (bootstrap.py): `client_auth_method: client_secret_basic`,
    `pkce_method: always`, `scopes: [openid, profile]`, `user_profile_method: auto`
    (`af_localpart` is in both the id_token and userinfo),
    `localpart_template: {{ user.af_localpart }}`, `confirm_localpart: false`. Put the
    Element origin in `SYNAPSE_SSO_CLIENT_WHITELIST` to skip Synapse's "continue to …?"
    page.
11. **Rate limits.** Better Auth uses 30 requests/60 s per IP+path in production. All
    token calls come from Synapse's single IP, so that means at most about 30 SSO
    completions per minute in total. This is fine at family scale; raise it with
    `rateLimit.customRules` if needed.
12. **Migrations.** `getMigrations(auth.options)` only adds tables (`jwks`,
    `oauthClient`, OAuth token/consent tables) and leaves existing ones alone. Back up
    the DB before enabling for the first time.

## Test coverage (`tests/unified-auth.test.ts`)

Each test drives a real Better Auth instance on a temporary SQLite file through a
Fastify app. The app mirrors the app.ts Origin hook and the `/api/auth/*` route; if
those change in app.ts, update the mirror. Covered:

- Fail-closed configuration.
- Idempotent client persistence and drift refusal.
- Discovery restricted to allowlisted endpoints; stable RS256 JWKS.
- Blocked registration, consent and extra endpoints.
- authorize without a session → signed login page.
- Signed sign-in continuation → PKCE code → token → verified id_token and userinfo with
  `sub` and `af_localpart`. Code replay is rejected.
- Tampered or unsigned `oauth_query` → 400 with no session.
- Rejection of a wrong verifier, a wrong redirect_uri, a missing PKCE challenge, bad
  client authentication, forged bearer tokens, a foreign redirect_uri or client at
  authorize, and a non-form token body.
- Normal Origin CSRF (app hook and Better Auth's own checks); token POST exempt.
- Restart with a new auth instance: same client row, same `kid`, same `sub`, same
  `af_localpart`, even after an email change.
- Restart with a wrong secret fails without modifying the row.
- A `matrix_accounts` mismatch refuses issuance and keeps the original row.

Run: `npx vitest run tests/unified-auth.test.ts`.
