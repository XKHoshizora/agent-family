// Safety check for the vendored lab logos (public/logos/labs/*.svg). They are shown only through <img src>, never
// inlined, but a file is still refused unless it is one plain <svg> document with nothing active in it.
// A failing file is rejected, never "fixed". Run `node scripts/check-logos.mjs [file-or-dir ...]` (default: the
// committed logos); the exit code is 1 when any file fails. tests/lab-logo.test.jsx runs `checkSvg` over every file.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MAX_BYTES = 20 * 1024;
export const LOGO_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "logos", "labs");

const FORBIDDEN_TAGS = new Set(["script", "foreignobject", "image", "iframe", "object", "embed", "audio", "video", "animate", "set", "animatetransform", "animatemotion"]);
const NAME = String.raw`[A-Za-z_][\w:.-]*`;
const TAG = new RegExp(String.raw`^<(/?)(${NAME})((?:\s+${NAME}(?:\s*=\s*(?:"[^"]*"|'[^']*'))?)*)\s*(/?)>$`);
const ATTR = new RegExp(String.raw`(${NAME})(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?`, "g");
const KNOWN_ENTITY = /&(?:amp|lt|gt|quot|apos|#\d{1,7}|#x[0-9a-fA-F]{1,6});/g;

/** Returns the list of problems with an SVG text (empty = accepted). `bytes` is the file's size on disk. */
export function checkSvg(text, bytes = Buffer.byteLength(String(text))) {
  const problems = [];
  if (typeof text !== "string") return ["not text"];
  if (bytes >= MAX_BYTES) problems.push(`too large (${bytes} bytes, limit ${MAX_BYTES})`);
  if (text.includes("\0")) problems.push("contains a NUL");
  if (/<!doctype|<!entity|<!\[cdata\[|<\?(?!xml\s)/i.test(text)) problems.push("contains a DOCTYPE, ENTITY, CDATA or processing instruction");
  if (/javascript\s*:/i.test(text)) problems.push("contains javascript:");
  if (/data\s*:/i.test(text)) problems.push("contains a data: URL");
  const bad = text.replace(KNOWN_ENTITY, "").match(/&/);
  if (bad) problems.push("contains an unknown or malformed entity");

  const body = text.replace(/^\uFEFF/, "").replace(/^\s*<\?xml[^>]*\?>/, "").replace(/<!--[\s\S]*?-->/g, "");
  if (body.includes("<!--") || body.includes("-->")) problems.push("malformed comment");

  const stack = [];
  let roots = 0;
  let inStyle = false;
  let pos = 0;
  while (pos < body.length) {
    const lt = body.indexOf("<", pos);
    const chunk = body.slice(pos, lt === -1 ? body.length : lt);
    if (inStyle) {
      if (/@import|url\s*\(/i.test(chunk)) problems.push("<style> with @import or url(");
    } else if (stack.length === 0 && chunk.trim() !== "") {
      problems.push("text outside the <svg> element");
    }
    if (lt === -1) break;
    const gt = body.indexOf(">", lt);
    if (gt === -1) { problems.push("unterminated tag"); break; }
    const raw = body.slice(lt, gt + 1);
    pos = gt + 1;
    const m = TAG.exec(raw);
    if (!m) { problems.push(`malformed tag ${raw.slice(0, 40)}`); continue; }
    const [, closing, name, attrs, selfClosing] = m;
    const tag = name.toLowerCase();
    if (closing) {
      if (stack.pop() !== name) problems.push(`mismatched </${name}>`);
      if (tag === "style") inStyle = false;
      continue;
    }
    if (stack.length === 0) {
      roots += 1;
      if (name !== "svg") problems.push(`root element is <${name}>, not <svg>`);
      if (roots > 1) problems.push("more than one root element");
    }
    if (FORBIDDEN_TAGS.has(tag)) problems.push(`forbidden element <${name}>`);
    if (tag === "style" && !selfClosing) inStyle = true;
    for (const a of attrs.matchAll(ATTR)) {
      const an = a[1].toLowerCase();
      const value = a[2] ?? a[3] ?? "";
      if (an.startsWith("on")) problems.push(`event attribute ${a[1]}`);
      if (an === "href" || an.endsWith(":href")) {
        if (!/^#[^\s#]+$/.test(value.trim())) problems.push(`${a[1]} that is not an internal #id`);
      }
      if (an === "style" && /@import|url\s*\(/i.test(value)) problems.push("style attribute with @import or url(");
      for (const u of value.matchAll(/url\s*\(\s*(['"]?)([^)]*)\1\s*\)/gi)) {
        if (!/^#[^\s#]+$/.test(u[2].trim())) problems.push(`${a[1]} with url() to something other than an internal #id`);
      }
    }
    if (!selfClosing) stack.push(name);
  }
  if (stack.length > 0) problems.push("unclosed element");
  if (roots !== 1) problems.push(`expected exactly one <svg> root, found ${roots}`);
  return [...new Set(problems)];
}

/** Checks files (a directory means its *.svg files). Returns { file, problems }[]. */
export function checkPaths(paths) {
  const files = [];
  for (const p of paths) {
    if (statSync(p).isDirectory()) {
      for (const f of readdirSync(p).sort()) files.push(path.join(p, f));
    } else files.push(p);
  }
  return files.map((file) => {
    const problems = [];
    if (!/^[a-z0-9]+\.svg$/.test(path.basename(file))) problems.push("file name is not <lowercase-id>.svg");
    const buf = readFileSync(file);
    problems.push(...checkSvg(buf.toString("utf8"), buf.length));
    return { file, problems };
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const results = checkPaths(args.length ? args : [LOGO_DIR]);
  for (const r of results) console.log(`${r.problems.length ? "FAIL" : "ok  "} ${path.basename(r.file)}${r.problems.length ? ": " + r.problems.join("; ") : ""}`);
  process.exitCode = results.some((r) => r.problems.length) ? 1 : 0;
}
