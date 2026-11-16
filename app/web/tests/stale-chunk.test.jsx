// @vitest-environment jsdom
// A tab left open across a deploy asks for chunk files that are gone: reload once, else say so instead of a blank page.
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ChunkBoundary } from "../src/ui/ChunkBoundary.jsx";
import { RELOAD_GUARD_MS, installStaleChunkReload } from "../src/staleChunk.js";

afterEach(cleanup);

function Boom() {
  throw new Error("Failed to fetch dynamically imported module");
}

describe("ChunkBoundary", () => {
  it("shows the reload prompt instead of a blank page, and the button reloads", () => {
    const reload = vi.fn();
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <ChunkBoundary reload={reload}>
        <Boom />
      </ChunkBoundary>,
    );
    expect(screen.getByRole("alert").textContent).toBe("页面已更新，请刷新");
    fireEvent.click(screen.getByRole("button", { name: "刷新页面" }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("shows its children when nothing fails", () => {
    render(<ChunkBoundary>fine</ChunkBoundary>);
    expect(screen.getByText("fine")).toBeTruthy();
  });
});

describe("installStaleChunkReload", () => {
  const setup = () => {
    const store = new Map();
    const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
    const target = new EventTarget();
    const reload = vi.fn();
    let clock = 1_000_000;
    const off = installStaleChunkReload({ target, storage, reload, now: () => clock });
    return { target, reload, off, advance: (ms) => (clock += ms) };
  };

  it("reloads once; a second error right after leaves it to the boundary (no loop)", () => {
    const { target, reload } = setup();
    target.dispatchEvent(new Event("vite:preloadError"));
    target.dispatchEvent(new Event("vite:preloadError"));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("may reload again after the guard time", () => {
    const { target, reload, advance } = setup();
    target.dispatchEvent(new Event("vite:preloadError"));
    advance(RELOAD_GUARD_MS + 1);
    target.dispatchEvent(new Event("vite:preloadError"));
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("does not reload when it cannot remember that it did, and stops listening when removed", () => {
    const target = new EventTarget();
    const reload = vi.fn();
    const off = installStaleChunkReload({ target, storage: { getItem: () => null, setItem: () => { throw new Error("blocked"); } }, reload });
    target.dispatchEvent(new Event("vite:preloadError"));
    expect(reload).not.toHaveBeenCalled();
    off();
    const again = setup();
    again.off();
    again.target.dispatchEvent(new Event("vite:preloadError"));
    expect(again.reload).not.toHaveBeenCalled();
  });
});
