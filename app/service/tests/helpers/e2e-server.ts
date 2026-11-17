// The browser suite's service (app/web/e2e; e2e/support/system.mjs starts it with tsx): src/server.ts with two
// differences, both for the suite's local model stub. Its site models come from E2E_SITE_MODELS and point at the stub
// (http on 127.0.0.1, which SITE_MODELS refuses), and the app is built with `allowInsecureLocal`, the build option no
// configuration can set, without which the service calls no loopback address. It is test code only: the production
// build compiles src/ alone (tsconfig.build.json), and it refuses to start unless NODE_ENV is `test` and its database
// is one whose name ends in `_e2e` (tests/e2e-entry.test.ts).
import { buildApp } from "../../src/app.ts";
import { loadConfig, type Config } from "../../src/config.ts";
import { normaliseBaseUrl } from "../../src/providers/guard.ts";

type Env = Record<string, string | undefined>;

/** Why this environment may not run the e2e service, or null when it may. */
function refusal(env: Env): string | null {
  if (env.NODE_ENV !== "test") return "the e2e service starts only with NODE_ENV=test";
  let database = "";
  try {
    database = decodeURIComponent(new URL(env.DATABASE_URL ?? "").pathname.replace(/^\/+/, ""));
  } catch {
    // (not a URL: no database name)
  }
  if (!database.endsWith("_e2e")) return "the e2e service starts only on a database whose name ends in _e2e";
  return null;
}

/** What a site model's address is while `loadConfig` checks everything else of it. */
const CHECKED_ELSEWHERE = "https://e2e-site-model.invalid/v1";

/**
 * The configuration from `env`, then the site models of E2E_SITE_MODELS (a JSON array of SITE_MODELS entries). They are
 * checked by `loadConfig`'s own rules except for their address, which must instead be an http(s) URL on 127.0.0.1.
 */
function e2eConfig(env: Env): Config {
  let models: unknown;
  try {
    models = JSON.parse(env.E2E_SITE_MODELS ?? "[]");
  } catch {
    throw new Error("E2E_SITE_MODELS must be valid JSON");
  }
  if (!Array.isArray(models)) throw new Error("E2E_SITE_MODELS must be a JSON array");
  const addresses = models.map((m: { baseUrl?: unknown }, i) => {
    const url = typeof m?.baseUrl === "string" ? normaliseBaseUrl(m.baseUrl, true) : null;
    if (url === null || new URL(url).hostname !== "127.0.0.1") throw new Error(`E2E_SITE_MODELS: entry ${i} needs a baseUrl on 127.0.0.1`);
    return url;
  });
  const config = loadConfig({ ...env, SITE_MODELS: JSON.stringify(models.map((m: object) => ({ ...m, baseUrl: CHECKED_ELSEWHERE }))) });
  config.siteModels = config.siteModels.map((m, i) => ({ ...m, baseUrl: addresses[i]! }));
  return config;
}

const why = refusal(process.env);
if (why !== null) {
  console.error(why);
  process.exit(1);
}

const config = e2eConfig(process.env);
// (NODE_ENV=test silences the app's own log; the suite keeps it, as src/server.ts would write it.)
const app = await buildApp({ config }, { allowInsecureLocal: true, logStream: process.stdout });

const shutdown = async (): Promise<void> => {
  await app.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ port: config.port, host: config.host });
