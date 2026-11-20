// Mentions as the service stores them with a message (`mentions`: `[{id, start, length}]`, `start` and `length` in
// UTF-16 code units of the stored text, ascending, not overlapping, each range beginning with "@"): who a mention means
// is decided once, when the message is sent, and the web never reads mention text to decide it. What is here only
// checks a stored list against its text (to show it), cuts a text into its parts, and — for the composer — keeps the
// ranges of the mentions picked from the @ list right while the text around them is edited, and maps them onto the text
// as it is sent.

/** The most mentions one message carries (the service's `MENTION_LIMIT`). */
export const MENTION_LIMIT = 20;

const isIndex = (n) => Number.isSafeInteger(n) && n >= 0;

/**
 * The stored `mentions` of a message that fit its `text`: each `{id, start, length}` with a string id, inside the text,
 * beginning with "@", in ascending order and not overlapping the one before (one that does is left out), at most
 * MENTION_LIMIT. [] for anything else (a message from before mentions were stored has none).
 */
export function mentionsIn(text, mentions) {
  if (typeof text !== "string" || !Array.isArray(mentions)) return [];
  const out = [];
  let end = 0;
  for (const m of mentions) {
    if (out.length === MENTION_LIMIT) break;
    if (!m || typeof m.id !== "string" || m.id === "" || !isIndex(m.start) || !isIndex(m.length) || m.length < 1) continue;
    if (m.start < end || m.start + m.length > text.length || text[m.start] !== "@") continue;
    out.push({ id: m.id, start: m.start, length: m.length });
    end = m.start + m.length;
  }
  return out;
}

/**
 * `text` cut at its mentions (`mentionsIn`): `[{ text, mention }]` in order, `mention` null for the plain parts; empty
 * parts are left out.
 */
export function mentionSegments(text, mentions) {
  const source = typeof text === "string" ? text : "";
  const parts = [];
  let at = 0;
  for (const m of mentionsIn(source, mentions)) {
    if (m.start > at) parts.push({ text: source.slice(at, m.start), mention: null });
    parts.push({ text: source.slice(m.start, m.start + m.length), mention: m });
    at = m.start + m.length;
  }
  if (at < source.length || parts.length === 0) parts.push({ text: source.slice(at), mention: null });
  return parts.filter((p) => p.text !== "" || parts.length === 1);
}

/** The name a mention shows, for a screen reader: its text without the leading "@" (`提到 Jarvis Lee`). */
export const mentionName = (text) => String(text ?? "").replace(/^@/, "");

// ───────── the composer: ranges kept through edits

/** How long the common start of `a` and `b` is (at most `max`). */
function commonStart(a, b, max) {
  let n = 0;
  while (n < max && a.charCodeAt(n) === b.charCodeAt(n)) n += 1;
  return n;
}

/** How long the common end of `a` and `b` is (at most `max`). */
function commonEnd(a, b, max) {
  let n = 0;
  while (n < max && a.charCodeAt(a.length - 1 - n) === b.charCodeAt(b.length - 1 - n)) n += 1;
  return n;
}

/**
 * What one edit changed, from the text before and after it: `{ start, end, inserted }` — the code units `[start, end)`
 * of `before` were replaced by `inserted`. The smallest such change; where several are as small (a character typed next
 * to the same character: "@Ann" + "n"), the one at `hint` — where the caret or the selection was before the edit
 * (`{start, end}`) — is taken, so typing inside a mention is seen as inside it.
 */
export function editOf(before, after, hint = null) {
  const most = Math.min(before.length, after.length);
  const head = commonStart(before, after, most);
  const tail = commonEnd(before, after, most - head);
  let start = head;
  let end = before.length - tail;
  const size = end - start;
  const candidates = [];
  if (hint && isIndex(hint.start)) {
    candidates.push(hint.start);
    // A deletion with nothing selected ends at the caret (Backspace) — or starts there (Delete, the first candidate).
    if (after.length < before.length && hint.end === hint.start) candidates.push(hint.start - (before.length - after.length));
  }
  for (const at of candidates) {
    if (!isIndex(at) || at >= head) continue;
    const t = commonEnd(before, after, most - at);
    if (before.length - t - at === size) {
      start = at;
      end = before.length - t;
      break;
    }
  }
  return { start, end, inserted: after.slice(start, start + (after.length - before.length) + (end - start)) };
}

/**
 * The composer's tags (`{id, start, length}` in the box's text) after an edit (`editOf`): those before it stay, those
 * after it move with it, one it covers wholly is gone (`removed`, with where it was), and one it only partly covers is
 * no tag any more (`broken`: typing inside a tag turns it back into plain text; a deletion that takes part of a tag is
 * the caller's to widen, `widenDeletion`). An edit touching a tag only at its edge — text typed right before or after
 * it — leaves it whole.
 */
export function retag(tags, edit) {
  const delta = edit.inserted.length - (edit.end - edit.start);
  const kept = [];
  const removed = [];
  const broken = [];
  for (const tag of tags) {
    const end = tag.start + tag.length;
    if (end <= edit.start) kept.push(tag);
    else if (tag.start >= edit.end) kept.push({ ...tag, start: tag.start + delta });
    else if (edit.start <= tag.start && end <= edit.end) removed.push(tag);
    else broken.push(tag);
  }
  return { kept, removed, broken };
}

/**
 * A deletion (nothing inserted) that takes part of a tag takes all of it: the code units to delete instead, `[start,
 * end)` of the text before the edit, covering every tag it touched. Null when it touched none partly.
 */
export function widenDeletion(tags, edit) {
  if (edit.inserted !== "" || edit.end <= edit.start) return null;
  let start = edit.start;
  let end = edit.end;
  let widened = false;
  for (const tag of tags) {
    const tagEnd = tag.start + tag.length;
    const overlaps = tag.start < edit.end && tagEnd > edit.start;
    const whole = edit.start <= tag.start && tagEnd <= edit.end;
    if (!overlaps || whole) continue;
    start = Math.min(start, tag.start);
    end = Math.max(end, tagEnd);
    widened = true;
  }
  return widened ? { start, end } : null;
}

/** The tag whose end is at `caret` (Backspace there takes it), or whose start is (Delete there takes it). */
export const tagEndingAt = (tags, caret) => tags.find((t) => t.start + t.length === caret) ?? null;
export const tagStartingAt = (tags, caret) => tags.find((t) => t.start === caret) ?? null;

// ───────── the text as it is sent

/** What the service removes from a message's text: bidi overrides and isolates (U+202A–U+202E, U+2066–U+2069). */
const isBidi = (unit) => (unit >= 0x202a && unit <= 0x202e) || (unit >= 0x2066 && unit <= 0x2069);
/** What the web drops before sending (the service refuses it): NUL and every other control character but tab and line breaks. */
const isStrayControl = (unit) => (unit < 0x20 && unit !== 0x09 && unit !== 0x0a && unit !== 0x0d) || (unit >= 0x7f && unit <= 0x9f);

/**
 * The text as it is sent — NUL, stray controls and bidi controls removed, lone surrogates replaced (U+FFFD), trimmed:
 * actions.js `sendText`'s rules, which are the service's — and `tags` (`{id, start, length}` in `value`) as ranges of
 * that text: `{ text, mentions }`, the mentions sorted, not overlapping, each beginning with "@", at most MENTION_LIMIT.
 * A tag whose text does not survive as it was (emptied, or no longer at an "@") is left out: it is sent as plain text.
 */
export function cleanWithMentions(value, tags = []) {
  const source = typeof value === "string" ? value : "";
  // position before cleaning → position after it (kept units before it)
  const at = new Array(source.length + 1);
  let cleaned = "";
  for (let i = 0; i < source.length; i += 1) {
    at[i] = cleaned.length;
    const unit = source.charCodeAt(i);
    if (isBidi(unit) || isStrayControl(unit)) continue;
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = source.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        at[i + 1] = cleaned.length + 1;
        cleaned += source[i] + source[i + 1];
        i += 1;
        continue;
      }
      cleaned += "\uFFFD";
      continue;
    }
    cleaned += unit >= 0xdc00 && unit <= 0xdfff ? "\uFFFD" : source[i];
  }
  at[source.length] = cleaned.length;
  const lead = cleaned.length - cleaned.trimStart().length;
  const text = cleaned.trim();
  const sorted = [...(Array.isArray(tags) ? tags : [])].filter((t) => t && isIndex(t.start) && isIndex(t.length)).sort((a, b) => a.start - b.start);
  const mentions = [];
  let end = 0;
  for (const tag of sorted) {
    if (mentions.length === MENTION_LIMIT) break;
    if (tag.start + tag.length > source.length) continue;
    const start = at[tag.start] - lead;
    const stop = at[tag.start + tag.length] - lead;
    if (start < end || stop <= start || stop > text.length || text[start] !== "@") continue;
    mentions.push({ id: tag.id, start, length: stop - start });
    end = stop;
  }
  return { text, mentions };
}
