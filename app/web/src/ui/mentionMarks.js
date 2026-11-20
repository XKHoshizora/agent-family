// An Agent's stored mentions in its rendered Markdown. The Markdown worker gets the text, not the mentions: each
// mention's range is put between two marks — U+FDD0 before it, U+FDD1 after it, Unicode noncharacters, which no text a
// reply stores holds (a text that does is sent unmarked: its tags are shown only while it is plain) — so the parser
// keeps each range where it is, and the tree's texts carry the marks to the main thread (Markdown.jsx), which shows the
// marked part as a tag. Inside code and maths a mark is only taken out: a mention there is plain text, as the service,
// which reads no typed mention inside code, would not have stored one there.

const OPEN = String.fromCharCode(0xfdd0);
const CLOSE = String.fromCharCode(0xfdd1);

/** `text` with each of `mentions` (in order, not overlapping: data/mentions.js `mentionsIn`) between the two marks. */
export function markMentions(text, mentions) {
  if (!Array.isArray(mentions) || mentions.length === 0 || text.includes(OPEN) || text.includes(CLOSE)) return text;
  let out = "";
  let at = 0;
  for (const m of mentions) {
    out += `${text.slice(at, m.start)}${OPEN}${text.slice(m.start, m.start + m.length)}${CLOSE}`;
    at = m.start + m.length;
  }
  return out + text.slice(at);
}

/** A text of the tree without the marks. */
export const withoutMarks = (text) => (text.includes(OPEN) || text.includes(CLOSE) ? text.replaceAll(OPEN, "").replaceAll(CLOSE, "") : text);

/**
 * A text of the tree cut at its marked mentions: strings, and `{ text }` for each mention whose two marks are in this one
 * text with an "@" right after the first (a mark left alone — a mention the Markdown split — is taken out).
 */
export function mentionParts(text) {
  if (!text.includes(OPEN) && !text.includes(CLOSE)) return [text];
  const parts = [];
  let plain = "";
  for (let at = 0; at < text.length; ) {
    const open = text.indexOf(OPEN, at);
    if (open === -1) {
      plain += withoutMarks(text.slice(at));
      break;
    }
    plain += withoutMarks(text.slice(at, open));
    const close = text.indexOf(CLOSE, open + 1);
    const next = text.indexOf(OPEN, open + 1);
    if (close === -1 || (next !== -1 && next < close) || text[open + 1] !== "@") {
      at = open + 1;
      continue;
    }
    if (plain !== "") parts.push(plain);
    plain = "";
    parts.push({ text: text.slice(open + 1, close) });
    at = close + 1;
  }
  if (plain !== "") parts.push(plain);
  return parts;
}
