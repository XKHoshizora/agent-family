/**
 * Unified login: Agent Family acts as the OIDC provider for Synapse, using the
 * OFFICIAL Better Auth plugins (`@better-auth/oauth-provider` + `better-auth`
 * `jwt`). Nothing here implements OAuth/OIDC protocol logic itself; this module
 * only (1) configures the plugins, (2) persists exactly one trusted first-party
 * client through the plugin's own schema/adapter, (3) exposes a strict
 * allowlisted forwarder for the parent's existing `/api/auth/*` Fastify route.
 *
 * Disabled unless AF_UNIFIED_LOGIN=true. When enabled, invalid configuration
 * throws at startup (fail closed) instead of silently degrading.
 *
 * This file deliberately does NOT import ./config or ./auth, so it can be
 * exercised against a throwaway database in tests.
 */
import crypto from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { BetterAuthPlugin } from "better-auth";
import { APIError } from "better-auth/api";
import { jwt } from "better-auth/plugins";
import { oauthProvider } from "@better-auth/oauth-provider";
import { matrixLocalpart } from "./matrix-account";

export const UNIFIED_LOGIN_PAGE = "/af-login.html";
export const OIDC_PROVIDER_SCOPES = ["openid", "profile"] as const;
/** Claim Synapse's `localpart_template` reads. Derived ONLY from the immutable AF user id. */
export const MATRIX_LOCALPART_CLAIM = "af_localpart";
const AUTH_BASE_PATH = "/api/auth";
const TOKEN_PATH = `${AUTH_BASE_PATH}/oauth2/token`;
const OAUTH_CLIENT_MODEL = "oauthClient";

export type UnifiedAuthSettings = {
  /** AF public origin (Element public origin when /api/ is proxied). */
  origin: string;
  /** `${origin}/api/auth` — must equal Synapse `oidc_providers[].issuer`. */
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** `${MATRIX_HOMESERVER_URL}/_synapse/client/oidc/callback` */
  redirectUri: string;
  matrixServerName: string;
  loginPage: string;
};
/** Returns the stored Matrix ID for an AF user (matrix_accounts), or null if none. */
export type MatrixAccountLookup = (
  userId: string,
) => string | null | undefined | Promise<string | null | undefined>;

export class UnifiedAuthConfigError extends Error {
  constructor(message: string) {
    super(`Unified login configuration invalid: ${message}`);
    this.name = "UnifiedAuthConfigError";
  }
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
function parseHttpsUrl(
  name: string,
  value: string | undefined,
  production: boolean,
): URL {
  if (!value) throw new UnifiedAuthConfigError(`${name} is required`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UnifiedAuthConfigError(`${name} is not a valid URL`);
  }
  const insecureLoopback =
    url.protocol === "http:" && !production && LOOPBACK.has(url.hostname);
  if (url.protocol !== "https:" && !insecureLoopback)
    throw new UnifiedAuthConfigError(`${name} must use https`);
  if (url.username || url.password || url.search || url.hash)
    throw new UnifiedAuthConfigError(
      `${name} must not contain credentials, query or fragment`,
    );
  return url;
}

/**
 * Reads unified-login settings from the environment. Returns null when
 * AF_UNIFIED_LOGIN is not exactly "true". Never logs or echoes secret values.
 */
export function loadUnifiedAuthSettings(
  env: Record<string, string | undefined>,
  appOrigin: string,
): UnifiedAuthSettings | null {
  if (env.AF_UNIFIED_LOGIN !== "true") return null;
  const production = env.NODE_ENV === "production";
  const origin = parseHttpsUrl("APP_URL", appOrigin, production);
  if (origin.pathname !== "/")
    throw new UnifiedAuthConfigError("APP_URL must be a bare origin");
  const clientId = env.AF_OIDC_CLIENT_ID || "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(clientId))
    throw new UnifiedAuthConfigError(
      "AF_OIDC_CLIENT_ID must be 8-128 characters of [A-Za-z0-9._-]",
    );
  const clientSecret = env.AF_OIDC_CLIENT_SECRET || "";
  // Unreserved characters only: Synapse (authlib) percent-encodes id/secret
  // inside client_secret_basic, so anything else would not round-trip.
  if (
    !/^[A-Za-z0-9._~-]{32,256}$/.test(clientSecret) ||
    clientSecret === clientId
  )
    throw new UnifiedAuthConfigError(
      "AF_OIDC_CLIENT_SECRET must be 32-256 characters of [A-Za-z0-9._~-]",
    );
  const homeserver = parseHttpsUrl(
    "MATRIX_HOMESERVER_URL",
    env.MATRIX_HOMESERVER_URL,
    production,
  );
  const matrixServerName = env.MATRIX_SERVER_NAME || "";
  if (!/^[A-Za-z0-9.-]+(:[0-9]{1,5})?$/.test(matrixServerName))
    throw new UnifiedAuthConfigError("MATRIX_SERVER_NAME is required");
  const base = `${homeserver.origin}${homeserver.pathname.replace(/\/+$/, "")}`;
  return {
    origin: origin.origin,
    issuer: `${origin.origin}${AUTH_BASE_PATH}`,
    clientId,
    clientSecret,
    redirectUri: `${base}/_synapse/client/oidc/callback`,
    matrixServerName,
    loginPage: UNIFIED_LOGIN_PAGE,
  };
}

/**
 * Deterministic AF→Matrix identity. The localpart is a hash of the immutable AF
 * user id (same function used for shared-secret provisioning). If the user
 * already has a matrix_accounts row it MUST equal the deterministic ID,
 * otherwise no identity is issued (fail closed). Email is never consulted.
 */
export function matrixIdentityClaims(
  userId: unknown,
  serverName: string,
  existingMatrixId: string | null | undefined,
) {
  if (typeof userId !== "string" || !userId)
    throw new APIError("FORBIDDEN", {
      error: "access_denied",
      error_description: "missing account identity",
    });
  const localpart = matrixLocalpart(userId);
  if (
    existingMatrixId !== null &&
    existingMatrixId !== undefined &&
    existingMatrixId !== `@${localpart}:${serverName}`
  )
    throw new APIError("FORBIDDEN", {
      error: "access_denied",
      error_description:
        "this account's chat identity does not match; contact the administrator",
    });
  return { [MATRIX_LOCALPART_CLAIM]: localpart };
}

/** Lookup against the existing `matrix_accounts` table (absent table ⇒ no row). */
export function sqliteMatrixLookup(database: {
  prepare(sql: string): { get(...params: unknown[]): unknown };
}): MatrixAccountLookup {
  return (userId) => {
    const table = database
      .prepare(
        "SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='matrix_accounts'",
      )
      .get();
    if (!table) return null;
    const row = database
      .prepare(
        "SELECT matrix_id AS matrixId FROM matrix_accounts WHERE user_id=?",
      )
      .get(userId) as { matrixId?: string } | undefined;
    return row?.matrixId ?? null;
  };
}

/** Same encoding as the plugin's default "hashed" store (SHA-256, base64url, unpadded). */
export function hashClientSecret(secret: string) {
  return crypto.createHash("sha256").update(secret, "utf8").digest("base64url");
}
function verifyClientSecret(secret: string, stored: string) {
  const a = Buffer.from(hashClientSecret(secret));
  const b = Buffer.from(String(stored));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const refuseGeneration = (): string => {
  throw new APIError("FORBIDDEN", {
    error: "registration_not_supported",
    error_description: "client registration is disabled",
  });
};

/**
 * Plugins to add to `betterAuth({ plugins })`. JWT signing keys (RS256 for
 * Synapse/authlib compatibility) are stored by the official jwt plugin in its
 * `jwks` table, private keys encrypted with the Better Auth secret, so they are
 * stable across restarts as long as AUTH_SECRET is. Tables are created by the
 * existing `getMigrations(auth.options)` call.
 */
export function unifiedAuthPlugins(
  settings: UnifiedAuthSettings,
  lookupMatrixId: MatrixAccountLookup,
): BetterAuthPlugin[] {
  const claims = async ({
    user,
    scopes,
  }: {
    user: { id: string; name?: string };
    scopes: string[];
  }) => ({
    ...matrixIdentityClaims(
      user.id,
      settings.matrixServerName,
      await lookupMatrixId(user.id),
    ),
    ...(scopes.includes("profile") && user.name ? { name: user.name } : {}),
  });
  return [
    jwt({
      jwks: { keyPairConfig: { alg: "RS256", modulusLength: 2048 } },
      jwt: { issuer: settings.issuer },
      disableSettingJwtHeader: true,
    }),
    oauthProvider({
      loginPage: settings.loginPage,
      // Consent is skipped for the single trusted client; no other client can exist.
      consentPage: settings.loginPage,
      scopes: [...OIDC_PROVIDER_SCOPES],
      grantTypes: ["authorization_code"],
      allowDynamicClientRegistration: false,
      allowUnauthenticatedClientRegistration: false,
      allowPublicClientPrelogin: false,
      cachedTrustedClients: new Set([settings.clientId]),
      storeClientSecret: { hash: hashClientSecret, verify: verifyClientSecret },
      generateClientId: refuseGeneration,
      generateClientSecret: refuseGeneration,
      validateRedirectUri: (uri, _registered, defaultResult) =>
        defaultResult === true && uri === settings.redirectUri,
      customIdTokenClaims: claims,
      customUserInfoClaims: claims,
    }),
  ];
}

function trustedClientRecord(settings: UnifiedAuthSettings) {
  return {
    clientId: settings.clientId,
    clientSecret: hashClientSecret(settings.clientSecret),
    disabled: false,
    skipConsent: true,
    enableEndSession: false,
    scopes: [...OIDC_PROVIDER_SCOPES],
    clientCredentialsScopes: [] as string[],
    name: "Agent Family chat (Synapse)",
    redirectUris: [settings.redirectUri],
    tokenEndpointAuthMethod: "client_secret_basic",
    applicationType: "web",
    grantTypes: ["authorization_code"],
    responseTypes: ["code"],
    requirePKCE: true,
    dpopBoundAccessTokens: false,
  };
}
const asList = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {}
    return value ? value.split(/[\s,]+/) : [];
  }
  return [];
};
const sameList = (a: unknown, b: string[]) => {
  const left = [...asList(a)].sort();
  const right = [...b].sort();
  return left.length === right.length && left.every((v, i) => v === right[i]);
};

type AdapterLike = {
  findOne(input: {
    model: string;
    where: { field: string; value: string }[];
  }): Promise<Record<string, unknown> | null>;
  create(input: {
    model: string;
    data: Record<string, unknown>;
  }): Promise<unknown>;
};

/**
 * Idempotently ensures the single trusted Synapse client exists, persisted via
 * the provider's own `oauthClient` model through the Better Auth adapter (the
 * provider's create endpoints require a user session, so they cannot be used at
 * boot). An existing row that differs from configuration is NOT silently
 * rewritten: startup fails with the names of the differing fields only.
 */
export async function ensureTrustedClient(
  auth: { $context: Promise<unknown> },
  settings: UnifiedAuthSettings,
): Promise<{ created: boolean }> {
  const context = (await auth.$context) as { adapter: AdapterLike };
  const adapter = context.adapter;
  const where = [{ field: "clientId", value: settings.clientId }];
  const expected = trustedClientRecord(settings);
  let existing = await adapter.findOne({ model: OAUTH_CLIENT_MODEL, where });
  if (!existing) {
    const at = new Date();
    try {
      await adapter.create({
        model: OAUTH_CLIENT_MODEL,
        data: { ...expected, createdAt: at, updatedAt: at },
      });
      return { created: true };
    } catch (error) {
      // A concurrent instance may have inserted it; re-validate instead.
      existing = await adapter.findOne({ model: OAUTH_CLIENT_MODEL, where });
      if (!existing) throw error;
    }
  }
  const drift: string[] = [];
  if (
    !verifyClientSecret(
      settings.clientSecret,
      String(existing.clientSecret ?? ""),
    )
  )
    drift.push("clientSecret");
  if (!sameList(existing.redirectUris, expected.redirectUris))
    drift.push("redirectUris");
  if (!sameList(existing.scopes, expected.scopes)) drift.push("scopes");
  if (!sameList(existing.grantTypes, expected.grantTypes))
    drift.push("grantTypes");
  if (!sameList(existing.responseTypes, expected.responseTypes))
    drift.push("responseTypes");
  if (existing.tokenEndpointAuthMethod !== expected.tokenEndpointAuthMethod)
    drift.push("tokenEndpointAuthMethod");
  if (existing.skipConsent !== true && existing.skipConsent !== 1)
    drift.push("skipConsent");
  if (existing.requirePKCE !== true && existing.requirePKCE !== 1)
    drift.push("requirePKCE");
  if (existing.disabled === true || existing.disabled === 1)
    drift.push("disabled");
  if (existing.userId || existing.referenceId || existing.clientDiscoveryId)
    drift.push("owner");
  if (drift.length)
    throw new UnifiedAuthConfigError(
      `persisted OIDC client differs from configuration (${drift.join(", ")}); see docs/design/unified-auth-integration.md`,
    );
  return { created: false };
}

/* ------------------------------------------------------------------ routes */

export type UnifiedAuthRoute = {
  path: string;
  methods: readonly ("GET" | "POST")[];
  /** browser: needs the AF session cookie; client: server-to-server, cookies stripped; public: cookies stripped. */
  kind: "browser" | "client" | "public";
};
/** The ONLY OAuth/OIDC paths reachable from outside. Exact match, no prefixes. */
export const UNIFIED_AUTH_ROUTES: readonly UnifiedAuthRoute[] = Object.freeze([
  {
    path: `${AUTH_BASE_PATH}/.well-known/openid-configuration`,
    methods: ["GET"],
    kind: "public",
  },
  { path: `${AUTH_BASE_PATH}/jwks`, methods: ["GET"], kind: "public" },
  {
    path: `${AUTH_BASE_PATH}/oauth2/authorize`,
    methods: ["GET"],
    kind: "browser",
  },
  { path: TOKEN_PATH, methods: ["POST"], kind: "client" },
  {
    path: `${AUTH_BASE_PATH}/oauth2/userinfo`,
    methods: ["GET"],
    kind: "client",
  },
]);
/** Paths only, for the parent's allowlist. */
export function unifiedAuthPaths(): string[] {
  return UNIFIED_AUTH_ROUTES.map((r) => r.path);
}
/** Returns the allowlisted route for (method, raw url), or undefined. */
export function unifiedAuthRoute(
  method: string,
  url: string,
): UnifiedAuthRoute | undefined {
  const path = url.split("?")[0];
  return UNIFIED_AUTH_ROUTES.find(
    (r) => r.path === path && (r.methods as readonly string[]).includes(method),
  );
}

/**
 * Registers an `application/x-www-form-urlencoded` parser (raw string, 16 KiB)
 * that accepts form bodies ONLY for the token endpoint; any other path gets 415,
 * so existing JSON routes keep their behaviour.
 */
export function registerUnifiedAuthBodyParser(app: FastifyInstance) {
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string", bodyLimit: 16 * 1024 },
    (req, body, done) => {
      if (req.url.split("?")[0] !== TOKEN_PATH) {
        done(
          Object.assign(new Error("Unsupported Media Type"), {
            statusCode: 415,
          }),
          undefined,
        );
        return;
      }
      done(null, body);
    },
  );
}

const HOP_HEADERS = new Set([
  "content-length",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "x-af-client-ip",
]);
function forwardHeaders(req: FastifyRequest, kind: UnifiedAuthRoute["kind"]) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    const name = key.toLowerCase();
    if (HOP_HEADERS.has(name) || value === undefined) continue;
    // Server-to-server and public endpoints never act on a browser session.
    if (kind !== "browser" && name === "cookie") continue;
    headers.set(name, Array.isArray(value) ? value.join(",") : value);
  }
  if (req.ip) headers.set("x-af-client-ip", req.ip);
  return headers;
}
const oauthError = (
  reply: FastifyReply,
  status: number,
  error: string,
  description: string,
) =>
  reply
    .code(status)
    .header("cache-control", "no-store")
    .send({ error, error_description: description });

/** A redirect is allowed only to the AF login page or the exact Synapse callback. */
export function isAllowedRedirect(
  location: string,
  settings: UnifiedAuthSettings,
) {
  let target: URL;
  try {
    target = new URL(location, `${settings.origin}/`);
  } catch {
    return false;
  }
  if (target.username || target.password || target.hash) return false;
  if (
    target.origin === settings.origin &&
    target.pathname === settings.loginPage
  )
    return true;
  return `${target.origin}${target.pathname}` === settings.redirectUri;
}

/**
 * Forwards ONE allowlisted OAuth/OIDC request to Better Auth. Call it from the
 * parent's existing `/api/auth/*` route when `unifiedAuthRoute()` matches,
 * instead of the JSON.stringify path. Does no origin bypass: browser-session
 * requests keep Better Auth's normal origin/CSRF handling; server-to-server
 * requests carry no cookies and must present client/bearer credentials.
 */
export async function handleUnifiedAuthRequest(
  authHandler: (request: Request) => Promise<Response>,
  req: FastifyRequest,
  reply: FastifyReply,
  settings: UnifiedAuthSettings,
) {
  const route = unifiedAuthRoute(req.method, req.url);
  if (!route) return reply.code(404).send({ error: "此登录操作未开放。" });
  const url = new URL(req.url, settings.origin);
  const headers = forwardHeaders(req, route.kind);
  let body: string | undefined;
  if (route.path === TOKEN_PATH) {
    const type = (headers.get("content-type") || "")
      .split(";")[0]
      .trim()
      .toLowerCase();
    if (type !== "application/x-www-form-urlencoded")
      return oauthError(
        reply,
        415,
        "invalid_request",
        "form-encoded body required",
      );
    if (typeof req.body === "string") body = req.body;
    else return oauthError(reply, 400, "invalid_request", "malformed body");
    const form = new URLSearchParams(body);
    const basic = /^basic\s+\S+/i.test(headers.get("authorization") || "");
    if (!basic && !(form.get("client_id") && form.get("client_secret")))
      return oauthError(
        reply,
        401,
        "invalid_client",
        "client authentication required",
      );
  } else if (route.path.endsWith("/oauth2/userinfo")) {
    if (!/^bearer\s+\S+/i.test(headers.get("authorization") || ""))
      return oauthError(reply, 401, "invalid_token", "bearer token required");
  } else if (route.path.endsWith("/oauth2/authorize")) {
    // Only the trusted client may start an authorization; reject before any redirect.
    if (url.searchParams.getAll("client_id").join("\n") !== settings.clientId)
      return oauthError(reply, 400, "invalid_client", "unknown client");
    if (
      url.searchParams.getAll("redirect_uri").join("\n") !==
      settings.redirectUri
    )
      return oauthError(reply, 400, "invalid_request", "invalid redirect_uri");
  }
  const response = await authHandler(
    new Request(url, {
      method: req.method,
      headers,
      ...(body !== undefined ? { body } : {}),
    }),
  );
  const text = await response.text();
  const location = response.headers.get("location");
  if (location && !isAllowedRedirect(location, settings))
    return oauthError(
      reply,
      400,
      "invalid_request",
      "redirect target rejected",
    );
  if (
    route.kind === "browser" &&
    /json/i.test(response.headers.get("content-type") || "")
  ) {
    try {
      const data = JSON.parse(text);
      if (
        data &&
        typeof data.url === "string" &&
        !isAllowedRedirect(data.url, settings)
      )
        return oauthError(
          reply,
          400,
          "invalid_request",
          "redirect target rejected",
        );
    } catch {}
  }
  reply.code(response.status);
  response.headers.forEach((value, key) => {
    if (key !== "set-cookie" && key !== "content-length")
      reply.header(key, value);
  });
  if (route.kind === "browser") {
    const cookies = response.headers.getSetCookie();
    if (cookies.length) reply.header("set-cookie", cookies);
  }
  if (route.kind === "client") reply.header("cache-control", "no-store");
  return reply.send(text);
}
