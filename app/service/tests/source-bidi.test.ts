import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * No source file may contain a literal bidi override or isolate (U+202A–U+202E, U+2066–U+2069): inside a line it
 * reorders how the rest of the line is displayed in editors and review tools ("Trojan Source"), so code can read
 * differently from what it does. Write them as escapes. The ranges are given as numbers here, so this file has none.
 */

const SERVICE = fileURLToPath(new URL("..", import.meta.url));
const ROOTS = ["src", "tests"];

const isBidiControl = (cp: number): boolean => (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069);

/** Each literal bidi control in `text`: line (1-based) and code point. */
function bidiControls(text: string): Array<{ line: number; codePoint: string }> {
  const found: Array<{ line: number; codePoint: string }> = [];
  let line = 1;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0x0a) line++;
    else if (isBidiControl(cp)) found.push({ line, codePoint: `U+${cp.toString(16).toUpperCase()}` });
  }
  return found;
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? filesUnder(path.join(dir, e.name)) : [path.join(dir, e.name)],
  );
}

describe("source files", () => {
  it("the check finds every bidi override and isolate, and nothing else", () => {
    const all = [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069];
    for (const cp of all) expect(bidiControls(`const a = "x${String.fromCodePoint(cp)}y";`)).toHaveLength(1);
    expect(bidiControls(`one\ntwo ${String.fromCodePoint(0x202e)}`)).toEqual([{ line: 2, codePoint: "U+202E" }]);
    // Neighbours that are not bidi controls: zero-width space and joiner, line and paragraph separators, the code points
    // just outside both ranges, word joiner, BOM.
    for (const cp of [0x200b, 0x200d, 0x2028, 0x2029, 0x202f, 0x2065, 0x206a, 0x2060, 0xfeff]) {
      expect(bidiControls(`"${String.fromCodePoint(cp)}"`)).toEqual([]);
    }
  });

  it("no file under src/ or tests/ contains a literal bidi override or isolate", () => {
    const files = ROOTS.flatMap((root) => filesUnder(path.join(SERVICE, root)));
    expect(files.length).toBeGreaterThan(50);
    const offending = files.flatMap((f) =>
      bidiControls(readFileSync(f, "utf8")).map((hit) => `${path.relative(SERVICE, f)}:${hit.line} ${hit.codePoint}`),
    );
    expect(offending).toEqual([]);
  });
});
