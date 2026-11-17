// @vitest-environment jsdom
// What one conversation spends on Agents' rendered texts (src/ui/markdownView.jsx): only texts in or near the visible
// part of the list are sent to the worker and rendered rich (IntersectionObserver, mocked here); a rich text stays rich
// while shown; all rich texts together stay within the view's element budget, the ones farthest from view going back
// to plain first; without IntersectionObserver the newest 20 Agent texts count as near.
import React, { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { AgentText, loadMarkdown } from "../src/ui/AgentText.jsx";
import { MarkdownView, NEWEST_NEAR } from "../src/ui/markdownView.jsx";
import { renderToTree } from "../src/ui/markdownPipeline.js";
import { validateTree } from "../src/ui/markdownTree.js";
import { InProcessWorker, SilentWorker, settle, useWorkers } from "./markdown-worker.js";

await loadMarkdown();

/** A stand-in IntersectionObserver: records what is observed; the test says what is near. */
class FakeObserver {
  static all = [];
  constructor(callback, options) {
    this.callback = callback;
    this.options = options;
    this.targets = new Set();
    FakeObserver.all.push(this);
  }
  observe(target) {
    this.targets.add(target);
  }
  unobserve(target) {
    this.targets.delete(target);
  }
  disconnect() {
    this.targets.clear();
  }
}
/** Says that these elements are (or are not) near the visible part of the list. */
async function near(elements, isIntersecting = true) {
  const observer = FakeObserver.all.at(-1);
  await act(async () => observer.callback(elements.map((target) => ({ target, isIntersecting }))));
  await settle();
}

/** Where each text is, for distances from the visible part (the list shows 0–800). */
function placeAt(element, top) {
  element.getBoundingClientRect = () => ({ top, bottom: top + 100, left: 0, right: 100, width: 100, height: 100 });
}

function Conversation({ texts, budget, newest = null }) {
  const list = useRef(null);
  return (
    <MarkdownView listRef={list} budget={budget} newest={newest}>
      <ol ref={list}>
        {texts.map((text, i) => (
          <li key={i} data-i={i}>
            <AgentText text={text} id={`m${i}`} />
          </li>
        ))}
      </ol>
    </MarkdownView>
  );
}

const textEl = (container, i) => container.querySelector(`li[data-i="${i}"] .md-text`);
const isRich = (container, i) => textEl(container, i).querySelector(".md") !== null;
/** A text of `n` list items: its tree has n + 1 elements, n + 2 in the page. */
const items = (n, tag) => `${tag}\n\n${"- 项\n".repeat(n)}`;

beforeEach(() => {
  FakeObserver.all = [];
  vi.stubGlobal("IntersectionObserver", FakeObserver);
  sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("only texts near the visible part are rendered rich", () => {
  it("observes the list with a generous margin; nothing is sent until a text is near; then only the near ones", async () => {
    const { workers } = useWorkers();
    const texts = Array.from({ length: 30 }, (_, i) => `**第 ${i} 条**`);
    const { container } = render(<Conversation texts={texts} />);
    await settle();
    const observer = FakeObserver.all.at(-1);
    expect(observer.options.root).toBe(container.querySelector("ol"));
    expect(observer.options.rootMargin).toBe("100% 0px 100% 0px");
    expect(observer.targets.size).toBe(30);
    expect(workers.flatMap((w) => w.sent)).toHaveLength(0);
    await near([25, 26, 27, 28, 29].map((i) => textEl(container, i)));
    expect(workers.flatMap((w) => w.sent.map((m) => m.text))).toEqual(texts.slice(25));
    for (let i = 0; i < 30; i += 1) expect(isRich(container, i), `text ${i}`).toBe(i >= 25);
    expect(textEl(container, 3).textContent).toBe("**第 3 条**");
  });

  it("the nearest is sent first", async () => {
    const workers = [];
    useWorkers(() => workers[workers.push(new SilentWorker()) - 1]);
    const { container } = render(<Conversation texts={["远", "最近", "近"]} />);
    await settle();
    placeAt(container.querySelector("ol"), 0);
    container.querySelector("ol").getBoundingClientRect = () => ({ top: 0, bottom: 800 });
    placeAt(textEl(container, 0), -3000);
    placeAt(textEl(container, 1), 400);
    placeAt(textEl(container, 2), 1000);
    await near([0, 1, 2].map((i) => textEl(container, i)));
    expect(workers[0].sent.map((m) => m.text)).toEqual(["最近"]);
  });

  it("a text no longer near before it is sent is not sent; a rich text stays rich when it leaves", async () => {
    const workers = [];
    useWorkers(() => workers[workers.push(new SilentWorker()) - 1]);
    const { container } = render(<Conversation texts={["**一**", "**二**"]} />);
    await settle();
    await near([textEl(container, 0), textEl(container, 1)]);
    expect(workers[0].sent.map((m) => m.text)).toEqual(["**一**"]);
    await near([textEl(container, 1)], false);
    workers[0].emit({ id: workers[0].sent[0].id, ...renderToTree("**一**") });
    await settle();
    expect(workers[0].sent.map((m) => m.text)).toEqual(["**一**"]); // the second was dropped
    expect(isRich(container, 0)).toBe(true);
    await near([textEl(container, 0)], false);
    expect(isRich(container, 0)).toBe(true);
  });
});

describe("the view's element budget", () => {
  it("one more text past the budget sends the farthest rich text back to plain; it is rich again once near again", async () => {
    useWorkers(() => new InProcessWorker());
    const texts = [items(40, "甲"), items(40, "乙"), items(40, "丙")];
    const rendered = validateTree(renderToTree(texts[0]).tree).rendered;
    const { container } = render(<Conversation texts={texts} budget={2 * rendered + 5} />);
    await settle();
    container.querySelector("ol").getBoundingClientRect = () => ({ top: 0, bottom: 800 });
    placeAt(textEl(container, 0), -5000);
    placeAt(textEl(container, 1), -2000);
    placeAt(textEl(container, 2), 300);
    await near([textEl(container, 0), textEl(container, 1)]);
    expect([0, 1, 2].map((i) => isRich(container, i))).toEqual([true, true, false]);
    await near([textEl(container, 2)]);
    // The third is the nearest: the farthest (the first) went back to plain.
    expect([0, 1, 2].map((i) => isRich(container, i))).toEqual([false, true, true]);
    expect(textEl(container, 0).textContent).toBe(texts[0]);
    // The first comes near again (and is now the nearest): it is rich again, and the farthest goes.
    placeAt(textEl(container, 0), 200);
    placeAt(textEl(container, 2), 4000);
    await near([textEl(container, 0)], false);
    await near([textEl(container, 0)]);
    expect([0, 1, 2].map((i) => isRich(container, i))).toEqual([true, true, false]);
  });

  it("opening a long conversation renders only what is near, however many heavy texts it holds", async () => {
    const { workers } = useWorkers();
    const texts = Array.from({ length: 60 }, (_, i) => items(500, `第 ${i} 条`));
    const { container } = render(<Conversation texts={texts} />);
    await settle();
    await near([57, 58, 59].map((i) => textEl(container, i)));
    expect(workers.flatMap((w) => w.sent)).toHaveLength(3);
    expect(container.querySelectorAll(".md")).toHaveLength(3);
    expect(container.querySelectorAll("li li").length).toBe(1500);
  });
});

describe("without IntersectionObserver", () => {
  it(`the newest ${NEWEST_NEAR} Agent texts count as near`, async () => {
    vi.unstubAllGlobals();
    vi.stubGlobal("IntersectionObserver", undefined);
    const { workers } = useWorkers();
    const texts = Array.from({ length: 25 }, (_, i) => `**第 ${i} 条**`);
    const newest = new Set(texts.slice(-NEWEST_NEAR).map((_, i) => `m${i + 25 - NEWEST_NEAR}`));
    const { container } = render(<Conversation texts={texts} newest={newest} />);
    await settle();
    expect(workers.flatMap((w) => w.sent.map((m) => m.text))).toEqual(texts.slice(-NEWEST_NEAR));
    for (let i = 0; i < 25; i += 1) expect(isRich(container, i), `text ${i}`).toBe(i >= 25 - NEWEST_NEAR);
  });
});
