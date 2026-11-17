// The Markdown pipeline for an Agent's text: everything that can be slow, run inside a Web Worker
// (markdownWorker.js), never on the page's main thread. One pure function, `renderToTree`: a text in, a plain tree of
// the allow-listed elements out (or "show it plain"), structured-cloneable, for the main thread to check again and
// show (markdownTree.js, Markdown.jsx). The text comes from a model that anything in the conversation can steer, and it
// is shown in the reader's signed-in page, so it is treated as hostile. In this order:
//   1. No raw HTML is parsed: it is shown as text.
//   2. Only the elements the Markdown pipeline makes are kept, each with only its own props: nothing gets an id, a
//      name, a handler or a style from the text (KaTeX's own layout styles, inside KaTeX's output only).
//   3. Every href goes through `safeHref`: an absolute http(s) URL, or the link is shown as its text.
//   4. An image is never an <img>: its alt text (or its URL) is a link to it, by rule 3. Nothing is ever fetched.
// And the work a text can cause is bounded: linear checks on the raw text before parsing (markdownLimits.js), table
// cells, formulas and their output, highlighted code and its output, and a final count of the tree. What is not
// bounded here is bounded by the main thread's deadline: a text whose answer takes too long is shown plain and the
// worker is ended (markdownClient.js).
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkRehype from "remark-rehype";
import katex from "katex";
import { fromHtml } from "hast-util-from-html";
import { createLowlight } from "lowlight";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import shell from "highlight.js/lib/languages/shell";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import yaml from "highlight.js/lib/languages/yaml";
import { fitsMarkdown } from "./markdownLimits.js";
import {
  ALIGN, APP_CLASSES, CLASS, ELEMENTS, KATEX_CLASS, KATEX_ELEMENTS, KATEX_PROPS, TREE_DEPTH, TREE_ELEMENTS, isKatexRootClass,
  safeHref, styleAllowed, withoutBidiControls,
} from "./markdownRules.js";

/** The limits on what one text may produce. `renderToTree`'s `limits` option replaces any of them (tests). */
export const LIMITS = Object.freeze({
  /** Table cells, counted as rendered: every row padded to the delimiter row's width. */
  cells: 600,
  /** One formula's source, in characters; formulas typeset per text. */
  mathLength: 2000,
  mathCount: 500,
  /** One formula's KaTeX output (HTML characters), and all of a text's (kept results included). */
  katexOutput: 100000,
  katexTextOutput: 100000,
  /** KaTeX time per text, and for one formula (beyond: never typeset again), in milliseconds. */
  katexBudgetMs: 100,
  katexSlowMs: 50,
  /** Code highlighted only when every line and the whole block are within these (characters). */
  highlightLine: 500,
  highlightCode: 10000,
  /** A highlighted block's output beyond these (elements, nesting) is discarded: plain code. */
  highlightElements: 1500,
  highlightDepth: 30,
  /** Highlighting time per text, and for one block (beyond: never highlighted again), in milliseconds. */
  highlightBudgetMs: 50,
  highlightSlowMs: 50,
  /** The final count: the whole tree of a text (beyond: the text is plain). */
  treeElements: TREE_ELEMENTS,
  treeDepth: TREE_DEPTH,
});

/** The render in progress (the pipeline is synchronous: one at a time): its limits, its clock, its source. */
let current = null;

const classesOf = (node) => (Array.isArray(node?.properties?.className) ? node.properties.className.map(String) : []);
const textOf = (node) => (node.children ?? []).map((child) => (child.type === "text" ? child.value : textOf(child))).join("");
const codeIn = (pre) => pre.children.find((child) => child.type === "element" && child.tagName === "code");
function remember(cache, key, value, max) {
  if (cache.size >= max) cache.delete(cache.keys().next().value);
  cache.set(key, value);
}
/**
 * Typeset formulas and highlighted code are kept by their source and used again as they are (a reply being written is
 * asked for again and again). Frozen, so nothing can change them: the allow-list below builds the tree afresh.
 */
function frozen(value) {
  const stack = [value];
  while (stack.length > 0) {
    const item = stack.pop();
    if (item === null || typeof item !== "object" || Object.isFrozen(item)) continue;
    Object.freeze(item);
    for (const child of Object.values(item)) stack.push(child);
  }
  return value;
}
/** Elements in a (hast) tree and its deepest element's depth, counted without recursion; stops past the limits. */
function sizeOf(tree, maxElements = Infinity, maxDepth = Infinity) {
  let elements = 0;
  let depth = 0;
  const stack = [[tree, 0]];
  while (stack.length > 0) {
    const [node, level] = stack.pop();
    if (node.type === "element") {
      elements += 1;
      if (level > depth) depth = level;
      if (elements > maxElements || depth > maxDepth) break;
    }
    for (const child of node.children ?? []) stack.push([child, level + 1]);
  }
  return { elements, depth };
}

// ───────── after parsing: limits on the tree

/** How deeply the parsed text may nest (emphasis in emphasis…, which markdownLimits.js cannot see in the raw text). */
const PARSED_DEPTH_MAX = 100;
/** A formula that defines macros (or uses a macro parameter) is shown as code: a macro can multiply its output. */
const MACRO_DEFINITION = /\\(?:def|gdef|edef|xdef|let|futurelet|newcommand|renewcommand|providecommand|global)(?![A-Za-z@])|#/;
/** A fence line's marker: `$$`, ``` or ~~~ (after any quote markers and indentation). */
const FENCE = /^(\${2,}|`{3,}|~{3,})/;
const CONTAINER_PREFIX = /^[ \t>]*/;

function tooDeep(tree) {
  const stack = [[tree, 0]];
  while (stack.length > 0) {
    const [node, depth] = stack.pop();
    if (depth > PARSED_DEPTH_MAX) return true;
    for (const child of node.children ?? []) stack.push([child, depth + 1]);
  }
  return false;
}

function cellsIn(tree) {
  let cells = 0;
  const stack = [tree];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node.type === "table") {
      const widest = Math.max(node.align?.length ?? 0, ...node.children.map((row) => row.children?.length ?? 0));
      cells += node.children.length * widest;
    } else {
      for (const child of node.children ?? []) stack.push(child);
    }
  }
  return cells;
}

/** Whether a maths block or code fence has its closing fence (one still open at the end of the text has not). */
function closed(node, source) {
  const start = node.position?.start?.offset;
  const end = node.position?.end?.offset;
  if (start === undefined || end === undefined) return true;
  const lines = source.slice(start, end).split("\n");
  const fence = FENCE.exec(lines[0].replace(CONTAINER_PREFIX, ""))?.[1];
  if (!fence) return true; // an indented code block has no fence to close
  if (lines.length < 2) return false;
  const last = lines.at(-1).replace(CONTAINER_PREFIX, "").trim();
  return last.length >= fence.length && [...last].every((ch) => ch === fence[0]);
}

const plainParagraph = (text) => ({ type: "paragraph", data: { hProperties: { className: ["md-plain"] } }, children: [{ type: "text", value: text }] });

/** A soft line break is a line break, as in the plain text (and in every block alike: no stray space between lines). */
function withBreaks(text) {
  if (!text.value.includes("\n")) return [text];
  return text.value.split("\n").flatMap((line, i) => (i === 0 ? [] : [{ type: "break" }]).concat(line ? [{ type: "text", value: line }] : []));
}

/**
 * The first step after parsing. A text that nests too deeply, or whose tables would have more than `cells` cells, is
 * shown plain. A maths block still open at the end (a reply being written) is its plain text until it closes, and a
 * code fence still open is not highlighted. Maths that is too long, beyond the count, or that defines macros becomes
 * code before KaTeX sees it.
 */
function remarkLimits() {
  return (tree) => {
    const { limits, source } = current;
    if (tooDeep(tree) || cellsIn(tree) > limits.cells) {
      current.plain = "complex";
      tree.children = [];
      return;
    }
    let formulas = 0;
    const walk = (node) => {
      if (!Array.isArray(node.children)) return;
      node.children = node.children.flatMap((child) => {
        if (child.type === "text") return withBreaks(child);
        const block = child.type === "math" || (child.type === "code" && child.lang === "math");
        if (child.type === "code" && !block) return [closed(child, source) ? child : { ...child, lang: null, meta: null }];
        if (!block && child.type !== "inlineMath") {
          walk(child);
          return [child];
        }
        if (block && !closed(child, source)) return [plainParagraph(source.slice(child.position.start.offset, child.position.end.offset))];
        formulas += 1;
        if (child.value.length <= limits.mathLength && formulas <= limits.mathCount && !MACRO_DEFINITION.test(child.value)) return [child];
        return [block ? { type: "code", lang: null, meta: null, value: child.value } : { type: "inlineCode", value: child.value }];
      });
    };
    walk(tree);
  };
}

// ───────── maths

/** (Maths KaTeX cannot read is shown as its source, in the muted text colour rather than an alarming red.) */
const KATEX = { throwOnError: false, strict: false, trust: false, maxExpand: 300, maxSize: 50, errorColor: "var(--ink-2)" };
/** Typeset formulas ({ nodes, size }) by display mode and source; formulas not to typeset again. */
const typeset = new Map();
const refusedFormulas = new Map();
const KATEX_KEPT = 500;

/** A formula in the tree: inline `<code class="math-inline">`, or a block's `<pre>` around `<code class="language-math">`. */
function formulaOf(node) {
  if (node.tagName === "code" && classesOf(node).includes("math-inline")) return { tex: textOf(node), display: false };
  const code = node.tagName === "pre" ? codeIn(node) : null;
  if (code && classesOf(code).includes("language-math")) return { tex: textOf(code), display: true };
  return null;
}

const codeElement = (text) => ({ type: "element", tagName: "code", properties: {}, children: [{ type: "text", value: text }] });
const formulaAsCode = ({ tex, display }) => (display ? { type: "element", tagName: "pre", properties: {}, children: [codeElement(tex)] } : codeElement(tex));

/**
 * One formula typeset: its tree and the size of KaTeX's HTML; null when KaTeX failed or the HTML is too long. KaTeX's
 * HTML is parsed by a spec-compliant parser without a DOM (parse5): nothing KaTeX emits is ever given to innerHTML.
 */
function typesetOne({ tex, display }, maxOutput) {
  let html;
  try {
    html = katex.renderToString(tex, { ...KATEX, displayMode: display });
  } catch {
    return null;
  }
  if (html.length > maxOutput) return null;
  return { nodes: fromHtml(html, { fragment: true }).children, size: html.length };
}

// KaTeX's first typeset sets itself up (font metrics and more): done as the worker starts, not charged to a reply.
typesetOne({ tex: "x", display: false }, Infinity);

/**
 * Typesets every formula with KaTeX, within a time budget and an output budget per text. A typeset runs to its end once
 * started: the static rules (length, count, no macro definitions, maxExpand) and the output cap protect a formula's
 * first typeset, the budgets everything after it (the text's other formulas, and the next pieces of a reply being
 * written: a typeset formula is kept and used again, one that failed, was too big or too slow is never typeset again).
 * Kept results count towards a text's output like new ones.
 */
function rehypeKatexBudgeted() {
  return (tree) => {
    const { limits, now } = current;
    let spent = 0;
    let output = 0;
    const walk = (parent) => {
      parent.children = parent.children.flatMap((node) => {
        if (node.type !== "element") return [node];
        const formula = formulaOf(node);
        if (!formula) {
          walk(node);
          return [node];
        }
        const key = `${formula.display ? "block" : "inline"}\n${formula.tex}`;
        let result = typeset.get(key);
        if (!result) {
          if (refusedFormulas.has(key) || spent > limits.katexBudgetMs || output >= limits.katexTextOutput) return [formulaAsCode(formula)];
          const started = now();
          result = typesetOne(formula, limits.katexOutput);
          const took = now() - started;
          spent += took;
          if (!result || took > limits.katexSlowMs) remember(refusedFormulas, key, true, KATEX_KEPT);
          if (!result) return [formulaAsCode(formula)];
          remember(typeset, key, frozen(result), KATEX_KEPT);
        }
        if (output + result.size > limits.katexTextOutput) return [formulaAsCode(formula)];
        output += result.size;
        return result.nodes;
      });
    };
    walk(tree);
  };
}

// ───────── code

/**
 * The languages highlighted; any other (or none, or a diagram such as mermaid) is plain code. Not Markdown (its
 * grammar takes seconds on a long line of links) and not XML/HTML/SVG (its grammar starts other grammars inside
 * `<script>` and `<style>`, seconds on short lines of them): such a fence is plain code.
 */
export const highlighter = createLowlight({ bash, c, cpp, css, diff, go, java, javascript, json, python, rust, shell, sql, typescript, yaml });
const highlighted = new Map();
const refusedBlocks = new Map();
const HIGHLIGHTED_KEPT = 100;

/** Whether a block is short enough, line by line and in all, to be given to a grammar (one pass over it). */
function highlightable(source, limits) {
  if (source.length > limits.highlightCode) return false;
  for (let start = 0; start <= source.length; ) {
    const end = source.indexOf("\n", start);
    const stop = end === -1 ? source.length : end;
    if (stop - start > limits.highlightLine) return false;
    start = stop + 1;
  }
  return true;
}

/**
 * Highlights every `<pre><code class="language-…">` of a known language that is short enough, within a time budget
 * per text; the result is discarded (plain code) when it has too many elements or nests too deeply. Highlighted blocks
 * are kept and used again; a block discarded or too slow is never highlighted again.
 */
function rehypeHighlightBudgeted() {
  return (tree) => {
    let spent = 0;
    const walk = (parent) => {
      for (const node of parent.children) {
        if (node.type !== "element") continue;
        if (node.tagName === "pre") spent += highlightBlock(node, spent);
        else walk(node);
      }
    };
    walk(tree);
  };
}

/** Highlights one block in place when it may be; returns the milliseconds spent. */
function highlightBlock(pre, spent) {
  const { limits, now } = current;
  const code = codeIn(pre);
  const language = classesOf(code).find((name) => name.startsWith("language-"))?.slice("language-".length);
  if (!language || !highlighter.registered(language)) return 0;
  const source = textOf(code);
  if (!highlightable(source, limits)) return 0;
  const key = `${language}\n${source}`;
  let done = highlighted.get(key);
  let took = 0;
  if (!done) {
    if (refusedBlocks.has(key) || spent > limits.highlightBudgetMs) return 0;
    const started = now();
    const { children } = highlighter.highlight(language, source, { prefix: "hljs-" });
    took = now() - started;
    done = { type: "element", tagName: "code", properties: { className: ["hljs", ...classesOf(code)] }, children };
    const { elements, depth } = sizeOf(done, limits.highlightElements, limits.highlightDepth);
    const tooBig = elements > limits.highlightElements || depth > limits.highlightDepth;
    if (tooBig || took > limits.highlightSlowMs) remember(refusedBlocks, key, true, HIGHLIGHTED_KEPT);
    if (tooBig) return took;
    remember(highlighted, key, frozen(done), HIGHLIGHTED_KEPT);
  }
  pre.children = pre.children.map((child) => (child === code ? done : child));
  return took;
}

// ───────── the allow-list (rules 1–4): the tree rebuilt as plain data

/** Adds nodes to a list of children, joining neighbouring text. */
function append(out, nodes) {
  for (const node of nodes) {
    if (typeof node === "string") {
      if (node === "") continue;
      if (typeof out.at(-1) === "string") out[out.length - 1] += node;
      else out.push(node);
    } else {
      out.push(node);
    }
  }
  return out;
}

/** Elements whose children are rows and cells only: the line breaks between them are not text of theirs. */
const TABLE_PARTS = new Set(["table", "thead", "tbody", "tfoot", "tr"]);

function cleanChildren(children, within, parent = null) {
  const out = [];
  for (const node of children ?? []) {
    if (TABLE_PARTS.has(parent) && node.type === "text" && node.value.trim() === "") continue;
    if (node.type === "text" || node.type === "raw") {
      // Rule 1: raw HTML is text. (The line break after a <br> is that <br>'s own.)
      const afterBreak = out.at(-1)?.tag === "br";
      append(out, [afterBreak ? node.value.replace(/^\n/, "") : node.value]);
    } else if (node.type === "element") {
      append(out, cleanElement(node, within));
    }
    // Comments, doctypes and anything else: dropped.
  }
  return out;
}

const element = (tag, props, children) => {
  const node = { tag };
  if (props && Object.keys(props).length > 0) node.props = props;
  if (children.length > 0) node.children = children;
  return node;
};

/** The element as it may be shown: itself with only its own props, its content alone, or nothing. */
function cleanElement(node, within) {
  if (within.katex || (node.tagName === "span" && classesOf(node).some(isKatexRootClass))) return katexElement(node);
  const tag = node.tagName;
  if (tag === "img") return imageAsLink(node, within);
  if (tag === "input") return [node.properties?.checked ? "☑" : "☐"]; // a task's box
  if (tag === "a") return link(node, within);
  if (!ELEMENTS.has(tag)) return [];
  const props = {};
  for (const name of ELEMENTS.get(tag)) {
    const value = node.properties?.[name];
    if (name === "align" ? ALIGN.has(value) : name === "start" ? Number.isSafeInteger(value) : false) props[name] = value;
  }
  const classes = classesOf(node).filter((name) => CLASS.test(name));
  if (classes.length > 0) props.className = classes;
  return [element(tag, props, cleanChildren(node.children, within, tag))];
}

/**
 * A link with a safe href, or its text alone (also inside another link, and for a footnote's in-page links). The
 * text's own title is dropped: the main thread shows the real address as the tooltip and the real host after the text.
 */
function link(node, within) {
  if (node.properties?.dataFootnoteBackref !== undefined) return [];
  const children = cleanChildren(node.children, { ...within, link: true });
  const href = within.link ? null : safeHref(node.properties?.href);
  if (!href) return children;
  return [element("a", { href }, children)];
}

/** An image is its alt text (or its URL when there is none), as a link to it: never an <img>, never fetched. */
function imageAsLink(node, within) {
  const src = typeof node.properties?.src === "string" ? node.properties.src : "";
  const alt = typeof node.properties?.alt === "string" ? node.properties.alt : "";
  return link({ type: "element", tagName: "a", properties: { href: src }, children: [{ type: "text", value: alt || src }] }, within);
}

const camelCase = (name) => name.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());

/** KaTeX's inline layout as React takes a style: only the properties and values it uses (markdownRules.js). */
function katexStyle(value) {
  if (typeof value !== "string") return null;
  const style = {};
  for (const declaration of value.split(";")) {
    const colon = declaration.indexOf(":");
    if (colon === -1) continue;
    const name = camelCase(declaration.slice(0, colon).trim().toLowerCase());
    const setting = declaration.slice(colon + 1).trim();
    if (styleAllowed(name, setting)) style[name] = setting;
  }
  return Object.keys(style).length > 0 ? style : null;
}

/** KaTeX's element with KaTeX's props (not the app's classes); maths it could not read is its source. */
function katexElement(node) {
  if (!KATEX_ELEMENTS.has(node.tagName)) return [];
  const classes = classesOf(node);
  const error = classes.includes("katex-error");
  const props = {};
  for (const [name, value] of Object.entries(node.properties ?? {})) {
    if (name === "className") {
      const kept = classes.filter((cls) => KATEX_CLASS.test(cls) && !APP_CLASSES.has(cls));
      if (kept.length > 0) props.className = kept;
    } else if (name === "style") {
      const style = error ? null : katexStyle(value);
      if (style) props.style = style;
    } else if (KATEX_PROPS.has(name) && (typeof value === "string" || typeof value === "number")) {
      props[KATEX_PROPS.get(name)] = String(value);
    }
  }
  return [element(node.tagName, props, cleanChildren(node.children, { katex: true, link: false }))];
}

// ───────── the whole pipeline

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkMath, { singleDollarTextMath: false }) // `$5 和 $10` stays a sentence: maths is `$$…$$` only
  .use(remarkLimits)
  .use(remarkRehype, { allowDangerousHtml: true, footnoteLabel: "脚注" }) // raw HTML kept as `raw`, shown as text (rule 1)
  .use(rehypeKatexBudgeted)
  .use(rehypeHighlightBudgeted)
  .freeze();

/** Elements and the deepest element's depth of a plain tree (the one returned), counted without recursion. */
export function treeSize(nodes) {
  let elements = 0;
  let depth = 0;
  const stack = nodes.map((node) => [node, 1]);
  while (stack.length > 0) {
    const [node, level] = stack.pop();
    if (typeof node === "string") continue;
    elements += 1;
    if (level > depth) depth = level;
    for (const child of node.children ?? []) stack.push([child, level + 1]);
  }
  return { elements, depth };
}

/**
 * An Agent's text as a plain tree of allow-listed elements: `{ tree, elements }` (the tree: text as strings, elements
 * as `{ tag, props?, children? }`), or `{ plain: true, reason }` — "complex" when the text is beyond a limit (shown
 * plain with a note), "error" when the pipeline failed. Options (tests): `limits` replaces any of LIMITS, `now` is the
 * clock of the time budgets, `skipChecks` skips the raw-text checks.
 */
export function renderToTree(text, { limits, now, skipChecks = false } = {}) {
  const source = withoutBidiControls(text);
  if (!skipChecks && !fitsMarkdown(source)) return { plain: true, reason: "complex" };
  const merged = limits ? { ...LIMITS, ...limits } : LIMITS;
  current = { limits: merged, now: now ?? (() => performance.now()), source, plain: null };
  try {
    const hast = processor.runSync(processor.parse(source), source);
    if (current.plain) return { plain: true, reason: current.plain };
    // Counted before the tree is rebuilt (which walks it), then once more as it is returned.
    const before = sizeOf(hast, merged.treeElements, merged.treeDepth);
    if (before.elements > merged.treeElements || before.depth > merged.treeDepth) return { plain: true, reason: "complex" };
    const tree = cleanChildren(hast.children, { katex: false, link: false });
    const { elements, depth } = treeSize(tree);
    if (elements > merged.treeElements || depth > merged.treeDepth) return { plain: true, reason: "complex" };
    return { tree, elements };
  } catch {
    return { plain: true, reason: "error" };
  } finally {
    current = null;
  }
}
