import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance } from "fastify";
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
import { AppError, registerErrorHandling } from "./errors.ts";
import { registerSessionRoutes } from "./session.ts";
import { createBlobStore, type BlobStore } from "./attachments/blob.ts";
import { registerPrincipalRoutes } from "./principals/routes.ts";
import { createSocialEvents, type SocialEvents } from "./social/events.ts";
import { registerSocialRoutes } from "./social/routes.ts";

/** Everything the app needs from outside; tests override pieces (e.g. raised rate limits). */
export interface Deps {
  config: Config;
  db: Db;
  /** Where avatars (and later attachments) live; tests inject a temp-dir store. */
  blobs: BlobStore;
  /** Per-app registry of "friendships/blocks changed" listeners; fired after commit. */
  social: SocialEvents;
}

declare module "fastify" {
  interface FastifyInstance {
    deps: Deps;
    auth: Auth;
  }
}

export async function buildApp(overrides: Partial<Deps> = {}): Promise<FastifyInstance> {
  const config = overrides.config ?? loadConfig();
  const ownsDb = overrides.db === undefined;
  const deps: Deps = {
    config,
    db: overrides.db ?? createDb(config.databaseUrl),
    blobs: overrides.blobs ?? createBlobStore(config),
    social: overrides.social ?? createSocialEvents(),
  };

  const app = Fastify({
    logger: process.env.NODE_ENV === "test" || process.env.VITEST ? false : { level: "info" },
    trustProxy: config.trustProxy,
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandling(app);

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

  registerRegistrationRoutes(app, perMinute);
  registerAuthRoutes(app, config.rateLimitScale);
  registerSessionRoutes(app);
  registerPrincipalRoutes(app);
  registerSocialRoutes(app);

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
