// @vitest-environment jsdom
// A model's brand mark: brandOf (a model's name or id → one of twelve brands, or null), <ModelBrand>, and the vendored
// lobe-icons files behind it (each one checked as the lab logos are).
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { BRANDS, brandOf } from "../src/ui/modelBrands.js";
import { ModelBrand } from "../src/ui/ModelBrand.jsx";
import { checkSvg } from "../scripts/check-logos.mjs";
import { isBundledColourMark } from "./brand-marks.js";

afterEach(cleanup);

const DIR = path.join(__dirname, "..", "src", "assets", "model-brands");

describe("brandOf", () => {
  it.each([
    ["gpt-4o", "openai"], ["GPT-4.1-mini", "openai"], ["gpt-x", "openai"], ["openai/gpt-4o", "openai"], ["gpt-oss-120b", "openai"],
    ["o1-mini", "openai"], ["o3", "openai"], ["o4-mini-high", "openai"], ["chatgpt-4o-latest", "openai"],
    ["claude-sonnet-4-5", "claude"], ["anthropic/claude-3.5-haiku", "claude"], ["Claude Mini", "claude"],
    ["deepseek-chat", "deepseek"], ["deepseek-reasoner", "deepseek"], ["DeepSeek-R1-Distill-Qwen-32B", "deepseek"],
    ["gemini-2.5-pro", "gemini"], ["models/gemini-1.5-flash", "gemini"], ["gemma-3-27b-it", "gemini"],
    ["qwen-max", "qwen"], ["Qwen/Qwen2.5-72B-Instruct", "qwen"], ["qwq-32b", "qwen"], ["qvq-72b", "qwen"],
    ["kimi-k2-0905", "moonshot"], ["moonshot-v1-8k", "moonshot"],
    ["glm-4.6", "zhipu"], ["zhipu-glm-4", "zhipu"], ["zhipuai/glm-4-plus", "zhipu"],
    ["doubao-seed-1-6-250615", "doubao"], ["Doubao-pro-32k", "doubao"],
    ["MiniMax-M2", "minimax"], ["abab6.5s-chat", "minimax"],
    ["mistral-large-latest", "mistral"], ["mixtral-8x7b", "mistral"], ["codestral-2501", "mistral"], ["pixtral-12b", "mistral"],
    ["llama-3.3-70b", "meta"], ["meta-llama/Llama-3.1-8B-Instruct", "meta"], ["Meta-Llama-3-8B", "meta"],
    ["grok-4", "grok"], ["x-ai/grok-3-mini", "grok"],
    ["hunyuan-turbo", "hunyuan"], ["tencent/Hunyuan-A13B-Instruct", "hunyuan"], ["tencent-hunyuan-large", "hunyuan"],
    ["command-r-plus", "cohere"], ["command-a-03-2025", "cohere"], ["cohere.command-r-plus-v1:0", "cohere"], ["cohere-rerank", "cohere"], ["aya-expanse-32b", "cohere"],
    ["sonar-pro", "perplexity"], ["perplexity/sonar-reasoning", "perplexity"], ["pplx-70b-online", "perplexity"],
    // anything else: no brand (the generic mark is drawn), never a guess
    ["小模型", null], ["house-blend", null], ["plain", null], ["ernie-4.5", null], ["ayame-7b", null], ["tencent-foo", null],
    ["o1x", null], ["o5-mini", null], ["o10", null], ["my-gpt", null], ["../openai", null],
    ["", null], ["a".repeat(301), null], [undefined, null], [null, null], [42, null], [{ toString: () => "gpt-4o" }, null],
  ])("%j -> %j", (name, brand) => {
    expect(brandOf(name)).toBe(brand);
  });

  it("knows exactly the fifteen brands, each one reachable", () => {
    expect([...BRANDS].sort()).toEqual(
      ["claude", "cohere", "deepseek", "doubao", "gemini", "grok", "hunyuan", "meta", "minimax", "mistral", "moonshot", "openai", "perplexity", "qwen", "zhipu"],
    );
  });
});

/** The brands drawn in their own colours (lobe-icons has a colour file for them); the other three are single-colour. */
const COLOURED = ["claude", "cohere", "deepseek", "doubao", "gemini", "hunyuan", "meta", "minimax", "mistral", "perplexity", "qwen", "zhipu"];
const MONO = ["grok", "moonshot", "openai"];

describe("<ModelBrand>", () => {
  it.each(COLOURED.map((b) => [b]))("draws %s in its own colours: a decorative image of the bundled file, never inlined markup", (brand) => {
    const { container } = render(<ModelBrand brand={brand} size={14} />);
    const mark = container.firstChild;
    expect(mark.tagName).toBe("IMG");
    expect(mark.classList.contains("model-brand")).toBe(true);
    expect(mark.dataset.brand).toBe(brand);
    expect(mark.getAttribute("alt")).toBe("");
    expect(isBundledColourMark(mark.getAttribute("src"), brand)).toBe(true);
    expect(mark.style.width).toBe("14px");
    expect(mark.style.height).toBe("14px");
    expect(container.querySelector("svg")).toBeNull();
  });

  it.each(MONO.map((b) => [b]))("draws %s (no colour file upstream) as a mask in the text's colour", (brand) => {
    const { container } = render(<ModelBrand brand={brand} />);
    const mark = container.firstChild;
    expect(mark.tagName).toBe("SPAN");
    expect(mark.classList.contains("model-brand")).toBe(true);
    expect(mark.dataset.brand).toBe(brand);
    expect(mark.getAttribute("aria-hidden")).toBe("true");
    expect(mark.style.width).toBe("16px");
    expect(container.querySelector("svg")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
  });

  it("takes a class of its caller's beside its own", () => {
    const { container } = render(<ModelBrand brand="claude" className="lab-logo" />);
    expect([...container.firstChild.classList]).toEqual(["model-brand", "lab-logo"]);
  });

  it.each([[null], [undefined], ["../openai"], ["OpenAI"], ["toString"], ["__proto__"], [{ toString: () => "openai" }]])("draws the generic chip for %j", (brand) => {
    const { container } = render(<ModelBrand brand={brand} size={18} />);
    const mark = container.firstChild;
    expect(mark.tagName.toLowerCase()).toBe("svg");
    expect(mark.dataset.brand).toBe("generic");
    expect(mark.getAttribute("aria-hidden")).toBe("true");
    expect(mark.getAttribute("stroke")).toBe("currentColor");
    expect(mark.style.width).toBe("18px");
  });
});

describe("the vendored brand marks", () => {
  const svgs = readdirSync(DIR).filter((f) => f.endsWith(".svg"));

  it("one file per brand — its colour file where lobe-icons has one, else its single-colour one — and nothing else but the licence and the note", () => {
    expect([...COLOURED, ...MONO].sort()).toEqual([...BRANDS].sort());
    expect(svgs.sort()).toEqual([...COLOURED.map((b) => `${b}-color.svg`), ...MONO.map((b) => `${b}.svg`)].sort());
    expect(readdirSync(DIR).filter((f) => !f.endsWith(".svg")).sort()).toEqual(["LICENSE-lobe-icons.txt", "README.md"]);
  });

  it.each(svgs.map((f) => [f]))("%s is one plain, inert <svg> (references only to its own gradients)", (file) => {
    const buf = readFileSync(path.join(DIR, file));
    const text = buf.toString("utf8");
    expect(checkSvg(text, buf.length)).toEqual([]);
    expect(text).not.toMatch(/<script|<image|<foreignObject|\son[a-z]+\s*=|href/i);
    for (const ref of text.matchAll(/url\(([^)]*)\)/g)) expect(ref[1]).toMatch(/^#lobe-icons-[\w-]+$/);
    if (file.endsWith("-color.svg")) expect(text).not.toContain("currentColor");
    else expect(text).toContain('fill="currentColor"');
  });

  it("carries lobe-icons' MIT notice and says where the files came from", () => {
    const licence = readFileSync(path.join(DIR, "LICENSE-lobe-icons.txt"), "utf8");
    expect(licence).toContain("MIT License");
    expect(licence).toContain("Copyright (c) 2023 LobeHub");
    expect(licence).toContain("THE SOFTWARE IS PROVIDED \"AS IS\"");
    const readme = readFileSync(path.join(DIR, "README.md"), "utf8").trim();
    expect(readme.split("\n")).toHaveLength(1);
    expect(readme).toContain("github.com/lobehub/lobe-icons");
    expect(readme).toContain("packages/static-svg/icons");
    expect(readme).toContain("-color.svg");
  });

  it("the old lab-logo files are gone: every mark the app shows is one of these, bundled with the page", () => {
    expect(existsSync(path.join(__dirname, "..", "public", "logos"))).toBe(false);
    expect(existsSync(path.join(__dirname, "..", "logos-NOTICE.md"))).toBe(false);
  });
});
