import React, { createContext, useContext, useEffect, useMemo, useReducer, useRef } from "react";
import { reducer } from "./reducer.js";
import { seedState, STORAGE_KEY, STATE_VERSION } from "../data/seed.js";

export const Ctx = createContext(null);

function load() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed?.v === STATE_VERSION) return { ...parsed, toast: null };
    }
  } catch {
    /* ignore unreadable mock state */
  }
  return seedState();
}

const clock = () => {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

// Pending simulated work derived from state. Each job carries the token the
// reducer re-checks, so a late timer can never publish into a frozen/paused scope.
function jobsOf(state) {
  const jobs = [];
  Object.values(state.convs).forEach((c) => {
    if (c.generating) jobs.push({ key: `gen:${c.id}:${c.generating.token}`, ms: 1700, action: { type: "gen/finish", convId: c.id, token: c.generating.token } });
    if (c.readToken) jobs.push({ key: `read:${c.id}:${c.readToken}`, ms: 1300, action: { type: "read/mark", convId: c.id, token: c.readToken } });
    if (c.discussion?.status === "running")
      jobs.push({ key: `disc:${c.id}:${c.discussion.token}`, ms: 1800, action: { type: "disc/tick", convId: c.id, token: c.discussion.token } });
  });
  Object.values(state.tasks).forEach((t) => {
    // ~8s per step so the owner can inspect the screen or request takeover first.
    if (t.status === "running" && t.control === "agent") jobs.push({ key: `task:${t.id}:${t.token}`, ms: 8000, action: { type: "task/tick", taskId: t.id, token: t.token } });
    if (t.control === "pendingStop" && !t.stopUnconfirmed)
      jobs.push({ key: `stop:${t.id}:${t.token}`, ms: 1500, action: { type: "task/stopConfirmed", taskId: t.id, token: t.token } });
    if (t.status === "running" && t.control === "returning") jobs.push({ key: `ret:${t.id}:${t.token}`, ms: 1300, action: { type: "task/returnChecked", taskId: t.id, token: t.token } });
  });
  if (state.toast) jobs.push({ key: `toast:${state.toast.id}`, ms: 4200, action: { type: "toast/clear", id: state.toast.id } });
  return jobs;
}

export function StoreProvider({ children }) {
  const [state, rawDispatch] = useReducer(reducer, null, load);
  const timers = useRef(new Map());

  const dispatch = useMemo(() => (action) => rawDispatch({ ...action, now: clock() }), []);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      /* storage is optional */
    }
  }, [state]);

  useEffect(() => {
    const map = timers.current;
    const jobs = jobsOf(state);
    const live = new Set(jobs.map((j) => j.key));
    map.forEach((handle, key) => {
      if (!live.has(key)) {
        window.clearTimeout(handle);
        map.delete(key);
      }
    });
    jobs.forEach((job) => {
      if (map.has(job.key)) return;
      map.set(
        job.key,
        window.setTimeout(() => {
          map.delete(job.key);
          dispatch(job.action);
        }, job.ms),
      );
    });
  }, [state, dispatch]);

  useEffect(() => {
    const map = timers.current;
    return () => {
      map.forEach((handle) => window.clearTimeout(handle));
      map.clear();
    };
  }, []);

  const value = useMemo(() => ({ state, dispatch }), [state, dispatch]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStore() {
  return useContext(Ctx);
}

export function resetDemo(dispatch) {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
  dispatch({ type: "reset" });
}
