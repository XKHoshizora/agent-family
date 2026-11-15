import React, { createContext, useContext, useEffect, useMemo, useReducer, useState, useSyncExternalStore } from "react";
import * as routes from "../api/routes.js";
import { reducer } from "../state/reducer.js";
import { createActions } from "./actions.js";
import { initial, resetKeepingDrafts } from "./model.js";
import { httpTransport, start as startSync } from "./sync.js";
import { toView } from "./viewmodel.js";

const Ctx = createContext(null);

// UI state (navigation, toast) kept by the reducer. The data layer's view model is merged over it.
export function emptyState(me = null) {
  return {
    nav: {
      section: "chat",
      convId: null,
      view: "chat",
      profileTab: "members",
      detailsOpen: false,
      contactId: null,
      agentId: null,
      agentView: "detail",
      agentTab: "profile",
      pane: "list",
    },
    people: me ? { me } : {},
    agents: {},
    convs: {},
    order: [],
    relations: {},
    blocks: [],
    seq: 0,
    toast: null,
  };
}

const defaultTimers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id),
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: (id) => globalThis.clearInterval(id),
};

/**
 * The model, the sync engine and the actions behind the store. Nothing talks to the service until
 * `start()`; `stop()` closes the socket and cancels every timer, forgets what the service said and keeps
 * this account's drafts and unsent messages. Every dependency can be replaced (tests use fakes).
 */
export function createDataLayer({
  transport,
  api = routes,
  timers = defaultTimers,
  now = () => Date.now(),
  random = Math.random,
  uuid = () => globalThis.crypto.randomUUID(),
} = {}) {
  const tx = transport ?? httpTransport({ timers });
  let model = initial();
  let connection = "idle";
  let snapshot = { model, connection };
  let engine = null;
  let epoch = 0;
  let notified = false;
  const listeners = new Set();
  const signedOutListeners = new Set();

  const emit = () => {
    snapshot = { model, connection };
    for (const fn of [...listeners]) fn();
  };
  const getModel = () => model;
  const setModel = (next) => {
    if (next === model) return;
    model = next;
    emit();
  };
  const setConnection = (next) => {
    if (next === connection) return;
    connection = next;
    emit();
  };

  function notifySignedOut() {
    engine = null;
    if (notified) return;
    notified = true;
    setConnection("signedOut");
    for (const fn of [...signedOutListeners]) {
      try {
        fn();
      } catch {
        /* a listener must not stop the others */
      }
    }
  }

  const { actions, reset: forgetRequests } = createActions({
    getModel,
    setModel,
    api,
    uuid,
    now,
    epoch: () => epoch,
    request: (needs) => engine?.request(needs),
    signedOut: () => (engine ? engine.signedOut() : notifySignedOut()),
  });

  return {
    actions,
    now,
    getSnapshot: () => snapshot,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /** Called once when the session ended (socket close 4001, or a 401 answer). Returns an unsubscribe. */
    onSignedOut(fn) {
      signedOutListeners.add(fn);
      return () => signedOutListeners.delete(fn);
    },
    start() {
      if (engine) return;
      notified = false;
      if (model.synced) model = resetKeepingDrafts(model); // signed out without stop(): start from a first load
      engine = startSync(tx, { getModel, setModel, timers, now, random, onSignedOut: notifySignedOut, onStatus: setConnection });
    },
    stop() {
      epoch += 1;
      forgetRequests();
      const running = engine;
      engine = null;
      running?.stop();
      model = resetKeepingDrafts(model);
      connection = "idle";
      emit();
    },
  };
}

/**
 * `useStore()` → `{state, dispatch, actions, start, stop, onSignedOut}`. `state` is the view model merged
 * with the UI state; `dispatch` takes the UI actions (nav, toast). With `initialState` the store shows that
 * fixed state instead of the view model (render tests).
 */
export function StoreProvider({ children, initialState, dataLayer }) {
  const [layer] = useState(() => dataLayer ?? createDataLayer());
  const snapshot = useSyncExternalStore(layer.subscribe, layer.getSnapshot, layer.getSnapshot);
  const [ui, dispatch] = useReducer(reducer, initialState, (s) => s || emptyState());
  const view = useMemo(() => (initialState ? null : toView(snapshot.model, { now: layer.now() })), [initialState, snapshot.model, layer]);
  const state = useMemo(() => (view ? { ...ui, ...view, connection: snapshot.connection } : ui), [ui, view, snapshot.connection]);

  useEffect(() => {
    if (!state.toast) return undefined;
    const id = state.toast.id;
    const handle = window.setTimeout(() => dispatch({ type: "toast/clear", id }), 4200);
    return () => window.clearTimeout(handle);
  }, [state.toast]);

  const value = useMemo(
    () => ({ state, dispatch, actions: layer.actions, start: layer.start, stop: layer.stop, onSignedOut: layer.onSignedOut }),
    [state, layer],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStore() {
  return useContext(Ctx);
}
