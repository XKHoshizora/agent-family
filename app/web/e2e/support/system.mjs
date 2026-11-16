// The local system under test, run from the Playwright runner process: build the client and the service, give
// the af_e2e database a fresh start, run ONE service process that serves the built client, and let test workers
// stop and start that process through a small control endpoint (127.0.0.1, random port, random token).
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { BASE_URL, E2E_DATABASE, OUTPUT_DIR, PORT, SERVICE_DIR, WEB_DIR, cliEnv, e2eDatabaseUrl, serviceEnv } from "./env.mjs";

/** Everything of one run that is not in the repository: blobs, the pid of the service. Keyed by port. */
const RUN_DIR = path.join(os.tmpdir(), `af-e2e-${PORT}`);
const PID_FILE = path.join(RUN_DIR, "service.pid");
const LOG_FILE = path.join(OUTPUT_DIR, "service.log");
const HEALTH_TIMEOUT_MS = 30_000;

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

/**
 * The service process. `start()` spawns it (same environment every time) and resolves once `/api/health`
 * answers; `stop()` ends it (a hard stop: on Windows a signal cannot reach Node, so this is how a crash looks).
 */
function createService(env) {
  let child = null;

  async function start() {
    if (child) throw new Error("the service is already running");
    if (await portInUse()) throw new Error(`port ${PORT} is in use; stop whatever listens there or set E2E_PORT`);
    const log = openSync(LOG_FILE, "a");
    try {
      child = spawn(process.execPath, ["--enable-source-maps", path.join(SERVICE_DIR, "dist", "server.js")], {
        cwd: RUN_DIR,
        env,
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

  return { start, stop };
}

/** POST /stop and POST /start for the workers (restart spec); answered once the step is done. */
function startControl(service) {
  const token = randomBytes(24).toString("hex");
  let queue = Promise.resolve();
  const server = http.createServer((req, res) => {
    const step = req.url === "/stop" ? service.stop : req.url === "/start" ? service.start : null;
    if (req.method !== "POST" || !step || req.headers["x-e2e-token"] !== token) {
      res.writeHead(404).end();
      return;
    }
    queue = queue.then(step).then(
      () => res.writeHead(204).end(),
      (err) => res.writeHead(500, { "content-type": "text/plain" }).end(String(err?.message ?? err)),
    );
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

  const service = createService(
    serviceEnv({
      DATABASE_URL: e2eDatabaseUrl(),
      APP_ORIGIN: BASE_URL,
      AUTH_SECRET: randomBytes(36).toString("base64url"),
      BLOB_DIR: path.join(RUN_DIR, "blobs"),
      WEB_DIST: path.join(WEB_DIR, "dist"),
      PORT: String(PORT),
      HOST: "127.0.0.1",
      REGISTRATION_MODE: "invite",
      MAIL_MODE: "outbox",
      // The suite signs up and signs in far more often than a person; it must never meet a limit.
      RATE_LIMIT_SCALE: "1000",
      SWEEP_INTERVAL_MINUTES: "0",
    }),
  );
  await service.start();
  let control;
  try {
    control = await startControl(service);
  } catch (err) {
    await service.stop();
    throw err;
  }
  // Workers are started after global setup and inherit these.
  process.env.E2E_CONTROL_URL = control.url;
  process.env.E2E_CONTROL_TOKEN = control.token;

  return async function teardown() {
    await control.close();
    await service.stop();
    rmSync(RUN_DIR, { recursive: true, force: true });
  };
}
