import React from "react";
import claude from "../assets/model-brands/claude.svg";
import deepseek from "../assets/model-brands/deepseek.svg";
import doubao from "../assets/model-brands/doubao.svg";
import gemini from "../assets/model-brands/gemini.svg";
import grok from "../assets/model-brands/grok.svg";
import meta from "../assets/model-brands/meta.svg";
import minimax from "../assets/model-brands/minimax.svg";
import mistral from "../assets/model-brands/mistral.svg";
import moonshot from "../assets/model-brands/moonshot.svg";
import openai from "../assets/model-brands/openai.svg";
import qwen from "../assets/model-brands/qwen.svg";
import zhipu from "../assets/model-brands/zhipu.svg";

// The brand marks (lobe-icons, MIT: src/assets/model-brands/), by brand (src/ui/modelBrands.js BRANDS). Each is a
// single-colour file used only as a mask image, so it is drawn in the text's colour (the row's, the header's, a dimmed
// row's) and is never inlined into the page: only a brand of this fixed table ever names a file.
const MARKS = Object.freeze({ claude, deepseek, doubao, gemini, grok, meta, minimax, mistral, moonshot, openai, qwen, zhipu });

/** A model's brand mark (decorative): the brand's own, or — no brand, or one without a mark — a plain outlined chip. */
export function ModelBrand({ brand, size = 16 }) {
  const src = typeof brand === "string" && Object.hasOwn(MARKS, brand) ? MARKS[brand] : null;
  if (!src) {
    return (
      <svg className="model-brand" data-brand="generic" width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" aria-hidden="true">
        <rect x="4" y="4" width="8" height="8" rx="1.75" />
        <path d="M6.5 1.75V4M9.5 1.75V4M6.5 12v2.25M9.5 12v2.25M1.75 6.5H4M1.75 9.5H4M12 6.5h2.25M12 9.5h2.25" />
      </svg>
    );
  }
  const image = `url("${src}")`;
  return <span className="model-brand" data-brand={brand} aria-hidden="true" style={{ width: size, height: size, WebkitMaskImage: image, maskImage: image }} />;
}
