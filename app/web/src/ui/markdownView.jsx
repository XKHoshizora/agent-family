// What one open conversation spends on Agents' rendered texts. Only texts in or near the message list's viewport are
// sent to the Markdown worker and rendered rich (an IntersectionObserver on the list, with a generous margin); a text
// once rich stays rich while it is shown. And all the rich trees shown at once have at most VIEW_ELEMENTS elements:
// when one more would pass that, the ones farthest from the viewport go back to plain text (until they come near
// again). So opening a conversation costs at most what is visible, each text capped.
import React, { createContext, useContext, useEffect, useMemo } from "react";

/** The elements of all rich texts shown at once in one conversation. */
export const VIEW_ELEMENTS = 30000;
/** How far beyond the visible part of the list a text counts as near (the list's own height, above and below). */
export const NEAR_MARGIN = "100% 0px 100% 0px";
/** Without IntersectionObserver: the newest this many Agent texts count as near. */
export const NEWEST_NEAR = 20;

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
