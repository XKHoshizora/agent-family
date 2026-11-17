// @vitest-environment jsdom
// The work an Agent's text can cause is bounded by what the renderer produces and by time, whatever the input: a cost
// gate before any highlighting grammar runs and caps on its output; caps on maths output per formula and per text; one
// final count of the whole tree before React sees it; and a time limit on the whole render, with texts found too slow
// remembered (by digest only) and shown plain from then on. Each test asserts on the work done, and only loosely on time.
import { useTimeLimits } from "./markdown-ready.js";
import React from "react";
import katex from "katex";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { AgentText, StreamingAgentText } from "../src/pages/AgentChatBits.jsx";
import { LIMITS, Markdown, highlighter } from "../src/ui/Markdown.jsx";
import { fitsMarkdown } from "../src/ui/markdownLimits.js";
import { SLOW_TEXTS_KEPT, SLOW_TEXT_NOTE, digestOf, isSlowText, rememberSlowText } from "../src/ui/slowTexts.jsx";
import { CASES } from "./hostile-cases.js";

const KEY = "agent-family.slow-markdown";
/** Loose: the counts are the measure (the machine runs other work at the same time). */
const WALL_MS = 15000;

let errors;
beforeEach(() => {
  sessionStorage.clear();
  errors = vi.spyOn(console, "error");
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const inBubble = (node) => <div className="bubble">{node}</div>;
function show(text) {
  return render(inBubble(<AgentText text={text} />)).container.firstChild;
}
/** Elements under the bubble and the deepest one's depth below it, counted without recursion. */
function measure(bubble) {
  let elements = 0;
  let depth = 0;
  const stack = [[bubble, 0]];
  while (stack.length > 0) {
    const [node, level] = stack.pop();
    for (const child of node.children) {
      elements += 1;
      depth = Math.max(depth, level + 1);
      stack.push([child, level + 1]);
    }
  }
  return { elements, depth };
}
/** Elements in a hast tree and its deepest element's depth. */
function hastSize(tree) {
  let elements = 0;
  let depth = 0;
  const stack = [[tree, 0]];
  while (stack.length > 0) {
    const [node, level] = stack.pop();
    if (node.type === "element") {
      elements += 1;
      depth = Math.max(depth, level);
    }
    for (const child of node.children ?? []) stack.push([child, level + 1]);
  }
  return { elements, depth };
}
const stored = () => JSON.parse(sessionStorage.getItem(KEY) ?? "[]");
const longestLine = (source) => Math.max(...source.split("\n").map((line) => line.length));
const wrapLines = (body, n) => Array.from({ length: Math.ceil(body.length / n) }, (_, i) => body.slice(i * n, (i + 1) * n)).join("\n");

/**
 * What each case must come to, beyond the bounds every case is held to: not parsed at all (`unparsed`), shown as its
 * plain text (`plain`), no formula typeset (`no-maths`), no grammar run (`no-highlight`), or highlighted and the
 * result discarded (`discarded`).
 */
const OUTCOME = {
  r1_table_2000x20000: "unparsed",
  c1_2000x20000: "unparsed",
  c1_100x60_piped: "unparsed",
  c1_just_under: "unparsed",
  md_tables_many: "unparsed",
  c1_300x2000: "plain",
  md_soft_breaks: "plain",
  r1_macro400: "no-maths",
  c2_macro100: "no-maths",
  one_sup_nest: "no-maths",
  one_sub_sup_nest: "no-maths",
  one_text_nest: "no-maths",
  one_mathchoice: "no-maths",
  code_js_tpl_2k: "no-highlight",
  code_js_tpl_4k: "no-highlight",
  code_js_tpl_6k: "no-highlight",
  code_js_tpl_9k: "no-highlight",
  code_js_tpl_20k: "no-highlight",
  code_js_tpl_x5_4k: "no-highlight",
  code_rust_cmt_9k: "no-highlight",
  code_bash_9k: "no-highlight",
  code_shell_4: "no-highlight",
  code_shell_dollar: "no-highlight",
  code_mdlink_1: "no-highlight",
  code_mdlink_line5k: "no-highlight",
  code_mdlink_5: "no-highlight",
  code_mdimg_1: "no-highlight",
  code_c_dyn_1: "no-highlight",
  code_shell_1: "discarded",
  code_shell_8: "discarded",
};

describe("the reviews' hostile texts", () => {
  it.each(Object.keys(CASES))("%s: bounded work", (name) => {
    const text = CASES[name]();
    const typesets = vi.spyOn(katex, "renderToString");
    const highlights = vi.spyOn(highlighter, "highlight");
    const started = performance.now();
    const bubble = show(text);
    const ms = performance.now() - started;
    const { elements, depth } = measure(bubble);
    // Never more than the final count lets through (+ the `.md` wrapper): the rest is plain text.
    expect(elements).toBeLessThanOrEqual(LIMITS.treeElements + 1);
    expect(depth).toBeLessThanOrEqual(LIMITS.treeDepth + 1);
    // No more formulas typeset than the cap; no block given to a grammar that the cost gate refuses.
    expect(typesets.mock.calls.length).toBeLessThanOrEqual(LIMITS.mathCount);
    for (const [, source] of highlights.mock.calls) {
      expect(source.length).toBeLessThanOrEqual(LIMITS.highlightCode);
      expect(longestLine(source)).toBeLessThanOrEqual(LIMITS.highlightLine);
    }
    expect(bubble.querySelectorAll("[class^='hljs-']").length).toBeLessThanOrEqual(LIMITS.highlightElements);
    // The note shows exactly when the text was found too slow, and then it is remembered (its digest only).
    expect(bubble.querySelector(".md-note") !== null).toBe(isSlowText(text));
    const outcome = OUTCOME[name];
    if (outcome === "unparsed") {
      expect(fitsMarkdown(text)).toBe(false);
      expect(elements).toBe(0);
    }
    if (outcome === "plain") expect(bubble.querySelector(".md-plain, .md-note")).not.toBeNull();
    if (outcome === "no-maths") expect(typesets).not.toHaveBeenCalled();
    if (outcome === "no-highlight") expect(highlights).not.toHaveBeenCalled();
    if (outcome === "discarded") {
      expect(highlights).toHaveBeenCalled();
      expect(bubble.querySelector("[class^='hljs-']")).toBeNull();
    }
    expect(ms).toBeLessThan(WALL_MS);
    expect(errors).not.toHaveBeenCalled();
  });
});

describe("highlighting, refused by cost before any grammar runs", () => {
  const OPENERS = ["[a](", "${", "/*", '"', "'", "`", "<", "{", "(", "`${"];
  it.each(highlighter.listLanguages())("%s: lines of 5 000 characters of openers", (language) => {
    const highlights = vi.spyOn(highlighter, "highlight");
    for (const opener of OPENERS) {
      // (After an `x`, so that a line of backticks is code, not the fence's end.)
      const line = `x${opener.repeat(Math.ceil(5000 / opener.length))}`.slice(0, 5000);
      const bubble = show(`\`\`\`${language}\n${line}\n\`\`\``);
      expect(bubble.querySelector("pre > code").textContent).toBe(`${line}\n`);
      cleanup();
    }
    expect(highlights).not.toHaveBeenCalled();
  });

  it("Markdown fences are not highlighted at all (its grammar is not registered)", () => {
    expect(highlighter.registered("markdown")).toBe(false);
    expect(highlighter.registered("md")).toBe(false);
  });

  it("a block over 10 000 characters, or with a line over 500, is not highlighted; within both it is", () => {
    const highlights = vi.spyOn(highlighter, "highlight");
    show(`\`\`\`js\n${"let a = 1;\n".repeat(1000)}\`\`\``); // 11 000 characters
    show(`\`\`\`js\nlet a = "${"x".repeat(500)}";\n\`\`\``); // one line of 511
    expect(highlights).not.toHaveBeenCalled();
    const bubble = show(`\`\`\`js\n${"let a = 1;\n".repeat(900)}\`\`\``);
    expect(highlights).toHaveBeenCalledTimes(1);
    expect(bubble.querySelector(".hljs-keyword")).not.toBeNull();
  });

  it("never a fence still open at the end of the text (a reply being written): only once it closes", () => {
    const highlights = vi.spyOn(highlighter, "highlight");
    const { container, rerender } = render(inBubble(<AgentText text={"```js\nconst open = 1;"} />));
    rerender(inBubble(<AgentText text={"```js\nconst open = 1;\nconst more = 2;"} />));
    expect(highlights).not.toHaveBeenCalled();
    expect(container.querySelector("pre > code").textContent).toBe("const open = 1;\nconst more = 2;\n");
    rerender(inBubble(<AgentText text={"```js\nconst open = 1;\nconst more = 2;\n```"} />));
    expect(highlights).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".hljs-keyword")).not.toBeNull();
  });

  it("a result with too many elements or nesting too deep is discarded (plain code), and not highlighted again", () => {
    const highlights = vi.spyOn(highlighter, "highlight");
    const deep = `\`\`\`shell\n${wrapLines("`${".repeat(300), 80)}\n\`\`\``; // nests ~300 deep
    const wide = `\`\`\`json\n${wrapLines("[[".repeat(2000), 80)}\n\`\`\``; // ~4 000 elements
    const { container, rerender } = render(inBubble(<AgentText text={`${deep}\n\n${wide}`} />));
    expect(highlights).toHaveBeenCalledTimes(2);
    const [deepResult, wideResult] = highlights.mock.results.map(({ value }) => hastSize(value));
    expect(deepResult.depth).toBeGreaterThan(LIMITS.highlightDepth);
    expect(wideResult.elements).toBeGreaterThan(LIMITS.highlightElements);
    expect(container.querySelector("[class^='hljs-']")).toBeNull();
    rerender(inBubble(<AgentText text={`${deep}\n\n${wide}\n\n。`} />));
    expect(highlights).toHaveBeenCalledTimes(2);
  });

  describe("within the app's time limits", () => {
  useTimeLimits();
  it("past 100 ms of highlighting in one text the remaining blocks are plain; the next pieces highlight them", () => {
    let clock = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const real = highlighter.highlight;
    const highlights = vi.spyOn(highlighter, "highlight").mockImplementation((...args) => {
      clock += 60;
      return real(...args);
    });
    const blocks = [1, 2, 3].map((i) => `\`\`\`js\nconst budget${i} = ${i};\n\`\`\``).join("\n\n");
    const { container, rerender } = render(inBubble(<AgentText text={blocks} />));
    // 60, then 120 ms: the third block waits.
    expect(highlights).toHaveBeenCalledTimes(2);
    expect(container.querySelectorAll("code.hljs")).toHaveLength(2);
    rerender(inBubble(<AgentText text={`${blocks}\n\n。`} />));
    expect(highlights).toHaveBeenCalledTimes(3);
    expect(container.querySelectorAll("code.hljs")).toHaveLength(3);
  });
  });
});

describe("maths output", () => {
  it("a text's KaTeX output is capped at 200 000 characters, kept results included", () => {
    const typesets = vi.spyOn(katex, "renderToString");
    const big = (i) => `$$\n${i}+${"x^{1}".repeat(190)}\n$$`; // ~90 000 characters of HTML each
    const text = [100, 101, 102].map(big).join("\n\n");
    const { container, rerender } = render(inBubble(<AgentText text={text} />));
    const sizes = typesets.mock.results.map(({ value }) => value.length);
    expect(sizes.every((size) => size > 80000 && size <= LIMITS.katexOutput)).toBe(true);
    expect(container.querySelectorAll(".katex")).toHaveLength(2);
    expect(container.querySelectorAll("pre > code")).toHaveLength(1);
    rerender(inBubble(<AgentText text={`${text}\n\n。`} />));
    expect(container.querySelectorAll(".katex")).toHaveLength(2);
    expect(typesets.mock.calls.length).toBeLessThanOrEqual(3);
  });
});

describe("the final count holds on its own", () => {
  // Every earlier limit lifted, the raw-text checks skipped (the renderer is used directly), and no time limits (a
  // clock that never moves): what remains is the count of the whole tree.
  const EARLIER = ["cells", "mathCount", "katexOutput", "katexTextOutput", "katexBudgetMs", "katexSlowMs", "highlightLine", "highlightCode", "highlightElements", "highlightDepth", "highlightBudgetMs", "highlightSlowMs"];
  let saved;
  beforeEach(() => {
    saved = { ...LIMITS };
    for (const key of EARLIER) LIMITS[key] = Infinity;
    vi.spyOn(performance, "now").mockReturnValue(0);
  });
  afterEach(() => Object.assign(LIMITS, saved));

  const table = (cols, rows) => `${"|a".repeat(cols)}|\n${"|-".repeat(cols)}|\n${"x\n".repeat(rows)}`;
  it.each([
    ["a table padded to 20 000 cells", table(100, 200), "cells"],
    ["highlighted code nesting ~666 deep", CASES.code_js_tpl_2k(), "highlight"],
    ["48 large formulas", Array.from({ length: 48 }, (_, i) => `$$\nfinal${i}+${"x^{1}".repeat(198)}\n$$`).join("\n\n"), "maths"],
    ["25 000 line breaks", CASES.md_soft_breaks(), "breaks"],
  ])("%s", (_, text, earlier) => {
    const typesets = vi.spyOn(katex, "renderToString");
    const highlights = vi.spyOn(highlighter, "highlight");
    const { container } = render(inBubble(<Markdown text={text} />));
    // The earlier guard really was out of the way: its work was done…
    if (earlier === "highlight") expect(highlights).toHaveBeenCalledTimes(1);
    if (earlier === "maths") expect(typesets).toHaveBeenCalledTimes(48);
    // …and the final count turned the text into its plain text.
    expect(container.querySelector(".md > .md-plain").textContent).toBe(text);
    expect(measure(container.firstChild).elements).toBe(2);
    expect(errors).not.toHaveBeenCalled();
  });
});

describe("a text that takes too long to render", () => {
  useTimeLimits();

  /** A clock that moves only while KaTeX works: each typeset "takes" `cost(tex)` milliseconds. */
  function slowKatex(cost) {
    let clock = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const real = katex.renderToString;
    return vi.spyOn(katex, "renderToString").mockImplementation((tex, options) => {
      clock += cost(tex);
      return real.call(katex, tex, options);
    });
  }

  it("is shown plain with a note, remembered by its digest only, and not rendered again (also after a reload)", async () => {
    const typesets = slowKatex(() => 500);
    const text = "很慢的回复 $$x^{slow1}$$";
    const bubble = show(text);
    expect(bubble.textContent).toBe(`${text}${SLOW_TEXT_NOTE}`);
    expect(bubble.querySelector(".md")).toBeNull();
    expect(typesets).toHaveBeenCalledTimes(1);
    expect(stored()).toEqual([digestOf(text)]);
    expect(stored()[0]).toMatch(/^[0-9a-f]{16}:\d+$/);
    expect(sessionStorage.getItem(KEY)).not.toContain("慢");
    cleanup();
    const again = show(text);
    expect(again.querySelector(".md-note").textContent).toBe(SLOW_TEXT_NOTE);
    expect(typesets).toHaveBeenCalledTimes(1);
    // A reload: the module's memory starts empty, the tab's storage still has the digest.
    vi.resetModules();
    const reloaded = await import("../src/ui/slowTexts.jsx");
    expect(reloaded.isSlowText(text)).toBe(true);
    expect(reloaded.isSlowText(`${text}。`)).toBe(false);
  });

  it("storage that fails never breaks rendering; the text is still remembered in the page", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const typesets = slowKatex(() => 500);
    const text = "很慢的回复 $$x^{slow2}$$";
    expect(show(text).querySelector(".md-note")).not.toBeNull();
    cleanup();
    expect(show(text).querySelector(".md-note")).not.toBeNull();
    expect(typesets).toHaveBeenCalledTimes(1);
    expect(errors).not.toHaveBeenCalled();
  });

  it(`keeps at most ${SLOW_TEXTS_KEPT} digests, the oldest dropped`, () => {
    for (let i = 0; i < SLOW_TEXTS_KEPT + 5; i += 1) rememberSlowText(`第${i}条`);
    const list = stored();
    expect(list).toHaveLength(SLOW_TEXTS_KEPT);
    expect(list[0]).toBe(digestOf("第5条"));
    expect(list.at(-1)).toBe(digestOf(`第${SLOW_TEXTS_KEPT + 4}条`));
  });

  it("in a reply being written, once a piece is too slow the rest of the reply is plain (nothing remembered)", async () => {
    const typesets = slowKatex((tex) => (tex.includes("slow3") ? 500 : 1));
    const first = "开头 $$x^{slow3}$$";
    const { container, rerender } = render(inBubble(<StreamingAgentText text={first} />));
    expect(container.querySelector(".md-note")).not.toBeNull();
    for (const more of [" 接着", " 接着 **再**", " 接着 **再** $$y^{fast}$$"]) {
      await act(async () => rerender(inBubble(<StreamingAgentText text={first + more} />)));
      expect(container.querySelector(".md")).toBeNull();
      expect(container.querySelector(".md-note")).not.toBeNull();
    }
    expect(typesets).toHaveBeenCalledTimes(1);
    expect(stored()).toEqual([]);
  });
});
