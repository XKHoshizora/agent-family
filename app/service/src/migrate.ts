import { runner } from "node-pg-migrate";
import { fileURLToPath } from "node:url";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));

export async function runMigrations(databaseUrl: string, opts: { quiet?: boolean } = {}): Promise<void> {
  const quiet = opts.quiet ?? false;
  await runner({
    databaseUrl,
    dir: MIGRATIONS_DIR,
    direction: "up",
    migrationsTable: "pgmigrations",
    count: Infinity,
    log: quiet ? () => {} : (msg: string) => console.log(msg),
  });
}
