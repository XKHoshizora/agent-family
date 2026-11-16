/** A reload for a stale chunk is tried at most once in this long (so a page that stays broken cannot reload in a loop). */
export const RELOAD_GUARD_MS = 30 * 1000;
const KEY = "stale-chunk-reload";

/**
 * After a deploy an open tab asks for chunk files that no longer exist (`vite:preloadError`). The first time, the page
 * reloads itself to get the new ones; if that happened just now already, the error is left to the error boundary.
 * @returns {() => void} removes the listener
 */
export function installStaleChunkReload({ target = window, storage = safeStorage(), now = () => Date.now(), reload = () => window.location.reload() } = {}) {
  const onError = () => {
    let last = 0;
    try {
      last = Number(storage?.getItem(KEY)) || 0;
    } catch {
      /* no storage: reload once per page load below */
    }
    if (last && now() - last < RELOAD_GUARD_MS) return;
    try {
      storage?.setItem(KEY, String(now()));
    } catch {
      return; // cannot remember it: do not risk a loop
    }
    reload();
  };
  target.addEventListener("vite:preloadError", onError);
  return () => target.removeEventListener("vite:preloadError", onError);
}

function safeStorage() {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}
