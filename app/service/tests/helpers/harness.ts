import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach } from "vitest";
import { buildApp, type BuildOptions, type Deps } from "../../src/app.ts";
import { loadConfig, type Config } from "../../src/config.ts";
import { createDb, type Db } from "../../src/db.ts";
import { testDatabaseUrl } from "./env.ts";

const MIGRATIONS_TABLE = "pgmigrations";

/**
 * The clock the reviewer's timers run on in tests (`memory: true`): nothing sleeps. `advance(ms)` moves `now()` and
 * fires, in order of due time, every timer that has come due. `reset()` forgets every timer and puts the clock back on
 * the wall clock.
 */
export interface TestClock {
  now(): number;
  setTimer(fn: () => void, ms: number): { clear(): void };
  advance(ms: number): void;
  /** Timers waiting. */
  timers(): number;
  reset(): void;
}

export function testClock(): TestClock {
  let offset = 0;
  const waiting = new Set<{ at: number; fn: () => void }>();
  const now = (): number => Date.now() + offset;
  return {
    now,
    setTimer(fn, ms) {
      const timer = { at: now() + ms, fn };
      waiting.add(timer);
      return { clear: () => void waiting.delete(timer) };
    },
    advance(ms) {
      offset += ms;
      for (;;) {
        const due = [...waiting].filter((t) => t.at <= now()).sort((a, b) => a.at - b.at)[0];
        if (!due) return;
        waiting.delete(due);
        due.fn();
      }
    },
    timers: () => waiting.size,
    reset() {
      waiting.clear();
      offset = 0;
    },
  };
}

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
 * `env` is the app's configuration and, while the file runs, also set in `process.env` (restored after), as it would
 * be in production: what is read when used rather than at start-up (a site model's key, `resolveModel`) sees it too.
 * `allowInsecureLocal` lets the app's providers reach a local stub over plain HTTP (src/providers/guard.ts).
 * `models` replaces the model gateway (a `scriptedGateway()` from helpers/models.ts), `providerProbe` how the provider
 * routes reach a provider, `judge` the judgement model (`scriptedJudge()` from helpers/judge.ts). `agentWorker: false` turns the
 * reply worker's background loop off: the test then runs replies itself with `app.agentWorker.runOnce()`. The stale-run
 * sweep's timer is off unless `staleRunSweep` asks for it (`app.staleRunSweep.run()` sweeps by hand). So is the
 * proactive scheduler unless `proactive` asks for it (`{}`, or `{ delayMs }` for a shorter wait; built only when the
 * judgement model is configured, `config.judge`): `app.deps.proactive` is null otherwise.
 * `config` replaces fields of the loaded configuration, past `loadConfig`'s rules (a file that needs a value they
 * refuse, such as a connection timeout of under a second, for what it tests; nothing else is affected).
 * `app` is a stable handle that forwards to the instance built in beforeAll.
 */
export function useApp(
  extra: Partial<Pick<Deps, "blobs" | "uploads" | "models" | "providerProbe" | "judge">> & { env?: Record<string, string>; config?: Partial<Config> } & Omit<BuildOptions, "memory"> & { memory?: boolean } = {},
): { app: FastifyInstance; db: Db; clock: TestClock } {
  const { env, config: configured, logStream, sweepInitialDelayMs, answerFloor = NO_ANSWER_FLOOR, allowInsecureLocal, agentWorker, staleRunSweep = false, proactive = false, memory = false, ...overrides } =
    extra;
  const clock = testClock();
  const options: BuildOptions = {
    answerFloor,
    staleRunSweep,
    proactive,
    memory: memory ? { now: clock.now, setTimer: clock.setTimer } : false,
    ...(logStream ? { logStream } : {}),
    ...(sweepInitialDelayMs === undefined ? {} : { sweepInitialDelayMs }),
    ...(allowInsecureLocal ? { allowInsecureLocal } : {}),
    ...(agentWorker === false ? { agentWorker } : {}),
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

  const previous = new Map<string, string | undefined>();
  beforeAll(async () => {
    for (const [name, value] of Object.entries(env ?? {})) {
      previous.set(name, process.env[name]);
      process.env[name] = value;
    }
    const loaded = {
      ...loadConfig({
        ...process.env,
        DATABASE_URL: testDatabaseUrl(),
        AUTH_SECRET: "test-secret-test-secret-test-secret-0000",
        PROVIDER_KEY_SECRET: "test-provider-key-secret-0000000000",
        APP_ORIGIN: "http://localhost:5173",
        RATE_LIMIT_SCALE: "1000",
        SWEEP_INTERVAL_MINUTES: "0", // no background timer unless a test asks for one
        ...env,
      }),
      ...configured,
    };
    // Nor the memory-change sweep's own timer, unless the file's MEMORY names `changesSweepMs`.
    const asked = (env?.MEMORY ?? "").includes("changesSweepMs") || configured?.memory?.changesSweepMs !== undefined;
    const config = asked ? loaded : { ...loaded, memory: { ...loaded.memory, changesSweepMs: 0 } };
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
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  return { app: forward(() => current(instance)), db: forward(() => current(database)), clock };
}
