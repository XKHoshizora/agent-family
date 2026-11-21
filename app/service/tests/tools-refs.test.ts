import { describe, expect, it } from "vitest";
import { notesPassage } from "../src/agents/runtime/prompt.ts";
import { excerpt } from "../src/agents/tools/search.ts";
import { citesIn, RunRefs, withoutCitations } from "../src/agents/tools/refs.ts";

/**
 * A reply's numbers (agents/tools/refs.ts) mean something only in the run that gave them (Task 6 fix 1, I-2): what a
 * reply cites is checked against its own run's numbers, however the model wrote them, and every text the model is shown
 * that it did not write in this run is shown without any citation. Pure functions: no database.
 */

const at = (n: number) => ({ conversationId: "c", seq: n });

describe("what a reply's citations become", () => {
  it("〔 M1 〕 is 〔m1〕; a file's number this run gave stays, unlinked; one it never gave, or a message's past the first 20, is taken out", () => {
    const refs = new RunRefs();
    for (let i = 1; i <= 21; i++) refs.message("c", i);
    refs.file("att-1");
    const many = Array.from({ length: 21 }, (_, i) => `〔m${i + 1}〕`).join("");
    const { text, cites } = citesIn(`见〔 M1 〕和〔F1 〕〔f2〕〔m1〕。${many}`, refs);
    expect(text).toBe(`见〔m1〕和〔f1〕〔m1〕。${many.replace("〔m21〕", "")}`);
    expect(cites).toEqual(Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`m${i + 1}`, at(i + 1)])));
  });

  it("text the run did not write keeps no citation of any kind; what is not one is left alone", () => {
    expect(withoutCitations("在河边〔m1〕，见〔 M12 〕和〔f3〕〔F 4〕。")).toBe("在河边，见和。");
    expect(withoutCitations("〔m0〕〔mx〕〔m1234567〕【m1】〔注〕")).toBe("〔m0〕〔mx〕〔m1234567〕【m1】〔注〕");
  });
});

describe("what the model is shown keeps no citation", () => {
  it("a note and a heard thing in the notes passage", () => {
    const passage = notesPassage(
      {
        owner: [{ text: "喜欢河边那家〔m1〕", updatedAt: new Date("2026-11-01T00:00:00Z") }],
        self: [],
        hearsay: [{ text: "他说过〔m2〕周三有空", speakerName: "mia", group: "饭搭子", saidAt: new Date("2026-11-02T00:00:00Z") }],
      },
      false,
      "Asia/Shanghai",
    );
    expect(passage).toContain("喜欢河边那家");
    expect(passage).toContain("他说过周三有空");
    expect(passage).not.toContain("〔");
  });
});

describe("a search result's excerpt", () => {
  it("is cut around the words in the text itself, whatever lower-casing would do to its length", () => {
    // "İ" lower-cases to two code units: an index found in a lower-cased copy lands too far on.
    const text = `${"İ".repeat(150)}${"中".repeat(60)}要找的词${"文".repeat(200)}`;
    expect(excerpt(text, "要找的词")).toContain("要找的词");
  });
});
