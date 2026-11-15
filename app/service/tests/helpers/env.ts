import { config as loadDotenv } from "dotenv";
import { fileURLToPath } from "node:url";

/** Loads app/service/.env and returns the test database URL. */
export function testDatabaseUrl(): string {
  loadDotenv({ path: fileURLToPath(new URL("../../.env", import.meta.url)), quiet: true });
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is not set (see .env.example)");
  return url;
}
