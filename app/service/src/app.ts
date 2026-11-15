import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { z } from "zod";
import { loadConfig, type Config } from "./config.ts";
import { createDb, type Db } from "./db.ts";
import { registerErrorHandling } from "./errors.ts";

/** Everything the app needs from outside; tests override pieces (e.g. raised rate limits). */
export interface Deps {
  config: Config;
  db: Db;
}

declare module "fastify" {
  interface FastifyInstance {
    deps: Deps;
  }
}

export async function buildApp(overrides: Partial<Deps> = {}): Promise<FastifyInstance> {
  const config = overrides.config ?? loadConfig();
  const ownsDb = overrides.db === undefined;
  const deps: Deps = { config, db: overrides.db ?? createDb(config.databaseUrl) };

  const app = Fastify({
    logger: process.env.NODE_ENV === "test" || process.env.VITEST ? false : { level: "info" },
    trustProxy: true,
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandling(app);

  app.decorate("deps", deps);
  if (ownsDb) app.addHook("onClose", async () => deps.db.close());

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
