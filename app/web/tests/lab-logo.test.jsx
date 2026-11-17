// @vitest-environment jsdom
// <LabLogo>, labOfModel, and the vendored files behind LAB_LOGOS (and the safety check over every one of them).
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { LAB_LOGOS, LabLogo, labOfModel } from "../src/ui/LabLogo.jsx";
import { LOGO_DIR, checkSvg } from "../scripts/check-logos.mjs";

afterEach(cleanup);

const files = readdirSync(LOGO_DIR).filter((f) => f.endsWith(".svg"));

describe("LabLogo", () => {
  it("shows a known lab as a same-origin decorative image", () => {
    const { container } = render(<LabLogo lab="openai" size={24} />);
    const img = container.querySelector("img");
    expect(img.getAttribute("src")).toBe("/logos/labs/openai.svg");
    expect(img.getAttribute("alt")).toBe("");
    expect(img.getAttribute("width")).toBe("24");
    expect(img.getAttribute("height")).toBe("24");
    expect(img.getAttribute("loading")).toBe("lazy");
    expect(container.querySelector("svg")).toBeNull();
  });

  it("is 18 pixels by default", () => {
    const { container } = render(<LabLogo lab="anthropic" />);
    expect(container.querySelector("img").getAttribute("width")).toBe("18");
  });

  it.each([["../x"], ["openai/../../"], ["openai.svg"], [""], ["x".repeat(200)], ["OpenAI"], ["baidu"], [undefined], [null], [{ toString: () => "openai" }], [["openai"]]])(
    "renders nothing for %j",
    (lab) => {
      const { container } = render(<LabLogo lab={lab} />);
      expect(container.innerHTML).toBe("");
    },
  );
});

describe("labOfModel", () => {
  it.each([
    ["gpt-4o", "openai"], ["o1-mini", "openai"], ["o3", "openai"], ["o4-mini", "openai"], ["chatgpt-4o-latest", "openai"],
    ["openai/gpt-4.1", "openai"],
    ["claude-sonnet-4-5", "anthropic"], ["Claude-3-Opus", "anthropic"],
    ["gemini-2.5-pro", "google"], ["gemma-3-27b", "google"],
    ["MiniMax-M2", "minimax"], ["abab6.5s-chat", "minimax"],
    ["deepseek-chat", "deepseek"],
    ["kimi-k2", "moonshotai"], ["moonshot-v1-8k", "moonshotai"],
    ["glm-4.6", "zhipuai"],
    ["qwen3-max", "alibaba"], ["qwq-32b", "alibaba"], ["qvq-72b", "alibaba"],
    ["grok-4", "xai"],
    ["mistral-large", "mistral"], ["codestral-latest", "mistral"], ["pixtral-12b", "mistral"],
    ["llama-3.3-70b", "meta"], ["meta-llama/llama-3.1-8b", "meta"],
    ["hunyuan-turbo", "tencent"],
    ["command-r-plus", "cohere"],
    ["sonar-pro", "perplexity"],
    // their logos are not vendored: no guess rather than a dead path
    ["ernie-4.5", null], ["doubao-pro", null], ["step-2-16k", null],
    ["something-else", null], ["", null], ["a".repeat(5000), null], [undefined, null], [null, null], [42, null],
  ])("%j -> %j", (name, lab) => {
    expect(labOfModel(name)).toBe(lab);
  });
});

describe("the vendored logos", () => {
  it("has a file for every id in LAB_LOGOS and lists every file", () => {
    expect(files.map((f) => f.replace(/\.svg$/, "")).sort()).toEqual([...LAB_LOGOS].sort());
    expect(new Set(LAB_LOGOS).size).toBe(LAB_LOGOS.length);
  });

  it.each(files)("%s passes the safety check", (file) => {
    const buf = readFileSync(path.join(LOGO_DIR, file));
    expect(checkSvg(buf.toString("utf8"), buf.length)).toEqual([]);
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
    ["doctype", '<!DOCTYPE svg [<!ENTITY a "b">]><svg/>'],
    ["two roots", "<svg/><svg/>"],
    ["not svg", "<html/>"],
    ["not xml", "<svg><path></svg>"],
    ["text outside", "hello <svg/>"],
    ["too large", ok.replace("</svg>", `<!-- ${"x".repeat(21000)} --></svg>`)],
  ])("rejects %s", (_n, text) => expect(checkSvg(text).length).toBeGreaterThan(0));
  it("allows an internal #id reference", () => expect(checkSvg('<svg><defs><g id="a"/></defs><use href="#a"/></svg>')).toEqual([]));
});
