/**
 * Unified login (AF as OIDC provider for Synapse) — runtime tests against the
 * official Better Auth OAuth Provider + JWT plugins on a SEPARATE temp SQLite
 * database. No production secrets, .env values, data/ or network access: all
 * secrets below are generated per run and every request is in-process.
 */
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";
vi.hoisted(() => {
  // server/matrix-account -> server/db -> server/config: keep them on a temp dir.
  process.env.DATA_DIR = `${process.env.TEMP || "/tmp"}/agent-family-unified-${process.pid}-${Date.now()}`;
  process.env.CANAL_KEY_FILE = `${process.env.DATA_DIR}/no-key.txt`;
  process.env.CANAL_API_KEY = "";
  process.env.APP_URL = "http://localhost:4317";
  process.env.TEST_MODE = "true";
});
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import Database from "better-sqlite3";
import Fastify, { type FastifyInstance } from "fastify";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import {
  ensureTrustedClient,
  handleUnifiedAuthRequest,
  isAllowedRedirect,
  loadUnifiedAuthSettings,
  matrixIdentityClaims,
  registerUnifiedAuthBodyParser,
  sqliteMatrixLookup,
  unifiedAuthPaths,
  unifiedAuthPlugins,
  unifiedAuthRoute,
  UnifiedAuthConfigError,
  type UnifiedAuthSettings,
} from "../server/unified-auth";
import { matrixLocalpart } from "../server/matrix-account";

const ORIGIN = "https://chat.example.test";
const HS = "https://matrix.example.test";
const SERVER = "example.test";
const CLIENT_ID = "agent-family-synapse";
const CLIENT_SECRET = `test-only-${crypto.randomBytes(24).toString("hex")}`;
const AUTH_SECRET = crypto.randomBytes(48).toString("base64url");
const PASSWORD = "Test-password-123!";
const REDIRECT = `${HS}/_synapse/client/oidc/callback`;
const ENV = {
  AF_UNIFIED_LOGIN: "true",
  AF_OIDC_CLIENT_ID: CLIENT_ID,
  AF_OIDC_CLIENT_SECRET: CLIENT_SECRET,
  MATRIX_HOMESERVER_URL: HS,
  MATRIX_SERVER_NAME: SERVER,
  NODE_ENV: "test",
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "af-unified-auth-"));
const database = new Database(path.join(dir, "unified-auth.sqlite"));
const settings = loadUnifiedAuthSettings(ENV, ORIGIN) as UnifiedAuthSettings;
const makeAuth = () =>
  betterAuth({
    database,
    baseURL: ORIGIN,
    secret: AUTH_SECRET,
    trustedOrigins: [ORIGIN],
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 10,
      maxPasswordLength: 128,
    },
    advanced: {
      cookiePrefix: "agent-family",
      useSecureCookies: true,
      ipAddress: { ipAddressHeaders: ["x-af-client-ip"] },
      // Better Auth disables origin/CSRF checks when NODE_ENV=test; force the
      // production behaviour so these tests exercise the real checks.
      disableOriginCheck: false,
    },
    rateLimit: { enabled: false },
    plugins: unifiedAuthPlugins(settings, sqliteMatrixLookup(database)),
  });
type Auth = ReturnType<typeof makeAuth>;
const auth = makeAuth();
let app: FastifyInstance;

/** Mirrors app.ts: onRequest CSRF hook + /api/auth/* route after integration (see docs). */
function buildApp(instance: Auth = auth) {
  const server = Fastify();
  registerUnifiedAuthBodyParser(server);
  server.addHook("onRequest", async (req, reply) => {
    if (
      ["POST", "PUT", "PATCH", "DELETE"].includes(req.method) &&
      unifiedAuthRoute(req.method, req.url)?.kind !== "client"
    ) {
      if (req.headers.origin !== ORIGIN)
        return reply.code(403).send({ error: "untrusted origin" });
    }
  });
  server.route({
    method: ["GET", "POST"],
    url: "/api/auth/*",
    handler: async (req, reply) => {
      if (unifiedAuthRoute(req.method, req.url))
        return handleUnifiedAuthRequest(instance.handler, req, reply, settings);
      if (req.url.split("?")[0] !== "/api/auth/sign-in/email")
        return reply.code(404).send({ error: "此登录操作未开放。" });
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers))
        if (
          v !== undefined &&
          !["content-length", "x-af-client-ip"].includes(k)
        )
          headers.set(k, Array.isArray(v) ? v.join(",") : v);
      headers.set("x-af-client-ip", req.ip);
      const response = await instance.handler(
        new Request(new URL(req.url, ORIGIN), {
          method: req.method,
          headers,
          body: JSON.stringify(req.body || {}),
        }),
      );
      reply.code(response.status);
      response.headers.forEach((value, key) => {
        if (key !== "set-cookie" && key !== "content-length")
          reply.header(key, value);
      });
      const cookies = response.headers.getSetCookie();
      if (cookies.length) reply.header("set-cookie", cookies);
      return reply.send(await response.text());
    },
  });
  return server;
}

const b64json = (part: string) =>
  JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
const pkce = () => {
  const verifier = crypto.randomBytes(32).toString("base64url");
  return {
    verifier,
    challenge: crypto.createHash("sha256").update(verifier).digest("base64url"),
  };
};
const authorizePath = (overrides: Record<string, string> = {}) =>
  `/api/auth/oauth2/authorize?${new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT,
    scope: "openid profile",
    state: "state-123",
    nonce: "nonce-456",
    code_challenge_method: "S256",
    code_challenge: "x".repeat(43),
    ...overrides,
  })}`;
const basic = (id = CLIENT_ID, secret = CLIENT_SECRET) =>
  `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;
const cookieHeader = (setCookie: string | string[] | undefined) =>
  ([] as string[])
    .concat(setCookie ?? [])
    .map((c) => c.split(";")[0])
    .join("; ");
function redirectTarget(res: {
  statusCode: number;
  headers: any;
  body: string;
}) {
  if (res.headers.location) return String(res.headers.location);
  try {
    const data = JSON.parse(res.body);
    if (typeof data?.url === "string") return data.url as string;
  } catch {}
  return "";
}
async function signUp(email: string) {
  const result = await auth.api.signUpEmail({
    body: { name: "Test User", email, password: PASSWORD },
  });
  return result.user;
}
async function signIn(
  email: string,
  extra: Record<string, string> = {},
  server: FastifyInstance = app,
  origin = ORIGIN,
) {
  return server.inject({
    method: "POST",
    url: "/api/auth/sign-in/email",
    headers: { origin, "content-type": "application/json" },
    payload: { email, password: PASSWORD, ...extra },
  });
}
async function exchange(
  code: string,
  verifier: string,
  authorization = basic(),
  server: FastifyInstance = app,
  redirectUri = REDIRECT,
) {
  return server.inject({
    method: "POST",
    url: "/api/auth/oauth2/token",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization,
    },
    payload: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }).toString(),
  });
}
/** authorize without a session -> AF login page URL carrying the provider-signed query. */
async function loginPage(challenge: string, server: FastifyInstance = app) {
  const start = await server.inject({
    method: "GET",
    url: authorizePath({ code_challenge: challenge }),
    headers: { accept: "text/html", "sec-fetch-mode": "navigate" },
  });
  const login = new URL(redirectTarget(start), `${ORIGIN}/`);
  expect(login.origin).toBe(ORIGIN);
  expect(login.pathname).toBe("/af-login.html");
  expect(login.searchParams.get("sig")).toBeTruthy();
  return login;
}
/** Full browser leg: authorize (no session) -> AF login page -> sign-in with oauth_query -> code. */
async function loginForCode(email: string, server: FastifyInstance = app) {
  const { verifier, challenge } = pkce();
  const login = await loginPage(challenge, server);
  // Same thing oauthProviderClient sends: the signed query of the login page.
  const res = await signIn(
    email,
    { oauth_query: login.search.slice(1) },
    server,
  );
  expect(res.statusCode).toBe(200);
  const callback = new URL(redirectTarget(res));
  expect(`${callback.origin}${callback.pathname}`).toBe(REDIRECT);
  expect(callback.searchParams.get("state")).toBe("state-123");
  const code = callback.searchParams.get("code");
  expect(code).toBeTruthy();
  return { code: code as string, verifier };
}
/** Login + token exchange; returns decoded id_token header/claims and the raw token response. */
async function idTokenFor(email: string, server: FastifyInstance = app) {
  const { code, verifier } = await loginForCode(email, server);
  const res = await exchange(code, verifier, basic(), server);
  expect(res.statusCode).toBe(200);
  const tokens = JSON.parse(res.body);
  const [h, p] = String(tokens.id_token).split(".");
  return { header: b64json(h), claims: b64json(p), tokens };
}

beforeAll(async () => {
  await (await getMigrations(auth.options)).runMigrations();
  database.exec(
    "CREATE TABLE IF NOT EXISTS matrix_accounts(user_id TEXT PRIMARY KEY,matrix_id TEXT UNIQUE NOT NULL,created_at TEXT NOT NULL)",
  );
  expect(await ensureTrustedClient(auth, settings)).toEqual({ created: true });
  app = buildApp();
  await app.ready();
});
afterAll(async () => {
  await app?.close();
  database.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("configuration (fail closed)", () => {
  it("is disabled unless AF_UNIFIED_LOGIN is exactly true", () => {
    expect(loadUnifiedAuthSettings({}, ORIGIN)).toBeNull();
    expect(
      loadUnifiedAuthSettings({ ...ENV, AF_UNIFIED_LOGIN: "1" }, ORIGIN),
    ).toBeNull();
  });
  it("derives issuer and the exact Synapse callback", () => {
    expect(settings.issuer).toBe(`${ORIGIN}/api/auth`);
    expect(settings.redirectUri).toBe(REDIRECT);
    expect(
      loadUnifiedAuthSettings(
        { ...ENV, MATRIX_HOMESERVER_URL: `${HS}/` },
        ORIGIN,
      )?.redirectUri,
    ).toBe(REDIRECT);
  });
  it("rejects insecure or incomplete configuration without echoing secrets", () => {
    const bad: Record<string, string>[] = [
      { MATRIX_HOMESERVER_URL: "http://matrix.example.test" },
      { MATRIX_HOMESERVER_URL: `${HS}/?x=1` },
      { MATRIX_HOMESERVER_URL: "https://user:pw@matrix.example.test" },
      { AF_OIDC_CLIENT_SECRET: "short" },
      { AF_OIDC_CLIENT_SECRET: "a+/=".repeat(10) }, // would not survive authlib's percent-encoding
      { AF_OIDC_CLIENT_ID: "x" },
      { MATRIX_SERVER_NAME: "" },
    ];
    for (const patch of bad) {
      let error: unknown;
      try {
        loadUnifiedAuthSettings({ ...ENV, ...patch }, ORIGIN);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(UnifiedAuthConfigError);
      expect(String((error as Error).message)).not.toContain(CLIENT_SECRET);
    }
    expect(() =>
      loadUnifiedAuthSettings(
        { ...ENV, NODE_ENV: "production" },
        "http://localhost:4317",
      ),
    ).toThrow(UnifiedAuthConfigError);
  });
});

describe("trusted client persistence", () => {
  it("is idempotent", async () => {
    expect(await ensureTrustedClient(auth, settings)).toEqual({
      created: false,
    });
    const rows = database
      .prepare("SELECT COUNT(*) AS n FROM oauthClient")
      .get() as { n: number };
    expect(rows.n).toBe(1);
    const row = database
      .prepare("SELECT clientSecret FROM oauthClient WHERE clientId=?")
      .get(CLIENT_ID) as { clientSecret: string };
    expect(row.clientSecret).not.toContain(CLIENT_SECRET); // stored hashed only
  });
  it("refuses to start when the persisted client drifts from configuration", async () => {
    const other = `test-only-${crypto.randomBytes(24).toString("hex")}`;
    await expect(
      ensureTrustedClient(auth, { ...settings, clientSecret: other }),
    ).rejects.toThrow(/clientSecret/);
    await expect(
      ensureTrustedClient(auth, {
        ...settings,
        redirectUri: "https://evil.example/_synapse/client/oidc/callback",
      }),
    ).rejects.toThrow(/redirectUris/);
  });
});

describe("public surface", () => {
  it("serves discovery whose endpoints are exactly the allowlisted ones", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/auth/.well-known/openid-configuration",
    });
    expect(res.statusCode).toBe(200);
    const meta = JSON.parse(res.body);
    expect(meta.issuer).toBe(settings.issuer);
    expect(meta.id_token_signing_alg_values_supported).toContain("RS256");
    for (const endpoint of [
      meta.authorization_endpoint,
      meta.token_endpoint,
      meta.userinfo_endpoint,
      meta.jwks_uri,
    ]) {
      const url = new URL(endpoint);
      expect(url.origin).toBe(ORIGIN);
      expect(unifiedAuthPaths()).toContain(url.pathname);
    }
  });
  it("keeps signing keys stable across auth instances (persisted jwks)", async () => {
    const first = JSON.parse(
      (await app.inject({ method: "GET", url: "/api/auth/jwks" })).body,
    );
    const again = await makeAuth().handler(
      new Request(`${ORIGIN}/api/auth/jwks`),
    );
    const second = await again.json();
    expect(first.keys.length).toBeGreaterThan(0);
    expect(first.keys[0].kty).toBe("RSA");
    expect(first.keys[0].d).toBeUndefined();
    expect(second.keys.map((k: any) => k.kid)).toEqual(
      first.keys.map((k: any) => k.kid),
    );
  });
  it("does not expose registration, consent, session JWT or other OAuth paths", async () => {
    const blocked: [string, string][] = [
      ["POST", "/api/auth/oauth2/register"],
      ["POST", "/api/auth/oauth2/create-client"],
      ["POST", "/api/auth/oauth2/consent"],
      ["POST", "/api/auth/oauth2/continue"],
      ["POST", "/api/auth/oauth2/introspect"],
      ["POST", "/api/auth/oauth2/authorize"],
      ["GET", "/api/auth/oauth2/authorize/"],
      ["GET", "/api/auth/oauth2/end-session"],
      ["GET", "/api/auth/token"],
      ["POST", "/api/auth/sign-up/email"],
    ];
    for (const [method, url] of blocked) {
      const res = await app.inject({
        method: method as "GET" | "POST",
        url,
        headers: { origin: ORIGIN, "content-type": "application/json" },
        ...(method === "POST"
          ? { payload: { redirect_uris: ["https://evil.example/cb"] } }
          : {}),
      });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    }
  });
  it("provider itself rejects dynamic registration even if reached directly", async () => {
    const res = await auth.handler(
      new Request(`${ORIGIN}/api/auth/oauth2/register`, {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({
          redirect_uris: ["https://evil.example/cb"],
          token_endpoint_auth_method: "none",
        }),
      }),
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    const rows = database
      .prepare("SELECT COUNT(*) AS n FROM oauthClient")
      .get() as { n: number };
    expect(rows.n).toBe(1);
  });
  it("accepts form bodies only on the token endpoint", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: {
        origin: ORIGIN,
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: "email=a%40b.c&password=x",
    });
    expect(res.statusCode).toBe(415);
  });
});

describe("authorization endpoint", () => {
  it("sends unauthenticated users to the AF login page with a signed query", async () => {
    const res = await app.inject({
      method: "GET",
      url: authorizePath(),
      headers: { accept: "text/html", "sec-fetch-mode": "navigate" },
    });
    const target = new URL(redirectTarget(res), `${ORIGIN}/`);
    expect(target.origin).toBe(ORIGIN);
    expect(target.pathname).toBe("/af-login.html");
    expect(target.searchParams.get("sig")).toBeTruthy();
    expect(res.headers["set-cookie"]).toBeUndefined();
  });
  it("rejects foreign redirect_uri and unknown clients without redirecting", async () => {
    for (const overrides of [
      { redirect_uri: "https://evil.example/_synapse/client/oidc/callback" },
      { redirect_uri: `${REDIRECT}/../../evil` },
      { client_id: "someone-else-client" },
    ] as Record<string, string>[]) {
      const res = await app.inject({
        method: "GET",
        url: authorizePath(overrides),
      });
      expect(res.statusCode).toBe(400);
      expect(res.headers.location).toBeUndefined();
    }
  });
  it("provider itself never redirects to an unregistered URI (defense in depth)", async () => {
    const res = await auth.handler(
      new Request(
        `${ORIGIN}${authorizePath({ redirect_uri: "https://evil.example/cb" })}`,
        {
          headers: { accept: "text/html" },
        },
      ),
    );
    expect(res.headers.get("location") || "").not.toMatch(
      /^https:\/\/evil\.example/,
    );
  });
  it("redirect guard only allows the login page and the exact callback", () => {
    expect(isAllowedRedirect("/af-login.html?sig=1", settings)).toBe(true);
    expect(isAllowedRedirect(`${REDIRECT}?code=1`, settings)).toBe(true);
    expect(isAllowedRedirect("//evil.example/af-login.html", settings)).toBe(
      false,
    );
    expect(isAllowedRedirect(`${HS}/other`, settings)).toBe(false);
    expect(isAllowedRedirect("/", settings)).toBe(false);
  });
});

describe("end-to-end code flow for the trusted client", () => {
  it("issues an RS256 id_token mapping the immutable AF id to the deterministic Matrix localpart", async () => {
    const user = await signUp("alice@example.test");
    const localpart = matrixLocalpart(user.id);
    // An existing matrix_accounts entry that matches the deterministic mapping is accepted.
    database
      .prepare("INSERT INTO matrix_accounts VALUES(?,?,?)")
      .run(user.id, `@${localpart}:${SERVER}`, new Date().toISOString());
    const { code, verifier } = await loginForCode("alice@example.test");
    const res = await exchange(code, verifier);
    expect(res.statusCode).toBe(200);
    expect(res.headers["set-cookie"]).toBeUndefined();
    const tokens = JSON.parse(res.body);
    const [h, p, s] = String(tokens.id_token).split(".");
    const header = b64json(h);
    const claims = b64json(p);
    expect(header.alg).toBe("RS256");
    const jwks = JSON.parse(
      (await app.inject({ method: "GET", url: "/api/auth/jwks" })).body,
    );
    const jwk = jwks.keys.find((k: any) => k.kid === header.kid);
    expect(
      crypto.verify(
        "sha256",
        Buffer.from(`${h}.${p}`),
        crypto.createPublicKey({ key: jwk, format: "jwk" }),
        Buffer.from(s, "base64url"),
      ),
    ).toBe(true);
    expect(claims.iss).toBe(settings.issuer);
    expect(([] as unknown[]).concat(claims.aud)).toContain(CLIENT_ID);
    expect(claims.sub).toBe(user.id);
    expect(claims.nonce).toBe("nonce-456");
    expect(claims.af_localpart).toBe(localpart);
    expect(claims.email).toBeUndefined();

    const info = await app.inject({
      method: "GET",
      url: "/api/auth/oauth2/userinfo",
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    expect(info.statusCode).toBe(200);
    const profile = JSON.parse(info.body);
    expect(profile.sub).toBe(user.id);
    expect(profile.af_localpart).toBe(localpart);
    expect(profile.name).toBe(user.name);
    expect(profile.email).toBeUndefined();

    const replay = await exchange(code, verifier);
    expect(replay.statusCode).toBeGreaterThanOrEqual(400);
    expect(JSON.parse(replay.body).access_token).toBeUndefined();
  });
  it("skips consent for an already signed-in user and returns to the exact callback", async () => {
    await signUp("bob@example.test");
    const cookie = cookieHeader(
      (await signIn("bob@example.test")).headers["set-cookie"],
    );
    expect(cookie).toContain("session_token");
    const { challenge } = pkce();
    const res = await app.inject({
      method: "GET",
      url: authorizePath({ code_challenge: challenge }),
      headers: { cookie, accept: "text/html", "sec-fetch-mode": "navigate" },
    });
    const target = new URL(redirectTarget(res));
    expect(`${target.origin}${target.pathname}`).toBe(REDIRECT);
    expect(target.searchParams.get("code")).toBeTruthy();
  });
  it("refuses to issue an identity when matrix_accounts disagrees with the deterministic mapping", async () => {
    const user = await signUp("carol@example.test");
    database
      .prepare("INSERT INTO matrix_accounts VALUES(?,?,?)")
      .run(user.id, `@someone_else:${SERVER}`, new Date().toISOString());
    const { code, verifier } = await loginForCode("carol@example.test");
    const res = await exchange(code, verifier);
    expect(res.statusCode).not.toBe(200);
    expect(JSON.parse(res.body).id_token).toBeUndefined();
    // The original Matrix ID is never rewritten by the login flow.
    const row = database
      .prepare("SELECT matrix_id AS m FROM matrix_accounts WHERE user_id=?")
      .get(user.id) as { m: string };
    expect(row.m).toBe(`@someone_else:${SERVER}`);
  });
  it("rejects bad client authentication and malformed token requests", async () => {
    await signUp("dave@example.test");
    const { code, verifier } = await loginForCode("dave@example.test");
    const wrong = await exchange(
      code,
      verifier,
      basic(CLIENT_ID, `test-only-${"0".repeat(40)}`),
    );
    expect(wrong.statusCode).toBe(401);
    expect(JSON.parse(wrong.body).access_token).toBeUndefined();
    const anonymous = await app.inject({
      method: "POST",
      url: "/api/auth/oauth2/token",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: "a=b",
      },
      payload: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT,
        code_verifier: verifier,
      }).toString(),
    });
    expect(anonymous.statusCode).toBe(401);
    const json = await app.inject({
      method: "POST",
      url: "/api/auth/oauth2/token",
      headers: { "content-type": "application/json", authorization: basic() },
      payload: { grant_type: "authorization_code", code },
    });
    expect(json.statusCode).toBe(415);
    const noBearer = await app.inject({
      method: "GET",
      url: "/api/auth/oauth2/userinfo",
    });
    expect(noBearer.statusCode).toBe(401);
  });
});

describe("CSRF and signed sign-in continuation", () => {
  it("keeps normal origin CSRF on browser routes; only the token POST is exempt", async () => {
    await signUp("erin@example.test");
    // App-level hook (mirror of app.ts): foreign or missing Origin on sign-in is refused.
    expect(
      (await signIn("erin@example.test", {}, app, "https://evil.example"))
        .statusCode,
    ).toBe(403);
    const noOrigin = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { "content-type": "application/json" },
      payload: { email: "erin@example.test", password: PASSWORD },
    });
    expect(noOrigin.statusCode).toBe(403);
    // Better Auth's own checks behind the hook (production default) also hold.
    const signInDirect = (headers: Record<string, string>) =>
      auth.handler(
        new Request(`${ORIGIN}/api/auth/sign-in/email`, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify({
            email: "erin@example.test",
            password: PASSWORD,
          }),
        }),
      );
    const withCookie = await signInDirect({
      origin: "https://evil.example",
      cookie: "agent-family.session_token=x",
    });
    expect(withCookie.status).toBe(403);
    expect(withCookie.headers.getSetCookie()).toEqual([]);
    const crossSite = await signInDirect({
      "sec-fetch-site": "cross-site",
      "sec-fetch-mode": "navigate",
    });
    expect(crossSite.status).toBe(403);
    // The server-to-server token POST (no Origin, no cookies) reaches the provider.
    const token = await exchange("not-a-real-code", pkce().verifier);
    expect(token.statusCode).not.toBe(403);
    expect(token.statusCode).toBeGreaterThanOrEqual(400);
    expect(JSON.parse(token.body).access_token).toBeUndefined();
  });
  it("rejects a tampered or unsigned oauth_query and creates no session", async () => {
    await signUp("gina@example.test");
    const login = await loginPage(pkce().challenge);
    const tampered: string[] = [];
    for (const [key, value] of [
      ["redirect_uri", "https://evil.example/cb"],
      ["client_id", "someone-else-client"],
      ["scope", "openid profile email offline_access"],
    ] as const) {
      const params = new URLSearchParams(login.search);
      params.set(key, value);
      tampered.push(params.toString());
    }
    const unsigned = new URLSearchParams(login.search);
    unsigned.delete("sig");
    tampered.push(unsigned.toString());
    for (const oauth_query of tampered) {
      const res = await signIn("gina@example.test", { oauth_query });
      expect(res.statusCode, oauth_query).toBe(400);
      expect(res.headers["set-cookie"]).toBeUndefined();
      expect(redirectTarget(res)).toBe("");
    }
  });
});

describe("PKCE, token and bearer rejection", () => {
  it("rejects a wrong code_verifier and a mismatched redirect_uri at the token endpoint", async () => {
    await signUp("hana@example.test");
    const first = await loginForCode("hana@example.test");
    const wrongVerifier = await exchange(first.code, pkce().verifier);
    expect(wrongVerifier.statusCode).toBeGreaterThanOrEqual(400);
    expect(JSON.parse(wrongVerifier.body).access_token).toBeUndefined();
    const second = await loginForCode("hana@example.test");
    const wrongRedirect = await exchange(
      second.code,
      second.verifier,
      basic(),
      app,
      "https://evil.example/_synapse/client/oidc/callback",
    );
    expect(wrongRedirect.statusCode).toBeGreaterThanOrEqual(400);
    expect(JSON.parse(wrongRedirect.body).access_token).toBeUndefined();
  });
  it("never issues a code without PKCE", async () => {
    const cookie = cookieHeader(
      (await signIn("hana@example.test")).headers["set-cookie"],
    );
    const url = new URL(authorizePath(), ORIGIN);
    url.searchParams.delete("code_challenge");
    url.searchParams.delete("code_challenge_method");
    const res = await app.inject({
      method: "GET",
      url: `${url.pathname}${url.search}`,
      headers: { cookie, accept: "text/html", "sec-fetch-mode": "navigate" },
    });
    const target = redirectTarget(res);
    if (target)
      expect(new URL(target, `${ORIGIN}/`).searchParams.get("code")).toBeNull();
    else expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });
  it("rejects forged bearer tokens at userinfo", async () => {
    for (const token of [
      "not-a-real-token",
      `${"a".repeat(20)}.${"b".repeat(20)}.${"c".repeat(20)}`,
    ]) {
      const res = await app.inject({
        method: "GET",
        url: "/api/auth/oauth2/userinfo",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode, token).toBeGreaterThanOrEqual(400);
      expect(res.body).not.toMatch(/af_localpart|"sub"/);
    }
  });
});

describe("restart: persisted client, keys and identity", () => {
  it("keeps client, signing key, sub and af_localpart across restart and email change", async () => {
    const user = await signUp("frank@example.test");
    const before = await idTokenFor("frank@example.test");
    const clientRow = () =>
      database
        .prepare("SELECT clientId, clientSecret, redirectUris FROM oauthClient")
        .all();
    const rowsBefore = clientRow();

    // Email is not part of the identity: change it, then "restart" (new auth + app on same DB).
    database
      .prepare('UPDATE "user" SET email=? WHERE id=?')
      .run("frank.new@example.test", user.id);
    const restarted = makeAuth();
    expect(await ensureTrustedClient(restarted, settings)).toEqual({
      created: false,
    });
    expect(clientRow()).toEqual(rowsBefore);
    const restartedApp = buildApp(restarted);
    await restartedApp.ready();
    try {
      const after = await idTokenFor("frank.new@example.test", restartedApp);
      expect(after.header.kid).toBe(before.header.kid);
      expect(after.claims.sub).toBe(user.id);
      expect(before.claims.sub).toBe(user.id);
      expect(after.claims.af_localpart).toBe(matrixLocalpart(user.id));
      expect(after.claims.af_localpart).toBe(before.claims.af_localpart);
      const info = await restartedApp.inject({
        method: "GET",
        url: "/api/auth/oauth2/userinfo",
        headers: { authorization: `Bearer ${after.tokens.access_token}` },
      });
      expect(JSON.parse(info.body).af_localpart).toBe(
        before.claims.af_localpart,
      );
    } finally {
      await restartedApp.close();
    }
    // The OIDC flow never creates or changes matrix_accounts rows.
    const rows = database
      .prepare("SELECT COUNT(*) AS n FROM matrix_accounts WHERE user_id=?")
      .get(user.id) as { n: number };
    expect(rows.n).toBe(0);
  });
  it("a restart with a different secret fails closed instead of rewriting the client", async () => {
    const restarted = makeAuth();
    const snapshot = () => database.prepare("SELECT * FROM oauthClient").all();
    const before = snapshot();
    await expect(
      ensureTrustedClient(restarted, {
        ...settings,
        clientSecret: `test-only-${crypto.randomBytes(24).toString("hex")}`,
      }),
    ).rejects.toThrow(UnifiedAuthConfigError);
    expect(snapshot()).toEqual(before);
    // The original secret still validates; the old client keeps working.
    expect(await ensureTrustedClient(restarted, settings)).toEqual({
      created: false,
    });
  });
});

describe("identity mapping helper", () => {
  it("is deterministic and never consults email", () => {
    expect(matrixIdentityClaims("user-1", SERVER, null)).toEqual({
      af_localpart: matrixLocalpart("user-1"),
    });
    expect(() =>
      matrixIdentityClaims("user-1", SERVER, `@af_other:${SERVER}`),
    ).toThrow();
    expect(() => matrixIdentityClaims("", SERVER, null)).toThrow();
  });
});
