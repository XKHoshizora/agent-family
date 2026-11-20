// @vitest-environment jsdom
// <LabLogo> and labOfModel — now the app's one set of brand marks (src/ui/ModelBrand.jsx, src/ui/modelBrands.js) under
// their old names — and the safety check (scripts/check-logos.mjs) that every bundled mark passes.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { LabLogo, labOfModel } from "../src/ui/LabLogo.jsx";
import { brandOf } from "../src/ui/modelBrands.js";
import { LOGO_DIR, checkPaths, checkSvg } from "../scripts/check-logos.mjs";
import { isBundledColourMark } from "./brand-marks.js";

afterEach(cleanup);

describe("LabLogo", () => {
  it("draws the bundled brand mark (no request to any other site), with the lab-logo class its places style", () => {
    const { container } = render(<LabLogo lab="claude" size={24} />);
    const mark = container.firstChild;
    expect(mark.tagName).toBe("IMG");
    expect([...mark.classList]).toEqual(["model-brand", "lab-logo"]);
    expect(mark.dataset.brand).toBe("claude");
    expect(isBundledColourMark(mark.getAttribute("src"), "claude")).toBe(true);
    expect(mark.getAttribute("alt")).toBe("");
    expect(mark.style.width).toBe("24px");
    const { container: mono } = render(<LabLogo lab="openai" />);
    expect(mono.firstChild.dataset.brand).toBe("openai");
    expect(mono.firstChild.classList.contains("lab-logo")).toBe(true);
  });

  it("is 18 pixels by default", () => {
    const { container } = render(<LabLogo lab="deepseek" />);
    expect(container.firstChild.style.width).toBe("18px");
  });

  it.each([["../x"], ["openai/../../"], ["openai.svg"], [""], ["x".repeat(200)], ["OpenAI"], ["anthropic"], ["baidu"], [undefined], [null], [{ toString: () => "openai" }], [["openai"]]])(
    "draws the generic mark for %j (never a path built from it)",
    (lab) => {
      const { container } = render(<LabLogo lab={lab} />);
      expect(container.firstChild.dataset.brand).toBe("generic");
      expect(container.firstChild.classList.contains("lab-logo")).toBe(true);
      expect(container.querySelector("img")).toBeNull();
    },
  );
});

describe("labOfModel", () => {
  it.each([
    ["gpt-4o", "openai"], ["o1-mini", "openai"], ["o3", "openai"], ["o4-mini", "openai"], ["chatgpt-4o-latest", "openai"],
    ["openai/gpt-4.1", "openai"],
    ["claude-sonnet-4-5", "claude"], ["Claude-3-Opus", "claude"],
    ["gemini-2.5-pro", "gemini"], ["gemma-3-27b", "gemini"],
    ["MiniMax-M2", "minimax"], ["abab6.5s-chat", "minimax"],
    ["deepseek-chat", "deepseek"],
    ["kimi-k2", "moonshot"], ["moonshot-v1-8k", "moonshot"],
    ["glm-4.6", "zhipu"],
    ["qwen3-max", "qwen"], ["qwq-32b", "qwen"], ["qvq-72b", "qwen"],
    ["grok-4", "grok"],
    ["mistral-large", "mistral"], ["codestral-latest", "mistral"], ["pixtral-12b", "mistral"],
    ["llama-3.3-70b", "meta"], ["meta-llama/llama-3.1-8b", "meta"],
    ["doubao-pro", "doubao"],
    // no mark in the set: the generic mark is drawn, never a guess
    ["hunyuan-turbo", "hunyuan"], ["command-r-plus", "cohere"], ["sonar-pro", "perplexity"],
    ["ernie-4.5", null], ["step-2-16k", null],
    ["something-else", null], ["", null], ["a".repeat(5000), null], [undefined, null], [null, null], [42, null],
  ])("%j -> %j", (name, lab) => {
    expect(labOfModel(name)).toBe(lab);
    expect(labOfModel(name)).toBe(brandOf(name));
  });
});

describe("the safety check's own run", () => {
  it("checks the bundled brand marks by default, by their file names (<brand>.svg or <brand>-color.svg), all accepted", () => {
    expect(LOGO_DIR.replaceAll("\\", "/")).toMatch(/\/src\/assets\/model-brands$/);
    const results = checkPaths([LOGO_DIR]).filter((r) => r.file.endsWith(".svg"));
    expect(results.length).toBe(15);
    for (const r of results) expect(r.problems, r.file).toEqual([]);
    const tmp = mkdtempSync(path.join(tmpdir(), "logos-"));
    try {
      writeFileSync(path.join(tmp, "Bad_Name.svg"), "<svg/>");
      expect(checkPaths([path.join(tmp, "Bad_Name.svg")])[0].problems).toContain("file name is not <lowercase-id>.svg or <lowercase-id>-color.svg");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("checkSvg", () => {
  const ok = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1" fill="url(#g)"/></svg>';
  it("accepts a plain svg", () => expect(checkSvg(ok)).toEqual([]));
  it.each([
    ["script", "<svg><script>alert(1)</script></svg>"],
    ["event attribute", '<svg onload="x()"></svg>'],
    ["foreignObject", "<svg><foreignObject/></svg>"],
    ["external href", '<svg><a href="https://x.test/"/></svg>'],
    ["external xlink:href", '<svg><use xlink:href="a.svg#b"/></svg>'],
    ["image", '<svg><image href="#a"/></svg>'],
    ["javascript:", '<svg><a href="javascript:alert(1)"/></svg>'],
    ["data: url", '<svg><path d="data:x"/></svg>'],
    ["style @import", "<svg><style>@import 'a.css';</style></svg>"],
    ["style url(", "<svg><style>a{fill:url(x.svg)}</style></svg>"],
    ["external url()", '<svg><path fill="url(https://x.test/a)"/></svg>'],
    ["encoded @import", '<svg><style>&#64;import "https://x/a.css"</style></svg>'],
    ["encoded url(", '<svg><path fill="u&#114;l(https://x/a.svg#p)"/></svg>'],
    ["css escape", String.raw`<svg><style>@\69mport 'a.css';</style></svg>`],
    ["doctype", '<!DOCTYPE svg [<!ENTITY a "b">]><svg/>'],
    ["two roots", "<svg/><svg/>"],
    ["not svg", "<html/>"],
    ["not xml", "<svg><path></svg>"],
    ["text outside", "hello <svg/>"],
    ["too large", ok.replace("</svg>", `<!-- ${"x".repeat(21000)} --></svg>`)],
  ])("rejects %s", (_n, text) => expect(checkSvg(text).length).toBeGreaterThan(0));
  it("allows an internal #id reference", () => expect(checkSvg('<svg><defs><g id="a"/></defs><use href="#a"/></svg>')).toEqual([]));
});
