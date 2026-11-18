// The browser suite's service (app/web/e2e; e2e/support/system.mjs starts it with tsx): src/server.ts with two
// differences, both for the suite's local stubs. Its site models come from E2E_SITE_MODELS and its judgement model from
// E2E_JUDGE, and point at the stubs (http on 127.0.0.1, which SITE_MODELS and JUDGE refuse), and the app is built with
// `allowInsecureLocal`, the build option no configuration can set, without which the service calls no loopback address
// (neither a model nor the judgement model). It is test code only: the production
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
/** What a judgement channel's address is while `loadConfig` checks everything else of `JUDGE`. */
const JUDGE_CHECKED_ELSEWHERE = "https://e2e-judge.invalid/v1/judge";

/** `address` (an http(s) URL) normalised as the service stores one, when it is on 127.0.0.1; else null. */
function localAddress(address: unknown): string | null {
  const url = typeof address === "string" ? normaliseBaseUrl(address, true) : null;
  return url !== null && new URL(url).hostname === "127.0.0.1" ? url : null;
}

/**
 * The configuration from `env`, then the site models of E2E_SITE_MODELS (a JSON array of SITE_MODELS entries) and the
 * judgement model of E2E_JUDGE (a JUDGE object; when set it replaces JUDGE). They are checked by `loadConfig`'s own rules
 * except for their addresses, which must instead be http(s) URLs on 127.0.0.1.
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
    const url = localAddress(m?.baseUrl);
    if (url === null) throw new Error(`E2E_SITE_MODELS: entry ${i} needs a baseUrl on 127.0.0.1`);
    return url;
  });
  let judge: { channels?: unknown } | null = null;
  if (env.E2E_JUDGE) {
    try {
      judge = JSON.parse(env.E2E_JUDGE) as { channels?: unknown };
    } catch {
      throw new Error("E2E_JUDGE must be valid JSON");
    }
    if (typeof judge !== "object" || judge === null || !Array.isArray(judge.channels)) throw new Error("E2E_JUDGE must be a JUDGE object with channels");
  }
  const channels: unknown[] = judge === null ? [] : (judge.channels as unknown[]);
  const judgeAddresses = channels.map((c, i) => {
    const url = localAddress((c as { url?: unknown } | null)?.url);
    if (url === null) throw new Error(`E2E_JUDGE: channel ${i} needs a url on 127.0.0.1`);
    return url;
  });
  const config = loadConfig({
    ...env,
    SITE_MODELS: JSON.stringify(models.map((m: object) => ({ ...m, baseUrl: CHECKED_ELSEWHERE }))),
    ...(judge === null ? {} : { JUDGE: JSON.stringify({ ...judge, channels: channels.map((c) => ({ ...(c as object), url: JUDGE_CHECKED_ELSEWHERE })) }) }),
  });
  config.siteModels = config.siteModels.map((m, i) => ({ ...m, baseUrl: addresses[i]! }));
  if (config.judge !== null && judge !== null) config.judge = { ...config.judge, channels: config.judge.channels.map((c, i) => ({ ...c, url: judgeAddresses[i]! })) };
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
