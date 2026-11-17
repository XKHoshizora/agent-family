// @vitest-environment jsdom
// A reply being written (StreamingAgentText): every piece is shown at once as plain text; the worker is asked for a
// tree at most every 300 ms, never twice at the same time; a tree is taken only if the text has not changed while it
// was being made (a stale one is dropped), and what came after the taken tree is shown after it, plain, until the next;
// two late answers in a row and the rest of the reply is plain, with the note. The same rules paced, as the bubble
// shows a reply (revealed at frames, asked for what is shown).
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

  describe("paced, as a reply being written is shown (its frames run on the fake clock: tests/setup.js)", () => {
    beforeEach(() => {
      // (The frames tell the time by Date.now(): it moves with the clock here.)
      vi.useRealTimers();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    });
    const paced = (text) => (
      <div className="bubble">
        <StreamingAgentText text={text} paced />
      </div>
    );
    // 6 006 characters in one piece: revealed over some 600 ms of frames.
    const BURST = `# 标题\n\n${"一二三四五六七八九十".repeat(600)}`;

    it(`asks for what is shown, at most every ${STREAM_EVERY_MS} ms and one at a time, while more is revealed at every frame`, async () => {
      const { container } = render(paced(BURST));
      await settle();
      expect(sentTexts()).toEqual([]); // nothing shown yet: nothing to ask for
      await advance(16); // the first frame
      expect(sentTexts()).toHaveLength(1);
      const [first] = sentTexts();
      expect(first.length).toBeGreaterThan(0);
      expect(first.length).toBeLessThan(BURST.length);
      expect(BURST.startsWith(first)).toBe(true);
      // The frames go on revealing; nothing more is asked while the first is in flight.
      await advance(DEADLINE_MS - 50);
      expect(sentTexts()).toHaveLength(1);
      expect(container.textContent.length).toBeGreaterThan(first.length);
      // Answered in time: taken (what is shown is the same text, grown), the rest plain after it.
      workers[0].answer(0);
      await settle();
      expect(container.querySelector(".md h1").textContent).toBe("标题");
      // The next is asked STREAM_EVERY_MS after the first was sent, not sooner, for what is shown then.
      await advance(STREAM_EVERY_MS - (DEADLINE_MS - 50) - 1);
      expect(sentTexts()).toHaveLength(1);
      await advance(1);
      expect(sentTexts()).toHaveLength(2);
      expect(sentTexts()[1].length).toBeGreaterThan(first.length);
      expect(BURST.startsWith(sentTexts()[1])).toBe(true);
      expect(sentTexts()[1].length).toBeLessThan(BURST.length); // (still being revealed: not what was received)
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
          {paced(BURST)}
        </>,
      );
      await advance(16); // the first frame: what is shown is asked for, behind the stored text
      expect(sentTexts()).toEqual(["存着的回复"]);
      await advance(DEADLINE_MS - 30);
      workers[0].answer(0);
      await settle();
      expect(sentTexts()).toHaveLength(2); // sent now, some 220 ms after it was asked for
      await advance(STREAM_EVERY_MS - (DEADLINE_MS - 30)); // 300 ms since it was asked for: still in flight
      expect(sentTexts()).toHaveLength(2);
      expect(most).toBe(1);
      workers[0].answer(1);
      await settle();
      expect(sentTexts()).toHaveLength(3); // only now the next is asked for
      expect(most).toBe(1);
      expect(BURST.startsWith(sentTexts()[2])).toBe(true);
      expect(sentTexts()[2].length).toBeGreaterThan(sentTexts()[1].length);
    });

    it("two late answers in a row: what is left is revealed plain with the note, and nothing more is asked", async () => {
      const { container, rerender } = render(paced(BURST));
      await advance(16);
      expect(sentTexts()).toHaveLength(1);
      await advance(DEADLINE_MS); // late
      expect(workers[0].terminated).toBe(true);
      expect(container.querySelector(".md-note")).toBeNull();
      await advance(STREAM_EVERY_MS - DEADLINE_MS); // asked again, of a new worker, for what is shown now
      expect(sentTexts()).toHaveLength(2);
      expect(sentTexts()[1].length).toBeGreaterThan(sentTexts()[0].length);
      await advance(DEADLINE_MS); // late again
      expect(workers[1].terminated).toBe(true);
      expect(container.querySelector(".md-note").textContent).toBe(SLOW_TEXT_NOTE);
      expect(container.textContent.length).toBeLessThan(BURST.length + SLOW_TEXT_NOTE.length);
      // The frames reveal the rest, plain, with the note after it; more text too.
      await advance(2000);
      expect(container.textContent).toBe(`${BURST}${SLOW_TEXT_NOTE}`);
      rerender(paced(`${BURST} **再来**`));
      await advance(2000);
      expect(container.textContent).toBe(`${BURST} **再来**${SLOW_TEXT_NOTE}`);
      expect(sentTexts()).toHaveLength(2);
      // The pieces of a reply are never remembered: the stored message is judged on its own.
      for (const text of sentTexts()) expect(isSlowText(text)).toBe(false);
    });
  });

  it("a tree is shown at an animation frame; what came between its arrival and the frame is shown after it, plain", async () => {
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
      // The next tree arrives for the text as it is, and more text comes before its frame.
      rerender(bubble("**一** *二*"));
      await advance(STREAM_EVERY_MS);
      workers[0].answer(1);
      await settle();
      rerender(bubble("**一** *二* 三"));
      await settle();
      expect(container.textContent).toBe("一 *二* 三");
      while (frames.length > 0) await act(async () => frames.shift()());
      await settle();
      expect(container.querySelector(".md em").textContent).toBe("二");
      expect(container.textContent).toBe("一 二 三");
      // A tree that arrives for a text that has changed meanwhile is dropped, as before: no frame is asked for it.
      await advance(STREAM_EVERY_MS);
      rerender(bubble("**一** *二* 三 `四`"));
      await settle();
      workers[0].answer(2);
      await settle();
      expect(frames).toHaveLength(0);
      expect(container.querySelector(".md code")).toBeNull();
    } finally {
      setFrameClock((run) => queueMicrotask(run));
    }
  });
});
