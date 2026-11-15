import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance, type FastifySchema } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { z } from "zod";
import { loadConfig, type Config } from "./config.ts";
import { createDb, type Db } from "./db.ts";
import { createAuth, registerAuthRoutes, type Auth } from "./auth/auth.ts";
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
import { appOriginCheck } from "./origin.ts";
import type { Hub } from "./sync/hub.ts";
import { registerSync } from "./sync/routes.ts";

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
  /** Uploads in progress per principal (at most 3 each). */
  uploads: UploadSlots;
}

/** One registered route (a GET also yields its HEAD), as declared: method, URL pattern and schema. */
export interface RouteEntry {
  method: string;
  url: string;
  schema: FastifySchema | undefined;
  websocket: boolean;
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

export async function buildApp(overrides: Partial<Deps> = {}): Promise<FastifyInstance> {
  const config = overrides.config ?? loadConfig();
  const ownsDb = overrides.db === undefined;
  const deps: Deps = {
    config,
    db: overrides.db ?? createDb(config.databaseUrl),
    blobs: overrides.blobs ?? createBlobStore(config),
    social: overrides.social ?? createSocialEvents(),
    conversations: overrides.conversations ?? createConversationEvents(),
    reads: overrides.reads ?? createReadEvents(),
    uploads: overrides.uploads ?? createUploadSlots(),
  };

  const app = Fastify({
    logger: process.env.NODE_ENV === "test" || process.env.VITEST ? false : { level: "info" },
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
  app.addHook("onRoute", (r) => {
    for (const method of [r.method].flat()) {
      routeList.push({ method, url: r.url, schema: r.schema, websocket: Boolean((r as { websocket?: boolean }).websocket) });
    }
  });
  app.decorate("routeList", routeList);

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
  app.decorate("auth", createAuth(config, deps.db));
  if (ownsDb) app.addHook("onClose", async () => deps.db.close());

  // The single source of throttling (Better Auth's own limiter is off): 10 per minute per IP and route.
  await app.register(rateLimit, {
    global: false,
    keyGenerator: (req) => req.ip,
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

  return app;
}
