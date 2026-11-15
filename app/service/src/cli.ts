import { config as loadDotenv } from "dotenv";
import { runMigrations } from "./migrate.ts";

loadDotenv({ quiet: true });

const command = process.argv[2];
if (command === "migrate") {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  await runMigrations(url);
} else {
  console.error("usage: cli.ts migrate");
  process.exit(1);
}
