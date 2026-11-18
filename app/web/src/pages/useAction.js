import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "../data/store.jsx";
import { commonErrorText } from "../data/errorTexts.js";

/** An action's answer (`{ok, value}` or `{ok: false, error, text}`) as a value, or the refusal thrown (for `run`). */
export async function settled(pending) {
  const result = await pending;
  if (!result.ok) throw result;
  return result.value;
}

/** The sentence of a refusal thrown by `settled` (or of anything else that went wrong). */
export const refusalText = (error) => error?.text ?? commonErrorText(error);

/**
 * Runs one action at a time per key and says which is running (`busy`), so its button shows the pending state.
 * `run(key, work, textFor)` → `{ok: true, value}` or `{ok: false, error}`; a failure toasts `textFor(error)` (no toast when it is empty).
 */
export function useAction() {
  const { dispatch } = useStore();
  const [busy, setBusy] = useState(null);
  const alive = useRef(true);
  const running = useRef(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const run = useCallback(
    async (key, work, textFor) => {
      if (running.current !== null) return { ok: false, error: { code: "busy_here" } };
      running.current = key;
      setBusy(key);
      try {
        const value = await work();
        return { ok: true, value };
      } catch (error) {
        const text = textFor(error);
        if (text) dispatch({ type: "toast", text });
        return { ok: false, error };
      } finally {
        running.current = null;
        if (alive.current) setBusy(null);
      }
    },
    [dispatch],
  );
  return { busy, run };
}

/** The current time, refreshed every `everyMs` while the component is mounted (shown). */
export function useNow(everyMs = 60 * 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), everyMs);
    return () => window.clearInterval(id);
  }, [everyMs]);
  return now;
}
