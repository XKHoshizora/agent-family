// Display preferences of this browser (localStorage), not of the account: nothing here is sent to the service.
import { useSyncExternalStore } from "react";

/** Whether each reply of my Agents shows what it cost (用量与余额 › 在每条回复下显示消耗的点数): "1" when on. */
export const REPLY_POINTS_KEY = "agent-family:show-reply-points";

const listeners = new Set();
/** The value this page holds, read from the storage once (null until then) and kept in step by `set` and the `storage` event. */
let cached = null;

function storage() {
  return globalThis.localStorage;
}

function readStored() {
  try {
    return storage()?.getItem(REPLY_POINTS_KEY) === "1";
  } catch {
    return false;
  }
}

function notify() {
  for (const fn of [...listeners]) fn();
}

// Another tab of this browser changed it (or cleared the storage): read it again once, then tell every subscriber.
globalThis.addEventListener?.("storage", (event) => {
  if (event.key !== REPLY_POINTS_KEY && event.key !== null) return;
  cached = readStored();
  notify();
});

/** Whether replies show their points: off by default, and when the storage cannot be read. Never reads the storage twice. */
export function showReplyPoints() {
  if (cached === null) cached = readStored();
  return cached;
}

/** Turns it on or off for this browser; every open line on this page shows the change at once. A storage that refuses the write still holds the value for this page. */
export function setShowReplyPoints(on) {
  const value = on === true;
  try {
    if (value) storage().setItem(REPLY_POINTS_KEY, "1");
    else storage().removeItem(REPLY_POINTS_KEY);
  } catch {
    // kept in memory only
  }
  cached = value;
  notify();
}

function subscribe(fn) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** `showReplyPoints()` as React state: re-renders when it changes. */
export function useShowReplyPoints() {
  return useSyncExternalStore(subscribe, showReplyPoints, () => false);
}
