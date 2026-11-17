// Display preferences of this browser (localStorage), not of the account: nothing here is sent to the service.
import { useSyncExternalStore } from "react";

/** Whether each reply of my Agents shows what it cost (用量与余额 › 在每条回复下显示消耗的点数): "1" when on. */
export const REPLY_POINTS_KEY = "agent-family:show-reply-points";

const listeners = new Set();
/** This page's value when the browser's storage refused it (a private window, storage blocked); null otherwise. */
let unstored = null;

function storage() {
  return globalThis.localStorage;
}

/** Whether replies show their points: off by default, and when the storage cannot be read. */
export function showReplyPoints() {
  if (unstored !== null) return unstored;
  try {
    return storage()?.getItem(REPLY_POINTS_KEY) === "1";
  } catch {
    return false;
  }
}

/** Turns it on or off for this browser; every open page of this tab shows the change at once. */
export function setShowReplyPoints(on) {
  const value = on === true;
  try {
    if (value) storage().setItem(REPLY_POINTS_KEY, "1");
    else storage().removeItem(REPLY_POINTS_KEY);
    unstored = null;
  } catch {
    unstored = value;
  }
  for (const fn of [...listeners]) fn();
}

function subscribe(fn) {
  listeners.add(fn);
  // Another tab of this browser changed it.
  const onStorage = (event) => {
    if (event.key === REPLY_POINTS_KEY || event.key === null) fn();
  };
  globalThis.addEventListener?.("storage", onStorage);
  return () => {
    listeners.delete(fn);
    globalThis.removeEventListener?.("storage", onStorage);
  };
}

/** `showReplyPoints()` as React state: re-renders when it changes. */
export function useShowReplyPoints() {
  return useSyncExternalStore(subscribe, showReplyPoints, () => false);
}
