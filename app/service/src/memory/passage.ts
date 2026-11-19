import type { Queryable } from "../db.ts";
import { NO_GROUP_TITLE, type PromptNotes } from "../agents/runtime/prompt.ts";
import { notesFor } from "./store.ts";

/**
 * What a run is given of its Agent's memory (`notesFor`'s answer, rule for rule), with each piece of hearsay carrying
 * the title of the group it was said in — read here for just the conversations `notesFor` returned; a group that is gone
 * or has no title is `某个群`. `notesPassage` (agents/runtime/prompt.ts) turns the result into text.
 */
export async function loadNotes(
  q: Queryable,
  agent: { id: string; ownerId: string; memory: boolean; sharedNotes: boolean },
  where: { conversationId: string; group: boolean },
): Promise<PromptNotes> {
  const found = await notesFor(q, agent, where);
  const ids = [...new Set(found.hearsay.map((h) => h.conversationId))];
  const titles = new Map<string, string>();
  if (ids.length > 0) {
    const { rows } = await q.query<{ id: string; title: string | null }>("select id, title from conversations where id = any($1::uuid[])", [ids]);
    for (const r of rows) if (r.title !== null && r.title !== "") titles.set(r.id, r.title);
  }
  return { ...found, hearsay: found.hearsay.map((h) => ({ ...h, group: titles.get(h.conversationId) ?? NO_GROUP_TITLE })) };
}
