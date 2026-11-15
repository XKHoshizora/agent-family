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

export function createDb(databaseUrl: string): Db {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
  // An idle client error must not crash the process.
  pool.on("error", () => {});
  return {
    pool,
    query: ((...args: unknown[]) => (pool.query as (...a: unknown[]) => unknown)(...args)) as pg.Pool["query"],
    tx: (fn) => tx(pool, fn),
    close: () => pool.end(),
  };
}
