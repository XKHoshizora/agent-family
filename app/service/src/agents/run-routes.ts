import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { notFound } from "../errors.ts";
import { perPrincipalLimit, type PrincipalLimit } from "../limits.ts";
import { uuidParam } from "../schemas.ts";
import { requirePrincipal } from "../session.ts";
import { dismissRun, haltAgents, latestRun, ownedAgentOf, retryRun, stopRun, toWireRun, wireRunSchema } from "./runs.ts";

const empty = z.object({});
const idParams = z.object({ id: uuidParam });
const ok = z.object({ ok: z.literal(true) });

/**
 * The owner's view of their Agent's replies, per conversation (README "Agents and runs"). For anyone else, and for a
 * conversation that is not an Agent's, every route answers the JSON 404 exactly as for an id that does not exist. The
 * one route here that is not the owner's: a group member's halt of Agents calling each other (`…/agents/halt`).
 * `readLimit`: the budget `GET …/run` shares with the owner's other reads of their Agents and providers.
 */
export function registerRunRoutes(app: FastifyInstance, { readLimit }: { readLimit: PrincipalLimit }): void {
  const { db, config, conversations } = app.deps;
  const api = app.withTypeProvider<ZodTypeProvider>();
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
      if (running) {
        // This process's worker stops it within 50 ms. A run nobody here is working on (another instance's, or one left
        // by a process that is gone) would never read the flag: it is released now, as recovery would end it.
        if (app.agentWorker.isWorking(req.params.runId)) app.agentPort.requestStop(req.params.runId);
        else await app.agentPort.releaseRun(req.params.runId);
      }
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

  // Any current member of a group stops Agents calling each other there (runs.ts `haltAgents`); a budget of its own.
  const haltLimit = perPrincipalLimit(app, 20);
  api.post(
    "/api/conversations/:id/agents/halt",
    { schema: { params: idParams, querystring: empty, body: noBody, response: { 200: ok } } },
    async (req) => {
      const me = await requirePrincipal(req);
      await haltLimit(req, me.id);
      const halted = await db.tx((t) => haltAgents(t, req.params.id, me.id));
      // Before answering: the interrupted calls are abandoned, and nothing more of them reaches their owners.
      app.agentPort.interruptRuns(halted.running);
      for (const cancelled of halted.cancelled) app.agentPort.announce(cancelled);
      if (halted.notice) conversations.publish({ messages: [halted.notice], conversations: [] }, req.log);
      return { ok: true as const };
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
