// The whole App over a real data layer with the fake transport and a fake route API, for the contact and group pages.
import React from "react";
import { vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { App } from "../src/App.jsx";
import { createDataLayer } from "../src/data/store.jsx";
import { ANN, BO, ME, ME_ID, apiError, at, emptySocial, fakeTimers, fakeTransport, principal, syncOf } from "./fixtures.js";

export const NOW = new Date(2026, 10, 16, 12, 0).getTime();
export const DORA = "00000000-0000-4000-8000-0000000000a4";
export const CY = "00000000-0000-4000-8000-0000000000a5";
export const EVE = "00000000-0000-4000-8000-0000000000a6";
export const D2 = "00000000-0000-4000-8000-0000000000c3";
export const pub = (id, handle, displayName) => ({ id, handle, displayName });
export const PEOPLE = {
  [ANN]: pub(ANN, "ann", "小安"),
  [BO]: pub(BO, "bo", "阿波"),
  [DORA]: pub(DORA, "dora", "朵拉"),
  [CY]: pub(CY, "chen", "小陈"),
  [EVE]: pub(EVE, "eve", "伊芙"),
};
export const request = (id, who, extra = {}) => ({
  id,
  principal: who,
  createdAt: new Date(NOW - 5 * 60 * 1000).toISOString(),
  expiresAt: new Date(NOW + 24 * 60 * 60 * 1000 - 5 * 60 * 1000).toISOString(),
  ...extra,
});

/** Lets pending promises and zero-delay timers run. */
export const flush = () =>
  act(async () => {
    // At least 6 turns; then on while the work is still moving (timers scheduled or cleared), at most 60 in all.
    let before = -1;
    for (let i = 0; i < 60; i += 1) {
      await vi.advanceTimersByTimeAsync(0);
      const count = vi.getTimerCount();
      if (i >= 5 && count === before) break;
      before = count;
    }
  });
/** Moves the fake clock forward, running what falls due. */
export const elapse = (ms) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
export const toastText = () => document.querySelector(".toast")?.textContent ?? null;
export const push = (transport, event) => act(() => transport.socket.emit(event));

/** Fake timers and browser stubs the pages need; call from beforeEach, and vi.useRealTimers() in afterEach. */
export function installBrowser() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "setImmediate", "clearImmediate", "Date"] });
  vi.setSystemTime(NOW);
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.spyOn(Element.prototype, "getClientRects").mockImplementation(() => [{ top: 0 }]);
  Element.prototype.scrollIntoView = () => {};
  history.replaceState(null, "", "/");
}

/**
 * @param {object} options
 * @param {() => object} options.sync the /api/sync answer (called again on every refetch)
 * @param {object} options.social the live /api/social answer; the fake routes change it, tests may too
 * @param {object} options.api route fakes replacing the defaults
 * @param {object} options.handlers the sync engine's other answers (fakeTransport handlers: agents, agent, run, models…)
 */
export async function openApp({ sync, social = emptySocial(), api = {}, handlers = {} } = {}) {
  const env = { social, sync: sync ?? (() => syncOf([])) };
  const transport = fakeTransport({
    sync: () => env.sync(),
    social: () => structuredClone(env.social),
    conversation: (id) => {
      const found = env.sync().conversations.find((c) => c.id === id);
      if (!found) throw apiError(404, "not_found");
      return structuredClone(found);
    },
    ...handlers,
  });
  const calls = {
    markRead: vi.fn(async (_id, seq) => ({ readSeq: seq })),
    listMessages: vi.fn(async () => ({ messages: [], nextBefore: null })),
    sendMessage: vi.fn(() => new Promise(() => {})),
    lookupPrincipal: vi.fn(async (handle) => {
      const found = Object.values(PEOPLE).find((p) => p.handle === handle);
      if (!found) throw apiError(404, "not_found");
      return found;
    }),
    ...api,
  };
  let n = 0;
  // (The data layer's own timers: a reconnect's backoff runs only when the test advances them.)
  const timers = fakeTimers();
  const layer = createDataLayer({ transport, api: calls, timers, now: () => NOW, random: () => 0.5, uuid: () => `tx-${++n}` });
  render(<App api={{ getMe: async () => ME }} createLayer={() => layer} />);
  await flush();
  return { env, layer, transport, api: calls, timers };
}

const rail = (name) => within(screen.getByRole("navigation", { name: "主导航" })).getByRole("button", { name });
export const goContacts = async () => {
  fireEvent.click(rail(/^通讯录/));
  await flush();
};
export const goChats = async () => {
  fireEvent.click(rail(/^消息/));
  await flush();
};
export const click = async (target) => {
  fireEvent.click(typeof target === "string" ? screen.getByText(target) : target);
  await flush();
};
export const button = (name) => screen.getByRole("button", { name });
export const inMain = () => within(document.querySelector(".main-col"));
export const dialog = () => document.querySelector('[role="dialog"]');
export const rowNames = () => [...document.querySelectorAll(".list-col .row-name")].map((x) => x.textContent);
export const mainText = () => document.querySelector(".main-col").textContent;

export { ANN, BO, ME, ME_ID, at, principal };
