import React from "react";
import claude from "../assets/model-brands/claude-color.svg";
import deepseek from "../assets/model-brands/deepseek-color.svg";
import doubao from "../assets/model-brands/doubao-color.svg";
import gemini from "../assets/model-brands/gemini-color.svg";
import grok from "../assets/model-brands/grok.svg";
import meta from "../assets/model-brands/meta-color.svg";
import minimax from "../assets/model-brands/minimax-color.svg";
import mistral from "../assets/model-brands/mistral-color.svg";
import moonshot from "../assets/model-brands/moonshot.svg";
import openai from "../assets/model-brands/openai.svg";
import qwen from "../assets/model-brands/qwen-color.svg";
import zhipu from "../assets/model-brands/zhipu-color.svg";

// The app's one set of brand marks (lobe-icons, MIT: src/assets/model-brands/), by brand (src/ui/modelBrands.js BRANDS),
// bundled with the page: no mark is ever fetched from another site. A brand lobe-icons draws in colour is an image of its
// colour file; the three it has only in one colour (openai, moonshot, grok) are used as a mask, so they take the text's
// colour. Never inlined into the page; only a brand of this fixed table ever names a file.
const MARKS = Object.freeze({
  claude: { src: claude, colour: true },
  deepseek: { src: deepseek, colour: true },
  doubao: { src: doubao, colour: true },
  gemini: { src: gemini, colour: true },
  grok: { src: grok, colour: false },
  meta: { src: meta, colour: true },
  minimax: { src: minimax, colour: true },
  mistral: { src: mistral, colour: true },
  moonshot: { src: moonshot, colour: false },
  openai: { src: openai, colour: false },
  qwen: { src: qwen, colour: true },
  zhipu: { src: zhipu, colour: true },
});

/**
 * A model's brand mark (decorative), `size` px square: the brand's own, or — no brand, or one without a mark — a plain
 * outlined chip. `className` is added to its own (`model-brand`), for where it stands.
 */
export function ModelBrand({ brand, size = 16, className = "" }) {
  const mark = typeof brand === "string" && Object.hasOwn(MARKS, brand) ? MARKS[brand] : null;
  const classes = className ? `model-brand ${className}` : "model-brand";
  const box = { width: size, height: size };
  if (!mark) {
    return (
      <svg className={classes} data-brand="generic" style={box} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" aria-hidden="true">
        <rect x="4" y="4" width="8" height="8" rx="1.75" />
        <path d="M6.5 1.75V4M9.5 1.75V4M6.5 12v2.25M9.5 12v2.25M1.75 6.5H4M1.75 9.5H4M12 6.5h2.25M12 9.5h2.25" />
      </svg>
    );
  }
  if (mark.colour) return <img className={classes} data-brand={brand} src={mark.src} alt="" style={box} draggable={false} decoding="async" />;
  const image = `url("${mark.src}")`;
  return <span className={classes} data-brand={brand} aria-hidden="true" style={{ ...box, WebkitMaskImage: image, maskImage: image }} />;
}
