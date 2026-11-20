// Mentions as the service stores them with a message (`mentions`: `[{id, start, length}]`, `start` and `length` in
// UTF-16 code units of the stored text, ascending, not overlapping, each range beginning with "@"): who a mention means
// is decided once, when the message is sent, and the web never reads mention text to decide it. What is here only
// checks a stored list against its text (to show it), cuts a text into its parts, and — for the composer — keeps the
// ranges of the mentions picked from the @ list right while the text around them is edited, and maps them onto the text
// as it is sent.

import { MESSAGE_DROPPED } from "../auth/validation.js";

/** The most mentions one message carries (the service's `MENTION_LIMIT`). */
export const MENTION_LIMIT = 20;

/**
 * An address — a URL (a scheme and `://`, or `www.`, up to white space or `<` `>`) or a Markdown link's target (`](` up
 * to `)` or white space): a name inside one is not someone addressed (the service's `ADDRESS_PATTERN`,
 * agents/mentions.ts; fix round 1, I-3). The same pattern, character for character: both test suites assert the shared
 * table app/shared/address-cases.json. A scheme is tried only where a run of its characters begins, so a long run of
 * letters is passed once — linear in the text (fix round 2, I-4).
 *
 * (The lookbehind needs Safari 16.4 / iOS 16.4, Chrome and Edge 62, Firefox 78; the build's target is the floor, README.)
 */
export const ADDRESS_PATTERN = /(?:(?<![A-Za-z0-9+.-])[A-Za-z][A-Za-z0-9+.-]*:\/\/|www\.)[^\s<>]*|\]\([^)\s]*/g;

/** `[start, end)` of each of `tags` (`{start, length}`). */
const rangesOf = (tags) => tags.map((t) => [t.start, t.start + t.length]);

/**
 * `text` with every character of `taken` (the tags' ranges, `[start, end)`) as `_`: a tag's own text is never read as an
 * address — a person named `www.anna` or `a://b` is picked like anyone, the tag is decided by its id (tidy round, m-6) —
 * while an address that runs into a tag still holds it (`_` is no scheme character, no white space, no `<` `>` `)`).
 */
function withTagsHidden(text, taken) {
  if (taken.length === 0) return text;
  let out = "";
  let at = 0;
  for (const [a, b] of [...taken].sort((x, y) => x[0] - y[0])) {
    const from = Math.max(a, at);
    const to = Math.min(b, text.length);
    if (to <= from) continue;
    out += text.slice(at, from) + "_".repeat(to - from);
    at = to;
  }
  return out + text.slice(at);
}

/** The addresses of `text` as `[start, end)`, in order; the text of `taken` (the tags' ranges) is never read as one. */
export const addressRanges = (text, taken = []) => [...withTagsHidden(String(text ?? ""), taken).matchAll(ADDRESS_PATTERN)].map((m) => [m.index, m.index + m[0].length]);

/**
 * Whether `[start, start + length)` of `text` is part of an address: right after a `/`, or overlapping one of `ranges`
 * (the text's `addressRanges`, found once by the caller for all of its mentions). The service's `inAddress` is the same
 * test (the shared table).
 */
export const inAddress = (text, start, length, ranges = addressRanges(text)) => text[start - 1] === "/" || ranges.some(([a, b]) => start < b && start + length > a);

/**
 * `mentions` (`{start, length}`, of `text`) but those in an address (`inAddress`; their own text never read as one):
 * a stored message's, shown as tags in its plain and its rendered text alike (tidy round, m-10), and the composer's at
 * send. The same list when none is (and nothing looked for when there are none).
 */
export function outsideAddresses(text, mentions) {
  if (mentions.length === 0) return mentions;
  const ranges = addressRanges(text, rangesOf(mentions));
  const kept = mentions.filter((m) => !inAddress(text, m.start, m.length, ranges));
  return kept.length === mentions.length ? mentions : kept;
}

const isIndex = (n) => Number.isSafeInteger(n) && n >= 0;

/**
 * The stored `mentions` of a message that fit its `text`: each `{id, start, length}` with a string id, inside the text,
 * beginning with "@", in ascending order and not overlapping the one before (one that does is left out), at most
 * `limit` (MENTION_LIMIT). [] for anything else (a message from before mentions were stored has none).
 */
export function mentionsIn(text, mentions, limit = MENTION_LIMIT) {
  if (typeof text !== "string" || !Array.isArray(mentions)) return [];
  const out = [];
  let end = 0;
  for (const m of mentions) {
    if (out.length === limit) break;
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
 * after it move with it, one it covers wholly is gone (`removed`), and one it lands inside of — a part of it, or an
 * insertion between its first and last character — is `broken` (`afterEdit` takes all of it). An edit touching a tag
 * only at its edge — text typed right before or after it — leaves it whole.
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

/** Deletions that took tags, kept so undo can bring them back: the newest this many. */
const REMOVALS_KEPT = 20;

/**
 * The composer's state (`{ text, tags, removals }`) once its box's text became `value` (by the browser, or by the
 * composer itself), as one pure step (fix round 1, M-8):
 * - the edit is found (`editOf`, the caret or selection before it, `hint`, deciding between equally small ones);
 * - **tags are atomic** (M-3): an edit that lands inside a tag — part of it, or text put between its characters by a
 *   paste or any other change — takes the whole tag, keeping what it put in (`caret`: where the caret goes, as the text
 *   is then the composer's, not the browser's). While an IME composes (`composing`) the text is never rewritten: such a
 *   tag is kept as a `broken` range of what is left of it, moved with the edits, and cut when the composition ends
 *   (`settleEdits`), so no half of a tag is ever left as plain text to be read at send;
 * - the other tags move with the edit or go with what it took (`retag`);
 * - the browser's own undo and redo (`history`: the input's `historyUndo` / `historyRedo`) are never rewritten (the
 *   browser's undo stack is the user's): a tag such an edit lands inside is dropped and remembered, the text as the
 *   browser made it (undoing a pick leaves the `@` typed before it);
 * - undo or redo putting back exactly a text that a deletion took, where it took it, brings back the tags it held; and
 *   an undo or redo that puts back, at its place, the text of a tag one dropped (a pick undone, then redone) brings
 *   that tag back (`removals`, moved with every later edit; found in the browser on a real undo/redo);
 * - a tag being picked (`picking`: `{id, start, length, text}`) is added once the text holds it at its place.
 * Returns `{ text, tags, removals, caret, picked, added, removed }`: `caret` null unless the text was rewritten,
 * `picked` whether `picking` was added, `added` and `removed` the tags' texts for the screen reader.
 */
export function afterEdit(state, value, { hint = null, composing = false, history = false, picking = null } = {}) {
  const before = state;
  let edit = editOf(before.text, value, hint);
  let text = value;
  let caret = null;
  const inside = (tag) => {
    const end = tag.start + tag.length;
    return edit.start < end && edit.end > tag.start && !(edit.start <= tag.start && end <= edit.end);
  };
  const touched = before.tags.filter(inside);
  const broken = [];
  // (Tags an undo or redo landed inside: dropped, the text left as the browser made it, remembered for the redo.)
  const dropped = history ? touched.filter((t) => !t.broken) : [];
  if (touched.length > 0 && history) {
    // nothing rewritten
  } else if (touched.length > 0 && !composing) {
    const start = Math.min(edit.start, ...touched.map((t) => t.start));
    const end = Math.max(edit.end, ...touched.map((t) => t.start + t.length));
    text = before.text.slice(0, start) + edit.inserted + before.text.slice(end);
    edit = { start, end, inserted: edit.inserted };
    caret = start + edit.inserted.length;
  } else if (touched.length > 0) {
    // What is left of each such tag, on either side of the edit (never what the composition puts in: fix round 2, M-3).
    const delta = edit.inserted.length - (edit.end - edit.start);
    for (const t of touched) {
      const end = t.start + t.length;
      if (t.start < edit.start) broken.push({ id: t.id, start: t.start, length: edit.start - t.start, broken: true });
      if (end > edit.end) broken.push({ id: t.id, start: edit.end + delta, length: end - edit.end, broken: true });
    }
  }
  const { kept, removed } = retag(
    before.tags.filter((t) => !touched.includes(t)),
    edit,
  );
  const delta = edit.inserted.length - (edit.end - edit.start);
  let removals = [];
  for (const r of before.removals ?? []) {
    if (r.at <= edit.start) removals.push(r);
    else if (r.at >= edit.end) removals.push({ ...r, at: r.at + delta });
  }
  const back = [];
  if (edit.inserted !== "" && edit.end === edit.start) {
    const undone = removals.findLast((r) => r.at === edit.start && r.text === edit.inserted);
    if (undone) {
      removals = removals.filter((r) => r !== undone);
      back.push(...undone.tags.map((t) => ({ id: t.id, start: undone.at + t.offset, length: t.length })));
    }
  }
  if (history && edit.inserted !== "") {
    const putAt = [edit.start, edit.start + edit.inserted.length];
    for (const r of [...removals].reverse()) {
      if (back.length > 0) break;
      if (text.slice(r.at, r.at + r.text.length) !== r.text || !(putAt[0] < r.at + r.text.length && putAt[1] > r.at)) continue;
      removals = removals.filter((o) => o !== r);
      back.push(...r.tags.map((t) => ({ id: t.id, start: r.at + t.offset, length: t.length })));
    }
  }
  const taken = [...removed, ...(caret === null ? [] : touched)].filter((t) => !t.broken);
  if (taken.length > 0) {
    removals.push({
      at: edit.start,
      text: before.text.slice(edit.start, edit.end),
      tags: taken.map((t) => ({ id: t.id, offset: t.start - edit.start, length: t.length })),
    });
  }
  for (const t of dropped) {
    removals.push({ at: t.start, text: before.text.slice(t.start, t.start + t.length), tags: [{ id: t.id, offset: 0, length: t.length }] });
  }
  removals = removals.slice(-REMOVALS_KEPT);
  let picked = false;
  if (picking && text.slice(picking.start, picking.start + picking.length) === picking.text) {
    picked = true;
    back.push({ id: picking.id, start: picking.start, length: picking.length });
  }
  // (No limit here: tags over MENTION_LIMIT — a deletion put back, a refill — are the composer's to turn into plain
  // text without their "@", `capped`, never left as a typed `@name` to be read at send. Fix round 2, M-7.)
  const whole = mentionsIn(text, [...kept.filter((t) => !t.broken), ...back].sort((a, b) => a.start - b.start), Infinity);
  const tags = [...whole, ...kept.filter((t) => t.broken), ...broken].sort((a, b) => a.start - b.start);
  const named = (t, from) => mentionName(from.slice(t.start, t.start + t.length));
  return {
    text,
    tags,
    removals,
    caret,
    picked,
    added: back.map((t) => named(t, text)),
    removed: [...taken, ...broken, ...dropped].map((t) => named(t, before.text)),
  };
}

/**
 * Once an IME composition ends — or before a send, with one still open: what is left of each tag an edit landed inside
 * while it composed (`broken`) is cut (`afterEdit`), the composed text kept. Returns the state as `afterEdit` does:
 * `caret` where the caret was (`caret`, moved back by what was cut before it), or the first cut's place when not given;
 * null when nothing was cut.
 */
export function settleEdits(state, caret = null) {
  const cut = state.tags.filter((t) => t.broken).sort((a, b) => b.start - a.start);
  if (cut.length === 0) return { ...state, caret: null };
  let text = state.text;
  let tags = state.tags.filter((t) => !t.broken);
  let at = caret;
  for (const c of cut) {
    text = text.slice(0, c.start) + text.slice(c.start + c.length);
    tags = tags.map((t) => (t.start >= c.start + c.length ? { ...t, start: t.start - c.length } : t));
    if (at !== null && at > c.start) at -= Math.min(c.length, at - c.start);
  }
  return { ...state, text, tags, removals: [], caret: at ?? cut.at(-1).start };
}

/**
 * The tags `which` picks out, turned into plain text without their "@" (the tags after them moved), so nothing reads
 * them as typed mentions at send; where the character before such an "@" is itself an "@" (`@@阿波`), the tag's "@"
 * becomes a space instead, so no "@name" is left behind (fix round 2, M-9). `texts`: their texts as they were.
 */
function unmention(state, which) {
  if (which.length === 0) return null;
  let text = state.text;
  let tags = state.tags.filter((t) => !which.includes(t));
  for (const t of [...which].sort((a, b) => b.start - a.start)) {
    if (text[t.start - 1] === "@") {
      text = `${text.slice(0, t.start)} ${text.slice(t.start + 1)}`;
      continue;
    }
    text = text.slice(0, t.start) + text.slice(t.start + 1);
    tags = tags.map((o) => (o.start > t.start ? { ...o, start: o.start - 1 } : o));
  }
  return { ...state, text, tags, removals: [], texts: which.map((t) => state.text.slice(t.start, t.start + t.length)) };
}

/**
 * The composer's tags beyond MENTION_LIMIT (reached through 改一下 or an undo putting tags back: the list never offers a
 * 21st), from the last, turned into plain text without their "@" (`unmention`; fix round 2, M-7): `over`, their texts.
 * The same state when there are none.
 */
export function capped(state) {
  const whole = state.tags.filter((t) => !t.broken);
  const done = unmention(state, whole.slice(MENTION_LIMIT));
  return done ? { ...done, over: done.texts } : state;
}

/**
 * The composer's tags that sit in an address — right after a `/`, or inside a URL or a link's target (`inAddress`; a
 * tag's own text, `www.anna`, is never read as one: tidy round, m-6) — are tags no more: their text stays as it is,
 * which the service reads as part of the address, naming nobody, rather than refusing the message (fix round 2, M-1).
 * `addressed`: their texts. The same state when there are none.
 */
export function withoutAddressed(state) {
  const live = state.tags.filter((t) => !t.broken);
  // (No tags, nothing to look for: m-8.)
  const kept = outsideAddresses(state.text, live);
  if (kept === live) return state;
  const addressed = live.filter((t) => !kept.includes(t));
  return { ...state, tags: state.tags.filter((t) => !addressed.includes(t)), removals: [], addressed: addressed.map((t) => state.text.slice(t.start, t.start + t.length)) };
}

/**
 * The composer's state without the tags whose principal is no longer one to mention here (`isMember(id)` false: a
 * person who left, an Agent taken out): each turns into plain text without its "@" — so nothing reads it as a typed
 * mention at send (fix round 1, I-2) — and the tags after it move. `stale`: their texts as they were (`@阿波`), for the
 * line that says so. The same state when none went stale.
 */
export function withoutStale(state, isMember) {
  const done = unmention(
    state,
    state.tags.filter((t) => !t.broken && !isMember(t.id)),
  );
  return done ? { ...done, stale: done.texts } : state;
}

/** The tag whose end is at `caret` (Backspace there takes it), or whose start is (Delete there takes it). */
export const tagEndingAt = (tags, caret) => tags.find((t) => !t.broken && t.start + t.length === caret) ?? null;
export const tagStartingAt = (tags, caret) => tags.find((t) => !t.broken && t.start === caret) ?? null;

/**
 * Where a caret that came to rest inside a tag goes instead (M-3: the caret never rests inside one): the tag's end when
 * it came from before the tag, its start when it came from after it, else (a click) the nearer edge. Null when `at` is
 * inside no tag.
 */
export function caretOutside(tags, at, from = null) {
  const tag = tags.find((t) => !t.broken && t.start < at && at < t.start + t.length);
  if (!tag) return null;
  const end = tag.start + tag.length;
  if (from !== null && from <= tag.start) return end;
  if (from !== null && from >= end) return tag.start;
  return at - tag.start <= end - at ? tag.start : end;
}

// ───────── the text as it is sent


/**
 * The text as it is sent — what validation.js `messageText` removes (its one pattern, `MESSAGE_DROPPED`: bidi overrides
 * and isolates, NUL and the other control characters but tab and line breaks), lone surrogates replaced (U+FFFD),
 * trimmed: actions.js `sendText`'s rules, which are the service's — and `tags` (`{id, start, length}` in `value`) as ranges of
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
    if (MESSAGE_DROPPED.test(source[i])) continue;
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
  const mapped = [];
  let end = 0;
  for (const tag of sorted) {
    if (tag.start + tag.length > source.length) continue;
    const start = at[tag.start] - lead;
    const stop = at[tag.start + tag.length] - lead;
    if (start < end || stop <= start || stop > text.length || text[start] !== "@") continue;
    mapped.push({ id: tag.id, start, length: stop - start });
    end = stop;
  }
  // (One in an address is no mention: the service would refuse it. Fix round 2, M-1.)
  return { text, mentions: outsideAddresses(text, mapped).slice(0, MENTION_LIMIT) };
}
