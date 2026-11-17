// How a reply being written is shown: not each piece the moment it arrives (they come in bursts — many in the same
// millisecond, then nothing for half a second; with thinking on, sometimes the whole reply at once after a long
// silence), but a prefix of what has arrived that grows at every animation frame. The text received is the truth
// (data/model.js keeps it as it comes); this only decides how much of it is shown.
//   - Pace: at least REVEAL_FLOOR_CPS characters a second, and faster the more is waiting (the backlog over
//     REVEAL_PACE_MS), so a burst flows out quickly at first and settles to the pace of what keeps coming.
//   - Bound: no character is shown later than REVEAL_MAX_LAG_MS after it arrived (each arrival is a deadline, drained
//     evenly), so a burst of thousands of characters takes about a second, never minutes.
//   - End: once nothing more will come, what is left is shown within REVEAL_END_MS.
//   - Where it stops: never inside a surrogate pair, before a combining mark, emoji modifier or joiner (or right after
//     a joiner or virama, before what it joins), or inside a `<…>` token (a tag or an autolink: shown whole, or held
//     back until its `>` has come — unless it grows longer than REVEAL_TOKEN_MAX, or a deadline is due).
// The frames are asked only while something is waiting; nothing runs once all of it is shown. Under
// `prefers-reduced-motion: reduce` and in a hidden tab everything received is shown at once (no frames at all).
import { useEffect, useLayoutEffect, useMemo, useReducer, useRef } from "react";

/** The slowest pace, in characters a second: a trickle is shown as it comes. */
export const REVEAL_FLOOR_CPS = 40;
/** Above the floor the pace is the backlog over this many milliseconds (a bigger backlog, a faster pace). */
export const REVEAL_PACE_MS = 400;
/** No character is shown later than this many milliseconds after it was received. */
export const REVEAL_MAX_LAG_MS = 1200;
/** Once nothing more will come, what is left is shown within this many milliseconds. */
export const REVEAL_END_MS = 300;
/** The first frame after a pause counts as this long; a longer frame counts as REVEAL_MAX_FRAME_MS. */
export const REVEAL_FRAME_MS = 16;
export const REVEAL_MAX_FRAME_MS = 250;
/** A `<…>` token longer than this (from its `<`) is not held back whole. */
export const REVEAL_TOKEN_MAX = 128;
/** Arrivals remembered as deadlines (more: the two oldest become one, keeping the earlier deadline). */
const MARKS_MAX = 64;

/**
 * The pacing state: `clock` (ms, advanced by the frames that reveal), `credit` (the fraction of a character carried to
 * the next frame), `received` (the length last seen), `marks` (`{end, by}`: what had arrived by then must be shown by
 * `by`), `ended` (nothing more will come) and `endBy` (when all of it must be shown, once ended).
 */
export const revealStart = () => ({ clock: 0, credit: 0, received: 0, marks: [], ended: false, endBy: null });
/** The same state, told that nothing more will come. */
export const endReveal = (state) => (state.ended ? state : { ...state, ended: true });

const isHigh = (c) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c) => c >= 0xdc00 && c <= 0xdfff;

/**
 * One frame: how far the shown prefix goes after `dtMs`. `revealedLen` of `receivedLen` characters are shown; `text`
 * (the received text, optional) moves the end to a safe boundary. Returns `{ revealed, state }`; with nothing new to
 * show it returns the same state object and does nothing else.
 */
export function nextReveal(revealedLen, receivedLen, dtMs, state = revealStart(), text = null) {
  let { clock, credit, received, marks, endBy } = state;
  let changed = false;
  if (receivedLen !== received) {
    if (receivedLen < received) {
      // (Not the same text any more: its deadlines go with it.)
      marks = [];
      credit = 0;
    } else {
      marks = [...marks, { end: receivedLen, by: clock + REVEAL_MAX_LAG_MS }];
      if (marks.length > MARKS_MAX) marks = [{ end: marks[1].end, by: marks[0].by }, ...marks.slice(2)];
    }
    received = receivedLen;
    changed = true;
  }
  if (state.ended && endBy === null) {
    endBy = clock + REVEAL_END_MS;
    changed = true;
  }
  const from = Math.max(0, Math.min(revealedLen, receivedLen));
  const backlog = receivedLen - from;
  if (backlog <= 0) {
    if (!changed && from === revealedLen) return { revealed: revealedLen, state };
    return { revealed: from, state: { ...state, received, marks: [], credit: 0, endBy } };
  }
  const dt = Math.min(Math.max(Number(dtMs) || 0, 0), REVEAL_MAX_FRAME_MS);
  const pace = credit + dt * Math.max(REVEAL_FLOOR_CPS / 1000, backlog / REVEAL_PACE_MS);
  // Each deadline is drained evenly over the time it has left; one that falls due in this frame is met in full.
  let due = from;
  let drain = 0;
  const meet = (end, by) => {
    const left = by - clock;
    if (left <= dt) due = Math.max(due, end);
    else drain = Math.max(drain, ((end - from) * dt) / left);
  };
  for (const mark of marks) if (mark.end > from) meet(mark.end, mark.by);
  if (endBy !== null) meet(receivedLen, endBy);
  const want = Math.max(pace, drain);
  let to = Math.min(receivedLen, from + Math.floor(want));
  if (text !== null && to > from) to = revealBoundary(text, from, to, receivedLen);
  if (due > to) {
    to = due;
    if (text !== null && to < receivedLen && isHigh(text.charCodeAt(to - 1))) to += 1;
  }
  credit = to >= receivedLen ? 0 : Math.min(Math.max(want - (to - from), -REVEAL_TOKEN_MAX), 1);
  if (marks.some((mark) => mark.end <= to)) marks = marks.filter((mark) => mark.end > to);
  return { revealed: to, state: { clock: clock + dt, credit, received, marks, ended: state.ended, endBy } };
}

// ───────── where a prefix may end

/** Joins the character before it: a combining mark, a joiner, an emoji modifier, a tag, a Hangul vowel or final jamo. */
const JOINS_PREVIOUS = /[\p{M}‍ᅠ-ᇿힰ-퟿\u{1F3FB}-\u{1F3FF}\u{E0020}-\u{E007F}]/uy;
/** Joins the character after it: the zero width joiner and the common viramas (a conjunct). */
const JOINS_NEXT = new Set([0x200d, 0x094d, 0x09cd, 0x0a4d, 0x0acd, 0x0b4d, 0x0bcd, 0x0c4d, 0x0ccd, 0x0d4d, 0x0dca, 0x1039, 0x17d2]);
const isRegional = (cp) => cp >= 0x1f1e6 && cp <= 0x1f1ff;
/** What may follow `<` in a tag or an autolink. */
const TOKEN_START = /[A-Za-z/!?]/;

function codePointBefore(text, i) {
  if (i <= 0) return -1;
  const c = text.charCodeAt(i - 1);
  if (isLow(c) && i >= 2 && isHigh(text.charCodeAt(i - 2))) return text.codePointAt(i - 2);
  return c;
}

/** Whether the regional indicator at `i` is the second of a pair (an odd run of them ends just before it). */
function secondOfPair(text, i) {
  let run = 0;
  let at = i;
  while (run < 32) {
    const cp = codePointBefore(text, at);
    if (!isRegional(cp)) break;
    run += 1;
    at -= 2;
  }
  return run % 2 === 1;
}

/** `end`, moved on past whatever joins the character before it (bounded by `limit`). */
function clusterEnd(text, end, limit) {
  let i = end;
  while (i < limit && i > 0) {
    const c = text.charCodeAt(i);
    const before = text.charCodeAt(i - 1);
    if ((isLow(c) && isHigh(before)) || (c === 0x0a && before === 0x0d)) {
      i += 1;
      continue;
    }
    const cp = text.codePointAt(i);
    const size = cp > 0xffff ? 2 : 1;
    JOINS_PREVIOUS.lastIndex = i;
    const prev = codePointBefore(text, i);
    if (JOINS_PREVIOUS.test(text) || (cp >= 0x80 && JOINS_NEXT.has(prev)) || (isRegional(cp) && secondOfPair(text, i))) {
      i += size;
      continue;
    }
    break;
  }
  return Math.min(i, limit);
}

/** `end`, or past the `>` of the `<…>` token it falls in, or back before its `<` while that token may still close. */
function tokenEnd(text, from, end, limit) {
  let open = -1;
  for (let i = end - 1; i >= Math.max(0, end - REVEAL_TOKEN_MAX); i -= 1) {
    const c = text.charCodeAt(i);
    if (c === 0x3c) {
      open = i;
      break;
    }
    if (c === 0x3e || c === 0x0a) return end;
  }
  if (open < 0) return end;
  if (open + 1 < limit && !TOKEN_START.test(text[open + 1])) return end;
  const last = Math.min(limit, open + REVEAL_TOKEN_MAX);
  for (let i = end; i < last; i += 1) {
    const c = text.charCodeAt(i);
    if (c === 0x3e) return i + 1;
    if (c === 0x3c || c === 0x0a) return end;
  }
  // No `>` yet: while it may still come, the `<` waits (what is shown never goes back, though).
  if (limit - open < REVEAL_TOKEN_MAX) return open >= from ? open : end;
  return end;
}

/**
 * The end of a prefix of `text` near `to` that shows as the whole text would there: not inside a `<…>` token, a
 * surrogate pair or a joined sequence. Never before `from` (shown already), never past `limit` (received).
 */
export function revealBoundary(text, from, to, limit = text.length) {
  let end = Math.min(to, limit);
  if (end <= from) return from;
  end = tokenEnd(text, from, end, limit);
  if (end > from) end = clusterEnd(text, end, limit);
  // At the end of what has come: never half a pair, and a joiner waits for what it joins.
  if (end > from && isHigh(text.charCodeAt(end - 1))) end -= 1;
  if (end === limit && end > from && text.charCodeAt(end - 1) === 0x200d) end -= 1;
  return Math.max(end, from);
}

// ───────── the frames

const browserFrames = {
  request(run) {
    if (typeof requestAnimationFrame === "function") return requestAnimationFrame(run);
    return setTimeout(() => run(typeof performance === "object" ? performance.now() : Date.now()), REVEAL_FRAME_MS);
  },
  cancel(id) {
    if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(id);
    else clearTimeout(id);
  },
};
let frames = browserFrames;
/** Replaces what runs the frames: `{ request(run) → id, cancel(id) }`, `run(timestampMs)` (tests); nothing: the browser's. */
export function setRevealFrames(clock) {
  frames = clock ?? browserFrames;
}

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

/** Whether everything received is shown at once here: reduced motion asked for, or the tab hidden. Kept current. */
function useAtOnce(watching) {
  const [, changed] = useReducer((n) => n + 1, 0);
  const query = useMemo(() => {
    try {
      return typeof window.matchMedia === "function" ? window.matchMedia(REDUCED_MOTION) : null;
    } catch {
      return null;
    }
  }, []);
  useEffect(() => {
    if (!watching) return undefined;
    document.addEventListener("visibilitychange", changed);
    query?.addEventListener?.("change", changed);
    return () => {
      document.removeEventListener("visibilitychange", changed);
      query?.removeEventListener?.("change", changed);
    };
  }, [watching, query]);
  return watching && (Boolean(query?.matches) || document.hidden === true);
}

/**
 * How much of `text` is shown, as its length. `text` grows by appending while `epoch` stays the same (another epoch:
 * another text, shown from its start). `paced`: revealed at the frames (otherwise all of it at once); `ended`: nothing
 * more will come (the rest within REVEAL_END_MS); `all`: everything received is shown now. One frame at a time is
 * asked, only while something waits; none is left once it is all shown, at unmount, or when it is shown at once.
 */
export function useReveal(text, epoch, { paced = true, ended = false, all = false } = {}) {
  const atOnce = useAtOnce(paced);
  const instant = !paced || all || atOnce;
  const [, shown] = useReducer((n) => n + 1, 0);
  const ref = useRef(null);
  ref.current ??= { epoch, text, upTo: 0, pace: revealStart(), frame: null, last: null, shown, alive: true };
  const r = ref.current;
  const upTo = instant ? text.length : r.epoch === epoch ? Math.min(r.upTo, text.length) : 0;

  useLayoutEffect(() => {
    const s = ref.current;
    s.text = text;
    if (s.epoch !== epoch) {
      stop(s);
      Object.assign(s, { epoch, upTo: 0, pace: revealStart(), last: null });
    }
    if (ended) s.pace = endReveal(s.pace);
    if (instant) {
      // Everything received is shown; what comes later is paced from there.
      stop(s);
      if (s.upTo !== text.length) s.upTo = text.length;
      if (s.pace.received !== text.length || s.pace.marks.length > 0) s.pace = { ...revealStart(), clock: s.pace.clock, received: text.length, ended: s.pace.ended };
      return;
    }
    if (s.upTo < text.length && s.frame === null) ask(s);
  }, [text, epoch, instant, ended]);

  useEffect(() => {
    const s = ref.current;
    s.alive = true;
    return () => {
      s.alive = false;
      stop(s);
    };
  }, []);
  return upTo;
}

function stop(s) {
  if (s.frame !== null) frames.cancel(s.frame);
  s.frame = null;
  s.last = null;
}

function ask(s) {
  s.frame = frames.request((now) => {
    s.frame = null;
    if (!s.alive) return;
    const dt = s.last === null ? REVEAL_FRAME_MS : now - s.last;
    s.last = now;
    const { revealed, state } = nextReveal(s.upTo, s.text.length, dt, s.pace, s.text);
    s.pace = state;
    if (revealed !== s.upTo) {
      s.upTo = revealed;
      s.shown();
    }
    if (s.upTo < s.text.length) ask(s);
    else s.last = null;
  });
}
