// The Markdown renderer for an Agent's text: its own chunk, loaded the first time an Agent's message is shown
// (AgentChatBits.jsx). The text comes from a model that anything in the conversation can steer, and it is shown in the
// reader's signed-in page, so it is treated as hostile. In this order:
//   1. No raw HTML is parsed: it is shown as text.
//   2. Only the elements the Markdown pipeline makes are kept, each with only its own attributes: nothing gets an id, a
//      name, a handler or a style from the text (KaTeX's own layout styles, inside KaTeX's output only).
//   3. Every href goes through `safeHref`: an absolute http(s) URL, or the link is shown as its text.
//   4. An image is never an <img>: its alt text (or its URL) is a link to it, by rule 3. Nothing is ever fetched.
//   5. Every link opens a new tab, with rel="noopener noreferrer nofollow".
//   6. The caller wraps this in an error boundary that shows the plain text instead, and shows a text too big or too
//      deep (markdownLimits.js) plain without trying.
import React, { memo, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeHighlight from "rehype-highlight";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import shell from "highlight.js/lib/languages/shell";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import "katex/dist/katex.min.css";

/** An absolute http(s) URL as the link's href, or null: the link is then shown as its text (rule 3). */
export function safeHref(value) {
  if (typeof value !== "string") return null;
  let url;
  try {
    url = new URL(value.trim()); // no base: a relative or protocol-relative URL is not a link here
  } catch {
    return null;
  }
  return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
}

// A reply being written is rendered again on every piece that arrives: the formulas and code blocks it already had are
// typeset and highlighted once (kept by their source, a bounded number), and only copies are used again.

const classesOf = (node) => (Array.isArray(node.properties?.className) ? node.properties.className.map(String) : []);
const textOf = (node) => (node.children ?? []).map((child) => (child.type === "text" ? child.value : textOf(child))).join("");
const codeIn = (pre) => pre.children.find((child) => child.type === "element" && child.tagName === "code");
function remember(cache, key, value, max) {
  if (cache.size >= max) cache.delete(cache.keys().next().value);
  cache.set(key, value);
}

// ───────── maths

/** A formula or maths block longer than this is shown as code, not typeset. */
const MATH_MAX = 2000;
/** Formulas typeset in one text; the ones after are shown as code (KaTeX's output is large). */
const MATH_COUNT_MAX = 500;
/** (Maths KaTeX cannot read is shown as its source, in the muted text colour rather than an alarming red.) */
const KATEX = { throwOnError: false, strict: false, trust: false, maxExpand: 1000, maxSize: 50, errorColor: "var(--ink-2)" };
const MATH_CLASSES = new Set(["language-math", "math-inline", "math-display"]);

/** How deeply the parsed text may nest (emphasis in emphasis…, which markdownLimits.js cannot see in the raw text). */
const TREE_DEPTH_MAX = 100;

function tooDeep(tree) {
  const stack = [[tree, 0]];
  while (stack.length > 0) {
    const [node, depth] = stack.pop();
    if (depth > TREE_DEPTH_MAX) return true;
    for (const child of node.children ?? []) stack.push([child, depth + 1]);
  }
  return false;
}

/**
 * The first step after parsing: a text that nests too deeply is shown as its plain text; maths that is too long
 * (`$$…$$`, `$…$`, a ```math fence), or beyond the count, becomes code before KaTeX sees it.
 */
function remarkLimits() {
  return (tree, file) => {
    if (tooDeep(tree)) {
      tree.children = [{ type: "paragraph", data: { hProperties: { className: ["md-plain"] } }, children: [{ type: "text", value: String(file.value) }] }];
      return;
    }
    let count = 0;
    const walk = (node) => {
      if (!Array.isArray(node.children)) return;
      node.children = node.children.map((child) => {
        const block = child.type === "math" || (child.type === "code" && child.lang === "math");
        const inline = child.type === "inlineMath";
        if (!block && !inline) {
          walk(child);
          return child;
        }
        count += 1;
        if (child.value.length <= MATH_MAX && count <= MATH_COUNT_MAX) return child;
        return block ? { type: "code", lang: null, meta: null, value: child.value, position: child.position } : { type: "inlineCode", value: child.value, position: child.position };
      });
    };
    walk(tree);
  };
}

/** rehype-katex's transform, made once and run one formula at a time. */
const katexTree = rehypeKatex(KATEX);
const typeset = new Map();
const TYPESET_MAX = MATH_COUNT_MAX;

/** A formula: inline `<code class="math-inline">`, or a block's `<pre>` around `<code class="language-math">`. */
function isMath(node) {
  const code = node.tagName === "pre" ? codeIn(node) : node.tagName === "code" ? node : null;
  return Boolean(code) && classesOf(code).some((name) => MATH_CLASSES.has(name));
}

/** Typesets every formula with KaTeX, from the cache when that formula was typeset before. */
function rehypeKatexCached() {
  const walk = (parent, file) => {
    parent.children = parent.children.flatMap((node) => {
      if (node.type !== "element") return [node];
      if (!isMath(node)) {
        walk(node, file);
        return [node];
      }
      const key = `${node.tagName}.${classesOf(node.tagName === "pre" ? codeIn(node) : node).join(".")}\n${textOf(node)}`;
      let done = typeset.get(key);
      if (!done) {
        const root = { type: "root", children: [node] };
        katexTree(root, file);
        done = root.children;
        remember(typeset, key, done, TYPESET_MAX);
      }
      return structuredClone(done);
    });
  };
  return walk;
}

// ───────── code

/** The languages highlighted; any other (or none, or a diagram such as mermaid) is plain code. */
const LANGUAGES = { bash, c, cpp, css, diff, go, java, javascript, json, markdown, python, rust, shell, sql, typescript, xml, yaml };
/** rehype-highlight's transform, made once (one set of grammars for every message) and run one code block at a time. */
const highlightTree = rehypeHighlight({ languages: LANGUAGES });
/** Code longer than this is not highlighted. */
const CODE_MAX = 20000;
const highlighted = new Map();
const HIGHLIGHTED_MAX = 100;

/** Highlights every `<pre><code class="language-…">`, from the cache when that block was highlighted before. */
function rehypeHighlightCached() {
  const walk = (parent, file) => {
    for (const node of parent.children) {
      if (node.type !== "element") continue;
      if (node.tagName === "pre") highlightBlock(node, file);
      else walk(node, file);
    }
  };
  return walk;
}

function highlightBlock(pre, file) {
  const code = codeIn(pre);
  const language = code && classesOf(code).find((name) => name.startsWith("language-"));
  if (!language) return;
  const source = textOf(code);
  if (source.length > CODE_MAX) return;
  const key = `${language}\n${source}`;
  let done = highlighted.get(key);
  if (!done) {
    const block = { ...code, properties: { ...code.properties, className: classesOf(code) } };
    highlightTree({ type: "root", children: [{ type: "element", tagName: "pre", properties: {}, children: [block] }] }, file);
    done = block;
    remember(highlighted, key, done, HIGHLIGHTED_MAX);
  }
  pre.children = pre.children.map((child) => (child === code ? structuredClone(done) : child));
}

// ───────── the allow-list (rules 2–4)

/** The elements the Markdown pipeline makes, outside KaTeX, and the attributes each keeps (hast property names). */
const ELEMENTS = new Map(
  Object.entries({
    p: [], h1: [], h2: [], h3: [], h4: [], h5: [], h6: [], ul: [], ol: ["start"], li: [], blockquote: [], hr: [], br: [],
    pre: [], code: [], em: [], strong: [], del: [], sup: [], span: [], section: [],
    table: [], thead: [], tbody: [], tr: [], th: ["align"], td: ["align"], a: ["href", "title"],
  }),
);
/** Classes kept outside KaTeX: the highlighter's, a code block's language, the task-list and footnote ones, ours. */
const CLASS = /^(hljs[\w-]*|[a-z]+_+|language-[\w#+.-]{1,40}|contains-task-list|task-list-item|footnotes|sr-only|md-plain)$/;
const ALIGN = new Set(["left", "right", "center"]);
/** KaTeX's own output: its HTML, its MathML and the few SVG shapes it draws (a root, an arrow, a hat). */
const KATEX_ELEMENTS = new Set([
  "span", "math", "semantics", "annotation", "mrow", "mi", "mn", "mo", "mtext", "mspace", "msup", "msub", "msubsup",
  "mfrac", "msqrt", "mroot", "mover", "munder", "munderover", "mtable", "mtr", "mtd", "mstyle", "mpadded", "mphantom",
  "menclose", "svg", "path", "line",
]);
const KATEX_ATTRIBUTES = new Set([
  "className", "style", "ariaHidden", "xmlns", "display", "encoding", "mathvariant", "stretchy", "fence", "separator",
  "minsize", "maxsize", "lspace", "rspace", "accent", "accentunder", "mathcolor", "mathbackground", "scriptlevel",
  "displaystyle", "width", "height", "depth", "voffset", "notation", "rowspacing", "rowalign", "columnalign",
  "columnspacing", "columnlines", "rowlines", "frame", "linethickness", "movablelimits", "largeop", "symmetric",
  "mathsize", "viewBox", "preserveAspectRatio", "d", "x1", "y1", "x2", "y2", "strokeWidth",
]);
/** A style that could fetch or run something is dropped, KaTeX's or not (its own never does). */
const UNSAFE_STYLE = /url\s*\(|image|expression|@|\\|src\s*\(/i;
const ALLOWED_ELEMENTS = [...new Set([...ELEMENTS.keys(), ...KATEX_ELEMENTS])];

const isKatexRoot = (node) => node.tagName === "span" && classesOf(node).some((name) => name === "katex" || name === "katex-display" || name === "katex-error");

/** The last step: rebuilds the tree from what may be shown, and nothing else. */
function rehypeAllowList() {
  return (tree) => {
    tree.children = cleanChildren(tree.children, { katex: false, link: false });
  };
}

function cleanChildren(children, within) {
  const out = [];
  for (const node of children ?? []) {
    if (node.type === "text" || node.type === "raw") {
      // Rule 1: raw HTML is text. (A paragraph keeps its line breaks, styles.css: the one after a <br> is that <br>'s.)
      const afterBreak = out.at(-1)?.tagName === "br";
      const value = afterBreak ? node.value.replace(/^\n/, "") : node.value;
      if (value) out.push({ type: "text", value });
    } else if (node.type === "element") {
      out.push(...cleanElement(node, within));
    }
    // Comments, doctypes and anything else: dropped.
  }
  return out;
}

/** The element as it may be shown: itself with only its own attributes, its content alone, or nothing. */
function cleanElement(node, within) {
  if (within.katex || isKatexRoot(node)) return katexElement(node);
  const tag = node.tagName;
  if (tag === "img") return imageAsLink(node, within);
  if (tag === "input") return [{ type: "text", value: node.properties?.checked ? "☑" : "☐" }]; // a task's box
  if (tag === "a") return link(node, within);
  if (!ELEMENTS.has(tag)) return [];
  const properties = {};
  for (const name of ELEMENTS.get(tag)) {
    const value = node.properties?.[name];
    if (name === "align" ? ALIGN.has(value) : name === "start" ? Number.isInteger(value) : false) properties[name] = value;
  }
  const classes = classesOf(node).filter((name) => CLASS.test(name));
  if (classes.length > 0) properties.className = classes;
  return [{ type: "element", tagName: tag, properties, children: cleanChildren(node.children, within) }];
}

/** A link with a safe href, or its text alone (also inside another link, and for a footnote's in-page links). */
function link(node, within) {
  if (node.properties?.dataFootnoteBackref !== undefined) return [];
  const children = cleanChildren(node.children, { ...within, link: true });
  const href = within.link ? null : safeHref(node.properties?.href);
  if (!href) return children;
  const properties = { href };
  if (typeof node.properties.title === "string") properties.title = node.properties.title;
  return [{ type: "element", tagName: "a", properties, children }];
}

/** An image is its alt text (or its URL when there is none), as a link to it: never an <img>, never fetched. */
function imageAsLink(node, within) {
  const src = typeof node.properties?.src === "string" ? node.properties.src : "";
  const alt = typeof node.properties?.alt === "string" ? node.properties.alt : "";
  const label = [{ type: "text", value: alt || src }];
  return link({ type: "element", tagName: "a", properties: { href: src }, children: label }, within);
}

/** KaTeX's element with KaTeX's attributes; maths it could not read is its source, coloured by styles.css. */
function katexElement(node) {
  if (!KATEX_ELEMENTS.has(node.tagName)) return [];
  const error = classesOf(node).includes("katex-error");
  const properties = {};
  for (const [name, value] of Object.entries(node.properties ?? {})) {
    if (!KATEX_ATTRIBUTES.has(name)) continue;
    if (name === "style" && (error || typeof value !== "string" || UNSAFE_STYLE.test(value))) continue;
    properties[name] = value;
  }
  return [{ type: "element", tagName: node.tagName, properties, children: cleanChildren(node.children, { katex: true, link: false }) }];
}

/** react-markdown's own URL step, after ours: an href of a link that is safe, nothing else. */
const urlTransform = (url, key, node) => (key === "href" && node.tagName === "a" ? safeHref(url) : null);

// ───────── what the elements render as

/** Rule 5, checked once more where the element is made. */
function Link({ href, title, children }) {
  const safe = safeHref(href);
  if (!safe) return <>{children}</>;
  return (
    <a href={safe} title={title} target="_blank" rel="noopener noreferrer nofollow">
      {children}
    </a>
  );
}

/** A table scrolls sideways inside the bubble. */
function Table({ children }) {
  return (
    <div className="md-table">
      <table>{children}</table>
    </div>
  );
}

/** A code block: scrolls sideways inside the bubble, with 复制 (a refused clipboard fails quietly). */
function CodeBlock({ children }) {
  const pre = useRef(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(pre.current?.textContent ?? "");
      setCopied(true);
    } catch {
      /* no clipboard here, or refused: nothing to say */
    }
  };
  return (
    <div className="md-code">
      <pre ref={pre}>{children}</pre>
      <button type="button" className="btn btn-sm md-copy" onClick={copy}>
        {copied ? "已复制" : "复制"}
      </button>
    </div>
  );
}

const COMPONENTS = { a: Link, pre: CodeBlock, table: Table };
const REMARK = [remarkGfm, remarkMath, remarkLimits];
const REHYPE = [rehypeKatexCached, rehypeHighlightCached, rehypeAllowList];
const REMARK_REHYPE = { footnoteLabel: "脚注" };

/** An Agent's text, rendered. Re-renders only when the text changes. */
export const Markdown = memo(function Markdown({ text }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={REMARK}
        rehypePlugins={REHYPE}
        remarkRehypeOptions={REMARK_REHYPE}
        allowedElements={ALLOWED_ELEMENTS}
        urlTransform={urlTransform}
        components={COMPONENTS}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
