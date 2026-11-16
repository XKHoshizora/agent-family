// @vitest-environment jsdom
// The signed-in application is a separate chunk: the account screens never ask for it, a signed-in session shows the
// loading view until it has arrived.
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { App } from "../src/App.jsx";
import { createDataLayer } from "../src/data/store.jsx";
import { ME, apiError, deferred, fakeTimers, fakeTransport, syncOf } from "./fixtures.js";

const shell = vi.hoisted(() => ({ loads: 0, gate: null }));
vi.mock("../src/AppShell.jsx", async () => {
  shell.loads += 1;
  await shell.gate;
  return { default: () => <div>应用已载入</div> };
});

beforeEach(() => {
  shell.loads = 0;
  shell.gate = null;
});
afterEach(() => {
  cleanup();
  history.replaceState(null, "", "/");
});

describe("the lazy shell", () => {
  it("is not asked for on the sign-in route", async () => {
    history.replaceState(null, "", "/signin");
    render(<App api={{ getMe: async () => Promise.reject(apiError(401, "unauthenticated")) }} />);
    await screen.findByRole("button", { name: "登录" });
    expect(shell.loads).toBe(0);
  });

  it("shows the loading view until the chunk has arrived, then the application", async () => {
    const gate = deferred();
    shell.gate = gate.promise;
    history.replaceState(null, "", "/");
    const layer = createDataLayer({ transport: fakeTransport({ sync: () => syncOf([]) }), api: {}, timers: fakeTimers(), now: () => 0 });
    render(<App api={{ getMe: async () => ME }} createLayer={() => layer} />);
    await vi.waitFor(() => expect(shell.loads).toBe(1));
    expect(screen.getByText("正在加载…")).toBeTruthy();
    expect(screen.queryByText("应用已载入")).toBeNull();
    gate.resolve();
    expect(await screen.findByText("应用已载入")).toBeTruthy();
    expect(screen.queryByText("正在加载…")).toBeNull();
  });
});
