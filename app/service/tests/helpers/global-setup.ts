import { runMigrations } from "../../src/migrate.ts";
import { testDatabaseUrl } from "./env.ts";

/** Runs once before the whole suite, against TEST_DATABASE_URL only. */
export default async function setup(): Promise<void> {
  await runMigrations(testDatabaseUrl(), { quiet: true });
}
