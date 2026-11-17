import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { perPrincipalLimit } from "../limits.ts";
import { chargeSource, headroom, readHolds } from "../metering/admit.ts";
import { requirePrincipal } from "../session.ts";
import { formatPoints, freeUsedToday, nextSiteMidnight, siteDayStart } from "./store.ts";

/** How many site-days `recent` covers, today included. */
const RECENT_DAYS = 7;

const usageResponse = z.object({
  tier: z.string(),
  agentLimit: z.number(),
  agentCount: z.number(),
  balance: z.string(),
  free: z.object({ allowance: z.string(), used: z.string(), resetsAt: z.string() }),
  canStartFreeReply: z.boolean(),
  recent: z.array(
    z.object({
      agentId: z.string().nullable(),
      model: z.string(),
      source: z.enum(["site", "provider"]),
      points: z.string(),
      replies: z.number(),
    }),
  ),
});

/** Read-only: nothing under /api/usage changes a balance; credits are granted only by the operator's CLI. */
export function registerAccountRoutes(app: FastifyInstance): void {
  const { db, config } = app.deps;
  const api = app.withTypeProvider<ZodTypeProvider>();
  // A read of several tables per call: 60 a minute each.
  const readLimit = perPrincipalLimit(app, 60);

  api.get(
    "/api/usage",
    {
      schema: {
        params: z.object({}),
        // Strict on purpose: no parameter may name another owner.
        querystring: z.strictObject({}),
        response: { 200: usageResponse },
      },
    },
    async (req) => {
      const me = await requirePrincipal(req);
      await readLimit(req, me.id);
      const now = new Date();
      const [account, agents, used, holds, recent] = await Promise.all([
        db.query<{ tier: string; balance_micro: string }>("select tier, balance_micro::text from accounts where principal_id = $1", [me.id]),
        db.query<{ n: number }>(
          `select count(*)::int as n
             from principals p join agents a on a.principal_id = p.id
            where p.kind = 'agent' and p.owner_id = $1 and a.deleted_at is null`,
          [me.id],
        ),
        freeUsedToday(db, me.id, now, config.siteTimezone),
        readHolds(db, me.id),
        db.query<{ agent_id: string | null; model: string; source: "site" | "provider"; points: string; replies: number }>(
          // What the person was charged (the allowance and the balance), not the true cost: what was forgiven is not
          // theirs to see as spent.
          `select agent_id, model, source, sum(free_micro + balance_micro)::text as points,
                  (count(*) filter (where purpose = 'reply'))::int as replies
             from usage_records
            -- A run settled without reaching a model has no model to list (and cost nothing).
            where owner_id = $1 and created_at >= $2 and source is not null
            group by agent_id, model, source
            order by sum(free_micro + balance_micro) desc, model, source, agent_id`,
          [me.id, siteDayStart(now, config.siteTimezone, RECENT_DAYS - 1)],
        ),
      ]);
      // An account with no row yet is a free-tier account with nothing in it; reading never creates one.
      const tier = account.rows[0]?.tier ?? "free";
      const balanceMicro = BigInt(account.rows[0]?.balance_micro ?? "0");
      return {
        tier,
        // A tier the configuration no longer names gets the free limit.
        agentLimit: config.agentTiers[tier] ?? config.agentTiers.free!,
        agentCount: agents.rows[0]!.n,
        balance: formatPoints(balanceMicro),
        free: {
          allowance: formatPoints(config.freeDailyMicro),
          used: formatPoints(used),
          resetsAt: nextSiteMidnight(now, config.siteTimezone).toISOString(),
        },
        // Admission's own rule (src/metering/admit.ts), running calls' holds included; read without the lock.
        canStartFreeReply: chargeSource("free", headroom({ freeDailyMicro: config.freeDailyMicro, freeUsedMicro: used, balanceMicro, holds })) !== null,
        recent: recent.rows.map((r) => ({
          agentId: r.agent_id,
          model: r.model,
          source: r.source,
          points: formatPoints(BigInt(r.points)),
          replies: r.replies,
        })),
      };
    },
  );
}
