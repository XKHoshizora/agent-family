import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { fromNodeHeaders } from "better-auth/node";
import { z } from "zod";
import { authCall } from "./auth/auth.ts";
import type { Queryable } from "./db.ts";
import { AppError } from "./errors.ts";

export interface Principal {
  id: string;
  handle: string;
  displayName: string;
  email: string;
  sessionId: string;
}

/**
 * The only way a handler learns who is acting: the session cookie, resolved by Better Auth.
 * Throws 401 `unauthenticated` for no/expired/revoked sessions, unverified e-mail, or a user without a principal;
 * a busy database is 503 `busy` (authCall), as everywhere.
 */
export async function requirePrincipal(req: FastifyRequest): Promise<Principal> {
  const session = await authCall(() => req.server.auth.api.getSession({ headers: fromNodeHeaders(req.headers) }));
  if (!session || !session.user.emailVerified) throw new AppError(401, "unauthenticated");
  const { rows } = await req.server.deps.db.query<{ id: string; handle: string; display_name: string }>(
    "select id, handle, display_name from principals where auth_user_id = $1",
    [session.user.id],
  );
  const row = rows[0];
  if (!row) throw new AppError(401, "unauthenticated");
  return {
    id: row.id,
    handle: row.handle,
    displayName: row.display_name,
    email: session.user.email,
    sessionId: session.session.id,
  };
}

/**
 * Which of `sessionIds` still exist and have not expired. Sign-out and password reset delete the row
 * (and announce it through `onSessionEnded`); expiry only shows here, so long-lived connections ask.
 */
export async function liveSessions(q: Queryable, sessionIds: string[]): Promise<Set<string>> {
  if (sessionIds.length === 0) return new Set();
  const { rows } = await q.query<{ id: string }>(
    `select id from "session" where id = any($1::text[]) and "expiresAt" > now()`,
    [sessionIds],
  );
  return new Set(rows.map((r) => r.id));
}

export function registerSessionRoutes(app: FastifyInstance): void {
  const api = app.withTypeProvider<ZodTypeProvider>();
  api.get(
    "/api/me",
    {
      schema: {
        params: z.object({}),
        querystring: z.object({}),
        response: {
          200: z.object({ id: z.string(), handle: z.string(), displayName: z.string(), email: z.string() }),
        },
      },
    },
    async (req) => {
      const p = await requirePrincipal(req);
      return { id: p.id, handle: p.handle, displayName: p.displayName, email: p.email };
    },
  );
}
