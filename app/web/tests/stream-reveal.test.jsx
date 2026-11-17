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
  REVEAL_END_MS,
  REVEAL_FLOOR_CPS,
  REVEAL_MAX_LAG_MS,
  REVEAL_TOKEN_MAX,
  endReveal,
  nextReveal,
  revealBoundary,
  revealStart,
  setRevealFrames,
} from "../src/ui/reveal.js";
import { SilentWorker, settle, useWorkers } from "./markdown-worker.js";

await loadMarkdown();

const FRAME = 16;

/**
 * Frames at FRAME ms. `arrivals`: [[atMs, receivedLength]] in order; `endAt`: when nothing more will come; `text`: the
 * received text (boundaries). Returns every frame's `{ t, received, revealed }`.
 */
function simulate({ arrivals, until, endAt = Infinity, text = null }) {
  let state = revealStart();
  let revealed = 0;
  const out = [];
  for (let t = FRAME; t <= until; t += FRAME) {
    let received = 0;
    for (const [at, length] of arrivals) if (at < t) received = length;
    if (t > endAt) state = endReveal(state);
    ({ revealed, state } = nextReveal(revealed, received, FRAME, state, text));
    out.push({ t, received, revealed });
  }
  return out;
}
/** When each arrival was all shown (the first frame at which it was), or null. */
const shownAt = (frames, length) => frames.find((f) => f.revealed >= length)?.t ?? null;

describe("the pace (nextReveal)", () => {
  it(`a small backlog goes at the floor, ${REVEAL_FLOOR_CPS} characters a second`, () => {
    const frames = simulate({ arrivals: [[0, 10]], until: 400 });
    const at = (ms) => frames.find((f) => f.t >= ms).revealed;
    expect(at(128)).toBeGreaterThanOrEqual(4);
    expect(at(128)).toBeLessThanOrEqual(6);
    expect(shownAt(frames, 10)).toBeLessThanOrEqual(250 + FRAME);
    // Never more than what has come, never back.
    for (let i = 1; i < frames.length; i += 1) {
      expect(frames[i].revealed).toBeGreaterThanOrEqual(frames[i - 1].revealed);
      expect(frames[i].revealed).toBeLessThanOrEqual(frames[i].received);
    }
  });

  it("a trickle is shown as it comes: each piece within the gap before the next", () => {
    const arrivals = Array.from({ length: 20 }, (_, i) => [i * 100, (i + 1) * 3]);
    const frames = simulate({ arrivals, until: 2100 });
    for (const [at, length] of arrivals) expect(shownAt(frames, length) - at).toBeLessThanOrEqual(100);
  });

  it(`a burst of 6 000 characters flows out over frames and is all shown within ${REVEAL_MAX_LAG_MS} ms`, () => {
    const frames = simulate({ arrivals: [[0, 6000]], until: 2000 });
    expect(frames[0].revealed).toBeGreaterThan(0);
    expect(frames[0].revealed).toBeLessThan(600);
    expect(frames.find((f) => f.t >= 600).revealed).toBeLessThan(6000);
    expect(shownAt(frames, 6000)).toBeLessThanOrEqual(REVEAL_MAX_LAG_MS + FRAME);
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

describe("where a prefix may end", () => {
  /** Every prefix end the frames choose for this text arriving whole. */
  const ends = (text) => [...new Set(simulate({ arrivals: [[0, text.length]], until: 1500, text }).map((f) => f.revealed))];

  it("never inside a surrogate pair", () => {
    const text = "😀".repeat(300);
    const all = ends(text);
    expect(all.length).toBeGreaterThan(5);
    for (const end of all) expect(end % 2).toBe(0);
  });

  it("never before a combining mark, an emoji modifier or a joiner, nor right after a joiner", () => {
    const pieces = ["é", "ạ̈", "👍🏽", "👨‍👩‍👧", "1️⃣", "🇨🇳", "क्ष", "한", "字"];
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

  it("a trickle appears as it comes", async () => {
    const text = sample(60);
    const { container, rerender } = render(bubble(text.slice(0, 3)));
    for (let i = 1; i <= 20; i += 1) {
      rerender(bubble(text.slice(0, 3 * i)));
      for (let ms = 0; ms < 100; ms += FRAME) frames.step();
      expect(shownText(container)).toBe(text.slice(0, 3 * i));
      expect(frames.pending).toBe(0);
    }
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

  it("`all` (a stop, a failure): everything received at once, and no frame left", async () => {
    const text = sample(500);
    const { container, rerender } = render(bubble(text));
    frames.step();
    expect(shownText(container).length).toBeLessThan(500);
    rerender(bubble(text, { all: true }));
    expect(shownText(container)).toBe(text);
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
