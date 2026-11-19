import { describe, expect, it } from "vitest";
import { storedWeight, weight, weightOf } from "../src/data/memoryWeight.js";

// The web's mirror of the service's one measure (app/service/src/memory/weight.ts): ceil(utf-8 bytes / 3). This vector is the
// same, verbatim, in app/service/tests/memory-weight.test.ts: a change on one side is a change on the other.
const VECTOR = [
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

// What the add row measures: the text as the service stores it (whitespace collapsed to single spaces, trimmed). Same rows in the service's test.
const STORED = [
  ["", 0],
  ["  你好  ", 2],
  ["你好\n\n你好", 5],
  ["a   b", 1],
  ["a\tb\r\nc", 2],
  ["   ", 0],
];

describe("memory weight", () => {
  it("storedWeight is the weight of the text as stored, for the shared rows", () => {
    for (const [text, expected] of STORED) expect(storedWeight(text), JSON.stringify(text)).toBe(expected);
  });

  it("is ceil(utf-8 bytes / 3) for the shared vector", () => {
    for (const [text, expected] of VECTOR) expect(weight(text), JSON.stringify(text)).toBe(expected);
  });

  it("weightOf sums each note's weight", () => {
    expect(weightOf([])).toBe(0);
    expect(weightOf([{ text: "你好" }, { text: "hello" }, { text: "a" }])).toBe(5);
  });
});
