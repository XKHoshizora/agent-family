import { AsyncLocalStorage } from "node:async_hooks";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
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

const outerTx = new AsyncLocalStorage<pg.PoolClient>();

const SAVEPOINT = "better_auth_nested";

function nestedSql(text: string): string {
  const t = text.trim().toLowerCase();
  if (t === "begin" || t.startsWith("start transaction")) return `savepoint ${SAVEPOINT}`;
  if (t === "commit") return `release savepoint ${SAVEPOINT}`;
  if (t === "rollback") return `rollback to savepoint ${SAVEPOINT}`;
  return text;
}

function switchablePool(pool: pg.Pool) {
  return {
    async connect() {
      const client = outerTx.getStore();
      if (!client) return pool.connect();
      return {
        query: (text: string, values?: unknown[]) => client.query(nestedSql(text), values),
        release: () => {},
      };
    },
    end: async () => {},
  };
}

/** Runs `fn` so that every Better Auth call inside it executes on `client`'s transaction. */
export function runInTransaction<T>(client: pg.PoolClient, fn: () => Promise<T>): Promise<T> {
  return outerTx.run(client, fn);
}

// --- session-ended notifications ------------------------------------------------------

type SessionEndedListener = (principalId: string, sessionId: string) => void;
const sessionEndedListeners = new Set<SessionEndedListener>();

/** Fires whenever a session is deleted: sign-out, password reset (once per session), expiry cleanup. */
export function onSessionEnded(fn: SessionEndedListener): () => void {
  sessionEndedListeners.add(fn);
  return () => sessionEndedListeners.delete(fn);
}

async function announceSessionEnded(db: Queryable, session: { id: string; userId: string }): Promise<void> {
  const { rows } = await db.query<{ id: string }>("select id from principals where auth_user_id = $1", [session.userId]);
  const principalId = rows[0]?.id;
  if (!principalId) return;
  for (const fn of sessionEndedListeners) {
    try {
      fn(principalId, session.id);
    } catch {
      // a faulty subscriber must not break sign-out or password reset
    }
  }
}

// --- the Better Auth instance -------------------------------------------------------------

export function createAuth(config: Config, db: Db) {
  // Mail caused by a registration commits with it; everything else writes straight to the pool.
  const mailDb = (): Queryable => outerTx.getStore() ?? db;

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
    advanced: { ipAddress: { disableIpTracking: true } },
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
        delete: { after: async (session) => announceSessionEnded(db, session) },
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

/**
 * Only these Better Auth endpoints are reachable. Notably absent: `/sign-up/email`, which would
 * bypass invites and principal creation (registration goes through POST /api/register).
 */
export function registerAuthRoutes(app: FastifyInstance, rateLimitScale: number): void {
  const signIn = accountAndIpLimiter(app, rateLimitScale);
  const resetRequest = accountAndIpLimiter(app, rateLimitScale);
  const exposed = new Map<string, Limiter | null>([
    ["POST /sign-in/email", signIn],
    ["POST /sign-out", null],
    ["GET /verify-email", null],
    ["POST /request-password-reset", resetRequest],
    ["POST /reset-password", null],
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
      if (key.toLowerCase() !== "set-cookie") reply.header(key, value);
    });
    for (const cookie of response.headers.getSetCookie()) reply.header("set-cookie", cookie);
    return reply.send(response.body ? await response.text() : null);
  };
  const onRequest = async (req: FastifyRequest) => {
    if (!exposed.has(endpointOf(req))) throw new AppError(404, "not_found");
  };
  // After body parsing, because the limiter keys on the e-mail in the body.
  const preHandler = async (req: FastifyRequest) => {
    await exposed.get(endpointOf(req))?.(req);
  };
  // Better Auth validates its own payloads (4xx on bad input); these schemas only bound the shape.
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
