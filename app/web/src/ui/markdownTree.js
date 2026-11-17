// The main thread's side of an Agent's rendered text, before React sees any of it: the tree the Markdown worker sent
// back is treated as untrusted data and checked against the same allow-list the worker applied (markdownRules.js), in
// one iterative walk over a capped size (so its cost is bounded however the tree is made): tags from a fixed set,
// props from a fixed set with typed values, every href re-checked by `safeHref`, class names from the fixed patterns,
// a link's content exactly one text, at most TREE_ELEMENTS elements, nothing deeper than TREE_DEPTH. Any failure: the
// whole text is shown plain. A string holding a bidirectional control is not trusted either: it is cleaned, in place.
// And where a link goes: the host shown after its text (`linkNote`).
import {
  ALIGN, APP_CLASSES, CLASS, ELEMENTS, KATEX_CLASS, KATEX_ELEMENTS, KATEX_REACT_PROPS, TREE_DEPTH, TREE_ELEMENTS, hasBidiControls,
  isKatexRootClass, safeHref, styleAllowed, withoutBidiControls,
} from "./markdownRules.js";

/** All nodes (elements and texts), and all their characters (texts and prop values), that one tree may have. */
const MAX_NODES = 4 * TREE_ELEMENTS;
const MAX_CHARS = 400000;
/** One prop value's characters (KaTeX's SVG paths are the long ones). */
const MAX_PROP_CHARS = 20000;
/** The props one element may have (KaTeX's has the most names), and the declarations of one style: counted first. */
const MAX_PROPS = 50;
const MAX_STYLES = 20;
/** Elements the React side adds around some: a link's wrapper and host note, a code block's frame and 复制, a table's frame. */
const ADDED = { a: 2, pre: 2, table: 1 };

const isPlainObject = (value) => value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
const NODE_KEYS = new Set(["tag", "props", "children"]);

/** A `className` prop: an array of class names, each passing `test`. */
const classesOk = (value, test) => Array.isArray(value) && value.length > 0 && value.length <= 20 && value.every((name) => typeof name === "string" && test(name));
const outsideKatexClass = (name) => CLASS.test(name);
const katexClass = (name) => KATEX_CLASS.test(name) && !APP_CLASSES.has(name);

function styleOk(style) {
  if (!isPlainObject(style)) return false;
  const names = Object.keys(style);
  return names.length > 0 && names.length <= MAX_STYLES && names.every((name) => styleAllowed(name, style[name]));
}

/**
 * Whether one element's props are those its tag may have, outside or inside KaTeX's output: their number first, then
 * each. A bidirectional control in a value that may be any text (KaTeX's) is taken out of it.
 */
function propsOk(tag, props, katex) {
  if (props === undefined) return true;
  if (!isPlainObject(props)) return false;
  const names = Object.keys(props);
  if (names.length > MAX_PROPS) return false;
  for (const name of names) {
    const value = props[name];
    if (name === "className") {
      if (!classesOk(value, katex ? katexClass : outsideKatexClass)) return false;
    } else if (katex) {
      if (name === "style" ? !styleOk(value) : !KATEX_REACT_PROPS.has(name) || typeof value !== "string" || value.length > MAX_PROP_CHARS) return false;
      if (name !== "style" && hasBidiControls(value)) props[name] = withoutBidiControls(value);
    } else if (!ELEMENTS.get(tag).includes(name)) {
      return false;
    } else if (name === "href" ? safeHref(value) !== value : name === "align" ? !ALIGN.has(value) : name === "start" ? !Number.isSafeInteger(value) : true) {
      return false;
    }
  }
  return true;
}

const propChars = (props) => {
  let chars = 0;
  for (const value of Object.values(props ?? {})) chars += typeof value === "string" ? value.length : Array.isArray(value) ? value.join(" ").length : 0;
  return chars;
};

/** Takes bidirectional controls out of the texts of a list of children, in place. */
function cleanTexts(children) {
  for (let i = 0; i < children.length; i += 1) {
    if (typeof children[i] === "string" && hasBidiControls(children[i])) children[i] = withoutBidiControls(children[i]);
  }
}

/**
 * Checks a tree from the worker. `{ ok: true, elements, rendered, chars }` (`rendered`: the elements it will make in
 * the page, the wrappers React adds included, and the `.md` root; `chars`: the characters of its texts and prop
 * values), or `{ ok: false }`. Never recursive; stops at the first fault; every count is checked before what it counts
 * is read. Strings holding bidirectional controls are cleaned in the tree itself (a tree that cannot be written to is
 * refused).
 */
export function validateTree(tree, options) {
  try {
    return checkTree(tree, options);
  } catch {
    return { ok: false };
  }
}

function checkTree(tree, { maxElements = TREE_ELEMENTS, maxDepth = TREE_DEPTH } = {}) {
  if (!Array.isArray(tree) || tree.length > MAX_NODES) return { ok: false };
  let nodes = 0;
  let elements = 0;
  let rendered = 1;
  let chars = 0;
  // [node, depth, inside KaTeX's output]
  const stack = [];
  cleanTexts(tree);
  for (let i = tree.length - 1; i >= 0; i -= 1) stack.push([tree[i], 1, false]);
  while (stack.length > 0) {
    const [node, depth, inKatex] = stack.pop();
    if (++nodes > MAX_NODES) return { ok: false };
    if (typeof node === "string") {
      chars += node.length;
      if (chars > MAX_CHARS) return { ok: false };
      continue;
    }
    if (!isPlainObject(node)) return { ok: false };
    const keys = Object.keys(node);
    if (keys.length > NODE_KEYS.size || keys.some((key) => !NODE_KEYS.has(key))) return { ok: false };
    if (++elements > maxElements || depth > maxDepth) return { ok: false };
    const { tag, props, children } = node;
    if (typeof tag !== "string") return { ok: false };
    const classes = Array.isArray(props?.className) ? props.className : [];
    const katex = inKatex || (tag === "span" && classes.some(isKatexRootClass));
    if (katex ? !KATEX_ELEMENTS.has(tag) : !ELEMENTS.has(tag)) return { ok: false };
    if (!propsOk(tag, props, katex)) return { ok: false };
    chars += propChars(props);
    if (chars > MAX_CHARS) return { ok: false };
    rendered += 1 + (katex ? 0 : ADDED[tag] ?? 0);
    // A link's content is exactly one text: no element (so no maths, no line break, no link) can be inside one.
    if (tag === "a" && (katex || !Array.isArray(children) || children.length !== 1 || typeof children[0] !== "string")) return { ok: false };
    if (children === undefined) continue;
    if (!Array.isArray(children) || children.length === 0 || nodes + stack.length + children.length > MAX_NODES) return { ok: false };
    cleanTexts(children);
    for (let i = children.length - 1; i >= 0; i -= 1) stack.push([children[i], depth + 1, katex]);
  }
  return { ok: true, elements, rendered, chars };
}

// ───────── where a link goes

/** The longest host shown after a link; a longer one is cut at its start (its registrable end is what matters). */
const HOST_SHOWN_MAX = 40;

/** The host a link's note shows: the parsed target's (Punycode, port kept), without a leading `www.`, its end kept. */
export function shownHost(href) {
  const host = new URL(href).host.replace(/^www\./, "");
  return host.length > HOST_SHOWN_MAX ? `…${host.slice(-(HOST_SHOWN_MAX - 1))}` : host;
}

/** Printable ASCII only, no space: what a text that is exactly an address is made of. */
const PRINTABLE_ASCII = /^[!-~]+$/;

/**
 * The host shown after a link's text, or null for the one link that needs none: its text is printable ASCII and is
 * exactly its address, or its address without its one final `/`. The strings are compared as they are: nothing is
 * trimmed, folded, decoded or normalised, so no text can be made to "equal" an address it does not show.
 */
export function linkNote(text, href) {
  if (PRINTABLE_ASCII.test(text) && (text === href || (href.endsWith("/") && text === href.slice(0, -1)))) return null;
  return shownHost(href);
}
