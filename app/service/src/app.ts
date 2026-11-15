import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance, type FastifyRequest, type FastifySchema } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { z } from "zod";
import { loadConfig, type Config } from "./config.ts";
import { createDb, type Db } from "./db.ts";
import { createAuth, createSessionEvents, registerAuthRoutes, type Auth, type SessionEvents } from "./auth/auth.ts";
import { registerRegistrationRoutes } from "./auth/register.ts";
import { AppError, frameworkErrors, registerErrorHandling } from "./errors.ts";
import { registerSessionRoutes } from "./session.ts";
import { createBlobStore, type BlobStore } from "./attachments/blob.ts";
import { registerAttachmentRoutes } from "./attachments/routes.ts";
import { createUploadSlots, type UploadSlots } from "./attachments/slots.ts";
import { registerPrincipalRoutes } from "./principals/routes.ts";
import { createSocialEvents, type SocialEvents } from "./social/events.ts";
import { registerSocialRoutes } from "./social/routes.ts";
import { createConversationEvents, type ConversationEvents } from "./conversations/events.ts";
import { registerConversationRoutes } from "./conversations/routes.ts";
import { createReadEvents, type ReadEvents } from "./messages/read.ts";
import { registerMessageRoutes } from "./messages/routes.ts";
import { MAX_CONCURRENT_SEARCHES, MAX_SEARCHES_IN_FLIGHT } from "./messages/search.ts";
import { clientIp } from "./limits.ts";
import { appOriginCheck } from "./origin.ts";
import { createSlots, type Slots } from "./slots.ts";
import type { Hub } from "./sync/hub.ts";
import { registerSync } from "./sync/routes.ts";
import { registerWebClient } from "./web.ts";

/** Everything the app needs from outside; tests override pieces (e.g. raised rate limits). */
export interface Deps {
  config: Config;
  db: Db;
  /** Where avatars and attachments live; tests inject a temp-dir store. */
  blobs: BlobStore;
  /** Per-app registry of "friendships/blocks changed" listeners; fired after commit. */
  social: SocialEvents;
  /** Per-app registry of "messages stored" / "membership changed" listeners; fired after commit. */
  conversations: ConversationEvents;
  /** Per-app registry of "a direct-chat read marker moved" listeners; fired after the update. */
  reads: ReadEvents;
  /** Per-app registry of "a session was deleted" listeners (sign-out, password reset, expiry cleanup). */
  sessions: SessionEvents;
  /** Uploads in progress per principal (at most 3 each). */
  uploads: UploadSlots;
  /** Searches in progress per principal (at most 2 each, 4 for everyone together). */
  searches: Slots;
}

/** One registered route (a GET also yields its HEAD), as declared: method, URL pattern and schema. */
export interface RouteEntry {
  method: string;
  url: string;
  schema: FastifySchema | undefined;
  websocket: boolean;
  /** A HEAD Fastify derived from the GET of the same URL (same handler, no body sent). */
  derived: boolean;
}

declare module "fastify" {
  interface FastifyInstance {
    deps: Deps;
    auth: Auth;
    /** The in-process socket registry and push delivery (src/sync/hub.ts). */
    realtime: Hub;
    /** Every route the app serves, in registration order (diagnostics; the fuzz suite walks it). */
    routeList: readonly RouteEntry[];
  }
}

const STATE_CHANGING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** What is not a dependency of the routes: where the log goes. */
export interface BuildOptions {
  /** JSON log lines at info level go here (tests capture them). Default: stdout, and nothing under test. */
  logStream?: { write(line: string): void };
}

/**
 * A URL as it may be logged: without its query string, which carries WebSocket tickets, e-mail
 * verification tokens and search terms. Only `?[redacted]` shows that there was one.
 */
export function redactQuery(url: string): string {
  const q = url.indexOf("?");
  return q < 0 ? url : `${url.slice(0, q)}?[redacted]`;
}

/** Fastify's default request serializer, minus the query string. */
const logSerializers = {
  req: (req: FastifyRequest) => ({
    method: req.method,
    url: redactQuery(req.url),
    host: req.host,
    remoteAddress: clientIp(req),
    remotePort: req.socket?.remotePort,
  }),
};

export async function buildApp(overrides: Partial<Deps> = {}, options: BuildOptions = {}): Promise<FastifyInstance> {
  const config = overrides.config ?? loadConfig();
  const ownsDb = overrides.db === undefined;
  const deps: Deps = {
    config,
    db:
      overrides.db ??
      createDb(config.databaseUrl, { statementTimeoutMs: config.dbStatementTimeoutMs, acquireTimeoutMs: config.dbAcquireTimeoutMs }),
    blobs: overrides.blobs ?? createBlobStore(config),
    social: overrides.social ?? createSocialEvents(),
    conversations: overrides.conversations ?? createConversationEvents(),
    reads: overrides.reads ?? createReadEvents(),
    sessions: overrides.sessions ?? createSessionEvents(),
    uploads: overrides.uploads ?? createUploadSlots(),
    searches: overrides.searches ?? createSlots(MAX_CONCURRENT_SEARCHES, MAX_SEARCHES_IN_FLIGHT),
  };

  const underTest = process.env.NODE_ENV === "test" || Boolean(process.env.VITEST);
  const app = Fastify({
    logger: options.logStream
      ? { level: "info", stream: options.logStream, serializers: logSerializers }
      : underTest
        ? false
        : { level: "info", serializers: logSerializers },
    trustProxy: config.trustProxy,
    // Server-wide limits (WebSockets are exempt: `ws` clears the socket timeout on upgrade, and an upgraded
    // connection is no longer a request). Uploads run under their own, tighter deadlines (attachments/routes.ts).
    connectionTimeout: config.httpConnectionTimeoutMs,
    requestTimeout: config.httpRequestTimeoutMs,
    keepAliveTimeout: config.httpKeepAliveTimeoutMs,
    frameworkErrors,
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandling(app);

  // Before any route: an onRoute hook only sees routes registered after it.
  const routeList: RouteEntry[] = [];
  const getHandlers = new Map<string, unknown>();
  app.addHook("onRoute", (r) => {
    // The web client's wildcard (src/web.ts) is not an API route: the README and the fuzz suite walk this list.
    if (r.config?.webClient) return;
    for (const method of [r.method].flat()) {
      if (method === "GET") getHandlers.set(r.url, r.handler);
      const derived = method === "HEAD" && getHandlers.get(r.url) === r.handler;
      routeList.push({ method, url: r.url, schema: r.schema, websocket: Boolean((r as { websocket?: boolean }).websocket), derived });
    }
  });
  app.decorate("routeList", routeList);

  // Every response: no content sniffing. API JSON is also never cached (a route that sets its own
  // Cache-Control, like attachments and avatars, keeps it). The web client's files set theirs in src/web.ts.
  app.addHook("onSend", async (req, reply, payload) => {
    void reply.header("x-content-type-options", "nosniff");
    const isApi = req.routeOptions.url?.startsWith("/api/") === true;
    const isJson = String(reply.getHeader("content-type") ?? "").startsWith("application/json");
    if ((isApi || isJson) && reply.getHeader("cache-control") === undefined) void reply.header("cache-control", "no-store");
    return payload;
  });

  // Cross-site request forgery: a browser names the page that sent a request in `Origin`. Every
  // state-changing request from any other origin is refused before body parsing or any handler. It
  // deliberately looks at the method only, never at the path: the router decodes the path (`/%61pi/…`
  // reaches `/api/…`), so any decision by the raw URL could be sidestepped. Requests without `Origin`
  // (non-browser clients, same-origin GETs) pass.
  const fromApp = appOriginCheck(config.appOrigin);
  app.addHook("onRequest", async (req) => {
    if (!STATE_CHANGING.has(req.method)) return;
    const origin = req.headers.origin;
    if (origin !== undefined && !fromApp(origin)) throw new AppError(403, "forbidden");
  });

  app.decorate("deps", deps);
  app.decorate("auth", createAuth(config, deps.db, deps.sessions, app.log));
  if (ownsDb) app.addHook("onClose", async () => deps.db.close());

  // The single source of throttling (Better Auth's own limiter is off). Routes that declare
  // `config.rateLimit` are counted per client address (`clientIp`); the rest use limits.ts / createRateLimit.
  await app.register(rateLimit, {
    global: false,
    keyGenerator: clientIp,
    errorResponseBuilder: () => new AppError(429, "rate_limited"),
  });
  const perMinute = { max: Math.max(1, Math.round(10 * config.rateLimitScale)), timeWindow: "1 minute" };

  // First among the routes: it registers the WebSocket plugin, whose route wrapper must see every route
  // (an upgrade request to any other route is then refused instead of answered over the raw socket).
  await registerSync(app);
  registerRegistrationRoutes(app, perMinute);
  registerAuthRoutes(app, config.rateLimitScale);
  registerSessionRoutes(app);
  registerPrincipalRoutes(app);
  registerSocialRoutes(app);
  registerConversationRoutes(app);
  registerMessageRoutes(app);
  registerAttachmentRoutes(app);

  const api = app.withTypeProvider<ZodTypeProvider>();

  api.get(
    "/api/health",
    {
      schema: {
        params: z.object({}),
        querystring: z.object({}),
        response: { 200: z.object({ ok: z.literal(true) }) },
      },
    },
    async () => {
      await deps.db.query("select 1");
      return { ok: true as const };
    },
  );

  // Last: the wildcard must never get ahead of an API route (a more specific route always wins, but be explicit).
  await registerWebClient(app);

  return app;
}
