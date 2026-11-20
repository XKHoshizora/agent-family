// @vitest-environment jsdom
// A model's brand mark: brandOf (a model's name or id → one of twelve brands, or null), <ModelBrand>, and the vendored
// lobe-icons files behind it (each one checked as the lab logos are).
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { BRANDS, brandOf } from "../src/ui/modelBrands.js";
import { ModelBrand } from "../src/ui/ModelBrand.jsx";
import { checkSvg } from "../scripts/check-logos.mjs";

afterEach(cleanup);

const DIR = path.join(__dirname, "..", "src", "assets", "model-brands");

describe("brandOf", () => {
  it.each([
    ["gpt-4o", "openai"], ["GPT-4.1-mini", "openai"], ["gpt-x", "openai"], ["openai/gpt-4o", "openai"], ["gpt-oss-120b", "openai"],
    ["o1-mini", "openai"], ["o3", "openai"], ["o4-mini-high", "openai"], ["chatgpt-4o-latest", "openai"],
    ["claude-sonnet-4-5", "claude"], ["anthropic/claude-3.5-haiku", "claude"], ["Claude Mini", "claude"],
    ["deepseek-chat", "deepseek"], ["deepseek-reasoner", "deepseek"], ["DeepSeek-R1-Distill-Qwen-32B", "deepseek"],
    ["gemini-2.5-pro", "gemini"], ["models/gemini-1.5-flash", "gemini"], ["gemma-3-27b-it", "gemini"],
    ["qwen-max", "qwen"], ["Qwen/Qwen2.5-72B-Instruct", "qwen"], ["qwq-32b", "qwen"],
    ["kimi-k2-0905", "moonshot"], ["moonshot-v1-8k", "moonshot"],
    ["glm-4.6", "zhipu"], ["zhipu-glm-4", "zhipu"], ["zhipuai/glm-4-plus", "zhipu"],
    ["doubao-seed-1-6-250615", "doubao"], ["Doubao-pro-32k", "doubao"],
    ["MiniMax-M2", "minimax"], ["abab6.5s-chat", "minimax"],
    ["mistral-large-latest", "mistral"], ["mixtral-8x7b", "mistral"], ["codestral-2501", "mistral"],
    ["llama-3.3-70b", "meta"], ["meta-llama/Llama-3.1-8B-Instruct", "meta"], ["Meta-Llama-3-8B", "meta"],
    ["grok-4", "grok"], ["x-ai/grok-3-mini", "grok"],
    // anything else: no brand (the generic mark is drawn), never a guess
    ["小模型", null], ["house-blend", null], ["plain", null], ["ernie-4.5", null], ["hunyuan-turbo", null],
    ["o1x", null], ["o5-mini", null], ["o10", null], ["my-gpt", null], ["../openai", null],
    ["", null], ["a".repeat(301), null], [undefined, null], [null, null], [42, null], [{ toString: () => "gpt-4o" }, null],
  ])("%j -> %j", (name, brand) => {
    expect(brandOf(name)).toBe(brand);
  });

  it("knows exactly the twelve brands, each one reachable", () => {
    expect([...BRANDS].sort()).toEqual(["claude", "deepseek", "doubao", "gemini", "grok", "meta", "minimax", "mistral", "moonshot", "openai", "qwen", "zhipu"]);
  });
});

describe("<ModelBrand>", () => {
  it("draws a known brand as a decorative mask in the text's colour (an image, never inlined markup)", () => {
    const { container } = render(<ModelBrand brand="openai" />);
    const mark = container.firstChild;
    expect(mark.tagName).toBe("SPAN");
    expect(mark.classList.contains("model-brand")).toBe(true);
    expect(mark.dataset.brand).toBe("openai");
    expect(mark.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector("svg")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
  });

  it.each([[null], [undefined], ["../openai"], ["OpenAI"], ["toString"], ["__proto__"], [{ toString: () => "openai" }]])("draws the generic chip for %j", (brand) => {
    const { container } = render(<ModelBrand brand={brand} />);
    const mark = container.firstChild;
    expect(mark.tagName.toLowerCase()).toBe("svg");
    expect(mark.dataset.brand).toBe("generic");
    expect(mark.getAttribute("aria-hidden")).toBe("true");
    expect(mark.getAttribute("stroke")).toBe("currentColor");
  });
});

describe("the vendored brand marks", () => {
  const svgs = readdirSync(DIR).filter((f) => f.endsWith(".svg"));

  it("one file per brand, and nothing else but the licence and the note on where they came from", () => {
    expect(svgs.map((f) => f.replace(/\.svg$/, "")).sort()).toEqual([...BRANDS].sort());
    expect(readdirSync(DIR).filter((f) => !f.endsWith(".svg")).sort()).toEqual(["LICENSE-lobe-icons.txt", "README.md"]);
  });

  it.each(BRANDS.map((b) => [b]))("%s.svg is one plain, inert, single-colour <svg>", (brand) => {
    const buf = readFileSync(path.join(DIR, `${brand}.svg`));
    const text = buf.toString("utf8");
    expect(checkSvg(text, buf.length)).toEqual([]);
    expect(text).not.toMatch(/<script|\son[a-z]+\s*=|href|url\(/i);
    expect(text).toContain('fill="currentColor"');
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
  });
});
