// A reply's citations (〔m3〕 for a message, 〔f2〕 for a file; the service's design rule 4) are links inside the message
// itself (ui/cites.jsx), and nothing wherever else a reply's text is shown as a line: the chat list's preview, search hits,
// a quote, the reply chip. The rule is the service's (app/service/src/agents/tools/refs.ts `withoutCitations`), and both
// are held to the shared table app/shared/citation-cases.json.

/** What a citation holds between its brackets: a letter m or f (any case) and a number of 1 to 6 digits, spaces around. */
const INSIDE = /^\s*[mMfF]\s*[1-9][0-9]{0,5}\s*$/;

/**
 * `text` without any citation — also one written with spaces or a capital letter, and one built around another
 * (`〔m〔m1〕1〕`), which leaves none behind — in ONE pass, in time proportional to the text however it nests: the text is
 * copied, keeping where each `〔` that may still open a citation stands in the copy; at a `〕`, what follows the last such
 * `〔` is a citation's inside or not — a citation is taken out of the copy (a `〔` before it may still open one); anything
 * else stays, and then no `〔` before it can open one any more.
 */
export function withoutCitations(text) {
  if (typeof text !== "string" || !text.includes("〕")) return text;
  const out = [];
  const opens = [];
  for (const ch of text) {
    if (ch === "〔") {
      opens.push(out.length);
      out.push(ch);
    } else if (ch === "〕" && opens.length > 0) {
      const at = opens[opens.length - 1];
      if (INSIDE.test(out.slice(at + 1).join(""))) {
        out.length = at;
        opens.pop();
      } else {
        opens.length = 0;
        out.push(ch);
      }
    } else out.push(ch);
  }
  return out.join("");
}
