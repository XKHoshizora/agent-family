import React from "react";

// The AI labs whose logo is vendored in public/logos/labs/<id>.svg (see logos-NOTICE.md). Keep this list and
// the files in step: tests/lab-logo.test.jsx fails when one has no file or a file is not listed. A logo is shown only
// through <img src>, never inlined, and only for an id from this fixed list: nothing from outside ever builds the path.
export const LAB_LOGOS = Object.freeze([
  "alibaba",
  "anthropic",
  "cohere",
  "deepseek",
  "google",
  "meta",
  "minimax",
  "mistral",
  "moonshotai",
  "nvidia",
  "openai",
  "perplexity",
  "tencent",
  "xai",
  "zhipuai",
]);

const LAB_SET = new Set(LAB_LOGOS);

/** True only for an id in LAB_LOGOS (a string; anything else, "../x" included, is not). */
export function isLabLogo(lab) {
  return typeof lab === "string" && LAB_SET.has(lab);
}

/** The lab's logo as a small decorative image, or nothing for an id that is not in LAB_LOGOS. */
export function LabLogo({ lab, size = 18 }) {
  if (!isLabLogo(lab)) return null;
  return <img className="lab-logo" src={`/logos/labs/${lab}.svg`} alt="" width={size} height={size} loading="lazy" decoding="async" />;
}

// [start of the name, lab]. A model name is lower-cased and an "org/" prefix ("openai/gpt-4o") is dropped, then the
// start is matched by one pass over a short list of anchored patterns: linear in the name's length.
const RULES = [
  [/^(gpt-|o1|o3|o4|chatgpt)/, "openai"],
  [/^claude/, "anthropic"],
  [/^(gemini|gemma)/, "google"],
  [/^(minimax|abab)/, "minimax"],
  [/^deepseek/, "deepseek"],
  [/^(kimi|moonshot)/, "moonshotai"],
  [/^glm/, "zhipuai"],
  [/^(qwen|qwq|qvq)/, "alibaba"],
  [/^grok/, "xai"],
  [/^(mistral|codestral|pixtral)/, "mistral"],
  [/^llama/, "meta"],
  [/^ernie/, "baidu"],
  [/^hunyuan/, "tencent"],
  [/^doubao/, "bytedance"],
  [/^step-/, "stepfun"],
  [/^command/, "cohere"],
  [/^sonar/, "perplexity"],
];

/** Guesses the lab from a model name when the catalogue gives none; null when unknown or when its logo is not vendored. */
export function labOfModel(name) {
  if (typeof name !== "string" || name.length === 0 || name.length > 300) return null;
  const lower = name.toLowerCase();
  const base = lower.slice(lower.lastIndexOf("/") + 1);
  for (const [re, lab] of RULES) {
    if (re.test(base)) return isLabLogo(lab) ? lab : null;
  }
  return null;
}
