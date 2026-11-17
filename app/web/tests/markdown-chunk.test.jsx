// @vitest-environment jsdom
// The chunk that shows a tree (ui/Markdown.jsx: the React side and KaTeX's stylesheet) is asked for the first time an
// Agent's text is sent to the worker. Until it is here, if it cannot be loaded, or if showing a tree fails, the text is
// shown plain (as a person's message is) and nothing breaks. Each test reads fresh modules (the chunk's state, and the
// page's client, are per module).
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { deferred } from "./fixtures.js";
import { InProcessWorker, settle } from "./markdown-worker.js";

afterEach(() => {
  cleanup();
  vi.doUnmock("../src/ui/Markdown.jsx");
  vi.resetModules();
  vi.restoreAllMocks();
});

/** A fresh AgentText (its renderer chunk replaced by `factory`'s when one is given), its page client on this thread. */
async function freshAgentText(factory) {
  vi.resetModules();
  if (factory) vi.doMock("../src/ui/Markdown.jsx", factory);
  const { createMarkdownClient, setMarkdownClient } = await import("../src/ui/markdownClient.js");
  setMarkdownClient(createMarkdownClient({ createWorker: () => new InProcessWorker() }));
  // (As in tests/setup.js, for these fresh modules: a tree is shown at the next microtask, not at a browser frame.)
  (await import("../src/ui/markdownView.jsx")).setFrameClock((run) => queueMicrotask(run));
  return import("../src/ui/AgentText.jsx");
}

const inBubble = (AgentText, text) => (
  <div className="bubble">
    <AgentText text={text} />
  </div>
);

describe("the chunk that shows trees", () => {
  it("is asked for once, with the first text sent to the worker; the text is plain until it has arrived", async () => {
    const gate = deferred();
    let loads = 0;
    // (A stand-in for the chunk: what is tested here is when it is asked for and what is shown meanwhile.)
    const { AgentText } = await freshAgentText(async () => {
      loads += 1;
      await gate.promise;
      return { RichTree: ({ tree }) => <div className="md">{JSON.stringify(tree)}</div> };
    });
    expect(loads).toBe(0);
    const { container, rerender } = render(inBubble(AgentText, "**粗体**"));
    expect(container.textContent).toBe("**粗体**");
    await settle();
    expect(loads).toBe(1);
    expect(container.querySelector(".md")).toBeNull();
    // Another text meanwhile: still plain, still one request for the chunk.
    rerender(inBubble(AgentText, "**粗体** 和"));
    await settle();
    expect(container.textContent).toBe("**粗体** 和");
    expect(container.querySelector(".md")).toBeNull();
    await act(async () => {
      gate.resolve();
      await gate.promise;
    });
    await vi.waitFor(() => expect(container.querySelector(".md")?.textContent).toContain("粗体"));
    expect(loads).toBe(1);
  });

  it("that cannot be loaded leaves every Agent text plain, without an error shown", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { AgentText, loadMarkdown } = await freshAgentText();
    const failed = loadMarkdown(async () => {
      throw new TypeError("Failed to fetch dynamically imported module: /assets/Markdown-x.js");
    });
    const { container, rerender } = render(inBubble(AgentText, "**一**"));
    expect(container.textContent).toBe("**一**");
    await act(async () => {
      await failed.catch(() => {});
    });
    await settle();
    expect(container.textContent).toBe("**一**");
    rerender(inBubble(AgentText, "**一** 二"));
    await settle();
    expect(container.textContent).toBe("**一** 二");
    expect(container.querySelector("strong, .md, [role='alert']")).toBeNull();
  });
});

describe("showing a tree that fails", () => {
  it("shows that text plain, and shows the next text's tree", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const RichTree = ({ tree }) => {
      if (JSON.stringify(tree).includes("炸")) throw new Error("renderer failed");
      return <div className="md">{JSON.stringify(tree)}</div>;
    };
    const { AgentText, loadMarkdown } = await freshAgentText();
    // (The chunk is here before the first render, so nothing suspends.)
    await loadMarkdown(async () => ({ RichTree }));
    const { container, rerender } = render(inBubble(AgentText, "会炸的 **文本**"));
    await settle();
    expect(container.textContent).toBe("会炸的 **文本**");
    expect(container.querySelector(".md, [role='alert']")).toBeNull();
    expect(log.mock.calls.some((args) => args.some((a) => a instanceof Error && a.message === "renderer failed"))).toBe(true);
    rerender(inBubble(AgentText, "好的 **文本**"));
    await settle();
    expect(container.querySelector(".md").textContent).toContain("好的");
  });
});
