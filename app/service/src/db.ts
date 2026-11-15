import pg from "pg";

export type Queryable = Pick<pg.Pool, "query">;

/** A client inside `db.tx(...)`: everything on it runs in the caller's transaction. */
export type Tx = pg.PoolClient;

export interface Db extends Queryable {
  readonly pool: pg.Pool;
  /** Runs `fn` in one transaction; commits on return, rolls back on throw. */
  tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export async function tx<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (err) {
    try {
      await client.query("rollback");
    } catch {
      // connection is broken; the original error is the useful one
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Default `statement_timeout` of a pool (`DB_STATEMENT_TIMEOUT_MS`). */
export const DEFAULT_STATEMENT_TIMEOUT_MS = 30_000;
/** Default wait for a pool connection (`DB_ACQUIRE_TIMEOUT_MS`). */
export const DEFAULT_ACQUIRE_TIMEOUT_MS = 10_000;

/**
 * The app's pool of 10 connections. Every connection has `statement_timeout` set, so no statement (lock
 * waits included) runs longer than `statementTimeoutMs`; a transaction may lower it for itself with
 * `set_config(…, true)`. Time between statements does not count: an upload streaming its body, or a sweep
 * deleting a blob inside its transaction, is not cut off by it. Whoever waits longer than `acquireTimeoutMs`
 * for a connection gets an error instead (`isBusy`, errors.ts). Migrations run on their own connection.
 */
export function createDb(
  databaseUrl: string,
  {
    statementTimeoutMs = DEFAULT_STATEMENT_TIMEOUT_MS,
    acquireTimeoutMs = DEFAULT_ACQUIRE_TIMEOUT_MS,
  }: { statementTimeoutMs?: number; acquireTimeoutMs?: number } = {},
): Db {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 10,
    statement_timeout: statementTimeoutMs,
    connectionTimeoutMillis: acquireTimeoutMs,
  });
  // An idle client error must not crash the process.
  pool.on("error", () => {});
  return {
    pool,
    query: ((...args: unknown[]) => (pool.query as (...a: unknown[]) => unknown)(...args)) as pg.Pool["query"],
    tx: (fn) => tx(pool, fn),
    close: () => pool.end(),
  };
}
