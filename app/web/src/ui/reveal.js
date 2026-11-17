// How a reply being written is shown: not each piece the moment it arrives (they come in bursts — many in the same
// millisecond, then nothing for half a second; with thinking on, sometimes the whole reply at once after a long
// silence), but a prefix of what has arrived that grows at every animation frame. The text received is the truth
// (data/model.js keeps it as it comes); this only decides how much of it is shown.
//   - Pace: the sustained pace of what comes — the characters received so far over the time since the first of them
//     (at least a second) — with a correction that keeps a small cushion waiting: the backlog is pulled toward that
//     pace times REVEAL_CUSHION_MIN_MS over REVEAL_PULL_MS (never below half the pace). After a stall — a gap between
//     pieces over REVEAL_STALL_FACTOR times the recent median gap — the cushion grows (up to REVEAL_CUSHION_MAX_MS), so
//     the next silence is played through instead of stopping; it decays back over a few seconds. The fraction of a
//     character a frame earns is carried to the next (a slow stream is not one character a frame). A backlog over
//     REVEAL_BACKLOG_MAX characters is drained faster (its excess over REVEAL_EXCESS_MS).
//   - Frames: a frame counts as at most REVEAL_MAX_FRAME_MS (a late frame resumes, it does not dump), the first after a
//     pause as one frame.
//   - Bound: no character is shown later than REVEAL_MAX_LAG_MS of that playing time after it arrived (each arrival is
//     a deadline, drained evenly) — a safety net the pace rarely reaches.
//   - End: once nothing more will come, what is left is shown within REVEAL_END_MS.
//   - Where it stops: at a grapheme boundary (Intl.Segmenter; where there is none: never inside a surrogate pair,
//     before a combining mark, emoji modifier or joiner, or right after a joiner or virama, before what it joins), and
//     never inside a `<…>` token (a tag or an autolink: shown whole, or held back until its `>` has come — unless it
//     grows longer than REVEAL_TOKEN_MAX, or a deadline is due).
// The frames are asked only while something is waiting; nothing runs once all of it is shown. Under
// `prefers-reduced-motion: reduce` and in a hidden tab everything received is shown at once (no frames at all).
import { useEffect, useLayoutEffect, useMemo, useReducer, useRef } from "react";

/** The pace is measured over at least this long from the first piece (the first pieces do not set a wild pace). */
export const REVEAL_RATE_MIN_MS = 1000;
/** The cushion kept waiting, as time at the pace: at least this (it bridges a provider's usual 0.3–0.7 s gaps), ... */
export const REVEAL_CUSHION_MIN_MS = 300;
/** ... at most this (after stalls). */
export const REVEAL_CUSHION_MAX_MS = 800;
/** A raised cushion decays back toward its least with this time constant. */
export const REVEAL_CUSHION_DECAY_MS = 2000;
/** A gap between pieces over this many times the recent median gap (and over REVEAL_STALL_MIN_MS) is a stall... */
export const REVEAL_STALL_FACTOR = 3;
export const REVEAL_STALL_MIN_MS = 200;
/** ... and raises the cushion to this share of it. */
const STALL_SHARE = 0.5;
/** The gaps the median is taken over. */
const GAPS_KEPT = 8;
/**
 * The backlog is pulled toward the cushion over this long. (Shorter: closer behind, but a burst is drained before the
 * next one comes more often, and the reveal pauses in the gap; longer: smoother, further behind.)
 */
export const REVEAL_PULL_MS = 500;
/** A backlog over this many characters has its excess drained over REVEAL_EXCESS_MS. */
export const REVEAL_BACKLOG_MAX = 300;
export const REVEAL_EXCESS_MS = 400;
/** No character is shown later than this many milliseconds (of playing time) after it was received. */
export const REVEAL_MAX_LAG_MS = 1200;
/** Once nothing more will come, what is left is shown within this many milliseconds. */
export const REVEAL_END_MS = 300;
/** Once its stored message has come, what a bubble has left to show is shown within this many milliseconds. */
export const REVEAL_FINISH_MS = 800;
/** The first frame after a pause counts as this long; a longer frame counts as REVEAL_MAX_FRAME_MS. */
export const REVEAL_FRAME_MS = 16;
export const REVEAL_MAX_FRAME_MS = 100;
/** A `<…>` token longer than this (from its `<`) is not held back whole. */
export const REVEAL_TOKEN_MAX = 128;
/** Arrivals remembered as deadlines (more: the two oldest become one, keeping the earlier deadline). */
const MARKS_MAX = 64;

/**
 * The pacing state: `clock` (ms: the time passed, as the calls said it), `play` (ms: the time played, each frame at
 * most REVEAL_MAX_FRAME_MS), `credit` (the fraction of a character carried to the next frame), `received` (the length
 * last seen), `firstAt` / `lastAt` (clock times of the first and the latest piece), `base` (the length before the first
 * piece: what had come before the pace was measured — 0, unless the state was started again with some of the text
 * shown), `gaps` (the latest gaps between pieces), `cushion` (ms), `caughtUp` (all of it was shown at the last call),
 * `marks` (`{end, by}`: what had arrived by then must be shown by play time `by`), `ended` (nothing more will come) and
 * `endBy` (play time by which all of it must be shown, once ended).
 */
export const revealStart = () => ({
  clock: 0,
  play: 0,
  credit: 0,
  received: 0,
  base: 0,
  firstAt: null,
  lastAt: null,
  gaps: [],
  cushion: REVEAL_CUSHION_MIN_MS,
  caughtUp: true,
  marks: [],
  ended: false,
  endBy: null,
});
/**
 * The same state, told that nothing more will come: all of it is to be shown within `withinMs` (of play time, from the
 * next frame). Told already, it stays as it was (an end told sooner is not put off).
 */
export const endReveal = (state, withinMs = REVEAL_END_MS) => (state.ended ? state : { ...state, ended: true, endWithin: withinMs });

const isHigh = (c) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c) => c >= 0xdc00 && c <= 0xdfff;

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

/**
 * One frame: how far the shown prefix goes, `dtMs` after the previous call. `revealedLen` of `receivedLen` characters
 * are shown; `text` (the received text, optional) moves the end to a safe boundary. Returns `{ revealed, state }`; with
 * nothing new to show it returns the same state object and does nothing else (the next call's `dtMs` then counts from
 * the call before).
 */
export function nextReveal(revealedLen, receivedLen, dtMs, state = revealStart(), text = null) {
  const dt = Math.max(Number(dtMs) || 0, 0);
  const now = state.clock + dt;
  let { credit, received, firstAt, lastAt, gaps, marks, endBy, base = 0 } = state;
  // (A raised cushion decays with the time passed — before a stall seen now raises it again.)
  let cushion = REVEAL_CUSHION_MIN_MS + (state.cushion - REVEAL_CUSHION_MIN_MS) * Math.exp(-dt / REVEAL_CUSHION_DECAY_MS);
  let changed = false;
  if (receivedLen !== received) {
    if (receivedLen < received) {
      // (Not the same text any more: its pace and deadlines go with it.)
      ({ credit, firstAt, lastAt, gaps, cushion, marks, base } = revealStart());
    } else {
      // (The pace counts what came from its first piece on, not what was there before it.)
      if (firstAt === null) {
        firstAt = now;
        base = received;
      } else {
        const gap = now - lastAt;
        if (gaps.length >= 3 && gap > REVEAL_STALL_MIN_MS && gap > REVEAL_STALL_FACTOR * median(gaps)) {
          cushion = Math.min(REVEAL_CUSHION_MAX_MS, Math.max(cushion, gap * STALL_SHARE));
        }
        gaps = [...gaps.slice(1 - GAPS_KEPT), gap];
      }
      lastAt = now;
      marks = [...marks, { end: receivedLen, by: state.play + REVEAL_MAX_LAG_MS }];
      if (marks.length > MARKS_MAX) marks = [{ end: marks[1].end, by: marks[0].by }, ...marks.slice(2)];
    }
    received = receivedLen;
    changed = true;
  }
  if (state.ended && endBy === null) {
    endBy = state.play + (state.endWithin ?? REVEAL_END_MS);
    changed = true;
  }
  const from = Math.max(0, Math.min(revealedLen, receivedLen));
  const backlog = receivedLen - from;
  if (backlog <= 0 && !changed && from === revealedLen) return { revealed: revealedLen, state };
  if (backlog <= 0) {
    return { revealed: from, state: { ...state, clock: now, credit: 0, received, base, firstAt, lastAt, gaps, cushion, caughtUp: true, marks: [], endBy } };
  }
  // A frame plays at most REVEAL_MAX_FRAME_MS; the first after everything was shown, one frame.
  const step = Math.min(dt, state.caughtUp ? REVEAL_FRAME_MS : REVEAL_MAX_FRAME_MS);
  // Characters a millisecond: the sustained pace, the backlog pulled toward its cushion, its excess drained.
  const pace = (received - base) / Math.max(now - firstAt, REVEAL_RATE_MIN_MS);
  let rate = Math.max(pace / 2, pace + (backlog - pace * cushion) / REVEAL_PULL_MS);
  if (backlog > REVEAL_BACKLOG_MAX) rate += (backlog - REVEAL_BACKLOG_MAX) / REVEAL_EXCESS_MS;
  const paced = credit + rate * step;
  // Each deadline is drained evenly over the play time it has left; one that falls due in this frame is met in full.
  let due = from;
  let drain = 0;
  const meet = (end, by) => {
    const left = by - state.play;
    if (left <= step) due = Math.max(due, end);
    else drain = Math.max(drain, ((end - from) * step) / left);
  };
  for (const mark of marks) if (mark.end > from) meet(mark.end, mark.by);
  if (endBy !== null) meet(receivedLen, endBy);
  const want = Math.max(paced, drain);
  let to = Math.min(receivedLen, from + Math.floor(want));
  if (text !== null && to > from) to = revealBoundary(text, from, to, receivedLen);
  if (due > to) {
    to = due;
    if (text !== null && to < receivedLen && isHigh(text.charCodeAt(to - 1))) to += 1;
  }
  credit = to >= receivedLen ? 0 : Math.min(Math.max(want - (to - from), -REVEAL_TOKEN_MAX), 1);
  if (marks.some((mark) => mark.end <= to)) marks = marks.filter((mark) => mark.end > to);
  const next = { clock: now, play: state.play + step, credit, received, base, firstAt, lastAt, gaps, cushion, caughtUp: to >= receivedLen, marks, ended: state.ended, endBy };
  return { revealed: to, state: next };
}

// ───────── where a prefix may end

/** Joins the character before it: a combining mark, a joiner, an emoji modifier, a tag, a Hangul vowel or final jamo. */
const JOINS_PREVIOUS = /[\p{M}\u200D\u1160-\u11FF\uD7B0-\uD7FF\u{1F3FB}-\u{1F3FF}\u{E0020}-\u{E007F}]/uy;
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

/** The grapheme segmenter: made once where there is one (null where there is none); `setRevealGraphemes`: tests. */
let graphemes;
function segmenter() {
  if (graphemes === undefined) {
    try {
      graphemes = typeof Intl === "object" && typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;
    } catch {
      graphemes = null;
    }
  }
  return graphemes;
}
/** Replaces the grapheme segmenter (tests): one, null (the rules below), or undefined (the platform's again). */
export function setRevealGraphemes(value) {
  graphemes = value;
}

/**
 * `end`, moved on to the end of the grapheme it falls in. `from` is a boundary already (shown), so only what lies
 * between it and a little past `end` is segmented: work for the characters added, not for the text.
 */
function graphemeEnd(text, from, end, limit) {
  const segments = segmenter();
  if (!segments) return clusterEnd(text, end, limit);
  for (let ahead = 32; ; ahead *= 4) {
    const stop = Math.min(limit, end + ahead);
    const hit = segments.segment(text.slice(from, stop)).containing(end - from);
    if (!hit || hit.index === end - from) return end;
    const after = from + hit.index + hit.segment.length;
    // (A grapheme that reaches the end of the piece may go on past it: look further, up to a bound.)
    if (after < stop || stop === limit || ahead >= 512) return after;
  }
}

/** `end`, moved on past whatever joins the character before it (bounded by `limit`), where there is no segmenter. */
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
  if (end > from) end = graphemeEnd(text, from, end, limit);
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
 * The pacing state of a text of which `upTo` characters were shown before it was made again: as after a pause with
 * everything shown (what has come since is paced from there, its pace measured afresh).
 */
const resumedAt = (upTo) => (upTo > 0 ? { ...revealStart(), received: upTo } : revealStart());

/**
 * How much of `text` is shown, as its length. `text` grows by appending while `epoch` stays the same (another epoch:
 * another text, shown from its start). `paced`: revealed at the frames (otherwise all of it at once); `ended`: nothing
 * more will come (the rest within `endWithin`, REVEAL_END_MS unless said); `all`: everything received is shown now;
 * `resumeAt` (read when it is made): how much of this text was shown before — shown at once, the rest revealed from
 * there. One frame at a time is asked, only while something waits; none is left once it is all shown, at unmount, or
 * when it is shown at once.
 */
export function useReveal(text, epoch, { paced = true, ended = false, endWithin = REVEAL_END_MS, all = false, resumeAt = 0 } = {}) {
  const atOnce = useAtOnce(paced);
  const instant = !paced || all || atOnce;
  const [, shown] = useReducer((n) => n + 1, 0);
  const ref = useRef(null);
  if (ref.current === null) {
    let upTo = Math.max(0, Math.min(Math.floor(Number(resumeAt) || 0), text.length));
    if (upTo > 0 && upTo < text.length && isHigh(text.charCodeAt(upTo - 1))) upTo -= 1;
    ref.current = { epoch, text, upTo, pace: resumedAt(upTo), frame: null, last: null, shown, alive: true };
  }
  const r = ref.current;
  const upTo = instant ? text.length : r.epoch === epoch ? Math.min(r.upTo, text.length) : 0;

  useLayoutEffect(() => {
    const s = ref.current;
    s.text = text;
    if (s.epoch !== epoch) {
      stop(s);
      Object.assign(s, { epoch, upTo: 0, pace: revealStart(), last: null });
    }
    if (ended) s.pace = endReveal(s.pace, endWithin);
    if (instant) {
      // Everything received is shown; what comes later is paced from there.
      stop(s);
      if (s.upTo !== text.length) s.upTo = text.length;
      if (s.pace.received !== text.length || s.pace.marks.length > 0) s.pace = { ...revealStart(), clock: s.pace.clock, received: text.length, ended: s.pace.ended, endWithin: s.pace.endWithin };
      return;
    }
    if (s.upTo < text.length && s.frame === null) ask(s);
  }, [text, epoch, instant, ended, endWithin]);

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

/**
 * Asks for the next frame. Its time since the previous call (`s.last`, kept while nothing waits) is the time that
 * passed: the pace is measured on it; nextReveal plays at most a frame of it after a pause.
 */
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
  });
}
