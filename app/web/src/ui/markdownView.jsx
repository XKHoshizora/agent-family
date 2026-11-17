// What one open conversation spends on Agents' rendered texts. Only texts in or near the message list's viewport are
// sent to the Markdown worker and rendered rich (an IntersectionObserver on the list, with a generous margin); a text
// once rich stays rich while it is shown. And all the rich trees shown at once have at most VIEW_ELEMENTS elements:
// when one more would pass that, the ones farthest from the viewport go back to plain text (until they come near
// again). So opening a conversation costs at most what is visible, each text capped. And texts turn rich a few at a
// time: at most FRAME_ELEMENTS elements' worth of trees per animation frame, the nearest to the viewport first
// (`inFrame`), wherever their trees come from (the worker, or the answers the client has kept).
import React, { createContext, useContext, useEffect, useMemo } from "react";

/** The elements of all rich texts shown at once in one conversation. */
export const VIEW_ELEMENTS = 30000;
/** How far beyond the visible part of the list a text counts as near (the list's own height, above and below). */
export const NEAR_MARGIN = "100% 0px 100% 0px";
/** Without IntersectionObserver: the newest this many Agent texts count as near. */
export const NEWEST_NEAR = 20;

// ───────── turning rich, a frame at a time

/** The elements of all the trees turned rich in one animation frame (one tree is at most this big: it always fits). */
export const FRAME_ELEMENTS = 3000;

const nextFrame = (run) => {
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => run());
  else setTimeout(run, 16);
};
let frameClock = nextFrame;
/** Trees waiting to be shown: `{ elements, distance, apply }`. */
const waiting = new Set();
let frameAsked = false;
/**
 * Replaces what calls back at the next frame (tests: a clock of their own); nothing: the browser's again. A frame
 * asked of the old clock is asked of the new one.
 */
export function setFrameClock(clock) {
  frameClock = clock ?? nextFrame;
  if (!frameAsked) return;
  frameAsked = false;
  if (waiting.size > 0) askFrame();
}

function askFrame() {
  if (frameAsked) return;
  frameAsked = true;
  frameClock(turnFrame);
}

/** One frame: the nearest waiting trees are shown, up to FRAME_ELEMENTS elements; the rest wait for the next. */
function turnFrame() {
  frameAsked = false;
  const order = [...waiting].map((item) => {
    let far = Infinity;
    try {
      far = Number(item.distance());
    } catch {
      /* gone: last */
    }
    return [item, Number.isNaN(far) ? Infinity : far];
  });
  order.sort((a, b) => a[1] - b[1]);
  let spent = 0;
  for (const [item] of order) {
    if (spent > 0 && spent + item.elements > FRAME_ELEMENTS) break;
    waiting.delete(item);
    spent += item.elements;
    try {
      item.apply();
    } catch {
      /* one text's failure is not the others' */
    }
  }
  if (waiting.size > 0) askFrame();
}

/**
 * Shows a tree of `elements` elements at an animation frame: `apply()` is called then, after the trees nearer the
 * viewport (`distance()`, lower is nearer) and only while the frame's FRAME_ELEMENTS are not spent. Returns a function
 * that gives up waiting.
 */
export function inFrame(elements, distance, apply) {
  const item = { elements: Math.max(1, Number(elements) || 1), distance, apply };
  waiting.add(item);
  askFrame();
  return () => waiting.delete(item);
}

// ───────── one conversation's view

/**
 * A view: `root` the scrolling list (null: the page). `watch(element, id, onNear)` reports whether the element is near
 * (now and on every change) and returns a function that stops watching; `claim(element, n, onDemoted)` asks to show
 * `n` elements and returns `{ granted, release }`; `distance(element)` is how far it is from the viewport (0 inside);
 * `changed()` says a text changed how it is shown (plain, rich), so the list can keep its place (`onChange`, once per
 * turn, before the page is painted).
 */
export function createView({ budget = VIEW_ELEMENTS, list = false, newest: initialNewest = null, onChange = null } = {}) {
  let root = null;
  let changeHandler = onChange;
  let changing = false;
  let observer = null;
  let newest = initialNewest;
  /** Watched elements: element → { id, onNear }. */
  const watched = new Map();
  /** The texts shown rich: tickets { element, n, onDemoted }. */
  const shown = new Set();
  let used = 0;
  const observing = typeof IntersectionObserver === "function";

  const nearWithoutObserver = (id) => id === null || id === undefined || newest === null || newest.has(id);

  function startObserver() {
    observer?.disconnect();
    observer = null;
    if (!observing || !root) return;
    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) watched.get(entry.target)?.onNear(entry.isIntersecting);
      },
      { root, rootMargin: NEAR_MARGIN },
    );
    for (const element of watched.keys()) observer.observe(element);
  }

  function distance(element) {
    if (!element?.isConnected) return Infinity;
    const box = element.getBoundingClientRect();
    const frame = root ? root.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
    if (box.bottom < frame.top) return frame.top - box.bottom;
    if (box.top > frame.bottom) return box.top - frame.bottom;
    return 0;
  }

  return {
    attach(element) {
      root = element;
      startObserver();
    },
    detach() {
      observer?.disconnect();
      observer = null;
      root = null;
    },
    /** Without an observer: which Agent texts (by message id) are the newest, and so near. */
    setNewest(ids, { quiet = false } = {}) {
      newest = ids;
      if (quiet) return;
      if (observing) return;
      for (const { id, onNear } of watched.values()) onNear(nearWithoutObserver(id));
    },
    watch(element, id, onNear) {
      watched.set(element, { id, onNear });
      if (!observing) onNear(nearWithoutObserver(id));
      else if (observer) observer.observe(element);
      else if (!list) onNear(true); // a text outside any list: near (a list's are observed once it is attached)
      return () => {
        watched.delete(element);
        observer?.unobserve(element);
      };
    },
    distance,
    changed() {
      if (changing || !changeHandler) return;
      changing = true;
      queueMicrotask(() => {
        changing = false;
        changeHandler?.();
      });
    },
    set onChange(handler) {
      changeHandler = handler;
    },
    claim(element, n, onDemoted) {
      const ticket = {
        element,
        n,
        onDemoted,
        granted: false,
        release() {
          if (!ticket.granted) return;
          ticket.granted = false;
          shown.delete(ticket);
          used -= n;
        },
      };
      if (used + n > budget) {
        const mine = distance(element);
        const others = [...shown].map((other) => [other, distance(other.element)]).sort((a, b) => b[1] - a[1]);
        for (const [other, far] of others) {
          if (used + n <= budget || far <= mine) break;
          other.release();
          other.onDemoted();
        }
      }
      if (used + n <= budget) {
        used += n;
        shown.add(ticket);
        ticket.granted = true;
      }
      return ticket;
    },
    /** The elements shown rich now (tests). */
    get used() {
      return used;
    },
  };
}

/** The view of texts outside any conversation list (a text shown on its own): everything near, one budget. */
const pageView = createView();
const ViewContext = createContext(pageView);
export const useMarkdownView = () => useContext(ViewContext);

/**
 * The view of one conversation's message list: `listRef` the scrolling list, `newest` the ids of the newest Agent
 * texts (used where the browser has no IntersectionObserver), `onChange` called when texts changed how they are shown;
 * `budget`: tests.
 */
export function MarkdownView({ listRef, newest = null, onChange = null, budget = VIEW_ELEMENTS, children }) {
  const view = useMemo(() => createView({ list: true, newest, budget }), []); // (one view for the list's life)
  view.setNewest(newest, { quiet: true }); // (known to the texts rendered now; they are told of changes below)
  view.onChange = onChange;
  useEffect(() => {
    view.attach(listRef.current);
    return () => view.detach();
  }, [view, listRef]);
  useEffect(() => view.setNewest(newest), [view, newest]);
  return <ViewContext.Provider value={view}>{children}</ViewContext.Provider>;
}
