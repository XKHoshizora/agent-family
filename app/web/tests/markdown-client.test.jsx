// @vitest-environment jsdom
// The main thread's link to the Markdown worker (src/ui/markdownClient.js): one text at a time, the most needed first,
// a hard deadline that ends a late worker, answers checked and kept, and no pipeline on this thread ever — not even
// when there is no worker.
import React from "react";
import { readFileSync, readdirSync } from "node:fs";
import katex from "katex";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { AgentText, loadMarkdown } from "../src/ui/AgentText.jsx";
import { CACHE_ENTRIES, DEADLINE_MS, DROPPED, STARTUP_MS, createMarkdownClient } from "../src/ui/markdownClient.js";
import { highlighter } from "../src/ui/markdownPipeline.js";
import { SLOW_TEXT_NOTE, isSlowText } from "../src/ui/slowTexts.jsx";
import { InProcessWorker, SilentWorker, settle, useWorkers } from "./markdown-worker.js";

await loadMarkdown();

beforeEach(() => {
  sessionStorage.clear();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const advance = (ms) => vi.advanceTimersByTimeAsync(ms);

/** A worker whose answers the test gives: `answer(i, data)` answers the i-th text sent. */
class HeldWorker extends SilentWorker {
  answer(i, data) {
    this.emit({ id: this.sent[i].id, ...data });
  }
}

describe("one text at a time, the most needed first", () => {
  it("sends the next text only once the last is answered, lowest priority first; a text asked twice is sent once", async () => {
    const workers = [];
    const client = createMarkdownClient({ createWorker: () => workers[workers.push(new HeldWorker()) - 1] });
    const got = [];
    const ask = (text, priority) => client.request(text, { priority: () => priority }).then((r) => got.push([text, r.plain ? r.reason : "tree"]));
    ask("甲", 5);
    await settle();
    ask("乙", 9);
    ask("丙", 1);
    ask("甲", 0); // the one in flight: shares its answer
    await settle();
    expect(workers[0].sent.map((m) => m.text)).toEqual(["甲"]);
    workers[0].answer(0, { tree: ["甲"], elements: 0 });
    await settle();
    expect(workers[0].sent.map((m) => m.text)).toEqual(["甲", "丙"]);
    workers[0].answer(1, { plain: true, reason: "complex" });
    await settle();
    expect(workers[0].sent.map((m) => m.text)).toEqual(["甲", "丙", "乙"]);
    expect(got).toEqual([
      ["甲", "tree"],
      ["甲", "tree"],
      ["丙", "complex"],
    ]);
  });

  it("drops a text no one wants any more before it is sent", async () => {
    const workers = [];
    const client = createMarkdownClient({ createWorker: () => workers[workers.push(new HeldWorker()) - 1] });
    client.request("一");
    await settle();
    let wanted = true;
    const dropped = client.request("二", { wanted: () => wanted });
    wanted = false;
    workers[0].answer(0, { tree: ["一"], elements: 0 });
    expect(await dropped).toBe(DROPPED);
    expect(workers[0].sent.map((m) => m.text)).toEqual(["一"]);
  });

  it("keeps answers by text (the oldest out first), so a text shown again needs no worker", async () => {
    const { client, workers } = useWorkers();
    const asked = client.request("**留着**");
    await settle();
    const first = await asked;
    expect(first.tree).toBeDefined();
    expect(client.peek("**留着**")).toBe(first);
    for (let i = 0; i < CACHE_ENTRIES; i += 1) {
      client.request(`第 ${i} 条`);
      await settle(4);
    }
    expect(workers[0].sent).toHaveLength(CACHE_ENTRIES + 1);
    expect(client.peek("**留着**")).toBeNull();
  });
});

describe("the deadline", () => {
  it(`a worker that has not answered ${DEADLINE_MS} ms after the text was sent is ended; the text is plain and remembered; the next text gets a new worker`, async () => {
    const { client, workers } = useWorkers((n) => (n === 0 ? new SilentWorker() : new InProcessWorker()));
    const late = client.request("很慢 **很慢**");
    await settle();
    await advance(DEADLINE_MS - 1);
    expect(workers[0].terminated).toBe(false);
    await advance(1);
    expect(workers[0].terminated).toBe(true);
    expect(await late).toEqual({ plain: true, reason: "slow" });
    expect(isSlowText("很慢 **很慢**")).toBe(true);
    const next = client.request("**快**");
    await settle();
    expect(workers).toHaveLength(2);
    expect((await next).tree).toBeDefined();
  });

  it("an answer that comes after the deadline is ignored", async () => {
    const workers = [];
    const client = createMarkdownClient({ createWorker: () => workers[workers.push(new HeldWorker()) - 1] });
    const late = client.request("迟到");
    await settle();
    await advance(DEADLINE_MS);
    workers[0].terminated = false; // (as if its message were already on its way)
    workers[0].answer(0, { tree: ["迟到"], elements: 0 });
    expect(await late).toEqual({ plain: true, reason: "slow" });
    expect(client.peek("迟到")).toEqual({ plain: true, reason: "slow" });
  });

  it("the time a new worker takes to load is not the text's: the deadline starts when the text is sent", async () => {
    const workers = [];
    const client = createMarkdownClient({ createWorker: () => workers[workers.push(new InProcessWorker({ ready: false })) - 1] });
    const answer = client.request("**等它**");
    await settle();
    await advance(5 * DEADLINE_MS);
    expect(workers[0].sent).toHaveLength(0);
    workers[0].emit({ ready: true });
    await settle();
    expect((await answer).tree).toBeDefined();
  });

  it("a text on screen whose worker is late becomes plain with the note", async () => {
    useWorkers(() => new SilentWorker());
    const { container } = render(<AgentText text="慢 *慢*" />);
    await settle();
    expect(container.textContent).toBe("慢 *慢*");
    await advance(DEADLINE_MS);
    await settle();
    expect(container.textContent).toBe(`慢 *慢*${SLOW_TEXT_NOTE}`);
  });
});

describe("a stored message the worker is too slow for", () => {
  it("is plain with the note once the deadline passes, the worker ended; shown again (the conversation opened again, the page reloaded) it is plain with the note at once and never sent again; the next message gets a new worker", async () => {
    const { workers } = useWorkers((n) => (n === 0 ? new SilentWorker() : new InProcessWorker()));
    const slow = "# 很慢\n\n".repeat(900); // a storable text (under 8 000 characters)
    const first = render(<AgentText text={slow} id="m7" />);
    await settle();
    expect(workers[0].sent.map((m) => m.text)).toEqual([slow]);
    expect(first.container.querySelector(".md-note")).toBeNull();
    await advance(DEADLINE_MS);
    await settle();
    expect(workers[0].terminated).toBe(true);
    expect(first.container.textContent).toBe(`${slow}${SLOW_TEXT_NOTE}`);
    expect(first.container.querySelector(".md")).toBeNull();
    first.unmount();
    // The conversation opened again: the note is there from the first render, nothing is asked.
    const again = render(<AgentText text={slow} id="m7" />);
    expect(again.container.textContent).toBe(`${slow}${SLOW_TEXT_NOTE}`);
    await settle();
    again.unmount();
    // After a reload (a new client; the tab's memory of slow texts is what is left): the same.
    const reloaded = useWorkers(() => new InProcessWorker());
    const later = render(<AgentText text={slow} id="m7" />);
    await settle();
    expect(later.container.textContent).toBe(`${slow}${SLOW_TEXT_NOTE}`);
    expect(reloaded.workers).toHaveLength(0);
    // Another message is rendered by a new worker.
    const other = render(<AgentText text="**快**" id="m8" />);
    await settle();
    expect(other.container.querySelector(".md strong").textContent).toBe("快");
    expect([...workers, ...reloaded.workers].flatMap((w) => w.sent.map((m) => m.text))).toEqual([slow, "**快**"]);
  });
});

describe("no worker: plain text, no note, and never the pipeline on this thread", () => {
  function expectNoPipelineRun(spies) {
    expect(spies.typesets).not.toHaveBeenCalled();
    expect(spies.highlights).not.toHaveBeenCalled();
  }
  let spies;
  beforeEach(() => {
    spies = { typesets: vi.spyOn(katex, "renderToString"), highlights: vi.spyOn(highlighter, "highlight") };
  });

  it("when no worker can be made", async () => {
    useWorkers(() => {
      throw new ReferenceError("Worker is not defined");
    });
    const { container } = render(<AgentText text={"**粗体** $$x^2$$\n\n```js\nlet a = 1;\n```"} />);
    await settle();
    expect(container.textContent).toBe("**粗体** $$x^2$$\n\n```js\nlet a = 1;\n```");
    expect(container.querySelector(".md, .md-note")).toBeNull();
    expectNoPipelineRun(spies);
  });

  it("when the worker fails to load (an error before it is ready), and when it never loads", async () => {
    for (const fail of ["error", "never"]) {
      const { client, workers } = useWorkers(() => new InProcessWorker({ ready: false }));
      const answer = client.request("**粗体**");
      await settle();
      if (fail === "error") workers[0].onerror?.({ preventDefault() {} });
      else await advance(STARTUP_MS);
      expect(await answer).toEqual({ plain: true, reason: "unavailable" });
      expect(workers[0].terminated).toBe(true);
      expect(client.available).toBe(false);
      expect(await client.request("别的")).toEqual({ plain: true, reason: "unavailable" });
      expect(workers).toHaveLength(1);
    }
    expectNoPipelineRun(spies);
  });

  it("a worker that crashes after loading: that text plain, a new worker for the next; three in a row, no more workers", async () => {
    const { client, workers } = useWorkers(() => new SilentWorker());
    for (let i = 0; i < 3; i += 1) {
      const answer = client.request(`崩 ${i}`);
      await settle();
      workers[i].onerror?.({ preventDefault() {} });
      expect(await answer).toEqual({ plain: true, reason: i < 2 ? "error" : "unavailable" });
    }
    expect(client.available).toBe(false);
    expectNoPipelineRun(spies);
  });

  it("the main thread's modules never import the pipeline, KaTeX's renderer, the highlighter or the parser", () => {
    const MAIN = ["AgentText.jsx", "Markdown.jsx", "markdownClient.js", "markdownTree.js", "markdownView.jsx", "markdownRules.js", "slowTexts.jsx"];
    const files = [...MAIN.map((f) => `src/ui/${f}`), "src/pages/AgentChatBits.jsx", "src/pages/Messages.jsx", "src/pages/ChatView.jsx"];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      const imports = [...source.matchAll(/^\s*(?:import\s+["']([^"']+)["']|(?:import|export)\b[^;"']*?\bfrom\s+["']([^"']+)["'])/gm)].map((m) => m[1] ?? m[2]);
      if (file.endsWith("AgentText.jsx")) expect(imports).toContain("./markdownClient.js"); // (the pattern finds imports)
      expect(source, file).not.toMatch(/\bimport\s*\(\s*["'][^"']*markdownPipeline/);
      for (const name of imports) {
        expect(name, `${file} imports ${name}`).not.toMatch(/markdownPipeline|markdownWorker|^katex$|^lowlight|highlight\.js|^unified|^remark|^micromark|^mdast|^hast|^parse5/);
      }
    }
    // Only the worker's entry imports the pipeline.
    const importers = readdirSync("src", { recursive: true })
      .filter((f) => /\.(js|jsx)$/.test(f))
      .filter((f) => /from\s+["'][./]*(?:ui\/)?markdownPipeline\.js["']/.test(readFileSync(`src/${f}`, "utf8")));
    expect(importers.map((f) => f.replace(/\\/g, "/"))).toEqual(["ui/markdownWorker.js"]);
  });
});

describe("what comes back is checked before it is kept or shown", () => {
  it("a tree the main thread's check refuses is shown plain with the note, none of it rendered", async () => {
    const workers = [];
    useWorkers(() => workers[workers.push(new HeldWorker()) - 1]);
    const { container } = render(<AgentText text="看似无害" />);
    await settle();
    workers[0].answer(0, { tree: [{ tag: "script", children: ["window.__xss = 1"] }, { tag: "a", props: { href: "javascript:alert(1)", onClick: "x" }, children: ["点"] }], elements: 2 });
    await settle();
    expect(container.querySelector("script, a, .md")).toBeNull();
    expect(container.textContent).toBe(`看似无害${SLOW_TEXT_NOTE}`);
  });
});
