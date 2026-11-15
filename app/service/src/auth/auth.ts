import { AsyncLocalStorage } from "node:async_hooks";
import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { betterAuth } from "better-auth";
import { fromNodeHeaders } from "better-auth/node";
import type pg from "pg";
import { z } from "zod";
import type { Config } from "../config.ts";
import type { Db, Queryable } from "../db.ts";
import { AppError } from "../errors.ts";
import { sendMail } from "./mailer.ts";

export const AUTH_BASE_PATH = "/api/auth";
const SESSION_LIFETIME_SECONDS = 7 * 24 * 60 * 60;

// --- joining Better Auth's writes to an outer transaction -------------------------------
//
// Better Auth talks to Postgres through its own (Kysely) connection handling and cannot be
// handed a transaction. Registration must create the auth user and the `principals` row
// atomically, so the pool given to Better Auth is a thin wrapper: inside `runInTransaction`
// it hands out the caller's transaction client instead of a pooled one, and turns Better
// Auth's own begin/commit/rollback into a savepoint so they nest inside the outer
// transaction instead of ending it. Outside `runInTransaction` it is a plain pool.
//
// The caller's client goes back to the pool when its transaction ends, and may then be serving
// someone else. So everything handed out inside `runInTransaction` stops working the moment its
// callback settles (and a handed-out connection once it is released): a late query throws instead
// of running on a client that is no longer ours.

interface OuterTransaction {
  client: pg.PoolClient;
  /** False once the `runInTransaction` callback has settled. */
  open: boolean;
}

const outerTx = new AsyncLocalStorage<OuterTransaction>();

const SAVEPOINT = "better_auth_nested";

function nestedSql(text: string): string {
  const t = text.trim().toLowerCase();
  if (t === "begin" || t.startsWith("start transaction")) return `savepoint ${SAVEPOINT}`;
  if (t === "commit") return `release savepoint ${SAVEPOINT}`;
  if (t === "rollback") return `rollback to savepoint ${SAVEPOINT}`;
  return text;
}

/** Queries on the outer transaction's client while it is ours (and `usable()` holds); a rejection after. */
function onOuter(outer: OuterTransaction, usable: () => boolean = () => true) {
  return async (text: string, values?: unknown[]) => {
    if (!outer.open) throw new Error("Better Auth used a registration transaction after it ended");
    if (!usable()) throw new Error("Better Auth used a connection after releasing it");
    return outer.client.query(nestedSql(text), values);
  };
}

/** The pool Better Auth is given (exported for tests). */
export function switchablePool(pool: pg.Pool) {
  return {
    async connect() {
      const outer = outerTx.getStore();
      if (!outer) return pool.connect();
      let released = false;
      return {
        query: onOuter(outer, () => !released),
        release: () => {
          released = true;
        },
      };
    },
    end: async () => {},
  };
}

/**
 * Runs `fn` so that every Better Auth call inside it executes on `client`'s transaction. What Better
 * Auth got hold of inside refuses to run once `fn` has settled.
 */
export async function runInTransaction<T>(client: pg.PoolClient, fn: () => Promise<T>): Promise<T> {
  const outer: OuterTransaction = { client, open: true };
  try {
    return await outerTx.run(outer, fn);
  } finally {
    outer.open = false;
  }
}

// --- session-ended notifications ------------------------------------------------------

export type SessionEndedListener = (principalId: string, sessionId: string) => void | Promise<void>;

/** Per-app registry (on `Deps.sessions`) of "a session ended" listeners, in the style of `SocialEvents`. */
export interface SessionEvents {
  on(fn: SessionEndedListener): () => void;
  /** Never throws; a listener that throws or rejects is logged. */
  emit(principalId: string, sessionId: string, log: Pick<FastifyBaseLogger, "error">): void;
}

export function createSessionEvents(): SessionEvents {
  const listeners = new Set<SessionEndedListener>();
  return {
    on(fn) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    emit(principalId, sessionId, log) {
      for (const fn of [...listeners]) {
        try {
          Promise.resolve(fn(principalId, sessionId)).catch((err) => log.error({ err }, "session-ended listener failed"));
        } catch (err) {
          log.error({ err }, "session-ended listener failed");
        }
      }
    },
  };
}

/**
 * Subscribe to "a session was deleted" (sign-out, password reset — once per session —, expiry cleanup) of
 * this app. Returns unsubscribe.
 */
export function onSessionEnded(app: FastifyInstance, fn: SessionEndedListener): () => void {
  return app.deps.sessions.on(fn);
}

/** Never throws: a failure here must not turn a completed sign-out or password reset into an error. */
async function announceSessionEnded(
  db: Queryable,
  sessions: SessionEvents,
  log: Pick<FastifyBaseLogger, "error">,
  session: { id: string; userId: string },
): Promise<void> {
  try {
    const { rows } = await db.query<{ id: string }>("select id from principals where auth_user_id = $1", [session.userId]);
    const principalId = rows[0]?.id;
    if (principalId) sessions.emit(principalId, session.id, log);
  } catch (err) {
    // Its sockets are still closed by the heartbeat's session check (sync/hub.ts) within 30 s.
    log.error({ err }, "could not announce an ended session");
  }
}

// --- the Better Auth instance -------------------------------------------------------------

export function createAuth(config: Config, db: Db, sessions: SessionEvents, log: Pick<FastifyBaseLogger, "error">) {
  // Mail caused by a registration commits with it (and cannot be written once that transaction is
  // over); everything else writes straight to the pool.
  const mailDb = (): Queryable => {
    const outer = outerTx.getStore();
    return outer ? ({ query: onOuter(outer) } as unknown as Queryable) : db;
  };
  const isHttps = new URL(config.appOrigin).protocol === "https:";

  return betterAuth({
    appName: "Agent Family",
    baseURL: config.appOrigin,
    basePath: AUTH_BASE_PATH,
    secret: config.authSecret,
    trustedOrigins: [config.appOrigin],
    database: switchablePool(db.pool),
    telemetry: { enabled: false },
    logger: { level: "error" },
    // One source of truth for throttling: @fastify/rate-limit in app.ts.
    rateLimit: { enabled: false },
    advanced: {
      ipAddress: { disableIpTracking: true },
      // Stated, not inherited from a library default: no cross-site POST carries the session (CSRF is
      // also refused by the Origin check in app.ts), scripts cannot read it, and https deployments
      // send it over TLS only (with the __Secure- name prefix).
      useSecureCookies: isHttps,
      defaultCookieAttributes: { sameSite: "lax", httpOnly: true, secure: isHttps },
    },
    session: { expiresIn: SESSION_LIFETIME_SECONDS },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      autoSignIn: false,
      minPasswordLength: 10,
      maxPasswordLength: 128,
      revokeSessionsOnPasswordReset: true,
      resetPasswordTokenExpiresIn: 60 * 60,
      sendResetPassword: async ({ user, token }) => {
        const link = `${config.appOrigin}/reset-password?token=${encodeURIComponent(token)}`;
        await sendMail(mailDb(), "reset_password", user.email, "Reset your password", `Reset your password: ${link}`);
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: false,
      expiresIn: 24 * 60 * 60,
      // After a correct password only, so it reveals nothing about which accounts exist; this is the resend path.
      sendOnSignIn: true,
      sendVerificationEmail: async ({ user, url }) => {
        await sendMail(mailDb(), "verify_email", user.email, "Verify your email", `Confirm your email address: ${url}`);
      },
    },
    databaseHooks: {
      session: {
        delete: { after: async (session) => announceSessionEnded(db, sessions, log, session) },
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;

// --- HTTP mount (Better Auth's Fastify integration: forward the request to `auth.handler`) -----

type Limiter = (req: FastifyRequest) => Promise<void>;

/** Lower-cased, trimmed e-mail from a request body, or undefined when absent or not a string. */
function bodyEmail(req: FastifyRequest): string | undefined {
  const email = (req.body as { email?: unknown } | null | undefined)?.email;
  if (typeof email !== "string") return undefined;
  const normalised = email.trim().toLowerCase();
  return normalised.length > 0 && normalised.length <= 254 ? normalised : undefined;
}

/**
 * Two counters per request: 10/min per IP + e-mail (so hammering one account never locks out another),
 * and a looser 60/min per IP (so one address cannot spray many accounts). Both times `scale`.
 * A missing or malformed e-mail falls back to the IP-only key.
 */
function accountAndIpLimiter(app: FastifyInstance, scale: number): Limiter {
  const per = (n: number) => ({ max: Math.max(1, Math.round(n * scale)), timeWindow: "1 minute" });
  const perAccount = app.createRateLimit({ ...per(10), keyGenerator: (req: FastifyRequest) => `${req.ip}|${bodyEmail(req) ?? ""}` });
  const perIp = app.createRateLimit({ ...per(60), keyGenerator: (req: FastifyRequest) => req.ip });
  return async (req) => {
    const results = [await perAccount(req), await perIp(req)];
    if (results.some((r) => "isExceeded" in r && r.isExceeded)) throw new AppError(429, "rate_limited");
  };
}

/**
 * A Better Auth JSON body without any `token` field, at any depth. Sign-in returns the session token
 * in its body; the HttpOnly cookie already carries the session, and a script must never see it.
 */
function withoutTokens(json: string): string {
  const strip = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(strip);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.entries(v).filter(([k]) => k !== "token").map(([k, x]) => [k, strip(x)]));
    }
    return v;
  };
  try {
    return JSON.stringify(strip(JSON.parse(json)));
  } catch {
    return json;
  }
}

const STATUS_CODES: Record<number, string> = { 401: "unauthenticated", 403: "forbidden", 404: "not_found", 429: "rate_limited" };

/** Better Auth's error code ("INVALID_EMAIL_OR_PASSWORD") as our snake_case; its message text is never forwarded. */
function errorCodeOf(status: number, body: string): string {
  try {
    const code = (JSON.parse(body) as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Za-z][A-Za-z0-9_]*$/.test(code)) return code.toLowerCase();
  } catch {
    // not JSON: fall through to the status
  }
  return STATUS_CODES[status] ?? "invalid_request";
}

/** Text Postgres can store and a URL can carry: no NUL, no lone surrogate. */
const storableText = (max: number) =>
  z
    .string()
    .max(max)
    .refine((s) => !s.includes("\u0000") && !/\p{Cs}/u.test(s), "not storable");

/**
 * Where Better Auth may send the browser afterwards: a path on this site (not `//host` or `/\host`, which
 * browsers read as another host) or a URL on the app's own origin. Better Auth would refuse other origins
 * too, but answers some malformed values with a 500.
 */
function appRedirect(appOrigin: string) {
  const own = new URL(appOrigin).origin;
  return storableText(2048).refine((s) => {
    if (/[\\\p{Cc}]/u.test(s)) return false;
    if (s.startsWith("/")) return !s.startsWith("//");
    try {
      return new URL(s).origin === own;
    } catch {
      return false;
    }
  }, "not a redirect on this site");
}

interface Endpoint {
  limit: Limiter | null;
  /** The query string, exactly (it is forwarded as sent, so nothing undeclared may be in it). */
  query: z.ZodType;
  /** The JSON body; what it parses to is what Better Auth receives (undeclared fields are dropped). */
  body: z.ZodType;
}

/**
 * Only these Better Auth endpoints are reachable. Notably absent: `/sign-up/email`, which would
 * bypass invites and principal creation (registration goes through POST /api/register).
 */
export function registerAuthRoutes(app: FastifyInstance, rateLimitScale: number): void {
  const signIn = accountAndIpLimiter(app, rateLimitScale);
  const resetRequest = accountAndIpLimiter(app, rateLimitScale);
  const redirect = appRedirect(app.deps.config.appOrigin);
  // Better Auth validates the values itself (e-mail format, password length, token); these schemas bound
  // the shape and keep out what it would choke on. Passwords are only hashed, never stored, so any text goes.
  const password = z.string().max(1024);
  const noQuery = z.strictObject({});
  const noBody = z.object({}).nullish();
  const exposed = new Map<string, Endpoint>([
    [
      "POST /sign-in/email",
      {
        limit: signIn,
        query: noQuery,
        body: z.object({ email: storableText(254), password, callbackURL: redirect.optional(), rememberMe: z.boolean().optional() }),
      },
    ],
    ["POST /sign-out", { limit: null, query: noQuery, body: noBody }],
    [
      "GET /verify-email",
      { limit: null, query: z.strictObject({ token: storableText(4096), callbackURL: redirect.optional() }), body: noBody },
    ],
    [
      "POST /request-password-reset",
      { limit: resetRequest, query: noQuery, body: z.object({ email: storableText(254), redirectTo: redirect.optional() }) },
    ],
    ["POST /reset-password", { limit: null, query: noQuery, body: z.object({ newPassword: password, token: storableText(512) }) }],
  ]);
  const endpointOf = (req: FastifyRequest): string => {
    const path = (req.url.split("?")[0] ?? "").replace(/\/{2,}/g, "/").replace(/\/+$/, "").toLowerCase();
    return `${req.method} ${path.startsWith(AUTH_BASE_PATH) ? path.slice(AUTH_BASE_PATH.length) : path}`;
  };

  const handler = async (req: FastifyRequest, reply: FastifyReply) => {
    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
    const request = new Request(url, {
      method: req.method,
      headers: fromNodeHeaders(req.headers),
      ...(req.body === undefined || req.body === null ? {} : { body: JSON.stringify(req.body) }),
    });
    const response = await app.auth.handler(request);
    if (response.status >= 400) {
      return reply.code(response.status).send({ error: errorCodeOf(response.status, await response.text()) });
    }
    reply.status(response.status);
    response.headers.forEach((value, key) => {
      // The body may be rewritten below, so its length is Fastify's to state.
      if (!["set-cookie", "content-length"].includes(key.toLowerCase())) reply.header(key, value);
    });
    for (const cookie of response.headers.getSetCookie()) reply.header("set-cookie", cookie);
    if (!response.body) return reply.send(null);
    const text = await response.text();
    return reply.send(/json/i.test(response.headers.get("content-type") ?? "") ? withoutTokens(text) : text);
  };
  const onRequest = async (req: FastifyRequest) => {
    if (!exposed.has(endpointOf(req))) throw new AppError(404, "not_found");
  };
  // After body parsing, because the limiter keys on the e-mail in the body. The limiter counts malformed
  // requests too; then the endpoint's own schemas decide (400 before Better Auth sees anything).
  const preHandler = async (req: FastifyRequest) => {
    const endpoint = exposed.get(endpointOf(req));
    if (!endpoint) throw new AppError(404, "not_found");
    await endpoint.limit?.(req);
    const query = endpoint.query.safeParse(req.query);
    const body = endpoint.body.safeParse(req.body ?? undefined);
    if (!query.success || !body.success) throw new AppError(400, "invalid_request");
    req.body = body.data;
  };
  // The mount's own schemas only bound the shape; each endpoint's schemas above are checked in preHandler.
  const schema = {
    params: z.object({ "*": z.string() }),
    querystring: z.object({}).catchall(z.union([z.string(), z.array(z.string())])),
  };
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.get(`${AUTH_BASE_PATH}/*`, { schema, onRequest, preHandler }, handler);
  typed.post(
    `${AUTH_BASE_PATH}/*`,
    { schema: { ...schema, body: z.record(z.string(), z.unknown()).optional() }, onRequest, preHandler },
    handler,
  );
}
