/** The most distinct handles one message can call (README "Agents and runs", In a group). */
export const MENTION_LIMIT = 20;

/**
 * `@` not preceded by a word character, then the whole run of word characters after it. Nothing follows the `+`, and a
 * global match resumes after the run, so each character is looked at a bounded number of times: linear in the text,
 * whatever it holds (a long run of `@` or of word characters included).
 */
const MENTION = /(?<![A-Za-z0-9_])@([A-Za-z0-9_]+)/g;

/**
 * The handles `text` calls (plan ruling 6): `@handle` on a token boundary — not preceded or followed by `[A-Za-z0-9_]` —
 * with a handle of 3 to 24 of those characters, matched case-insensitively and returned lower-cased, distinct, in the
 * order they first appear; at most the first `MENTION_LIMIT`. `@anna_2` calls `anna_2`, never `anna`; `mail@anna`
 * calls nobody. Pure: no lookup, so a text that calls nobody costs no query.
 */
export function mentionedHandles(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(MENTION)) {
    const handle = match[1]!;
    if (handle.length < 3 || handle.length > 24) continue;
    const lower = handle.toLowerCase();
    if (found.includes(lower)) continue;
    found.push(lower);
    if (found.length === MENTION_LIMIT) break;
  }
  return found;
}
