// Where the suite runs and what it talks to. Local mode (the default) runs the real service on a port of its
// own; remote mode (E2E_BASE_URL set) talks to a deployed environment and starts nothing.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

export const E2E_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const WEB_DIR = path.resolve(E2E_DIR, "..");
export const SERVICE_DIR = path.resolve(WEB_DIR, "..", "service");
/** Playwright's output directory (git-ignored); the local service writes its log here. */
export const OUTPUT_DIR = path.join(E2E_DIR, "test-results");

const remoteBase = (process.env.E2E_BASE_URL ?? "").trim().replace(/\/+$/, "");

/** True when the suite runs against a deployed environment (E2E_BASE_URL). */
export const REMOTE = remoteBase !== "";
/** The local service's port (8787 and 5273 belong to the developer's servers). */
export const PORT = Number(process.env.E2E_PORT ?? 8911);
/** The one origin the browsers talk to: pages, API and WebSocket. */
export const BASE_URL = REMOTE ? remoteBase : `http://127.0.0.1:${PORT}`;
/** The database the local suite owns. Never af_dev or af_test. */
export const E2E_DATABASE = "af_e2e";

/**
 * The local suite's database URL: the server, role and password of TEST_DATABASE_URL (the environment, else
 * app/service/.env) with the database name replaced by af_e2e. Never printed.
 */
export function e2eDatabaseUrl() {
  let source = process.env.TEST_DATABASE_URL;
  if (!source) {
    let text;
    try {
      text = readFileSync(path.join(SERVICE_DIR, ".env"), "utf8");
    } catch {
      throw new Error("TEST_DATABASE_URL is not set and app/service/.env cannot be read");
    }
    source = parseEnv(text).TEST_DATABASE_URL;
  }
  if (!source) throw new Error("TEST_DATABASE_URL is missing from app/service/.env");
  const url = new URL(source);
  url.pathname = `/${E2E_DATABASE}`;
  return url.toString();
}

/** Service configuration variables a developer's shell might carry; the suite sets its own or none. */
const SERVICE_KEYS = [
  "DATABASE_URL",
  "TEST_DATABASE_URL",
  "APP_ORIGIN",
  "AUTH_SECRET",
  "BLOB_DIR",
  "WEB_DIST",
  "PORT",
  "HOST",
  "S3_ENDPOINT",
  "S3_REGION",
  "S3_BUCKET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "REGISTRATION_MODE",
  "MAIL_MODE",
  "RATE_LIMIT_SCALE",
  "CLIENT_IP_HEADER",
  "TRUST_PROXY",
  "ATTACHMENT_QUOTA_BYTES",
  "UPLOAD_IDLE_TIMEOUT_MS",
  "UPLOAD_TOTAL_TIMEOUT_MS",
  "HTTP_CONNECTION_TIMEOUT_MS",
  "HTTP_REQUEST_TIMEOUT_MS",
  "HTTP_KEEP_ALIVE_TIMEOUT_MS",
  "DB_STATEMENT_TIMEOUT_MS",
  "DB_ACQUIRE_TIMEOUT_MS",
  "SEARCH_STATEMENT_TIMEOUT_MS",
  "SWEEP_INTERVAL_MINUTES",
];

/** The process environment without any service configuration or suite variable, plus `extra`. */
export function serviceEnv(extra) {
  const env = { ...process.env };
  for (const key of SERVICE_KEYS) delete env[key];
  for (const key of Object.keys(env)) if (key.startsWith("E2E_")) delete env[key];
  return { ...env, ...extra };
}

/** Environment for the service's CLI (migrate, invite:create, inbox:list) against af_e2e. */
export const cliEnv = () => serviceEnv({ DATABASE_URL: e2eDatabaseUrl() });
