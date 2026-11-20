// An Agent's stored mentions in its rendered Markdown. The Markdown worker gets the text, not the mentions: each
// mention's range is put between marks — U+FDD0 before it, then U+FDD2 + its index (which of the message's mentions
// it is), and U+FDD1 after it, all Unicode noncharacters — so the parser keeps each range where it is, and the tree's
// texts carry the marks to the main thread (Markdown.jsx), which shows the marked part as a tag meaning that mention's
// id. Any such character already in a text is taken out before (AgentText.jsx; fix round 1, M-1): the only marks the
// worker sees are these. A mention inside an address — right after `/`, in a URL or a link's target — is not marked
// (the service stores none there since fix round 1, I-3; an older message may hold one), so no mark ever lands in a link;
// the worker drops any from an address all the same (markdownPipeline.js `link`). Inside code and maths a mark is only
// taken out: a mention there is plain text.
import { addressRanges, inAddress } from "../data/mentions.js";

const OPEN = String.fromCharCode(0xfdd0);
const CLOSE = String.fromCharCode(0xfdd1);
/** The first index mark: U+FDD2 + the mention's index (at most 20 mentions: U+FDD2–U+FDE5). */
const INDEX = 0xfdd2;
/** Every noncharacter of U+FDD0–U+FDEF: the marks and the indexes, and nothing a text needs. */
const MARKS = /[\uFDD0-\uFDEF]/g;

/** `text` without any mark (U+FDD0–U+FDEF). */
export const withoutMarks = (text) => (/[\uFDD0-\uFDEF]/.test(text) ? text.replace(MARKS, "") : text);

/**
 * `text` without any mark it holds itself, and `mentions` (ranges of `text`) moved onto what is left: a forged mark
 * hides only itself, never the text's stored mentions (fix round 2, M-4). `{ text, mentions }`.
 */
export function withoutMarksKeeping(text, mentions) {
  if (!/[\uFDD0-\uFDEF]/.test(text)) return { text, mentions };
  const at = new Array(text.length + 1);
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    at[i] = out.length;
    if (!/[\uFDD0-\uFDEF]/.test(text[i])) out += text[i];
  }
  at[text.length] = out.length;
  const moved = (Array.isArray(mentions) ? mentions : [])
    .filter((m) => m && Number.isSafeInteger(m.start) && Number.isSafeInteger(m.length) && m.start >= 0 && m.start + m.length <= text.length)
    .map((m) => ({ id: m.id, start: at[m.start], length: at[m.start + m.length] - at[m.start] }));
  return { text: out, mentions: moved };
}

/**
 * `text` (holding no mark) with each of `mentions` (in order, not overlapping: data/mentions.js `mentionsIn`) between
 * the marks, its index after the first: `OPEN INDEX+k @name CLOSE`. A mention right after a backslash (`\@anna`, the
 * Markdown escape of @) is marked from the backslash, so the escape still works and the tag shows no backslash (M-10).
 * A mention inside an address (`inAddress`) is left unmarked.
 */
export function markMentions(text, mentions) {
  if (!Array.isArray(mentions) || mentions.length === 0) return text;
  // The text's addresses, found once for all its mentions (fix round 2, I-4).
  const addresses = addressRanges(text);
  let out = "";
  let at = 0;
  mentions.forEach((m, k) => {
    if (inAddress(text, m.start, m.length, addresses)) return;
    const from = text[m.start - 1] === "\\" && m.start - 1 >= at ? m.start - 1 : m.start;
    out += `${text.slice(at, from)}${OPEN}${String.fromCharCode(INDEX + k)}${text.slice(from, m.start + m.length)}${CLOSE}`;
    at = m.start + m.length;
  });
  return out + text.slice(at);
}

/**
 * A text of the tree cut at its marked mentions: strings, and `{ text, index }` for each mention whose marks are all in
 * this one text with an "@" right after them (a mark left alone — a mention the Markdown split — is taken out).
 */
export function mentionParts(text) {
  if (!/[\uFDD0-\uFDEF]/.test(text)) return [text];
  const parts = [];
  let plain = "";
  for (let at = 0; at < text.length; ) {
    const open = text.indexOf(OPEN, at);
    if (open === -1) {
      plain += withoutMarks(text.slice(at));
      break;
    }
    plain += withoutMarks(text.slice(at, open));
    const index = text.charCodeAt(open + 1) - INDEX;
    const close = text.indexOf(CLOSE, open + 2);
    const next = text.indexOf(OPEN, open + 1);
    if (index < 0 || index > 0xfdef - INDEX || close === -1 || (next !== -1 && next < close) || text[open + 2] !== "@") {
      at = open + 1;
      continue;
    }
    if (plain !== "") parts.push(plain);
    plain = "";
    parts.push({ text: withoutMarks(text.slice(open + 2, close)), index });
    at = close + 1;
  }
  if (plain !== "") parts.push(plain);
  return parts;
}
