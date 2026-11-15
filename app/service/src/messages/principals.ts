import { z } from "zod";
import type { Queryable } from "../db.ts";
import type { WireMessage } from "./model.ts";

/** A principal as `GET /api/sync` lists it (and as message reads list the ones their messages name). */
export interface SyncPrincipal {
  id: string;
  handle: string;
  displayName: string;
  kind: "human" | "agent";
}

export const syncPrincipalSchema = z.object({
  id: z.string(),
  handle: z.string(),
  displayName: z.string(),
  kind: z.enum(["human", "agent"]),
});

/** `principals` of a message read: every principal its messages name, by id. */
export const principalMapSchema = z.record(z.string(), syncPrincipalSchema);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Principal ids a rendered message names: its sender, a visible quote's sender, a notice's participants. */
export function mentionedIn(m: WireMessage): string[] {
  const ids: unknown[] = [m.senderId];
  if (m.replyTo?.visible) ids.push(m.replyTo.senderId);
  if (m.system) {
    const { actorId, principalId, newCreatorId, memberIds } = m.system as Record<string, unknown>;
    ids.push(actorId, principalId, newCreatorId, ...(Array.isArray(memberIds) ? memberIds : []));
  }
  return ids.filter((id): id is string => typeof id === "string" && UUID.test(id)).map((id) => id.toLowerCase());
}

/** The principals with these ids (unknown ids are skipped), by handle: the one reader behind `/api/sync` and message reads. */
export async function readPrincipals(q: Queryable, ids: Iterable<string>): Promise<SyncPrincipal[]> {
  const { rows } = await q.query<{ id: string; handle: string; display_name: string; kind: "human" | "agent" }>(
    "select id, handle::text as handle, display_name, kind from principals where id = any($1::uuid[]) order by handle",
    [[...ids]],
  );
  return rows.map((p) => ({ id: p.id, handle: p.handle, displayName: p.display_name, kind: p.kind }));
}

/**
 * Who `messages` name, by id. Pass only messages already rendered for one reader (`toWireFor`): what is
 * named is exactly what that reader's copies show, so nothing about hidden messages or quotes leaks.
 */
export async function principalsOf(q: Queryable, messages: WireMessage[]): Promise<Record<string, SyncPrincipal>> {
  const mentioned = new Set(messages.flatMap(mentionedIn));
  if (mentioned.size === 0) return {};
  return Object.fromEntries((await readPrincipals(q, mentioned)).map((p) => [p.id, p]));
}
