import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach } from "vitest";
import { buildApp, type BuildOptions, type Deps } from "../../src/app.ts";
import { loadConfig } from "../../src/config.ts";
import { createDb, type Db } from "../../src/db.ts";
import { testDatabaseUrl } from "./env.ts";

const MIGRATIONS_TABLE = "pgmigrations";

async function truncateAll(db: Db): Promise<void> {
  const { rows } = await db.query<{ t: string }>(
    `select format('%I.%I', schemaname, tablename) as t
       from pg_tables
      where schemaname = 'public' and tablename <> $1`,
    [MIGRATIONS_TABLE],
  );
  if (rows.length === 0) return;
  await db.query(`truncate ${rows.map((r) => r.t).join(", ")} restart identity cascade`);
}

/**
 * No answer floor (`BuildOptions.answerFloor`): registrations and reset requests answer as soon as they are done.
 * What `useApp()` uses unless a test asks for a floor; pass it to an app a test builds itself.
 */
export const NO_ANSWER_FLOOR = { ms: 0, jitterMs: 0 } as const;

/**
 * Builds the app once per test file (against TEST_DATABASE_URL, with rate limits
 * raised and no answer floor) and truncates every table except the migrations table before each test.
 * `app` is a stable handle that forwards to the instance built in beforeAll.
 */
export function useApp(
  extra: Partial<Pick<Deps, "blobs" | "uploads">> & { env?: Record<string, string> } & BuildOptions = {},
): { app: FastifyInstance; db: Db } {
  const { env, logStream, sweepInitialDelayMs, answerFloor = NO_ANSWER_FLOOR, ...overrides } = extra;
  const options: BuildOptions = {
    answerFloor,
    ...(logStream ? { logStream } : {}),
    ...(sweepInitialDelayMs === undefined ? {} : { sweepInitialDelayMs }),
  };
  let instance: FastifyInstance | undefined;
  let database: Db | undefined;
  const current = <T>(v: T | undefined): T => {
    if (!v) throw new Error("useApp(): app is only available inside tests and hooks");
    return v;
  };
  const forward = <T extends object>(get: () => T): T =>
    new Proxy({} as T, {
      get(_t, prop) {
        const target = get();
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

  beforeAll(async () => {
    const config = loadConfig({
      ...process.env,
      DATABASE_URL: testDatabaseUrl(),
      AUTH_SECRET: "test-secret-test-secret-test-secret-0000",
      PROVIDER_KEY_SECRET: "test-provider-key-secret-0000000000",
      APP_ORIGIN: "http://localhost:5173",
      RATE_LIMIT_SCALE: "1000",
      SWEEP_INTERVAL_MINUTES: "0", // no background timer unless a test asks for one
      ...env,
    });
    database = createDb(config.databaseUrl, { statementTimeoutMs: config.dbStatementTimeoutMs, acquireTimeoutMs: config.dbAcquireTimeoutMs });
    instance = await buildApp({ config, db: database, ...overrides }, options);
    await instance.ready();
  });

  beforeEach(async () => {
    await truncateAll(current(database));
  });

  afterAll(async () => {
    await instance?.close();
    await database?.close();
  });

  return { app: forward(() => current(instance)), db: forward(() => current(database)) };
}
