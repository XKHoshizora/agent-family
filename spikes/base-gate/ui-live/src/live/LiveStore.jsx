// Gate-verification spike: same store contract as the mock StoreProvider, but conversations,
// identities and messages come from a live backend session and sending goes to the server.
import React, { useEffect, useMemo, useReducer, useState } from "react";
import { Ctx } from "../state/store.jsx";
import { reducer } from "../state/reducer.js";
import { seedState } from "../data/seed.js";
import { PEOPLE } from "../data/identities.js";
import { connectMatrix } from "./matrix.js";
import { connectCore } from "./core.js";

const clock = () => {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

function liveReducer(state, action) {
  if (action.type === "live/sync") {
    const { snap } = action;
    // The prototype reads people from a module-level table; refill it in place.
    Object.keys(PEOPLE).forEach((k) => delete PEOPLE[k]);
    Object.assign(PEOPLE, snap.people);
    const convId = snap.convs[state.nav.convId] ? state.nav.convId : snap.order[0] || null;
    return { ...state, agents: snap.agents, convs: snap.convs, order: snap.order, relations: snap.relations, nav: { ...state.nav, convId } };
  }
  return reducer(state, action);
}

function emptyState() {
  const s = seedState();
  return { ...s, agents: {}, convs: {}, order: [], relations: {}, tasks: {}, nav: { ...s.nav, convId: null } };
}

export function LiveStoreProvider({ session, children }) {
  const [state, raw] = useReducer(liveReducer, null, emptyState);
  const dispatch = useMemo(
    () => (action) => {
      if (action.type === "msg/send") {
        if (action.kind && action.kind !== "text") return raw({ type: "toast", text: "本次验证未接附件发送", now: clock() });
        session.send(action.convId, action.text).catch((e) => raw({ type: "toast", text: `服务器拒绝：${e.errcode || ""} ${e.data?.error || e.message}`, now: clock() }));
        return;
      }
      if (action.type === "nav/openConv") session.markRead(action.convId);
      raw({ ...action, now: clock() });
    },
    [session],
  );
  useEffect(() => session.subscribe((snap) => raw({ type: "live/sync", snap })), [session]);
  useEffect(() => {
    if (!state.toast) return undefined;
    const id = state.toast.id;
    const t = setTimeout(() => raw({ type: "toast/clear", id }), 4200);
    return () => clearTimeout(t);
  }, [state.toast]);
  const value = useMemo(() => ({ state, dispatch }), [state, dispatch]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

// Minimal sign-in screen for the spike (the prototype has none).
export function LiveGate({ baseUrl, backend = "matrix", children }) {
  const [session, setSession] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError("");
    try {
      setSession(await (backend === "core" ? connectCore : connectMatrix)({ baseUrl, user: f.get("user"), password: f.get("password") }));
    } catch (err) {
      setError(String(err.message || err));
    } finally {
      setBusy(false);
    }
  }
  if (session) return <LiveStoreProvider session={session}>{children}</LiveStoreProvider>;
  return (
    <form onSubmit={submit} style={{ maxWidth: 320, margin: "18vh auto", display: "grid", gap: 12, fontSize: 16 }}>
      <strong>Agent Family · 真实数据验证登录</strong>
      <input name="user" placeholder="账号" autoComplete="username" required style={{ padding: 10 }} />
      <input name="password" type="password" placeholder="密码" autoComplete="current-password" required style={{ padding: 10 }} />
      <button type="submit" disabled={busy} style={{ padding: 10 }}>{busy ? "连接中…" : "登录"}</button>
      {error && <span role="alert" style={{ color: "#b3261e" }}>{error}</span>}
    </form>
  );
}
