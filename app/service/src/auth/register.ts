import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { APIError } from "better-auth/api";
import { z } from "zod";
import { AppError } from "../errors.ts";
import { displayName } from "../schemas.ts";
import { holdUntilFloor, noteArrival, type AnswerFloor } from "./answer-floor.ts";
import { runInTransaction } from "./auth.ts";
import { lockUsableInvite, markInviteUsed } from "./invites.ts";

const UNIQUE_VIOLATION = "23505";

/** Thrown inside the registration transaction to roll it back when the e-mail already has an account. */
class EmailAlreadyRegistered extends Error {}

export const registerBody = z.object({
  inviteCode: z.string().max(100).optional(),
  email: z.email().max(254),
  password: z.string().min(10).max(128),
  displayName,
  handle: z.string().regex(/^[a-z0-9_]{3,24}$/),
});

export function registerRegistrationRoutes(
  app: FastifyInstance,
  rateLimit: { max: number; timeWindow: string },
  answerFloor: AnswerFloor,
): void {
  const { db, config } = app.deps;
  const api = app.withTypeProvider<ZodTypeProvider>();

  api.post(
    "/api/register",
    {
      config: { rateLimit },
      onRequest: noteArrival,
      schema: {
        params: z.object({}),
        querystring: z.object({}),
        body: registerBody,
        response: { 201: z.object({ ok: z.literal(true) }) },
      },
    },
    async (req, reply) => {
      const { inviteCode, email, password, displayName, handle } = req.body;
      const needsInvite = config.registrationMode === "invite";

      try {
        // One transaction: invite lock, Better Auth's user/account/verification rows (joined to this
        // transaction, see auth.ts), the principal and the invite consumption all commit together.
        await db.tx(async (client) => {
          // The invite first: without one, nothing (not even whether a handle is taken) is revealed.
          if (needsInvite) {
            if (!inviteCode || !(await lockUsableInvite(client, inviteCode))) throw new AppError(400, "invalid_invite");
          }

          const taken = await client.query("select 1 from principals where handle = $1", [handle]);
          if (taken.rowCount) throw new AppError(409, "handle_taken");

          const created = await runInTransaction(client, () =>
            app.auth.api.signUpEmail({
              body: { name: displayName, email, password, callbackURL: `${config.appOrigin}/verify` },
            }),
          );

          // Better Auth answers a taken e-mail with a synthetic user and writes nothing.
          const real = await client.query("select 1 from \"user\" where id = $1", [created.user.id]);
          if (real.rowCount !== 1) throw new EmailAlreadyRegistered();

          let principalId: string;
          try {
            const { rows } = await client.query<{ id: string }>(
              `insert into principals (kind, handle, display_name, auth_user_id)
               values ('human', $1, $2, $3) returning id`,
              [handle, displayName, created.user.id],
            );
            principalId = rows[0]!.id;
          } catch (err) {
            if ((err as { code?: string }).code === UNIQUE_VIOLATION) throw new AppError(409, "handle_taken");
            throw err;
          }
          if (needsInvite) await markInviteUsed(client, inviteCode!, principalId);
        });
      } catch (err) {
        if (err instanceof APIError && err.statusCode >= 400 && err.statusCode < 500) {
          throw new AppError(400, "invalid_request");
        }
        if (!(err instanceof EmailAlreadyRegistered)) throw err;
        // Otherwise the same answer as a successful registration; nothing was written, no invite consumed, no mail sent.
      }
      await holdUntilFloor(req, answerFloor);
      return reply.code(201).send({ ok: true });
    },
  );
}
