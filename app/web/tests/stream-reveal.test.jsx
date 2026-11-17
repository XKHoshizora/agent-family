// @vitest-environment jsdom
// A reply being written is revealed a little at every frame (ui/reveal.js): the pace (`nextReveal`, on a clock of the
// test's own), where a prefix may end, and the streaming text with frames turned by hand — a burst over several
// frames, a trickle as it comes, the end in a moment, at once under reduced motion or in a hidden tab, the trees asked
// for what is shown, and a bounded number of DOM changes per frame however long the text.
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { StreamingAgentText, loadMarkdown } from "../src/ui/AgentText.jsx";
import { renderToTree } from "../src/ui/markdownPipeline.js";
import {
  REVEAL_BACKLOG_MAX,
  REVEAL_CUSHION_MAX_MS,
  REVEAL_CUSHION_MIN_MS,
  REVEAL_END_MS,
  REVEAL_FINISH_MS,
  REVEAL_MAX_LAG_MS,
  REVEAL_TOKEN_MAX,
  endReveal,
  nextReveal,
  revealBoundary,
  revealStart,
  setRevealFrames,
  setRevealGraphemes,
} from "../src/ui/reveal.js";
import { SilentWorker, settle, useWorkers } from "./markdown-worker.js";

await loadMarkdown();

const FRAME = 16;

/**
 * Frames at FRAME ms, called as the hook calls: only while something waits or has just come (or the end is told), with
 * the time since the previous call. `arrivals`: [[atMs, receivedLength]] in order; `endAt`: when nothing more will
 * come; `text`: the received text (boundaries); `from`: that many characters were there and shown already (the state
 * started again, as a bubble made again starts it). Returns every frame's `{ t, received, revealed, state }`.
 */
function simulate({ arrivals, until, endAt = Infinity, text = null, from = 0 }) {
  let state = from > 0 ? { ...revealStart(), received: from } : revealStart();
  let revealed = from;
  let last = null;
  const out = [];
  for (let t = FRAME; t <= until; t += FRAME) {
    let received = from;
    for (const [at, length] of arrivals) if (at < t) received = length;
    const ending = t > endAt && !state.ended;
    if (ending) state = endReveal(state);
    if (revealed < received || received !== state.received || ending) {
      ({ revealed, state } = nextReveal(revealed, received, last === null ? FRAME : t - last, state, text));
      last = t;
    }
    out.push({ t, received, revealed, state });
  }
  return out;
}
/** When each arrival was all shown (the first frame at which it was), or null. */
const shownAt = (frames, length) => frames.find((f) => f.revealed >= length)?.t ?? null;
/** `count` pieces of `size` characters, one every `every` ms from `start` (lengths go on from `base`). */
const steady = ({ start = 0, every, size, count, base = 0 }) => Array.from({ length: count }, (_, i) => [start + i * every, base + (i + 1) * size]);

describe("the pace (nextReveal)", () => {
  it("follows the sustained pace of what comes, carrying fractions: a slow stream is not one character a frame", () => {
    // 10 characters a second, one every 100 ms.
    const arrivals = steady({ every: 100, size: 1, count: 30 });
    const frames = simulate({ arrivals, until: 3200 });
    for (let i = 1; i < frames.length; i += 1) {
      expect(frames[i].revealed).toBeGreaterThanOrEqual(frames[i - 1].revealed);
      expect(frames[i].revealed).toBeLessThanOrEqual(frames[i].received);
      expect(frames[i].revealed - frames[i - 1].revealed).toBeLessThanOrEqual(1);
    }
    const late = frames.filter((f) => f.t > 1000);
    const adding = late.filter((f, i) => i > 0 && f.revealed > late[i - 1].revealed).length;
    expect(adding).toBeLessThan(late.length / 3); // most frames add nothing: the pace is a character every 100 ms
    // (Behind by about the cushion kept waiting, and a frame or two.)
    for (const [at, length] of arrivals) expect(shownAt(frames, length) - at, `${length}`).toBeLessThanOrEqual(REVEAL_CUSHION_MIN_MS + 200);

    // 200 characters a second, in pieces of 10 every 50 ms: about 3 a frame, never far behind.
    const fast = simulate({ arrivals: steady({ every: 50, size: 10, count: 60 }), until: 3200 });
    const middle = fast.filter((f) => f.t > 1000 && f.t < 3000);
    const added = middle[middle.length - 1].revealed - middle[0].revealed;
    expect(added / middle.length).toBeGreaterThan(2.5);
    expect(added / middle.length).toBeLessThan(4);
    for (const f of middle) expect(f.received - f.revealed).toBeLessThanOrEqual(0.2 * REVEAL_CUSHION_MIN_MS + 40);
  });

  it("a trickle is shown as it comes: about the cushion behind once its pace is known, a little more in its first second", () => {
    // (In the first second the pace is taken over a whole second: a little slower than the trickle's.)
    const arrivals = steady({ every: 100, size: 3, count: 30 });
    const frames = simulate({ arrivals, until: 3500 });
    // (The last piece, with nothing after it, waits a little longer: under the cushion the pace halves. Its stored
    // message, when it comes, finishes it within REVEAL_FINISH_MS.)
    const lastAt = arrivals[arrivals.length - 1][0];
    for (const [at, length] of arrivals) expect(shownAt(frames, length) - at, `${length} at ${at}`).toBeLessThanOrEqual(REVEAL_CUSHION_MIN_MS + (at < 1000 || at === lastAt ? 250 : 100));
  });

  it("started again with 3 000 characters shown (a bubble made again): the pace counts what comes from then on, not all of the text", () => {
    const arrivals = steady({ every: 100, size: 3, count: 30, base: 3000 });
    const frames = simulate({ arrivals, until: 3500, from: 3000 });
    expect(frames[0].revealed).toBe(3000);
    // A trickle paced as a trickle is (about the cushion behind) — not each piece the frame it comes, as it would be
    // at the pace of 3 000 characters come in a second.
    const lags = arrivals.map(([at, length]) => shownAt(frames, length) - at);
    expect(Math.min(...lags.slice(10))).toBeGreaterThan(100);
    for (const lag of lags) expect(lag).toBeLessThanOrEqual(REVEAL_CUSHION_MIN_MS + 250);
  });

  it("a stall grows the cushion (up to its most); it decays back over a few seconds", () => {
    // 100 characters a second for 2 s, nothing for 2 s, then on again.
    const arrivals = [...steady({ every: 50, size: 5, count: 40 }), ...steady({ start: 4000, every: 50, size: 5, count: 160, base: 200 })];
    const frames = simulate({ arrivals, until: 12000 });
    const cushionAt = (ms) => frames.find((f) => f.t >= ms).state.cushion;
    expect(cushionAt(1900)).toBeCloseTo(REVEAL_CUSHION_MIN_MS, 0);
    expect(cushionAt(4040)).toBeGreaterThan(REVEAL_CUSHION_MAX_MS * 0.95);
    expect(cushionAt(6000)).toBeLessThan((REVEAL_CUSHION_MIN_MS + REVEAL_CUSHION_MAX_MS) / 2);
    expect(cushionAt(10000)).toBeLessThan(REVEAL_CUSHION_MIN_MS + 50);
    // Regular gaps are no stall.
    const regular = simulate({ arrivals: steady({ every: 500, size: 60, count: 12 }), until: 6500 });
    for (const f of regular) expect(f.state.cushion).toBeCloseTo(REVEAL_CUSHION_MIN_MS, 0);
  });

  it(`a burst of 6 000 characters flows out over frames, not at once, and is all shown within ${REVEAL_MAX_LAG_MS} ms`, () => {
    const frames = simulate({ arrivals: [[0, 6000]], until: 2000 });
    expect(frames[0].revealed).toBeGreaterThan(0);
    expect(frames[0].revealed).toBeLessThan(1500);
    expect(frames.find((f) => f.t >= 200).revealed).toBeLessThan(6000);
    expect(shownAt(frames, 6000)).toBeLessThanOrEqual(REVEAL_MAX_LAG_MS + FRAME);
  });

  it(`a backlog over ${REVEAL_BACKLOG_MAX} characters is drained faster: a slow stream's sudden burst is soon close behind`, () => {
    const arrivals = [...steady({ every: 100, size: 5, count: 20 }), [2000, 2100]];
    const frames = simulate({ arrivals, until: 3500 });
    const at = frames.find((f) => f.t >= 2600);
    expect(at.received - at.revealed).toBeLessThanOrEqual(REVEAL_BACKLOG_MAX);
  });

  it("a late frame plays at most 100 ms (it does not dump); the first frame after a pause plays one frame", () => {
    let state = revealStart();
    let revealed = 0;
    ({ revealed, state } = nextReveal(revealed, 3000, FRAME, state));
    ({ revealed, state } = nextReveal(revealed, 3000, FRAME, state));
    const late = nextReveal(revealed, 3000, 2000, state);
    const capped = nextReveal(revealed, 3000, 100, state);
    expect(late.revealed).toBeLessThanOrEqual(capped.revealed);
    expect(late.revealed).toBeLessThan(3000);
    // All shown, a long pause, then a piece: its first frame plays a frame's worth, not the pause's.
    while (revealed < 3000) ({ revealed, state } = nextReveal(revealed, 3000, FRAME, state));
    const resumed = nextReveal(revealed, 3300, 5000, state);
    const oneFrame = nextReveal(revealed, 3300, FRAME, state);
    expect(resumed.revealed).toBeLessThanOrEqual(oneFrame.revealed);
    expect(resumed.revealed).toBeLessThan(3300);
  });

  it(`bursts and gaps: every character is shown within ${REVEAL_MAX_LAG_MS} ms of arriving, and the reveal never stalls while something waits`, () => {
    // Bursts of 20–2 000 characters every 300–700 ms, as measured against the real provider.
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const arrivals = [];
    let at = 0;
    let length = 0;
    for (let i = 0; i < 30; i += 1) {
      length += Math.floor(20 + random() * (i % 7 === 3 ? 2000 : 200));
      arrivals.push([at, length]);
      at += 300 + Math.floor(random() * 400);
    }
    const frames = simulate({ arrivals, until: at + 2000 });
    for (const [when, upTo] of arrivals) expect(shownAt(frames, upTo) - when, `${upTo} at ${when}`).toBeLessThanOrEqual(REVEAL_MAX_LAG_MS + FRAME);
    // While something waits, every 100 ms shows more.
    for (let i = 6; i < frames.length; i += 1) {
      const before = frames[i - 6];
      if (before.revealed < before.received) expect(frames[i].revealed, `at ${frames[i].t}`).toBeGreaterThan(before.revealed);
    }
  });

  it("ordinary provider gaps are bridged: bursts of about 5 characters every 0.3–0.7 s rarely leave the reveal waiting", () => {
    let seed = 11;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const arrivals = [];
    let at = 0;
    let length = 0;
    for (let i = 0; i < 80; i += 1) {
      length += 3 + Math.floor(random() * 5);
      arrivals.push([at, length]);
      at += 300 + Math.floor(random() * 400);
    }
    const frames = simulate({ arrivals, until: at + 3000 });
    const middle = frames.filter((f) => f.t > 1000 && f.t < at);
    const idle = middle.filter((f) => f.revealed === f.received).length;
    expect(idle / middle.length).toBeLessThan(0.15);
    let pause = 0;
    let longest = 0;
    for (const f of middle) {
      pause = f.revealed === f.received ? pause + FRAME : 0;
      longest = Math.max(longest, pause);
    }
    expect(longest).toBeLessThan(400);
    for (const [when, upTo] of arrivals) expect(shownAt(frames, upTo) - when).toBeLessThanOrEqual(REVEAL_MAX_LAG_MS + FRAME);
  });

  it(`the stored message came: what is left is shown frame by frame within ${REVEAL_FINISH_MS} ms, at whole graphemes`, () => {
    const text = "😀".repeat(1500);
    let state = revealStart();
    let revealed = 0;
    ({ revealed, state } = nextReveal(revealed, text.length, FRAME, state, text));
    state = endReveal(state, REVEAL_FINISH_MS);
    const ends = [];
    for (let t = FRAME; t <= REVEAL_FINISH_MS + FRAME && revealed < text.length; t += FRAME) {
      ({ revealed, state } = nextReveal(revealed, text.length, FRAME, state, text));
      ends.push(revealed);
    }
    expect(revealed).toBe(text.length);
    expect(ends.length).toBeGreaterThan(3);
    for (const end of ends) expect(end % 2).toBe(0);
    // An end told sooner (the cut) is not put off by a later one.
    let cut = endReveal(revealStart(), REVEAL_END_MS);
    ({ state: cut } = nextReveal(0, 3000, FRAME, cut));
    expect(endReveal(cut, REVEAL_FINISH_MS)).toBe(cut);
  });

  it(`once nothing more will come, the rest is shown within ${REVEAL_END_MS} ms`, () => {
    const frames = simulate({ arrivals: [[0, 3000]], endAt: 100, until: 1000 });
    expect(frames.find((f) => f.t >= 100).revealed).toBeLessThan(3000);
    expect(shownAt(frames, 3000)).toBeLessThanOrEqual(100 + REVEAL_END_MS + FRAME);
  });

  it("does nothing when nothing new has come: the same state back", () => {
    let state = revealStart();
    let revealed = 0;
    for (let i = 0; i < 100; i += 1) ({ revealed, state } = nextReveal(revealed, 50, FRAME, state));
    expect(revealed).toBe(50);
    const again = nextReveal(50, 50, FRAME, state);
    expect(again.state).toBe(state);
    expect(again.revealed).toBe(50);
    expect(nextReveal(0, 0, FRAME, revealStart()).revealed).toBe(0);
  });
});

describe.each([
  ["by Intl.Segmenter's graphemes", undefined],
  ["by the rules, where there is no Intl.Segmenter", null],
])("where a prefix may end, %s", (_how, graphemes) => {
  beforeEach(() => setRevealGraphemes(graphemes));
  afterEach(() => setRevealGraphemes(undefined));

  /** Every prefix end the frames choose for this text arriving whole. */
  const ends = (text) => [...new Set(simulate({ arrivals: [[0, text.length]], until: 1500, text }).map((f) => f.revealed))];

  it("never inside a surrogate pair", () => {
    const text = "😀".repeat(300);
    const all = ends(text);
    expect(all.length).toBeGreaterThan(5);
    for (const end of all) expect(end % 2).toBe(0);
  });

  it("never before a combining mark, an emoji modifier or a joiner, nor right after a joiner", () => {
    const pieces = ["e\u0301", "a\u0308\u0323", "👍🏽", "👨\u200D👩\u200D👧", "1\uFE0F\u20E3", "🇨🇳", "क\u094Dष", "\u1112\u1161\u11AB", "字"];
    const text = pieces.join("").repeat(40);
    const starts = new Set([text.length]);
    let at = 0;
    for (let i = 0; i < 40; i += 1) {
      for (const piece of pieces) {
        starts.add(at);
        at += piece.length;
      }
    }
    for (const end of ends(text)) expect(starts.has(end), `ends at ${end}: ${JSON.stringify(text.slice(end - 2, end + 2))}`).toBe(true);
  });

  it("never inside a <…> token; one not closed yet waits whole until its > comes", () => {
    const text = "看 <https://example.com/a> 这里 <b>粗</b> 和 a < b 完。".repeat(20);
    const inside = (end) => {
      const open = text.lastIndexOf("<", end - 1);
      if (open < 0 || !/[A-Za-z/]/.test(text[open + 1])) return false;
      const close = text.indexOf(">", open);
      return end > open && end <= close;
    };
    for (const end of ends(text)) expect(inside(end), `ends at ${end}`).toBe(false);

    const head = "前面的话 <https://exa";
    expect(revealBoundary(head, 0, head.length)).toBe(head.indexOf("<"));
    const whole = `${head}mple.com> 后面`;
    expect(revealBoundary(whole, 0, head.length)).toBe(whole.indexOf(">") + 1);
    // Too long to be one: shown as it comes.
    const long = `<a${"x".repeat(REVEAL_TOKEN_MAX + 10)}`;
    expect(revealBoundary(long, 0, 50)).toBe(50);
    // A lone "<" at the end of what has come waits for the next character.
    expect(revealBoundary("a <", 0, 3)).toBe(2);
    expect(revealBoundary("a < b", 0, 3)).toBe(3);
  });
});

// ───────── the streaming text, frames turned by hand

/** A frame clock the test turns: `step(ms)` runs the frames asked so far, at a time `ms` later. */
function handFrames() {
  const asked = new Map();
  let next = 1;
  let time = 1000;
  const clock = {
    request(run) {
      asked.set(next, run);
      return next++;
    },
    cancel(id) {
      asked.delete(id);
    },
  };
  return {
    clock,
    get pending() {
      return asked.size;
    },
    step(ms = FRAME) {
      time += ms;
      const due = [...asked.values()];
      asked.clear();
      act(() => {
        for (const run of due) run(time);
      });
    },
  };
}

let frames;
beforeEach(() => {
  frames = handFrames();
  setRevealFrames(frames.clock);
  // (No worker: every text is shown plain, so what is in the bubble is exactly what was revealed.)
  useWorkers(() => {
    throw new Error("no worker");
  });
});
afterEach(() => {
  cleanup();
  setRevealFrames(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
  useWorkers();
});

const WAIT = "等一下";
const bubble = (text, props = {}) => (
  <div className="bubble">
    <StreamingAgentText text={text} paced placeholder={<span className="wait">{WAIT}</span>} {...props} />
  </div>
);
const shownText = (container) => container.querySelector(".md-text").textContent;
const sample = (n) => Array.from({ length: n }, (_, i) => "一二三四五六七八九十，。"[i % 12]).join("");

describe("a reply being revealed", () => {
  it("a burst of 500 characters appears over several frames; the placeholder until its first characters", async () => {
    const text = sample(500);
    const { container } = render(bubble(text));
    await settle();
    expect(shownText(container)).toBe(WAIT);
    const lengths = [];
    for (let i = 0; i < 200 && frames.pending > 0; i += 1) {
      frames.step();
      lengths.push(shownText(container).length);
    }
    expect(shownText(container)).toBe(text);
    expect(lengths.length).toBeGreaterThan(5);
    expect(lengths[0]).toBeGreaterThan(0);
    expect(lengths[0]).toBeLessThan(500);
    expect(lengths.length * FRAME).toBeLessThanOrEqual(REVEAL_MAX_LAG_MS + FRAME);
    for (let i = 1; i < lengths.length; i += 1) expect(lengths[i]).toBeGreaterThanOrEqual(lengths[i - 1]);
    // All shown: no frame is asked any more.
    expect(frames.pending).toBe(0);
  });

  it("a trickle appears as it comes, about the cushion behind; once it is all shown no frame is asked", async () => {
    const text = sample(60);
    const { container, rerender } = render(bubble(text.slice(0, 3)));
    for (let i = 1; i <= 20; i += 1) {
      rerender(bubble(text.slice(0, 3 * i)));
      for (let ms = 0; ms < 96; ms += FRAME) frames.step(); // (six frames: 96 ms)
      const shown = container.querySelector(".wait") ? "" : shownText(container);
      expect(text.startsWith(shown)).toBe(true);
      expect(shown.length).toBeGreaterThanOrEqual(3 * (i - 5)); // (30 a second, the cushion 300 ms: some 3 pieces)
    }
    for (let i = 0; i < 100 && frames.pending > 0; i += 1) frames.step();
    expect(shownText(container)).toBe(text);
    expect(frames.pending).toBe(0);
  });

  it(`the end: what is left is shown within ${REVEAL_END_MS} ms`, async () => {
    const text = sample(3000);
    const { container, rerender } = render(bubble(text));
    frames.step();
    frames.step();
    expect(shownText(container).length).toBeLessThan(3000);
    rerender(bubble(text, { ended: true }));
    for (let ms = 0; ms <= REVEAL_END_MS + FRAME; ms += FRAME) frames.step();
    expect(shownText(container)).toBe(text);
    expect(frames.pending).toBe(0);
  });

  it(`finishing (its stored message came): the rest within ${REVEAL_FINISH_MS} ms of frames; onShown tells how far it has got`, async () => {
    const text = sample(3000);
    const seen = [];
    const onShown = (upTo, length) => seen.push([upTo, length]);
    const { rerender } = render(bubble(text, { onShown }));
    frames.step();
    frames.step();
    expect(seen.at(-1)[0]).toBeGreaterThan(0);
    expect(seen.at(-1)[0]).toBeLessThan(3000);
    rerender(bubble(text, { onShown, ended: true, endWithin: REVEAL_FINISH_MS }));
    let n = 0;
    for (; n < 200 && frames.pending > 0; n += 1) frames.step();
    expect(n).toBeGreaterThan(3);
    expect(n * FRAME).toBeLessThanOrEqual(REVEAL_FINISH_MS + FRAME);
    expect(seen.at(-1)).toEqual([3000, 3000]);
  });

  it("`all` (a stop, a failure): everything received at once, and no frame left", async () => {
    const text = sample(500);
    const { container, rerender } = render(bubble(text));
    frames.step();
    expect(shownText(container).length).toBeLessThan(500);
    rerender(bubble(text, { all: true }));
    expect(shownText(container)).toBe(text);
    expect(frames.pending).toBe(0);
  });

  it("made again (`resumeAt`: how far it had got before): that much at once, no placeholder, the rest revealed from there", async () => {
    const text = sample(500);
    const { container, unmount } = render(bubble(text, { resumeAt: 200 }));
    expect(shownText(container)).toBe(text.slice(0, 200));
    frames.step();
    expect(shownText(container).length).toBeGreaterThan(200);
    expect(shownText(container).length).toBeLessThan(500);
    for (let i = 0; i < 200 && frames.pending > 0; i += 1) frames.step();
    expect(shownText(container)).toBe(text);
    unmount();
    // All of it shown before: all of it at once, and no frame.
    const again = render(bubble(text, { resumeAt: 500 }));
    expect(shownText(again.container)).toBe(text);
    expect(frames.pending).toBe(0);
    again.unmount();
    // (Never past what was received.)
    const shorter = render(bubble(text.slice(0, 100), { resumeAt: 200 }));
    expect(shownText(shorter.container)).toBe(text.slice(0, 100));
    expect(frames.pending).toBe(0);
  });

  it("another text starts from its beginning", async () => {
    const { container, rerender } = render(bubble(sample(40)));
    for (let i = 0; i < 100 && frames.pending > 0; i += 1) frames.step();
    expect(shownText(container)).toBe(sample(40));
    rerender(bubble("全新的回复"));
    expect(shownText(container)).toBe(WAIT);
    for (let i = 0; i < 100 && frames.pending > 0; i += 1) frames.step();
    expect(shownText(container)).toBe("全新的回复");
  });

  it("with reduced motion everything received is shown at once, with no frames", async () => {
    const listeners = new Set();
    window.matchMedia = (query) => ({
      matches: query === "(prefers-reduced-motion: reduce)",
      media: query,
      addEventListener: (_type, fn) => listeners.add(fn),
      removeEventListener: (_type, fn) => listeners.delete(fn),
    });
    try {
      const text = sample(500);
      const { container, rerender, unmount } = render(bubble(text.slice(0, 200)));
      expect(shownText(container)).toBe(text.slice(0, 200));
      rerender(bubble(text));
      expect(shownText(container)).toBe(text);
      expect(frames.pending).toBe(0);
      unmount();
      expect(listeners.size).toBe(0);
    } finally {
      delete window.matchMedia;
    }
  });

  it("in a hidden tab everything received is shown at once; visible again, what was received stays shown and the rest is paced", async () => {
    let hidden = false;
    vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
    const text = sample(900);
    const { container, rerender } = render(bubble(text.slice(0, 500)));
    frames.step();
    expect(shownText(container).length).toBeLessThan(500);
    // Hidden: the frame asked is given up, and all of it is shown.
    hidden = true;
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(shownText(container)).toBe(text.slice(0, 500));
    expect(frames.pending).toBe(0);
    rerender(bubble(text.slice(0, 700)));
    expect(shownText(container)).toBe(text.slice(0, 700));
    expect(frames.pending).toBe(0);
    // Visible again: what was received is shown; what comes next is paced.
    hidden = false;
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(shownText(container)).toBe(text.slice(0, 700));
    rerender(bubble(text));
    expect(shownText(container)).toBe(text.slice(0, 700));
    expect(frames.pending).toBe(1);
    for (let i = 0; i < 200 && frames.pending > 0; i += 1) frames.step();
    expect(shownText(container)).toBe(text);
  });

  it("no frame is left after unmount", async () => {
    const { unmount } = render(bubble(sample(500)));
    frames.step();
    expect(frames.pending).toBe(1);
    unmount();
    expect(frames.pending).toBe(0);
  });

  it("a 20 000-character reply revealed over many frames: a bounded number of DOM changes per frame, one text node appended to", async () => {
    const text = sample(20000);
    const { container, rerender } = render(bubble(text.slice(0, 2000)));
    await settle();
    // (The first frame puts the text in place of the placeholder; from then on the text only grows.)
    frames.step();
    await settle();
    const host = container.querySelector(".md-text");
    const observer = new MutationObserver(() => {});
    observer.observe(host, { subtree: true, childList: true, characterData: true, attributes: true });
    // Every way a text node's whole text is set, and what is appended.
    const replaced = [
      vi.spyOn(CharacterData.prototype, "data", "set"),
      vi.spyOn(Node.prototype, "nodeValue", "set"),
      vi.spyOn(Node.prototype, "textContent", "set"),
    ];
    const appended = vi.spyOn(CharacterData.prototype, "appendData");
    const node = host.querySelector("span").firstChild;
    let counted = 0;
    let most = 0;
    let received = 2000;
    for (let i = 0; i < 2000 && (frames.pending > 0 || received < 20000); i += 1) {
      // A burst of 2 000 more every 30 frames (about half a second).
      if (i % 30 === 29 && received < 20000) {
        received += 2000;
        rerender(bubble(text.slice(0, received)));
        await settle();
        observer.takeRecords();
      }
      if (frames.pending === 0) continue;
      const before = shownText(container).length;
      appended.mockClear();
      frames.step();
      const changes = observer.takeRecords();
      most = Math.max(most, changes.length);
      counted += 1;
      // The frame's work on the DOM: the characters it added, appended to the one text node (never set whole).
      const added = shownText(container).length - before;
      expect(appended.mock.calls.map(([s]) => s.length).reduce((a, b) => a + b, 0)).toBe(added);
      for (const spy of replaced) expect(spy).not.toHaveBeenCalled();
      expect(host.querySelector("span").firstChild).toBe(node);
    }
    observer.disconnect();
    expect(shownText(container)).toBe(text);
    expect(counted).toBeGreaterThan(50);
    expect(most).toBeLessThanOrEqual(2);
  });
});

describe("the trees of a reply being revealed", () => {
  /** A worker whose answers the test gives. */
  class HeldWorker extends SilentWorker {
    answer(i) {
      const { id, text } = this.sent[i];
      this.emit({ id, ...renderToTree(text, { now: () => 0 }) });
    }
  }
  let workers;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    workers = [];
    useWorkers(() => workers[workers.push(new HeldWorker()) - 1]);
  });
  const sent = () => workers.flatMap((w) => w.sent.map((m) => m.text));

  it("are asked for what is shown, not what was received; a tree for what is shown is taken, the rest plain after it", async () => {
    const text = `**粗体** ${sample(400)}`;
    const { container } = render(bubble(text));
    await settle();
    expect(sent()).toEqual([]); // nothing is shown yet: nothing to ask for
    frames.step();
    frames.step();
    await settle();
    const shown = shownText(container);
    expect(sent()).toHaveLength(1);
    expect(sent()[0].length).toBeLessThan(text.length);
    expect(text.startsWith(sent()[0])).toBe(true);
    expect(sent()[0].length).toBeLessThanOrEqual(shown.length);
    // More is revealed while the tree is made: it is still taken (the same text, grown).
    frames.step();
    workers[0].answer(0);
    await settle();
    expect(container.querySelector(".md strong").textContent).toBe("粗体");
    // What is shown is the tree, then the rest plain: the visible text never goes beyond what was revealed.
    const after = shownText(container);
    expect(text.replace("**粗体**", "粗体").startsWith(after)).toBe(true);
    // The next is asked no sooner than 300 ms later, for what is shown then.
    for (let i = 0; i < 5; i += 1) frames.step();
    await settle();
    expect(sent()).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    await settle();
    expect(sent()).toHaveLength(2);
    expect(sent()[1].length).toBeGreaterThan(sent()[0].length);
    expect(text.startsWith(sent()[1])).toBe(true);
  });

  it("a tree for a text that is not shown any more (another text) is dropped", async () => {
    const { container, rerender } = render(bubble("**旧的** 回复"));
    for (let i = 0; i < 20; i += 1) frames.step();
    await settle();
    expect(sent()).toHaveLength(1);
    rerender(bubble("全新的回复"));
    workers[0].answer(0);
    await settle();
    expect(container.querySelector(".md")).toBeNull();
    for (let i = 0; i < 100 && frames.pending > 0; i += 1) frames.step();
    expect(shownText(container)).toBe("全新的回复");
  });
});
