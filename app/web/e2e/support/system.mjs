// The local system under test, run from the Playwright runner process: build the client and the service, give
// the af_e2e database a fresh start, start the model stub (model-stub.mjs), run ONE service process that serves the
// built client and whose site models are the stub, and let test workers stop and start that process and script the
// stub through a small control endpoint (127.0.0.1, random port, random token).
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { startModelStub } from "./model-stub.mjs";
import { BASE_URL, E2E_DATABASE, E2E_PROVIDER_KEY_SECRET, OUTPUT_DIR, PORT, SERVICE_DIR, WEB_DIR, cliEnv, e2eDatabaseUrl, serviceEnv } from "./env.mjs";

/** Everything of one run that is not in the repository: blobs, the pid of the service. Keyed by port. */
const RUN_DIR = path.join(os.tmpdir(), `af-e2e-${PORT}`);
const PID_FILE = path.join(RUN_DIR, "service.pid");
const LOG_FILE = path.join(OUTPUT_DIR, "service.log");
const HEALTH_TIMEOUT_MS = 30_000;
/**
 * The service runs from its test-only entry (app/service/tests/helpers/e2e-server.ts) under tsx's loader, in one
 * process: the production entry cannot reach the local stub (it is plain http on 127.0.0.1), by design.
 */
const SERVICE_ENTRY = path.join(SERVICE_DIR, "tests", "helpers", "e2e-server.ts");
const TSX_LOADER = pathToFileURL(createRequire(path.join(SERVICE_DIR, "package.json")).resolve("tsx")).href;

/** The upstream key of the site models (the stub takes any): a fixed fake value. */
const STUB_KEY = "e2e-site-model-key-not-real";

/**
 * The site's two models, both the stub: a free one and a paid one. Prices are micro-points per token: input is cheap, so
 * a reply charged on its estimate (one stopped before the stub reported its usage: one token per character, and the
 * service's system text is long) costs little; output is dear, so the usage a step reports decides the cost. With the
 * stub's usual usage (model-stub.mjs DEFAULT_USAGE: 20 in, 10 out) a free reply costs 0.1002 of the 1-point daily
 * allowance; agents.spec.mjs reports more to use it up.
 */
function siteModels(baseUrl) {
  const common = { protocol: "openai_chat", baseUrl, apiKeyEnv: "E2E_STUB_MODEL_KEY", maxOutputTokens: 1024, contextTokens: 32_000, vision: false, pdf: false, reasoning: [] };
  return [
    { ...common, id: "e2e-free", label: "演示快速模型", tier: "free", model: "stub-chat", inputMicroPerToken: 10, outputMicroPerToken: 10_000 },
    { ...common, id: "e2e-paid", label: "演示高级模型", tier: "paid", model: "stub-chat", inputMicroPerToken: 10, outputMicroPerToken: 12_000 },
  ];
}

function run(label, command, cwd) {
  const res = spawnSync(command, { cwd, shell: true, encoding: "utf8", windowsHide: true });
  if (res.status !== 0) {
    throw new Error(`${label} failed (exit ${res.status}):\n${(res.stdout ?? "").slice(-4000)}\n${(res.stderr ?? "").slice(-4000)}`);
  }
}

function runCli(args) {
  // cwd outside the repository: the CLI loads a .env from its working directory, and must not find one.
  const res = spawnSync(process.execPath, [path.join(SERVICE_DIR, "dist", "cli.js"), ...args], {
    cwd: os.tmpdir(),
    env: cliEnv(),
    encoding: "utf8",
    windowsHide: true,
  });
  if (res.status !== 0) throw new Error(`service CLI ${args[0]} failed (exit ${res.status}):\n${(res.stderr ?? "").slice(-4000)}`);
  return res.stdout;
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function waitUntil(check, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * A service left behind by a run that crashed (its pid file survived): stop it. Only while its port is still
 * served, so a pid the system has since given to another process is left alone.
 */
async function stopLeftover() {
  let pid = null;
  try {
    pid = Number(readFileSync(PID_FILE, "utf8"));
  } catch {
    return;
  }
  if (Number.isSafeInteger(pid) && pid > 0 && alive(pid) && (await portInUse())) {
    process.kill(pid);
    await waitUntil(() => !alive(pid), 10_000, `the leftover service (pid ${pid}) to exit`);
  }
}

function portInUse() {
  return new Promise((resolve) => {
    const socket = net.connect({ port: PORT, host: "127.0.0.1" });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

async function healthy() {
  try {
    const res = await fetch(`${BASE_URL}/api/health`);
    return res.ok;
  } catch {
    return false;
  }
}

/** Runs the migrations on af_e2e, then empties every table but the migrations' own (the extensions stay). */
async function freshDatabase() {
  runCli(["migrate"]);
  const pg = createRequire(path.join(SERVICE_DIR, "package.json"))("pg");
  const client = new pg.Client({ connectionString: e2eDatabaseUrl() });
  await client.connect();
  try {
    const { rows: db } = await client.query("select current_database() as name");
    if (db[0].name !== E2E_DATABASE) throw new Error(`refusing to empty database ${db[0].name}`);
    const { rows } = await client.query(
      "select format('%I.%I', schemaname, tablename) as t from pg_tables where schemaname = 'public' and tablename <> 'pgmigrations'",
    );
    if (rows.length > 0) await client.query(`truncate ${rows.map((r) => r.t).join(", ")} restart identity cascade`);
  } finally {
    await client.end();
  }
}

/** What a spec may set for the next start of the service (`restart(extra)`): small brakes, nothing else. */
const ADJUSTABLE = new Set(["AGENT_CHAIN_LIMIT"]);

/**
 * The service process. `start()` spawns it (same environment every time, plus what the last `restart(extra)` set) and
 * resolves once `/api/health` answers; `stop()` ends it (a hard stop: on Windows a signal cannot reach Node, so this is
 * how a crash looks); `restart(extra)` stops it and starts it with `extra` (only the ADJUSTABLE variables, as strings)
 * over the base environment — `restart({})` is the base environment again.
 */
function createService(env) {
  let child = null;
  let extra = {};

  async function start() {
    if (child) throw new Error("the service is already running");
    if (await portInUse()) throw new Error(`port ${PORT} is in use; stop whatever listens there or set E2E_PORT`);
    const log = openSync(LOG_FILE, "a");
    try {
      child = spawn(process.execPath, ["--enable-source-maps", "--import", TSX_LOADER, SERVICE_ENTRY], {
        cwd: RUN_DIR,
        env: { ...env, ...extra },
        stdio: ["ignore", log, log],
        windowsHide: true,
      });
    } finally {
      closeSync(log);
    }
    writeFileSync(PID_FILE, String(child.pid));
    const me = child;
    let exited = false;
    me.once("exit", () => {
      exited = true;
      if (child === me) child = null;
    });
    try {
      await waitUntil(async () => {
        if (exited) throw new Error(`the service exited during start-up; see ${LOG_FILE}`);
        return healthy();
      }, HEALTH_TIMEOUT_MS, "the service to answer /api/health");
    } catch (err) {
      await stop();
      throw err;
    }
  }

  async function stop() {
    const me = child;
    if (!me) return;
    if (me.exitCode === null && me.signalCode === null) {
      const exited = new Promise((resolve) => me.once("exit", resolve));
      me.kill();
      await exited;
    }
    if (child === me) child = null;
    rmSync(PID_FILE, { force: true });
    await waitUntil(async () => !(await portInUse()), 10_000, `port ${PORT} to be released`);
  }

  async function restart(next) {
    const chosen = {};
    for (const [key, value] of Object.entries(next ?? {})) {
      if (!ADJUSTABLE.has(key) || typeof value !== "string") throw new Error(`the service's ${key} cannot be set by a spec`);
      chosen[key] = value;
    }
    await stop();
    extra = chosen;
    await start();
  }

  return { start, stop, restart };
}

/**
 * For the workers: POST /stop and POST /start (restart spec), answered once the step is done; POST /restart with a JSON
 * body `{env}` (the service's `restart`: e.g. a small AGENT_CHAIN_LIMIT for one spec, `{}` for the base again); POST
 * /stub/<command> with a JSON body, the model stub's `control` (model-stub.mjs), answered with its JSON.
 */
function startControl(service, stub) {
  const token = randomBytes(24).toString("hex");
  let queue = Promise.resolve();
  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || req.headers["x-e2e-token"] !== token) {
      res.writeHead(404).end();
      return;
    }
    const failed = (err) => res.writeHead(500, { "content-type": "text/plain" }).end(String(err?.message ?? err));
    if (req.url.startsWith("/stub/")) {
      const parts = [];
      req.on("data", (c) => parts.push(c));
      req.on("end", () => {
        try {
          const raw = Buffer.concat(parts).toString("utf8");
          const answer = stub.control(req.url.slice("/stub/".length), raw ? JSON.parse(raw) : {});
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(answer));
        } catch (err) {
          failed(err);
        }
      });
      return;
    }
    if (req.url === "/restart") {
      const parts = [];
      req.on("data", (c) => parts.push(c));
      req.on("end", () => {
        let env;
        try {
          const raw = Buffer.concat(parts).toString("utf8");
          env = (raw ? JSON.parse(raw) : {}).env ?? {};
        } catch (err) {
          failed(err);
          return;
        }
        queue = queue.then(() => service.restart(env)).then(() => res.writeHead(204).end(), failed);
      });
      return;
    }
    const step = req.url === "/stop" ? service.stop : req.url === "/start" ? service.start : null;
    if (!step) {
      res.writeHead(404).end();
      return;
    }
    req.resume();
    queue = queue.then(step).then(() => res.writeHead(204).end(), failed);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ url: `http://127.0.0.1:${server.address().port}`, token, close: () => new Promise((done) => server.close(done)) });
    });
  });
}

/**
 * Builds and starts everything; returns the teardown. Skips the two builds when E2E_SKIP_BUILD=1 (only for
 * re-running against builds made a moment ago).
 */
export async function startLocalSystem() {
  await stopLeftover();
  rmSync(RUN_DIR, { recursive: true, force: true });
  mkdirSync(path.join(RUN_DIR, "blobs"), { recursive: true });
  mkdirSync(OUTPUT_DIR, { recursive: true });

  if (process.env.E2E_SKIP_BUILD !== "1") {
    run("web client build", "npm run build", WEB_DIR);
    run("service build", "npm run build", SERVICE_DIR);
  }
  await freshDatabase();

  const stub = await startModelStub();
  const service = createService(
    serviceEnv({
      // The test-only entry starts only so, and only on af_e2e (e2e-server.ts).
      NODE_ENV: "test",
      DATABASE_URL: e2eDatabaseUrl(),
      APP_ORIGIN: BASE_URL,
      AUTH_SECRET: randomBytes(36).toString("base64url"),
      PROVIDER_KEY_SECRET: E2E_PROVIDER_KEY_SECRET,
      BLOB_DIR: path.join(RUN_DIR, "blobs"),
      WEB_DIST: path.join(WEB_DIR, "dist"),
      PORT: String(PORT),
      HOST: "127.0.0.1",
      REGISTRATION_MODE: "invite",
      MAIL_MODE: "outbox",
      // The suite signs up and signs in far more often than a person; it must never meet a limit.
      RATE_LIMIT_SCALE: "1000",
      SWEEP_INTERVAL_MINUTES: "0",
      E2E_SITE_MODELS: JSON.stringify(siteModels(stub.baseUrl)),
      E2E_STUB_MODEL_KEY: STUB_KEY,
      // Small, so a few replies use it up (agents.spec.mjs).
      FREE_DAILY_POINTS: "1",
      // tsx compiles the service's TypeScript with the service's own settings.
      TSX_TSCONFIG_PATH: path.join(SERVICE_DIR, "tsconfig.json"),
    }),
  );
  let control;
  try {
    await service.start();
    control = await startControl(service, stub);
  } catch (err) {
    await service.stop();
    await stub.close();
    throw err;
  }
  // Workers are started after global setup and inherit these.
  process.env.E2E_CONTROL_URL = control.url;
  process.env.E2E_CONTROL_TOKEN = control.token;
  process.env.E2E_STUB_URL = stub.baseUrl;

  return async function teardown() {
    await control.close();
    await service.stop();
    await stub.close();
    rmSync(RUN_DIR, { recursive: true, force: true });
  };
}
