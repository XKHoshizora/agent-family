// @vitest-environment jsdom
// A reply being written (StreamingAgentText): every piece is shown at once as plain text; the worker is asked for a
// tree at most every 300 ms, never twice at the same time; a tree is taken only if the text has not changed while it
// was being made (a stale one is dropped), and what came after the taken tree is shown after it, plain, until the next;
// two late answers in a row and the rest of the reply is plain, with the note.
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { AgentText, StreamingAgentText, STREAM_EVERY_MS, loadMarkdown } from "../src/ui/AgentText.jsx";
import { DEADLINE_MS, markdownClient } from "../src/ui/markdownClient.js";
import { setFrameClock } from "../src/ui/markdownView.jsx";
import { renderToTree } from "../src/ui/markdownPipeline.js";
import { SLOW_TEXT_NOTE, isSlowText } from "../src/ui/slowTexts.jsx";
import { SilentWorker, settle, useWorkers } from "./markdown-worker.js";

await loadMarkdown();

/** A worker whose answers the test gives. */
class HeldWorker extends SilentWorker {
  /** Answers the i-th text it was sent, as the pipeline would. */
  answer(i) {
    const { id, text } = this.sent[i];
    this.emit({ id, ...renderToTree(text, { now: () => 0 }) });
  }
}

let workers;
beforeEach(() => {
  sessionStorage.clear();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  workers = [];
  useWorkers(() => workers[workers.push(new HeldWorker()) - 1]);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const advance = async (ms) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  await settle();
};
const sentTexts = () => workers.flatMap((w) => w.sent.map((m) => m.text));
const bubble = (text) => (
  <div className="bubble">
    <StreamingAgentText text={text} />
  </div>
);

describe("a reply being written", () => {
  it(`shows every piece at once, and asks for a tree at most every ${STREAM_EVERY_MS} ms, one at a time`, async () => {
    const { container, rerender } = render(bubble("# 标"));
    await settle();
    expect(sentTexts()).toEqual(["# 标"]);
    for (const piece of ["# 标题", "# 标题\n\n第", "# 标题\n\n第一"]) {
      rerender(bubble(piece));
      await settle();
      expect(container.textContent).toBe(piece); // plain, at once
    }
    // Nothing more is asked while the first is in flight.
    await advance(DEADLINE_MS - 50);
    expect(sentTexts()).toEqual(["# 标"]);
    workers[0].answer(0); // (the text has changed since: this tree is dropped)
    await settle();
    expect(container.querySelector(".md")).toBeNull();
    expect(sentTexts()).toEqual(["# 标"]);
    // Asked again once STREAM_EVERY_MS has passed since the last, for the text as it is then.
    await advance(STREAM_EVERY_MS - (DEADLINE_MS - 50));
    expect(sentTexts()).toEqual(["# 标", "# 标题\n\n第一"]);
    // Answered at once, the next is asked no sooner than STREAM_EVERY_MS after the last was.
    workers[0].answer(1);
    await settle();
    expect(container.querySelector(".md h1").textContent).toBe("标题");
    rerender(bubble("# 标题\n\n第一段"));
    await settle();
    expect(sentTexts()).toHaveLength(2);
    await advance(STREAM_EVERY_MS);
    expect(sentTexts()).toEqual(["# 标", "# 标题\n\n第一", "# 标题\n\n第一段"]);
  });

  it(`never two requests at a time, even when one waits behind another text for longer than ${STREAM_EVERY_MS} ms`, async () => {
    const client = markdownClient();
    const request = client.request;
    let open = 0;
    let most = 0;
    vi.spyOn(client, "request").mockImplementation((text, options) => {
      const answer = request.call(client, text, options);
      if (options?.remember === false) {
        open += 1;
        most = Math.max(most, open);
        answer.then(() => {
          open -= 1;
        });
      }
      return answer;
    });
    const { rerender } = render(<AgentText text="存着的回复" />);
    await settle();
    rerender(
      <>
        <AgentText text="存着的回复" />
        {bubble("流 1")}
      </>,
    );
    await settle();
    expect(sentTexts()).toEqual(["存着的回复"]); // the stream's text waits behind it
    await advance(DEADLINE_MS - 10);
    workers[0].answer(0);
    await settle();
    expect(sentTexts()).toEqual(["存着的回复", "流 1"]); // sent 240 ms after it was asked for
    rerender(
      <>
        <AgentText text="存着的回复" />
        {bubble("流 1 2")}
      </>,
    );
    await advance(STREAM_EVERY_MS - (DEADLINE_MS - 10)); // 300 ms since it was asked for: still in flight
    expect(most).toBe(1);
    expect(sentTexts()).toEqual(["存着的回复", "流 1"]);
    workers[0].answer(1); // (stale: dropped) — and only now the next is asked for
    await settle();
    expect(sentTexts()).toEqual(["存着的回复", "流 1", "流 1 2"]);
    expect(most).toBe(1);
  });

  it("a stale tree is dropped; the taken tree stays, with what came after it shown plain after it, until the next", async () => {
    const { container, rerender } = render(bubble("**粗体**"));
    await settle();
    workers[0].answer(0);
    await settle();
    expect(container.querySelector(".md strong").textContent).toBe("粗体");
    rerender(bubble("**粗体** 然后 *斜"));
    await settle();
    // The taken tree, then the new text as it came, plain.
    expect(container.querySelector(".md strong").textContent).toBe("粗体");
    expect(container.textContent).toBe("粗体 然后 *斜");
    expect(container.querySelector("em")).toBeNull();
    await advance(STREAM_EVERY_MS);
    expect(sentTexts()).toEqual(["**粗体**", "**粗体** 然后 *斜"]);
    rerender(bubble("**粗体** 然后 *斜体*"));
    await settle();
    workers[0].answer(1); // made for a text that has changed since: dropped
    await settle();
    expect(container.querySelector("em")).toBeNull();
    expect(container.textContent).toBe("粗体 然后 *斜体*");
    await advance(STREAM_EVERY_MS);
    workers[0].answer(2);
    await settle();
    expect(container.querySelector(".md em").textContent).toBe("斜体");
    expect(container.textContent).toBe("粗体 然后 斜体");
  });

  it("two late answers in a row: the rest of the reply is plain with the note, and nothing more is asked", async () => {
    const { container, rerender } = render(bubble("慢 1"));
    await settle();
    await advance(DEADLINE_MS);
    expect(workers[0].terminated).toBe(true);
    expect(container.querySelector(".md-note")).toBeNull();
    rerender(bubble("慢 1 2"));
    await advance(STREAM_EVERY_MS);
    expect(sentTexts()).toEqual(["慢 1", "慢 1 2"]);
    await advance(DEADLINE_MS);
    expect(workers[1].terminated).toBe(true);
    expect(container.textContent).toBe(`慢 1 2${SLOW_TEXT_NOTE}`);
    for (const piece of ["慢 1 2 3", "慢 1 2 3 **4**"]) {
      rerender(bubble(piece));
      await advance(STREAM_EVERY_MS * 2);
      expect(container.textContent).toBe(`${piece}${SLOW_TEXT_NOTE}`);
    }
    expect(sentTexts()).toHaveLength(2);
    // The pieces of a reply are never remembered: the stored message is judged on its own.
    expect(isSlowText("慢 1")).toBe(false);
    expect(isSlowText("慢 1 2")).toBe(false);
  });

  it("a late answer followed by one in time starts the count again", async () => {
    const { container, rerender } = render(bubble("一"));
    await settle();
    await advance(DEADLINE_MS); // late
    expect(container.querySelector(".md-note")).toBeNull();
    rerender(bubble("一 **二**"));
    await advance(STREAM_EVERY_MS - DEADLINE_MS);
    workers[1].answer(0); // in time
    await settle();
    expect(container.querySelector(".md strong").textContent).toBe("二");
    rerender(bubble("一 **二** 三"));
    await advance(STREAM_EVERY_MS);
    await advance(DEADLINE_MS); // late again: one in a row
    expect(container.querySelector(".md-note")).toBeNull();
    expect(container.textContent).toBe("一 二 三");
  });

  it("a tree is shown at an animation frame, and only if the text is still the one it was made for then", async () => {
    const frames = [];
    setFrameClock((run) => frames.push(run));
    try {
      const { container, rerender } = render(bubble("**一**"));
      await settle();
      workers[0].answer(0);
      await settle();
      expect(frames).toHaveLength(1);
      expect(container.querySelector(".md")).toBeNull(); // not before the frame
      await act(async () => frames.shift()());
      await settle();
      expect(container.querySelector(".md strong").textContent).toBe("一");
      // The next tree arrives, and the text changes before its frame: that tree is dropped.
      rerender(bubble("**一** *二*"));
      await advance(STREAM_EVERY_MS);
      workers[0].answer(1);
      await settle();
      rerender(bubble("**一** *二* 三"));
      await settle();
      while (frames.length > 0) await act(async () => frames.shift()());
      await settle();
      expect(container.querySelector(".md em")).toBeNull();
      expect(container.textContent).toBe("一 *二* 三");
    } finally {
      setFrameClock((run) => queueMicrotask(run));
    }
  });
});
