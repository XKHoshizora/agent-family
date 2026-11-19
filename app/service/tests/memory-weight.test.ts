import { describe, expect, it } from "vitest";
import { cutToWeight, weight, weightOf } from "../src/memory/weight.ts";

/**
 * The one measure of memory (README "How memory is measured"): ceil(utf8 bytes / 3). The vector below is the same, verbatim, in
 * app/web/tests/memory-weight.test.js: the web's mirror must give the same number for every string.
 */
const VECTOR: Array<[string, number]> = [
  ["", 0],
  ["你好", 2],
  ["记住了：我喜欢麻婆豆腐", 11],
  ["こんにちは", 5],
  ["안녕하세요", 5],
  ["hello", 2],
  ["I like mapo tofu", 6],
  ["a", 1],
  ["我喜欢 coffee", 6],
  ["🙂", 2],
  ["café", 2],
  ["   ", 1],
];

describe("weight", () => {
  it("is ceil(utf-8 bytes / 3) for the shared vector", () => {
    for (const [text, expected] of VECTOR) expect(weight(text), JSON.stringify(text)).toBe(expected);
  });

  it("weightOf sums the weight of each note's text, rounded up per note", () => {
    expect(weightOf([])).toBe(0);
    expect(weightOf([{ text: "你好" }, { text: "hello" }, { text: "a" }])).toBe(2 + 2 + 1);
  });

  it("one fact costs about the same in Chinese and English, where code points differ threefold", () => {
    const zh = "我喜欢吃麻婆豆腐，不吃香菜";
    const en = "I like eating mapo tofu and never eats coriander";
    expect(Array.from(en).length / Array.from(zh).length).toBeGreaterThan(3);
    expect(weight(en) / weight(zh)).toBeLessThan(1.6);
  });

  it("cutToWeight keeps the longest whole-character start within the weight, never splitting a character", () => {
    expect(cutToWeight("你好世界", 2)).toBe("你好");
    expect(cutToWeight("你好世界", 100)).toBe("你好世界");
    expect(cutToWeight("hello world", 2)).toBe("hello ");
    expect(cutToWeight("🙂🙂🙂", 3)).toBe("🙂🙂");
    expect(cutToWeight("abc", 0)).toBe("");
    expect(weight(cutToWeight("a你b好c世界", 3))).toBeLessThanOrEqual(3);
  });
});
