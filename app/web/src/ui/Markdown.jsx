// The Markdown renderer for an Agent's text: its own chunk, loaded the first time an Agent's message is shown
// (AgentChatBits.jsx). The text comes from a model that anything in the conversation can steer, and it is shown in the
// reader's signed-in page, so it is treated as hostile. In this order:
//   1. No raw HTML is parsed: it is shown as text.
//   2. Only the elements the Markdown pipeline makes are kept, each with only its own attributes: nothing gets an id, a
//      name, a handler or a style from the text (KaTeX's own layout styles, inside KaTeX's output only).
//   3. Every href goes through `safeHref`: an absolute http(s) URL, or the link is shown as its text.
//   4. An image is never an <img>: its alt text (or its URL) is a link to it, by rule 3. Nothing is ever fetched.
//   5. Every link opens a new tab, with rel="noopener noreferrer nofollow", its real address as its tooltip.
//   6. The caller wraps this in an error boundary that shows the plain text instead, and shows a text too big or too
//      deep (markdownLimits.js) plain without trying.
// And the work a text can cause is bounded: table cells, formulas, maths output and maths time (below).
import React, { memo, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import katex from "katex";
import { fromHtmlIsomorphic } from "hast-util-from-html-isomorphic";
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
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import shell from "highlight.js/lib/languages/shell";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import "katex/dist/katex.min.css";

/** An absolute http(s) URL without a user name or password as the link's href, or null: the link is then its text. */
export function safeHref(value) {
  if (typeof value !== "string") return null;
  let url;
  try {
    url = new URL(value.trim()); // no base: a relative or protocol-relative URL is not a link here
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return url.username || url.password ? null : url.href;
}

const classesOf = (node) => (Array.isArray(node?.properties?.className) ? node.properties.className.map(String) : []);
const textOf = (node) => (node.children ?? []).map((child) => (child.type === "text" ? child.value : textOf(child))).join("");
const codeIn = (pre) => pre.children.find((child) => child.type === "element" && child.tagName === "code");
function remember(cache, key, value, max) {
  if (cache.size >= max) cache.delete(cache.keys().next().value);
  cache.set(key, value);
}
/**
 * Typeset formulas and highlighted code are kept by their source and used again as they are (a reply being written
 * re-renders on every piece). Frozen, so nothing can change them: the allow-list below builds the shown tree afresh.
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

// ───────── after parsing: limits on the tree

/** How deeply the parsed text may nest (emphasis in emphasis…, which markdownLimits.js cannot see in the raw text). */
const TREE_DEPTH_MAX = 100;
/** Table cells in one text, counted as the rendered table has them: every row padded to the delimiter row's width. */
export const CELLS_MAX = 5000;
/** A formula or maths block longer than this is shown as code, not typeset. */
const MATH_MAX = 2000;
/** Formulas typeset in one text; the ones after are shown as code (KaTeX's output is large). */
const MATH_COUNT_MAX = 500;
/** A formula that defines macros (or uses a macro parameter) is shown as code: a macro can multiply its output. */
const MACRO_DEFINITION = /\\(?:def|gdef|edef|xdef|let|futurelet|newcommand|renewcommand|providecommand|global)(?![A-Za-z@])|#/;
/** A fence line's marker: `$$`, ``` or ~~~ (after any quote markers and indentation). */
const FENCE = /^(\${2,}|`{3,}|~{3,})/;
const CONTAINER_PREFIX = /^[ \t>]*/;

function tooDeep(tree) {
  const stack = [[tree, 0]];
  while (stack.length > 0) {
    const [node, depth] = stack.pop();
    if (depth > TREE_DEPTH_MAX) return true;
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

/** Whether a maths block or ```math fence has its closing fence (one still open at the end of the text has not). */
function closed(node, source) {
  const start = node.position?.start?.offset;
  const end = node.position?.end?.offset;
  if (start === undefined || end === undefined) return true;
  const lines = source.slice(start, end).split("\n");
  const fence = FENCE.exec(lines[0].replace(CONTAINER_PREFIX, ""))?.[1];
  if (!fence || lines.length < 2) return false;
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
 * The first step after parsing. A text that nests too deeply, or whose tables would have more than CELLS_MAX cells, is
 * shown as its plain text. A maths block still open at the end (a reply being written) is shown as its plain text until
 * it closes. Maths that is too long, beyond the count, or that defines macros becomes code before KaTeX sees it.
 */
function remarkLimits() {
  return (tree, file) => {
    const source = String(file.value);
    if (tooDeep(tree) || cellsIn(tree) > CELLS_MAX) {
      tree.children = [plainParagraph(source)];
      return;
    }
    let formulas = 0;
    const walk = (node) => {
      if (!Array.isArray(node.children)) return;
      node.children = node.children.flatMap((child) => {
        if (child.type === "text") return withBreaks(child);
        const block = child.type === "math" || (child.type === "code" && child.lang === "math");
        if (!block && child.type !== "inlineMath") {
          walk(child);
          return [child];
        }
        if (block && !closed(child, source)) return [plainParagraph(source.slice(child.position.start.offset, child.position.end.offset))];
        formulas += 1;
        if (child.value.length <= MATH_MAX && formulas <= MATH_COUNT_MAX && !MACRO_DEFINITION.test(child.value)) return [child];
        return [block ? { type: "code", lang: null, meta: null, value: child.value } : { type: "inlineCode", value: child.value }];
      });
    };
    walk(tree);
  };
}

// ───────── maths

/** (Maths KaTeX cannot read is shown as its source, in the muted text colour rather than an alarming red.) */
const KATEX = { throwOnError: false, strict: false, trust: false, maxExpand: 300, maxSize: 50, errorColor: "var(--ink-2)" };
/** KaTeX output longer than this (as HTML) is discarded: the formula is shown as code. */
export const KATEX_OUTPUT_MAX = 100000;
/** KaTeX time for one text, in milliseconds: past it, the text's remaining formulas are shown as code (this time). */
const KATEX_BUDGET_MS = 150;
/** A formula that alone takes longer than this is never typeset again: shown while its result is kept, else as code. */
const KATEX_SLOW_MS = 50;
/** Typeset formulas by display mode and source; formulas not to typeset again (failed, too big, too slow). */
const typeset = new Map();
const refused = new Map();
const KATEX_KEPT = MATH_COUNT_MAX;

/** A formula in the tree: inline `<code class="math-inline">`, or a block's `<pre>` around `<code class="language-math">`. */
function formulaOf(node) {
  if (node.tagName === "code" && classesOf(node).includes("math-inline")) return { tex: textOf(node), display: false };
  const code = node.tagName === "pre" ? codeIn(node) : null;
  if (code && classesOf(code).includes("language-math")) return { tex: textOf(code), display: true };
  return null;
}

const codeElement = (text) => ({ type: "element", tagName: "code", properties: {}, children: [{ type: "text", value: text }] });
const formulaAsCode = ({ tex, display }) => (display ? { type: "element", tagName: "pre", properties: {}, children: [codeElement(tex)] } : codeElement(tex));

/** One formula typeset, as a tree; null when KaTeX failed or its output is over KATEX_OUTPUT_MAX. */
function typesetOne({ tex, display }) {
  let html;
  try {
    html = katex.renderToString(tex, { ...KATEX, displayMode: display });
  } catch {
    return null;
  }
  if (html.length > KATEX_OUTPUT_MAX) return null;
  return fromHtmlIsomorphic(html, { fragment: true }).children;
}

// KaTeX's first typeset sets itself up (font metrics and more): done as this chunk loads, not charged to a reply.
typesetOne({ tex: "x", display: false });

/**
 * Typesets every formula with KaTeX, within a time budget per text. A typeset runs to its end once started (it cannot be
 * interrupted): the static rules (length, count, no macro definitions, maxExpand) and the output cap are what protect a
 * formula's first typeset; the budget protects everything after it (the text's other formulas, and the next pieces of
 * a reply being written: a typeset formula is kept and used again, one that failed, was too big or too slow is never
 * typeset again).
 */
function rehypeKatexBudgeted() {
  return (tree) => {
    let spent = 0;
    const walk = (parent) => {
      parent.children = parent.children.flatMap((node) => {
        if (node.type !== "element") return [node];
        const formula = formulaOf(node);
        if (!formula) {
          walk(node);
          return [node];
        }
        const key = `${formula.display ? "block" : "inline"}\n${formula.tex}`;
        const known = typeset.get(key);
        if (known) return known;
        if (refused.has(key) || spent > KATEX_BUDGET_MS) return [formulaAsCode(formula)];
        const started = performance.now();
        const result = typesetOne(formula);
        const took = performance.now() - started;
        spent += took;
        if (!result || took > KATEX_SLOW_MS) remember(refused, key, true, KATEX_KEPT);
        if (!result) return [formulaAsCode(formula)];
        remember(typeset, key, frozen(result), KATEX_KEPT);
        return result;
      });
    };
    walk(tree);
  };
}

// ───────── code

/** The languages highlighted; any other (or none, or a diagram such as mermaid) is plain code. */
const lowlight = createLowlight({ bash, c, cpp, css, diff, go, java, javascript, json, markdown, python, rust, shell, sql, typescript, xml, yaml });
/** Code longer than this is not highlighted. */
const CODE_MAX = 20000;
const highlighted = new Map();
const HIGHLIGHTED_MAX = 100;

/** Highlights every `<pre><code class="language-…">` of a known language, from the cache when it was highlighted before. */
function rehypeHighlightCached() {
  const walk = (parent) => {
    for (const node of parent.children) {
      if (node.type !== "element") continue;
      if (node.tagName === "pre") highlightBlock(node);
      else walk(node);
    }
  };
  return walk;
}

function highlightBlock(pre) {
  const code = codeIn(pre);
  const language = classesOf(code).find((name) => name.startsWith("language-"))?.slice("language-".length);
  if (!language || !lowlight.registered(language)) return;
  const source = textOf(code);
  if (source.length > CODE_MAX) return;
  const key = `${language}\n${source}`;
  let done = highlighted.get(key);
  if (!done) {
    const { children } = lowlight.highlight(language, source, { prefix: "hljs-" });
    done = frozen({ type: "element", tagName: "code", properties: { className: ["hljs", ...classesOf(code)] }, children });
    remember(highlighted, key, done, HIGHLIGHTED_MAX);
  }
  pre.children = pre.children.map((child) => (child === code ? done : child));
}

// ───────── the allow-list (rules 2–5)

/** The elements the Markdown pipeline makes, outside KaTeX, and the attributes each keeps (hast property names). */
const ELEMENTS = new Map(
  Object.entries({
    p: [], h1: [], h2: [], h3: [], h4: [], h5: [], h6: [], ul: [], ol: ["start"], li: [], blockquote: [], hr: [], br: [],
    pre: [], code: [], em: [], strong: [], del: [], sup: [], span: [], section: [],
    table: [], thead: [], tbody: [], tr: [], th: ["align"], td: ["align"], a: ["href"],
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
/**
 * The classes the app's own stylesheet (styles.css) styles: one in KaTeX's output would take the app's look (KaTeX's
 * `\tag` makes a `tag`). Dropped there. tests/markdown.test.jsx checks this list against styles.css.
 */
export const APP_CLASSES = new Set(
  `active app apply-box approvals attachment-image auth-card auth-foot auth-form auth-head auth-page auth-submit avatar
  avatar-dot avatar-editor avatar-fallback avatar-img back badge blocker boxed brand-mark brand-name btn btn-danger
  btn-primary btn-sm btn-text bubble card card-actions card-head card-title chat chat-head chat-head-actions chat-search
  chat-title check checks compact composer composer-hint composer-input composer-resize composer-row composer-tools
  current device-rows device-static disc-actions disc-bar disc-text document-address document-label document-preview
  document-tools done dots dropping emoji-grid emoji-heading emoji-picker emoji-tabs empty-main exp-block exp-candidate
  exp-footer exp-meta exp-new eyebrow failed field field-error field-hint field-label field-msg file-card flash footnotes
  form-actions group-avatar grow head-actions human-input icon-btn identity-line info-lines inline kv kv-row lead
  list-col list-head list-note list-title main-col md md-code md-copy md-plain md-table member-actions member-body
  member-rows mention-empty mention-heading mention-picker menu menu-anchor messages mine mini-kv modal modal-backdrop
  modal-body modal-foot modal-head msg msg-action msg-divider msg-foot msg-main msg-meta msg-system muted n2 n3 n4 notice
  notice-actions notice-body notice-ok notice-pause notice-sub notice-warn only-mobile order-list owner pad page page-body
  pills plain-list profile-head proposal-persona quick-bar radio-cards rail rail-bottom rail-icon rail-item rail-me
  rail-nav readonly reason receipt rel-rows reply-chip row row-actions row-body row-name row-preview row-sub row-top rows
  rows-empty rows-label screen screen-bar screen-body screen-human search send settings-me share-items side side-body
  side-col side-head side-hero side-list slim spacer sr-only stack-actions steps tag tag-human tag-muted tag-ok
  tag-pending tag-row tag-solid tag-warn task-controls task-list-item theirs thinking thinking-text toast typed up
  upload-progress vis-banner`.split(/\s+/),
);
/** A style that could fetch or run something is dropped, KaTeX's or not (its own never does). */
const UNSAFE_STYLE = /url\s*\(|image|expression|@|\\|src\s*\(/i;
const ALLOWED_ELEMENTS = [...new Set([...ELEMENTS.keys(), ...KATEX_ELEMENTS])];

const isKatexRoot = (node) => node.tagName === "span" && classesOf(node).some((name) => name === "katex" || name === "katex-display" || name === "katex-error");

/** The last step: builds the shown tree afresh from what may be shown, and nothing else (it never changes its input). */
function rehypeAllowList() {
  return (tree) => {
    tree.children = cleanChildren(tree.children, { katex: false, link: false });
  };
}

function cleanChildren(children, within) {
  const out = [];
  for (const node of children ?? []) {
    if (node.type === "text" || node.type === "raw") {
      // Rule 1: raw HTML is text. (The line break after a <br> is that <br>'s own.)
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

/** The host a link's text claims when the text is itself an http(s) URL (or a www. address), else null. */
function claimedHost(text) {
  const shown = text.trim();
  try {
    const url = new URL(/^www\./i.test(shown) ? `http://${shown}` : shown);
    return url.protocol === "http:" || url.protocol === "https:" ? url.host : null;
  } catch {
    return null;
  }
}

/**
 * A link with a safe href, or its text alone (also inside another link, and for a footnote's in-page links). The text's
 * own title is dropped (the tooltip is the real address, Link). A text that is itself an address on another host is
 * followed by the real host, which touch screens show too.
 */
function link(node, within) {
  if (node.properties?.dataFootnoteBackref !== undefined) return [];
  const children = cleanChildren(node.children, { ...within, link: true });
  const href = within.link ? null : safeHref(node.properties?.href);
  if (!href) return children;
  const a = { type: "element", tagName: "a", properties: { href }, children };
  const claimed = claimedHost(textOf(a));
  const host = new URL(href).host;
  return claimed && claimed !== host ? [a, { type: "text", value: ` （实际指向 ${host}）` }] : [a];
}

/** An image is its alt text (or its URL when there is none), as a link to it: never an <img>, never fetched. */
function imageAsLink(node, within) {
  const src = typeof node.properties?.src === "string" ? node.properties.src : "";
  const alt = typeof node.properties?.alt === "string" ? node.properties.alt : "";
  const label = [{ type: "text", value: alt || src }];
  return link({ type: "element", tagName: "a", properties: { href: src }, children: label }, within);
}

/** KaTeX's element with KaTeX's attributes (not the app's classes); maths it could not read is its source. */
function katexElement(node) {
  if (!KATEX_ELEMENTS.has(node.tagName)) return [];
  const error = classesOf(node).includes("katex-error");
  const properties = {};
  for (const [name, value] of Object.entries(node.properties ?? {})) {
    if (!KATEX_ATTRIBUTES.has(name)) continue;
    if (name === "style" && (error || typeof value !== "string" || UNSAFE_STYLE.test(value))) continue;
    if (name === "className") {
      const classes = classesOf(node).filter((cls) => !APP_CLASSES.has(cls));
      if (classes.length > 0) properties.className = classes;
      continue;
    }
    properties[name] = Array.isArray(value) ? [...value] : value;
  }
  return [{ type: "element", tagName: node.tagName, properties, children: cleanChildren(node.children, { katex: true, link: false }) }];
}

/** react-markdown's own URL step, after ours: an href of a link that is safe, nothing else. */
const urlTransform = (url, key, node) => (key === "href" && node.tagName === "a" ? safeHref(url) : null);

// ───────── what the elements render as

/** Rule 5, checked once more where the element is made; the tooltip is the real address. */
function Link({ href, children }) {
  const safe = safeHref(href);
  if (!safe) return <>{children}</>;
  return (
    <a href={safe} title={safe} target="_blank" rel="noopener noreferrer nofollow">
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
/** Maths is `$$…$$` only (inline or as a block): a single `$` is text, so `$5 和 $10` stays a sentence. */
const REMARK = [remarkGfm, [remarkMath, { singleDollarTextMath: false }], remarkLimits];
const REHYPE = [rehypeKatexBudgeted, rehypeHighlightCached, rehypeAllowList];
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
