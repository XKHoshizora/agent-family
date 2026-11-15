import { useCallback, useEffect, useRef, useState } from "react";

/** A search starts this long after the last keystroke. */
export const SEARCH_DEBOUNCE_MS = 300;

const IDLE = { status: "idle", q: "", hits: [], nextBefore: null, loadingMore: false, error: null, moreError: null };

const keyOf = (m) => `${m.conversationId}:${m.seq}`;

/**
 * The state of one message search box, kept apart from the conversations (hits may lie far from what is loaded).
 * `search(q, before)` resolves `{ok, hits, nextBefore}` or `{ok: false, error}` (`actions.searchConversation` / `searchAll`).
 * A query is trimmed; an empty one is idle. A new query waits SEARCH_DEBOUNCE_MS and drops whatever an older one
 * still has in flight (its answer is ignored). `scope` names what is searched: a change starts over.
 * @returns {{status: "idle"|"loading"|"ready"|"error", q: string, hits: object[], more: boolean, loadingMore: boolean,
 *   error: object|null, loadMore: () => void, retry: () => void}}
 */
export function useMessageSearch(query, search, scope = "") {
  const q = query.trim();
  const [state, setState] = useState(IDLE);
  const latest = useRef(state);
  latest.current = state;
  const run = useRef(search);
  run.current = search;
  /** Numbers the requests: only the answer of the latest counts. */
  const ticket = useRef(0);

  const first = useCallback((term) => {
    const mine = ++ticket.current;
    setState({ ...IDLE, status: "loading", q: term });
    run.current(term, null).then((res) => {
      if (ticket.current !== mine) return;
      setState(
        res.ok
          ? { ...IDLE, status: "ready", q: term, hits: res.hits, nextBefore: res.nextBefore }
          : { ...IDLE, status: "error", q: term, error: res.error },
      );
    });
  }, []);

  useEffect(() => {
    ticket.current += 1; // whatever an earlier query still has in flight is no longer wanted
    if (!q) {
      setState(IDLE);
      return undefined;
    }
    setState({ ...IDLE, status: "loading", q });
    const timer = window.setTimeout(() => first(q), SEARCH_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      ticket.current += 1;
    };
  }, [q, scope, first]);

  const loadMore = useCallback(() => {
    const s = latest.current;
    if (s.status !== "ready" || s.nextBefore === null || s.nextBefore === undefined || s.loadingMore) return;
    const mine = ++ticket.current;
    setState((c) => ({ ...c, loadingMore: true, moreError: null }));
    run.current(s.q, s.nextBefore).then((res) => {
      if (ticket.current !== mine) return;
      setState((c) => {
        if (!res.ok) return { ...c, loadingMore: false, moreError: res.error };
        const seen = new Set(c.hits.map(keyOf));
        return { ...c, loadingMore: false, moreError: null, hits: [...c.hits, ...res.hits.filter((m) => !seen.has(keyOf(m)))], nextBefore: res.nextBefore };
      });
    });
  }, []);

  const retry = useCallback(() => {
    const s = latest.current;
    if (s.status === "error") first(s.q);
    else loadMore();
  }, [first, loadMore]);

  return {
    status: state.status,
    q: state.q,
    hits: state.hits,
    more: state.nextBefore !== null && state.nextBefore !== undefined,
    loadingMore: state.loadingMore,
    error: state.status === "error" ? state.error : state.moreError,
    loadMore,
    retry,
  };
}
