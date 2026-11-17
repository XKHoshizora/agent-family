// The main thread's side of an Agent's rendered text, before React sees any of it: the tree the Markdown worker sent
// back is treated as untrusted data and checked against the same allow-list the worker applied (markdownRules.js), in
// one iterative walk over a capped size (so its cost is bounded however the tree is made): tags from a fixed set,
// props from a fixed set with typed values, every href re-checked by `safeHref`, class names from the fixed patterns,
// no link in a link, at most TREE_ELEMENTS elements, nothing deeper than TREE_DEPTH. Any failure: the whole text is
// shown plain. And where a link goes: the host shown after its text (`linkHost`).
import {
  ALIGN, APP_CLASSES, CLASS, ELEMENTS, KATEX_CLASS, KATEX_ELEMENTS, KATEX_REACT_PROPS, TREE_DEPTH, TREE_ELEMENTS, isKatexRootClass,
  safeHref, styleAllowed,
} from "./markdownRules.js";

/** All nodes (elements and texts), and all their characters (texts and prop values), that one tree may have. */
const MAX_NODES = 4 * TREE_ELEMENTS;
const MAX_CHARS = 400000;
/** One prop value's characters (KaTeX's SVG paths are the long ones). */
const MAX_PROP_CHARS = 20000;
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
  const entries = Object.entries(style);
  return entries.length > 0 && entries.length <= 20 && entries.every(([name, value]) => styleAllowed(name, value));
}

/** Whether one element's props are those its tag may have, outside or inside KaTeX's output. */
function propsOk(tag, props, katex) {
  if (props === undefined) return true;
  if (!isPlainObject(props)) return false;
  for (const [name, value] of Object.entries(props)) {
    if (name === "className") {
      if (!classesOk(value, katex ? katexClass : outsideKatexClass)) return false;
    } else if (katex) {
      if (name === "style" ? !styleOk(value) : !KATEX_REACT_PROPS.has(name) || typeof value !== "string" || value.length > MAX_PROP_CHARS) return false;
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

/**
 * Checks a tree from the worker. `{ ok: true, elements, rendered }` (`rendered`: the elements it will make in the page,
 * the wrappers React adds included, and the `.md` root), or `{ ok: false }`. Never recursive; stops at the first fault.
 */
export function validateTree(tree, { maxElements = TREE_ELEMENTS, maxDepth = TREE_DEPTH } = {}) {
  if (!Array.isArray(tree) || tree.length > MAX_NODES) return { ok: false };
  let nodes = 0;
  let elements = 0;
  let rendered = 1;
  let chars = 0;
  // [node, depth, inside KaTeX's output, inside a link]
  const stack = [];
  for (let i = tree.length - 1; i >= 0; i -= 1) stack.push([tree[i], 1, false, false]);
  while (stack.length > 0) {
    const [node, depth, inKatex, inLink] = stack.pop();
    if (++nodes > MAX_NODES) return { ok: false };
    if (typeof node === "string") {
      chars += node.length;
      if (chars > MAX_CHARS) return { ok: false };
      continue;
    }
    if (!isPlainObject(node) || Object.keys(node).some((key) => !NODE_KEYS.has(key))) return { ok: false };
    if (++elements > maxElements || depth > maxDepth) return { ok: false };
    const { tag, props, children } = node;
    if (typeof tag !== "string") return { ok: false };
    const classes = Array.isArray(props?.className) ? props.className : [];
    const katex = inKatex || (tag === "span" && classes.some(isKatexRootClass));
    if (katex ? !KATEX_ELEMENTS.has(tag) : !ELEMENTS.has(tag)) return { ok: false };
    if (tag === "a" && (inLink || katex)) return { ok: false };
    if (!propsOk(tag, props, katex)) return { ok: false };
    chars += propChars(props);
    if (chars > MAX_CHARS) return { ok: false };
    rendered += 1 + (katex ? 0 : ADDED[tag] ?? 0);
    if (children === undefined) continue;
    if (!Array.isArray(children) || children.length === 0 || nodes + stack.length + children.length > MAX_NODES) return { ok: false };
    for (let i = children.length - 1; i >= 0; i -= 1) stack.push([children[i], depth + 1, katex, inLink || tag === "a"]);
  }
  return { ok: true, elements, rendered };
}

// ───────── where a link goes

/** Characters that do not show as themselves: format and control characters, marks, separators, ignorables. */
const UNSEEN = /[\p{Cf}\p{Cc}\p{Mn}\p{Me}\p{Z}\p{Default_Ignorable_Code_Point}]/gu;
/** Text as compared with an address: without what does not show, compatibility forms folded, lower case. */
const normalised = (text) => text.replace(UNSEEN, "").normalize("NFKC").replace(UNSEEN, "").toLowerCase();
/** The longest host shown after a link; a longer one is cut at its start (its registrable end is what matters). */
const HOST_SHOWN_MAX = 40;

/** The host a link's note shows: the parsed target's (Punycode, port kept), without a leading `www.`, its end kept. */
export function shownHost(href) {
  const host = new URL(href).host.replace(/^www\./, "");
  return host.length > HOST_SHOWN_MAX ? `…${host.slice(-(HOST_SHOWN_MAX - 1))}` : host;
}

/**
 * Where a link goes, as it is shown: `{ label, host }` — `label` replaces a text that shows nothing (the address itself
 * then), and `host` (null when the text already is the address) is shown after the text in a muted note. Every other
 * link shows its real host, whatever its text says: nothing is detected, so nothing can be forged.
 */
export function linkHost(text, href) {
  const url = new URL(href);
  const shown = normalised(text);
  if (shown === "") return { label: href, host: null };
  const host = url.host.toLowerCase();
  const bare = host.replace(/^www\./, "");
  const forms = new Set([href, host, bare, `www.${bare}`]);
  if (url.pathname === "/" && !url.search && !url.hash) forms.add(href.slice(0, -1));
  try {
    forms.add(decodeURI(href));
  } catch {
    /* not decodable: the encoded form only */
  }
  for (const form of forms) if (normalised(form) === shown) return { label: null, host: null };
  return { label: null, host: shownHost(href) };
}
