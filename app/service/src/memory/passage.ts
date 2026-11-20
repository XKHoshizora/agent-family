import type { Queryable } from "../db.ts";
import { NO_GROUP_TITLE, type PromptNotes } from "../agents/runtime/prompt.ts";
import { notesFor } from "./store.ts";

/**
 * What a group the Agent's owner is no longer a member of is called in the passage: neither the title it had (it is not
 * kept) nor its title now (renames after the owner left are not theirs to learn).
 */
export const LEFT_GROUP_TITLE = "一个已离开的群";

/**
 * What a run is given of its Agent's memory (`notesFor`'s answer, rule for rule), with each piece of hearsay carrying
 * the title of the group it was said in — read here for just the conversations `notesFor` returned, and only while the
 * Agent's owner is a current member there (else `LEFT_GROUP_TITLE`); a group that has no title is
 * `某个群`. `notesPassage` (agents/runtime/prompt.ts) turns the result into text.
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
    const { rows } = await q.query<{ id: string; title: string | null; member: boolean }>(
      `select c.id, c.title, exists (select 1 from memberships m where m.conversation_id = c.id and m.principal_id = $2 and m.left_seq is null) as member
         from conversations c where c.id = any($1::uuid[])`,
      [ids, agent.ownerId],
    );
    for (const r of rows) {
      if (!r.member) titles.set(r.id, LEFT_GROUP_TITLE);
      else if (r.title !== null && r.title !== "") titles.set(r.id, r.title);
    }
  }
  return { ...found, hearsay: found.hearsay.map((h) => ({ ...h, group: titles.get(h.conversationId) ?? NO_GROUP_TITLE })) };
}
