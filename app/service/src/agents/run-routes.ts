import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { notFound } from "../errors.ts";
import { perPrincipalLimit } from "../limits.ts";
import { uuidParam } from "../schemas.ts";
import { requirePrincipal } from "../session.ts";
import { dismissRun, latestRun, ownedAgentOf, retryRun, stopRun, toWireRun, wireRunSchema } from "./runs.ts";

const empty = z.object({});
const idParams = z.object({ id: uuidParam });
const ok = z.object({ ok: z.literal(true) });

/**
 * The owner's view of their Agent's replies, per conversation (README "Agents and runs"). For anyone else, and for a
 * conversation that is not an Agent's, every route answers the JSON 404 exactly as for an id that does not exist.
 */
export function registerRunRoutes(app: FastifyInstance): void {
  const { db, config } = app.deps;
  const api = app.withTypeProvider<ZodTypeProvider>();
  const readLimit = perPrincipalLimit(app, 120);
  // Stop, retry and dismiss share one budget; a retry also counts toward the replies one may start a minute.
  const writeLimit = perPrincipalLimit(app, 60);
  const noBody = empty.nullish();

  api.get(
    "/api/conversations/:id/run",
    { schema: { params: idParams, querystring: empty, response: { 200: z.object({ run: wireRunSchema.nullable() }) } } },
    async (req) => {
      const me = await requirePrincipal(req);
      await readLimit(req, me.id);
      if (!(await ownedAgentOf(db, me.id, req.params.id))) throw notFound();
      const run = await latestRun(db, req.params.id);
      // A failure the owner dismissed is no longer shown.
      return { run: run && !(run.status === "failed" && run.dismissed_at !== null) ? toWireRun(run) : null };
    },
  );

  api.post(
    "/api/conversations/:id/runs/:runId/stop",
    { schema: { params: z.object({ id: uuidParam, runId: uuidParam }), querystring: empty, body: noBody, response: { 200: ok } } },
    async (req) => {
      const me = await requirePrincipal(req);
      await writeLimit(req, me.id);
      const { stopped, running } = await db.tx((t) => stopRun(t, me.id, req.params.id, req.params.runId));
      if (stopped) app.agentPort.announce(stopped);
      if (running) app.agentPort.requestStop(req.params.runId);
      return { ok: true as const };
    },
  );

  api.post(
    "/api/conversations/:id/runs/retry",
    { schema: { params: idParams, querystring: empty, body: noBody, response: { 201: z.object({ run: wireRunSchema }) } } },
    async (req, reply) => {
      const me = await requirePrincipal(req);
      await writeLimit(req, me.id);
      const queued = await db.tx((t) => retryRun(t, me.id, req.params.id, config));
      app.agentPort.announce(queued);
      return reply.code(201).send({ run: queued.run });
    },
  );

  api.post(
    "/api/conversations/:id/runs/dismiss",
    { schema: { params: idParams, querystring: empty, body: noBody, response: { 200: ok } } },
    async (req) => {
      const me = await requirePrincipal(req);
      await writeLimit(req, me.id);
      await dismissRun(db, me.id, req.params.id);
      return { ok: true as const };
    },
  );
}
