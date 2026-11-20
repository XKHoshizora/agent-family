import type { Queryable } from "../db.ts";

/** The most distinct handles one message can call (README "Agents and runs", In a group). */
export const MENTION_LIMIT = 20;

/**
 * `@` not preceded by a word character, then the whole run of word characters after it and, when a `.` and another run
 * follow, that run too: `@owner.name` (family names, Task N). Nothing follows the second `+`, the first run cannot give
 * up a character to a `.` (it is no word character), and a global match resumes after what it took, so each character is
 * looked at a bounded number of times: linear in the text, whatever it holds (long runs of `@`, `.` or word characters
 * included).
 */
const MENTION = /(?<![A-Za-z0-9_])@([A-Za-z0-9_]+)(?:\.([A-Za-z0-9_]+))?/g;

/**
 * The handles `text` calls (plan ruling 6; family names): `@handle` on a token boundary — not preceded or followed by
 * `[A-Za-z0-9_]` — either the full form of an Agent's handle, `owner.name` (an owner's handle of 3 to 24 of those
 * characters, a dot, a name part of 2 to 24), or a bare one of 2 to 24 (a person's handle, or an Agent's name part:
 * `resolveMentions` says whose). A `.` not followed by such a character is punctuation (`ask @xiaolin.jarvis.` calls
 * `xiaolin.jarvis`), and only one dot counts (`@abc.def.ghi` calls `abc.def`; `.ghi` is text). Out of those lengths on
 * either side: nobody. Matched case-insensitively and returned lower-cased, distinct, in the order they first appear; at
 * most the first `MENTION_LIMIT`. `@anna_2` calls `anna_2`, never `anna`; `mail@anna` calls nobody. Pure: no lookup, so a
 * text that calls nobody costs no query.
 */
export function mentionedHandles(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(MENTION)) {
    const [, first, name] = match as unknown as [string, string, string | undefined];
    const fits = name === undefined ? first.length >= 2 && first.length <= 24 : first.length >= 3 && first.length <= 24 && name.length >= 2 && name.length <= 24;
    if (!fits) continue;
    const lower = (name === undefined ? first : `${first}.${name}`).toLowerCase();
    if (found.includes(lower)) continue;
    found.push(lower);
    if (found.length === MENTION_LIMIT) break;
  }
  return found;
}

/**
 * Whom in conversation `conversationId` each of `handles` (`mentionedHandles`) calls, by handle: the current Agent
 * members (not deleted) it names. `owner.name` names the Agent with name part `name` of the person whose handle is
 * `owner` now (a handle they gave up names nobody). A bare `name` names nobody when a current member is the person with
 * that handle (people first), else the one current Agent member with that name part — nobody when two or more are, as
 * for a handle nobody here has. An Agent's own message is read the same way: one of two `jarvis` is itself. One query
 * over the conversation's current members, none when there is nothing to look up. Handles that call nobody are absent.
 */
export async function resolveMentions(q: Queryable, conversationId: string, handles: readonly string[]): Promise<Map<string, string>> {
  const called = new Map<string, string>();
  const wanted = [...new Set(handles)];
  if (wanted.length === 0) return called;
  // What a principal's own handle may be: a bare handle, or the name part of a full one.
  const parts = [...new Set(wanted.map((h) => h.slice(h.indexOf(".") + 1)))];
  const { rows } = await q.query<{ id: string; kind: "human" | "agent"; handle: string; owner: string | null }>(
    `select p.id, p.kind, lower(p.handle::text) as handle, lower(o.handle::text) as owner
       from memberships m
       join principals p on p.id = m.principal_id
       left join principals o on o.id = p.owner_id
      where m.conversation_id = $1 and m.left_seq is null and p.handle = any($2::citext[])
        and not exists (select 1 from agents a where a.principal_id = p.id and a.deleted_at is not null)`,
    [conversationId, parts],
  );
  for (const handle of wanted) {
    const dot = handle.indexOf(".");
    if (dot >= 0) {
      const agent = rows.find((r) => r.kind === "agent" && `${r.owner}.${r.handle}` === handle);
      if (agent) called.set(handle, agent.id);
      continue;
    }
    if (rows.some((r) => r.kind === "human" && r.handle === handle)) continue;
    const agents = rows.filter((r) => r.kind === "agent" && r.handle === handle);
    if (agents.length === 1) called.set(handle, agents[0]!.id);
  }
  return called;
}
