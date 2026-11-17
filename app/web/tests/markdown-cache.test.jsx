// @vitest-environment jsdom
// What the Markdown client keeps (src/ui/markdownClient.js): an answer is found again by its text, not only by the
// text's digest (two texts with one digest never share an answer); the answers kept are bounded by their characters
// too; the answers for the pieces of a reply being written are not kept; and a worker that could not start is tried
// again, at most once a minute, instead of never.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Texts starting with 撞 all have one digest here (a real collision of the 64-bit digest cannot be made to order). The
// client is read afresh, after the stand-in is in place (tests/setup.js has loaded the application's modules already).
vi.mock("../src/ui/slowTexts.jsx", async (original) => {
  const actual = await original();
  return { ...actual, digestOf: (text) => (text.startsWith("撞") ? "00000000deadbeef:1" : actual.digestOf(text)) };
});
vi.resetModules();
const { CACHE_CHARS, CACHE_ENTRIES, RETRY_MS, STARTUP_MS, createMarkdownClient } = await import("../src/ui/markdownClient.js");
const { InProcessWorker, SilentWorker, settle } = await import("./markdown-worker.js");

beforeEach(() => {
  sessionStorage.clear();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** A worker whose answers the test gives: `answer(i, data)` answers the i-th text sent. */
class HeldWorker extends SilentWorker {
  answer(i, data) {
    this.emit({ id: this.sent[i].id, ...data });
  }
}
function heldClient(options = {}) {
  const workers = [];
  const client = createMarkdownClient({ createWorker: () => workers[workers.push(new HeldWorker()) - 1], ...options });
  return { client, workers };
}

describe("an answer is found again by its text", () => {
  it("two texts with the same digest: the second is not given the first's answer, kept or on its way", async () => {
    const { client, workers } = heldClient();
    const first = client.request("撞 **甲**");
    const second = client.request("撞 乙"); // (asked while the first is with the worker: it does not share its answer)
    await settle();
    expect(workers[0].sent.map((m) => m.text)).toEqual(["撞 **甲**"]);
    workers[0].answer(0, { tree: [{ tag: "p", children: ["撞 ", { tag: "strong", children: ["甲"] }] }], elements: 2 });
    await settle();
    expect((await first).tree[0].children[1].children).toEqual(["甲"]);
    expect(workers[0].sent.map((m) => m.text)).toEqual(["撞 **甲**", "撞 乙"]);
    workers[0].answer(1, { tree: [{ tag: "p", children: ["撞 乙"] }], elements: 1 });
    expect((await second).tree).toEqual([{ tag: "p", children: ["撞 乙"] }]);
    // The digest's one place now holds the second text's answer: the first is a miss, never the other's tree.
    expect(client.peek("撞 乙").tree).toEqual([{ tag: "p", children: ["撞 乙"] }]);
    expect(client.peek("撞 **甲**")).toBeNull();
    expect(client.peek("撞 丙")).toBeNull();
    const third = client.request("撞 丙");
    await settle();
    expect(workers[0].sent.map((m) => m.text)).toEqual(["撞 **甲**", "撞 乙", "撞 丙"]);
    workers[0].answer(2, { plain: true, reason: "complex" });
    expect(await third).toEqual({ plain: true, reason: "complex" });
    expect(client.peek("撞 乙")).toBeNull();
  });
});

describe("the answers kept are bounded by their characters", () => {
  it(`at most ${CACHE_CHARS} characters of texts and trees, the oldest out first`, async () => {
    const { client, workers } = heldClient();
    const line = `${"长".repeat(99)}\n`;
    const texts = Array.from({ length: 60 }, (_, i) => `第 ${i} 篇\n${line.repeat(300)}`); // about 30 000 characters each
    const tree = (i) => [{ tag: "p", children: [`第 ${i} 篇 ${"树".repeat(20000)}`] }];
    for (let i = 0; i < texts.length; i += 1) {
      const asked = client.request(texts[i]);
      await settle(4);
      workers[0].answer(i, { tree: tree(i), elements: 1 });
      expect((await asked).tree).toBeDefined();
      expect(client.kept.chars).toBeLessThanOrEqual(CACHE_CHARS);
    }
    // 60 answers of about 50 000 characters each: fewer than CACHE_ENTRIES, a few elements, 3 000 000 characters.
    expect(texts.length).toBeLessThan(CACHE_ENTRIES);
    expect(client.kept.entries).toBeLessThan(texts.length);
    expect(client.kept.entries).toBeGreaterThan(30);
    expect(client.peek(texts[0])).toBeNull();
    expect(client.peek(texts.at(-1)).tree).toEqual(tree(59));
    expect(client.kept.chars).toBeGreaterThan(CACHE_CHARS - 60000);
  });
});

describe("the pieces of a reply being written", () => {
  it("their answers are not kept; an answer a stored message also asked for is", async () => {
    const { client, workers } = heldClient();
    const piece = client.request("写到一半", { remember: false });
    await settle();
    workers[0].answer(0, { tree: ["写到一半"], elements: 0 });
    expect((await piece).tree).toEqual(["写到一半"]);
    expect(client.peek("写到一半")).toBeNull();
    expect(client.kept.entries).toBe(0);

    const streamed = client.request("写完了", { remember: false });
    const stored = client.request("写完了");
    await settle();
    workers[0].answer(1, { tree: ["写完了"], elements: 0 });
    expect(await streamed).toBe(await stored);
    expect(client.peek("写完了").tree).toEqual(["写完了"]);
    expect(client.kept.entries).toBe(1);
  });
});

describe("a worker that could not start", () => {
  it(`is tried again, once, ${RETRY_MS / 1000} s later: rendering is not off for the life of the page`, async () => {
    let made = 0;
    const client = createMarkdownClient({
      createWorker: () => {
        made += 1;
        if (made === 1) throw new TypeError("Failed to fetch the worker's script");
        return new InProcessWorker();
      },
    });
    expect(await client.request("**一**")).toEqual({ plain: true, reason: "unavailable" });
    expect(client.available).toBe(false);
    await vi.advanceTimersByTimeAsync(RETRY_MS - 1);
    expect(await client.request("**二**")).toEqual({ plain: true, reason: "unavailable" });
    expect(client.peek("**二**")).toEqual({ plain: true, reason: "unavailable" });
    expect(made).toBe(1); // not tried meanwhile
    await vi.advanceTimersByTimeAsync(1);
    expect(client.available).toBe(true);
    expect(client.peek("**二**")).toBeNull();
    const again = client.request("**二**");
    await settle();
    expect((await again).tree).toBeDefined();
    expect(made).toBe(2);
  });

  it("a worker that never loads, then fails again a minute later: one try a minute, no more", async () => {
    const workers = [];
    const client = createMarkdownClient({ createWorker: () => workers[workers.push(new InProcessWorker({ ready: false })) - 1] });
    const first = client.request("甲");
    await settle();
    await vi.advanceTimersByTimeAsync(STARTUP_MS);
    expect(await first).toEqual({ plain: true, reason: "unavailable" });
    for (let i = 0; i < 5; i += 1) expect(await client.request(`乙 ${i}`)).toEqual({ plain: true, reason: "unavailable" });
    expect(workers).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    const second = client.request("丙");
    client.request("丁");
    await settle();
    expect(workers).toHaveLength(2);
    workers[1].onerror?.({ preventDefault() {} });
    expect(await second).toEqual({ plain: true, reason: "unavailable" });
    for (let i = 0; i < 5; i += 1) expect(await client.request(`戊 ${i}`)).toEqual({ plain: true, reason: "unavailable" });
    expect(workers).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    workers.length = 0;
    const third = client.request("己");
    await settle();
    expect(workers).toHaveLength(1);
    workers[0].emit({ ready: true });
    await settle();
    expect((await third).tree).toBeDefined();
  });
});
