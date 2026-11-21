// A reply's citations (〔m3〕, 〔f2〕) are links in the message and nothing anywhere a reply's text is previewed (the chat
// list, search hits, a quote, the reply chip): src/ui/citations.js `withoutCitations`, the service's rule
// (app/service/src/agents/tools/refs.ts) in one linear pass — both held to the shared table app/shared/citation-cases.json.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { withoutCitations } from "../src/ui/citations.js";

describe("withoutCitations", () => {
  it("the shared table's cases (app/shared/citation-cases.json, which the service's tests assert too)", () => {
    const table = JSON.parse(readFileSync("../shared/citation-cases.json", "utf8"));
    expect(table.cases.length).toBeGreaterThan(10);
    for (const [text, kept] of table.cases) expect([text, withoutCitations(text)]).toEqual([text, kept]);
  });

  it("one pass gives what taking every citation out again and again until none is left gives: random texts", () => {
    const CITATION = /〔\s*([mMfF])\s*([1-9][0-9]{0,5})\s*〕/g;
    const again = (text) => {
      let out = text;
      for (let next = out.replace(CITATION, ""); next !== out; next = out.replace(CITATION, "")) out = next;
      return out;
    };
    const alphabet = ["〔", "〕", "m", "M", "f", "F", "1", "2", "0", "9", " ", "　", "\t", "x", "主", "人"];
    let seed = 20261121;
    const next = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 8) / 16777216;
    for (let i = 0; i < 50_000; i++) {
      const text = Array.from({ length: 1 + Math.floor(next() * 24) }, () => alphabet[Math.floor(next() * alphabet.length)]).join("");
      const want = again(text);
      if (withoutCitations(text) !== want) expect([text, withoutCitations(text)]).toEqual([text, want]);
    }
  });

  it("is linear in the text however it nests: four times the nest, less than eight times the time", () => {
    const nest = (n) => "〔m".repeat(n / 4) + "1〕".repeat(n / 4);
    const burst = (work) => {
      let calls = 0;
      const started = performance.now();
      let spent = 0;
      do {
        work();
        calls += 1;
        spent = performance.now() - started;
      } while (spent < 20);
      return spent / calls;
    };
    const perCall = (work) => Math.min(burst(work), burst(work), burst(work));
    const [small, large] = [nest(4000), nest(16000)];
    expect(withoutCitations(large)).toBe("");
    const [inLarge, inSmall] = [() => withoutCitations(large), () => withoutCitations(small)];
    burst(inLarge);
    burst(inSmall);
    const ratio = Array.from({ length: 5 }, () => perCall(inLarge) / perCall(inSmall)).sort((a, b) => a - b)[2];
    expect(ratio, `4× the nest took ${ratio.toFixed(1)}× the time`).toBeLessThan(8);
  }, 60_000);
});
