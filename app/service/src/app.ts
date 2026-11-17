import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance, type FastifyRequest, type FastifySchema } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { z } from "zod";
import { loadConfig, type Config } from "./config.ts";
import { createDb, type Db } from "./db.ts";
import { ANSWER_FLOOR, type AnswerFloor } from "./auth/answer-floor.ts";
import { createAuth, createSessionEvents, registerAuthRoutes, type Auth, type SessionEvents } from "./auth/auth.ts";
import { registerRegistrationRoutes } from "./auth/register.ts";
import { AppError, frameworkErrors, registerErrorHandling } from "./errors.ts";
import { registerSessionRoutes } from "./session.ts";
import { createBlobStore, type BlobStore } from "./attachments/blob.ts";
import { registerBodyDeadline } from "./body-deadline.ts";
import { runSweep, startSweeper } from "./attachments/sweeper.ts";
import { registerAttachmentRoutes } from "./attachments/routes.ts";
import { createUploadSlots, type UploadSlots } from "./attachments/slots.ts";
import { registerAccountRoutes } from "./accounts/routes.ts";
import { createAgentPort, recoverRuns, startStaleRunSweep, sweepStaleRuns, type DbAgentPort } from "./agents/port-impl.ts";
import { registerRunRoutes } from "./agents/run-routes.ts";
import { registerAgentRoutes } from "./agents/routes.ts";
import { createAgentWorker, SHUTDOWN_GRACE_MS, within, type AgentWorker } from "./agents/runtime/worker.ts";
import { registerPrincipalRoutes } from "./principals/routes.ts";
import { createModelGateway, type ModelGateway } from "./models/gateway.ts";
import { registerModelRoutes } from "./models/routes.ts";
import { guardedFetch } from "./providers/guard.ts";
import { createProviderProbe, PROBE_GUARD, type ProviderProbe } from "./providers/probe.ts";
import { registerProviderRoutes } from "./providers/routes.ts";
import { createSocialEvents, type SocialEvents } from "./social/events.ts";
import { registerSocialRoutes } from "./social/routes.ts";
import { createConversationEvents, type ConversationEvents } from "./conversations/events.ts";
import { registerConversationRoutes } from "./conversations/routes.ts";
import { createReadEvents, type ReadEvents } from "./messages/read.ts";
import { registerMessageRoutes } from "./messages/routes.ts";
import { MAX_CONCURRENT_SEARCHES, MAX_SEARCHES_IN_FLIGHT } from "./messages/search.ts";
import { clientIp, perPrincipalLimit } from "./limits.ts";
import { appOriginCheck } from "./origin.ts";
import { createSlots, type Slots } from "./slots.ts";
import type { Hub } from "./sync/hub.ts";
import { registerSync } from "./sync/routes.ts";
import { registerWebClient } from "./web.ts";

/** Everything the app needs from outside; tests override pieces (e.g. raised rate limits). */
export interface Deps {
  config: Config;
  db: Db;
  /** Where avatars and attachments live; tests inject a temp-dir store. */
  blobs: BlobStore;
  /** Per-app registry of "friendships/blocks changed" listeners; fired after commit. */
  social: SocialEvents;
  /** Per-app registry of "messages stored" / "membership changed" listeners; fired after commit. */
  conversations: ConversationEvents;
  /** Per-app registry of "a direct-chat read marker moved" listeners; fired after the update. */
  reads: ReadEvents;
  /** Per-app registry of "a session was deleted" listeners (sign-out, password reset, expiry cleanup). */
  sessions: SessionEvents;
  /** Uploads in progress per principal (at most 3 each). */
  uploads: UploadSlots;
  /** Searches in progress per principal (at most 2 each, 4 for everyone together). */
  searches: Slots;
  /** How `POST /api/providers/:id/test` and `…/models/refresh` reach a provider (default: a GET of its model list through `guardedFetch`). */
  providerProbe: ProviderProbe;
  /** How the service talks to a language model (default: the AI SDK through `guardedFetch`); tests inject a scripted one. */
  models: ModelGateway;
}

/** One registered route (a GET also yields its HEAD), as declared: method, URL pattern and schema. */
export interface RouteEntry {
  method: string;
  url: string;
  schema: FastifySchema | undefined;
  websocket: boolean;
  /** A HEAD Fastify derived from the GET of the same URL (same handler, no body sent). */
  derived: boolean;
}

declare module "fastify" {
  interface FastifyInstance {
    deps: Deps;
    auth: Auth;
    /** The in-process socket registry and push delivery (src/sync/hub.ts). */
    realtime: Hub;
    /** Every route the app serves, in registration order (diagnostics; the fuzz suite walks it). */
    routeList: readonly RouteEntry[];
    /** The reply worker's port (src/agents/port-impl.ts): routes announce runs and reach a run in flight through it. */
    agentPort: DbAgentPort;
    /** The reply worker (src/agents/runtime/worker.ts); with `agentWorker: false` tests run replies with `runOnce()`. */
    agentWorker: AgentWorker;
    /** The stale-run sweep (src/agents/port-impl.ts `sweepStaleRuns`): `run()` sweeps now; the timer does it every minute. */
    staleRunSweep: { run(): Promise<number> };
  }
}

const STATE_CHANGING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** What is not a dependency of the routes: where the log goes. */
export interface BuildOptions {
  /** JSON log lines at info level go here (tests capture them). Default: stdout, and nothing under test. */
  logStream?: { write(line: string): void };
  /** Delay before the first scheduled attachment sweep (default one minute); tests shorten it. */
  sweepInitialDelayMs?: number;
  /** The least time a registration's or reset request's success takes (default `ANSWER_FLOOR`); tests shorten it. */
  answerFloor?: AnswerFloor;
  /**
   * Tests only, and deliberately not configuration (no variable can set it): providers may then be reached at
   * loopback addresses, and over plain `http:` there, so tests can stand up a local stub (src/providers/guard.ts).
   */
  allowInsecureLocal?: boolean;
  /**
   * Tests only: `false` turns the reply worker's background loop off (no polling, no wake-ups); replies then run only
   * when the test calls `app.agentWorker.runOnce()` or `drain()`.
   */
  agentWorker?: false;
  /**
   * The stale-run sweep's timer (default: first a minute after start, then every minute). Tests: `false` turns it off
   * (`app.staleRunSweep.run()` still sweeps by hand), or shorter delays.
   */
  staleRunSweep?: false | { initialDelayMs?: number; intervalMs?: number };
}

/**
 * A URL as it may be logged: without its query string, which carries WebSocket tickets, e-mail
 * verification tokens and search terms. Only `?[redacted]` shows that there was one.
 */
export function redactQuery(url: string): string {
  const q = url.indexOf("?");
  return q < 0 ? url : `${url.slice(0, q)}?[redacted]`;
}

/** Fastify's default request serializer, minus the query string. */
const logSerializers = {
  req: (req: FastifyRequest) => ({
    method: req.method,
    url: redactQuery(req.url),
    host: req.host,
    remoteAddress: clientIp(req),
    remotePort: req.socket?.remotePort,
  }),
};

export async function buildApp(overrides: Partial<Deps> = {}, options: BuildOptions = {}): Promise<FastifyInstance> {
  const config = overrides.config ?? loadConfig();
  const ownsDb = overrides.db === undefined;
  const insecureLocal = options.allowInsecureLocal === true ? { allowInsecureLocal: true } : {};
  // One count of the calls to providers and site models in flight, for every guard the app builds.
  const providerCalls = createSlots(config.providerMaxConcurrentCalls);
  const deps: Deps = {
    config,
    db:
      overrides.db ??
      createDb(config.databaseUrl, { statementTimeoutMs: config.dbStatementTimeoutMs, acquireTimeoutMs: config.dbAcquireTimeoutMs }),
    blobs: overrides.blobs ?? createBlobStore(config),
    social: overrides.social ?? createSocialEvents(),
    conversations: overrides.conversations ?? createConversationEvents(),
    reads: overrides.reads ?? createReadEvents(),
    sessions: overrides.sessions ?? createSessionEvents(),
    uploads: overrides.uploads ?? createUploadSlots(),
    searches: overrides.searches ?? createSlots(MAX_CONCURRENT_SEARCHES, MAX_SEARCHES_IN_FLIGHT),
    providerProbe: overrides.providerProbe ?? createProviderProbe(guardedFetch({ ...PROBE_GUARD, ...insecureLocal, calls: providerCalls })),
    models: overrides.models ?? createModelGateway({ ...insecureLocal, calls: providerCalls }),
  };

  const underTest = process.env.NODE_ENV === "test" || Boolean(process.env.VITEST);
  const app = Fastify({
    logger: options.logStream
      ? { level: "info", stream: options.logStream, serializers: logSerializers }
      : underTest
        ? false
        : { level: "info", serializers: logSerializers },
    trustProxy: config.trustProxy,
    // Server-wide limits (WebSockets are exempt: `ws` clears the socket timeout on upgrade, and an upgraded
    // connection is no longer a request). Uploads run under their own, tighter deadlines (attachments/routes.ts);
    // everything else under the much shorter body deadline (body-deadline.ts), so `requestTimeout` is only the
    // uploads' backstop.
    connectionTimeout: config.httpConnectionTimeoutMs,
    requestTimeout: config.httpRequestTimeoutMs,
    keepAliveTimeout: config.httpKeepAliveTimeoutMs,
    frameworkErrors,
  });
  // Fastify refuses `content-type: application/json` with an empty body (400) before any route runs, but a
  // client that has no fields to send may well say "JSON" and send nothing. An empty body is "no body" (what a
  // request without a content type already is); anything else parses exactly as before, and a route that needs
  // fields still fails its own schema. Routes that declare their own parsers (avatar upload) are unaffected.
  // JSON is UTF-8 (RFC 8259): a body that says it is in another charset is refused (415) rather than read as UTF-8.
  const parseJson = app.getDefaultJsonParser("error", "error");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    const charset = /;\s*charset\s*=\s*"?([^";\s]*)"?/i.exec(req.headers["content-type"] ?? "")?.[1]?.toLowerCase();
    if (charset !== undefined && charset !== "utf-8" && charset !== "utf8") return done(new AppError(415, "invalid_request"), undefined);
    if (body === "") return done(null, undefined);
    parseJson(req, body as string, done);
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandling(app);

  // Before any route: an onRoute hook only sees routes registered after it.
  const routeList: RouteEntry[] = [];
  const getHandlers = new Map<string, unknown>();
  app.addHook("onRoute", (r) => {
    // The web client's wildcard (src/web.ts) is not an API route: the README and the fuzz suite walk this list.
    if (r.config?.webClient) return;
    for (const method of [r.method].flat()) {
      if (method === "GET") getHandlers.set(r.url, r.handler);
      const derived = method === "HEAD" && getHandlers.get(r.url) === r.handler;
      routeList.push({ method, url: r.url, schema: r.schema, websocket: Boolean((r as { websocket?: boolean }).websocket), derived });
    }
  });
  app.decorate("routeList", routeList);

  // Every response: no content sniffing. API JSON is also never cached (a route that sets its own
  // Cache-Control, like attachments and avatars, keeps it). The web client's files set theirs in src/web.ts.
  app.addHook("onSend", async (req, reply, payload) => {
    void reply.header("x-content-type-options", "nosniff");
    const isApi = req.routeOptions.url?.startsWith("/api/") === true;
    const isJson = String(reply.getHeader("content-type") ?? "").startsWith("application/json");
    if ((isApi || isJson) && reply.getHeader("cache-control") === undefined) void reply.header("cache-control", "no-store");
    return payload;
  });

  // Cross-site request forgery: a browser names the page that sent a request in `Origin`. Every
  // state-changing request from any other origin is refused before body parsing or any handler. It
  // deliberately looks at the method only, never at the path: the router decodes the path (`/%61pi/…`
  // reaches `/api/…`), so any decision by the raw URL could be sidestepped. Requests without `Origin`
  // (non-browser clients, same-origin GETs) pass.
  const fromApp = appOriginCheck(config.appOrigin);
  app.addHook("onRequest", async (req) => {
    if (!STATE_CHANGING.has(req.method)) return;
    const origin = req.headers.origin;
    if (origin !== undefined && !fromApp(origin)) throw new AppError(403, "forbidden");
  });

  // Slow bodies: a request must have arrived whole within HTTP_BODY_TIMEOUT_MS, unless it is an upload let in.
  // Armed on the server's `request` event, so it also covers requests refused above or by the router.
  registerBodyDeadline(app, config.httpBodyTimeoutMs);

  app.decorate("deps", deps);
  app.decorate("auth", createAuth(config, deps.db, deps.sessions, app.log));
  if (ownsDb) app.addHook("onClose", async () => deps.db.close());

  // The service is one process by design, so it sweeps unsent uploads and abandoned blobs itself.
  // Registered after the db's close hook: hooks run last-in first-out, so the timer stops (and a run in
  // flight finishes) before the pool closes.
  const sweeper = startSweeper({
    run: () => runSweep(deps, config, app.log),
    intervalMinutes: config.sweepIntervalMinutes,
    ...(options.sweepInitialDelayMs === undefined ? {} : { initialDelayMs: options.sweepInitialDelayMs }),
    log: app.log,
  });
  if (sweeper) app.addHook("onClose", async () => sweeper.stop());

  // The single source of throttling (Better Auth's own limiter is off). Routes that declare
  // `config.rateLimit` are counted per client address (`clientIp`); the rest use limits.ts / createRateLimit.
  await app.register(rateLimit, {
    global: false,
    keyGenerator: clientIp,
    errorResponseBuilder: () => new AppError(429, "rate_limited"),
  });
  const perMinute = { max: Math.max(1, Math.round(10 * config.rateLimitScale)), timeWindow: "1 minute" };

  // First among the routes: it registers the WebSocket plugin, whose route wrapper must see every route
  // (an upgrade request to any other route is then refused instead of answered over the raw socket).
  await registerSync(app);

  // The reply worker runs in this process (one instance, like the hub). Once the app is ready, the runs the previous
  // process left running are recovered and then the worker starts. It stops when the app starts closing, before the hub
  // and the database: calls in flight are abandoned and their runs ended here as recovery would end them, within
  // SHUTDOWN_GRACE_MS (what could not be written by then is left running, for the stale-run sweep or the next start).
  const agentPort = createAgentPort({
    db: deps.db,
    config,
    blobs: deps.blobs,
    realtime: app.realtime,
    conversations: deps.conversations,
    reads: deps.reads,
    log: app.log,
  });
  const agentWorker = createAgentWorker({
    port: agentPort,
    models: deps.models,
    runTimeoutMs: config.agentRunTimeoutMs,
    maxRunsInFlight: config.agentMaxRunsInFlight,
    background: options.agentWorker !== false,
    log: app.log,
  });
  agentPort.onQueued(() => agentWorker.wake());
  app.decorate("agentPort", agentPort);
  app.decorate("agentWorker", agentWorker);
  // The persona drafts this process is working on, by run id: the stale-run sweep leaves them alone, as it does the
  // worker's runs.
  const draftRuns = new Set<string>();
  const staleRunSweep = {
    run: (): Promise<number> => sweepStaleRuns(agentPort, deps.db, config, app.log, (id) => agentWorker.isWorking(id) || draftRuns.has(id)),
  };
  app.decorate("staleRunSweep", staleRunSweep);
  let staleTimer: { stop(): Promise<void> } | undefined;
  app.addHook("onReady", async () => {
    const recovered = await recoverRuns(deps.db, config, app.log);
    if (recovered > 0) app.log.info({ recovered }, "agent runs left running by the previous start were recovered");
    agentWorker.start();
    if (options.staleRunSweep !== false) staleTimer = startStaleRunSweep(() => staleRunSweep.run(), app.log, options.staleRunSweep ?? {});
  });
  app.addHook("onClose", async () => staleTimer?.stop());

  const answerFloor = options.answerFloor ?? ANSWER_FLOOR;
  registerRegistrationRoutes(app, perMinute, answerFloor);
  registerAuthRoutes(app, config.rateLimitScale, answerFloor);
  registerSessionRoutes(app);
  registerPrincipalRoutes(app);
  registerSocialRoutes(app);
  registerConversationRoutes(app);
  registerMessageRoutes(app);
  registerAttachmentRoutes(app);
  registerAccountRoutes(app);
  // One budget for an owner's reads of their Agents, providers and replies (GET /api/agents, /api/agents/:id,
  // /api/providers, /api/conversations/:id/run): 120 a minute together.
  const ownReads = perPrincipalLimit(app, 120);
  const { endDrafts } = registerAgentRoutes(app, { draftRuns, readLimit: ownReads });
  // The service's stop ends what this process was working on — the worker's replies and the persona drafts under way —
  // together, within SHUTDOWN_GRACE_MS (agentWorker.stop bounds itself).
  app.addHook("preClose", async () => {
    await Promise.all([
      within(endDrafts(), SHUTDOWN_GRACE_MS).then((ended) => {
        if (!ended) app.log.warn(`persona drafts not ended within ${SHUTDOWN_GRACE_MS} ms of the stop; their runs stay running until the stale-run sweep or the next start releases them`);
      }),
      agentWorker.stop(),
    ]);
  });
  registerRunRoutes(app, { readLimit: ownReads });
  registerProviderRoutes(app, { allowInsecureLocal: options.allowInsecureLocal === true, readLimit: ownReads });
  registerModelRoutes(app);

  const api = app.withTypeProvider<ZodTypeProvider>();

  api.get(
    "/api/health",
    {
      schema: {
        params: z.object({}),
        querystring: z.object({}),
        response: { 200: z.object({ ok: z.literal(true) }) },
      },
    },
    async () => {
      await deps.db.query("select 1");
      return { ok: true as const };
    },
  );

  // Last: the wildcard must never get ahead of an API route (a more specific route always wins, but be explicit).
  await registerWebClient(app);

  return app;
}
