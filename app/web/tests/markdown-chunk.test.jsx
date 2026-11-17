// @vitest-environment jsdom
// The Markdown renderer is its own chunk, asked for the first time an Agent's text is shown. Until it is here, if it
// cannot be loaded, or if it fails on a text, the text is shown plain (as a person's message is) and nothing breaks.
// Each test reads a fresh copy of AgentChatBits (its chunk state is per module).
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { deferred } from "./fixtures.js";

afterEach(() => {
  cleanup();
  vi.doUnmock("../src/ui/Markdown.jsx");
  vi.resetModules();
  vi.restoreAllMocks();
});

/** A fresh AgentChatBits, its renderer module replaced by `factory`'s when one is given. */
async function freshAgentChatBits(factory) {
  vi.resetModules();
  if (factory) vi.doMock("../src/ui/Markdown.jsx", factory);
  return import("../src/pages/AgentChatBits.jsx");
}

const inBubble = (AgentText, text) => (
  <div className="bubble">
    <AgentText text={text} />
  </div>
);

describe("the renderer's chunk", () => {
  it("is asked for once, on the first Agent text; the text is plain until it has arrived", async () => {
    const gate = deferred();
    let loads = 0;
    // (A stand-in renderer: what is tested here is when it is asked for and what is shown meanwhile.)
    const { AgentText } = await freshAgentChatBits(async () => {
      loads += 1;
      await gate.promise;
      return { Markdown: ({ text }) => <div className="md">{text}</div> };
    });
    expect(loads).toBe(0);
    const { container, rerender } = render(inBubble(AgentText, "**粗体**"));
    expect(container.textContent).toBe("**粗体**");
    expect(container.querySelector(".md")).toBeNull();
    // A streaming reply keeps growing meanwhile: still plain, still one request.
    await act(async () => rerender(inBubble(AgentText, "**粗体** 和")));
    expect(container.textContent).toBe("**粗体** 和");
    expect(container.querySelector(".md")).toBeNull();
    await act(async () => {
      gate.resolve();
      await gate.promise;
    });
    await vi.waitFor(() => expect(container.querySelector(".md")?.textContent).toBe("**粗体** 和"));
    expect(loads).toBe(1);
  });

  it("that cannot be loaded leaves every Agent text plain, without an error shown", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { AgentText, loadMarkdown } = await freshAgentChatBits();
    const failed = loadMarkdown(async () => {
      throw new TypeError("Failed to fetch dynamically imported module: /assets/Markdown-x.js");
    });
    const { container, rerender } = render(inBubble(AgentText, "**一**"));
    expect(container.textContent).toBe("**一**");
    await act(async () => {
      await failed.catch(() => {});
    });
    expect(container.textContent).toBe("**一**");
    rerender(inBubble(AgentText, "**一** 二"));
    expect(container.textContent).toBe("**一** 二");
    expect(container.querySelector("strong, .md, [role='alert']")).toBeNull();
  });
});

describe("a renderer that fails on a text", () => {
  it("shows that text plain, and renders the next text again", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const Markdown = ({ text }) => {
      if (text.includes("炸")) throw new Error("renderer failed");
      return (
        <div className="md">
          <strong>{text}</strong>
        </div>
      );
    };
    const { AgentText, loadMarkdown } = await freshAgentChatBits();
    // (The chunk is here before the first render, so nothing suspends.)
    await loadMarkdown(async () => ({ Markdown }));
    const { container, rerender } = render(inBubble(AgentText, "会炸的 **文本**"));
    expect(container.textContent).toBe("会炸的 **文本**");
    expect(container.querySelector(".md, [role='alert']")).toBeNull();
    expect(log.mock.calls.some((args) => args.some((a) => a instanceof Error && a.message === "renderer failed"))).toBe(true);
    rerender(inBubble(AgentText, "好的文本"));
    expect(container.querySelector(".md strong").textContent).toBe("好的文本");
  });
});
