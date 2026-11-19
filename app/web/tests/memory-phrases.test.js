// The sentences of the memory chip: picked by a stable hash of the change id, never by chance; every sentence of a set
// is reachable; the count and the Agent's name are put in; the kind of notice (rest, tidy, hearsay, dream) chooses the set.
import { describe, expect, it } from "vitest";
import { DREAM, HEARSAY, RECORD, TIDY, memorySentence, pickIndex } from "../src/data/memoryPhrases.js";

const ids = Array.from({ length: 200 }, (_, i) => `change-${i}-${(i * 7919).toString(16)}`);
const notice = (fields) => ({ name: "小助手", changeId: "c1", phase: "rest", lines: ["记住了：不吃辣"], count: 1, full: false, ...fields });

describe("pickIndex", () => {
  it("is the same for the same id, and always inside the set", () => {
    for (const id of ids) {
      expect(pickIndex(id, 3)).toBe(pickIndex(id, 3));
      expect(pickIndex(id, 3)).toBeGreaterThanOrEqual(0);
      expect(pickIndex(id, 3)).toBeLessThan(3);
    }
    expect(pickIndex("c1", 1)).toBe(0);
  });
  it("reaches every sentence of a set", () => {
    expect(new Set(ids.map((id) => pickIndex(id, 3)))).toEqual(new Set([0, 1, 2]));
  });
});

describe("memorySentence", () => {
  it("is the same sentence for the same notice every time", () => {
    for (const id of ids.slice(0, 20)) expect(memorySentence(notice({ changeId: id }))).toBe(memorySentence(notice({ changeId: id })));
  });
  it("a rest that recorded something: the three sentences, all reachable, with the count", () => {
    const seen = new Set(ids.map((changeId) => memorySentence(notice({ changeId, count: 3 }))));
    expect(seen).toEqual(new Set(["小助手小憩时记下了 3 件事", "小助手歇了一会儿，记住了 3 件事", "小助手趁着小憩，把 3 件事记了下来"]));
  });
  it("a rest of only forgetting and locking: 理了理记忆", () => {
    for (const lines of [["忘掉了：x"], ["锁进了保险箱：y"], ["忘掉了：x", "锁进了保险箱：y"]]) {
      expect(memorySentence(notice({ lines, count: lines.length }))).toBe("小助手小憩时理了理记忆");
    }
    expect(TIDY).toHaveLength(1);
  });
  it("a rest with one recording among removals is a recording one", () => {
    expect(memorySentence(notice({ lines: ["忘掉了：x", "记住了：y"], count: 2, changeId: "c1" }))).toMatch(/2 件事/);
  });
  it("a rest of only hearsay", () => {
    expect(memorySentence(notice({ lines: ["听说：「阿波」在「项目群」里说：x", "听说：「小陈」在「项目群」里说：y"], count: 2 }))).toBe("小助手小憩时想起听来的 2 件事");
    expect(HEARSAY).toHaveLength(1);
  });
  it("a dream: the three sentences, all reachable, with the count", () => {
    const seen = new Set(ids.map((changeId) => memorySentence(notice({ phase: "dream", lines: ["合并了：x"], count: 4, changeId }))));
    expect(seen).toEqual(new Set(["小助手入梦时整理了 4 条记忆", "小助手昨夜入梦，把 4 条记忆理顺了", "小助手在梦里收拾了 4 条记忆"]));
  });
  it("full adds 快满了; a full notice without lines says the palace is nearly full", () => {
    expect(memorySentence(notice({ changeId: "c1", full: true, phase: "dream", count: 2, lines: ["改成了：x"] }))).toMatch(/ · 快满了$/);
    expect(memorySentence(notice({ lines: [], count: 0, full: true }))).toBe("小助手的记忆宫殿快满了");
  });
  it("an unknown name reads 它", () => {
    expect(memorySentence(notice({ name: "它", lines: ["忘掉了：x"] }))).toBe("它小憩时理了理记忆");
  });
  it("keeps the sets in the module for adding more", () => {
    expect(RECORD).toHaveLength(3);
    expect(DREAM).toHaveLength(3);
  });
});
