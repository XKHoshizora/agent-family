// What an Agent's text may be and still be rendered as Markdown. Checked on the raw text before anything parses it
// (and before the renderer's chunk is even asked for): a text beyond any limit is shown as plain text, as a person's is.
// Every count here errs on the side of plain text.

/** The whole text, in characters. */
export const MAX_CHARS = 50000;
/** Any one line, in characters. */
export const MAX_LINE = 10000;
/** Lines that may be table rows (any line with a `|` outside a code fence). */
export const MAX_TABLE_ROWS = 2000;
/** Nested lists and quotes: the markers that open a level, plus every two columns of indentation. */
export const MAX_DEPTH = 30;
/**
 * In one block of text (a paragraph, a list item, a table row…): its emphasis, link and maths characters
 * (`* _ ~ [ ] $`) times its length. The parser looks back over the block for each of those characters, so a block full
 * of them can take it many seconds; this much takes it well under a tenth of a second.
 */
export const MAX_INLINE_WORK = 5000000;

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const ORDERED_MARKER = /^\d{1,9}[.)]/;
const DELIMITERS = /[*_~[\]$]/g;
/** A line (after its quote markers) that starts a block of its own: a list item or a heading. */
const BLOCK_START = /^(?:[-+*](?:[ \t]|$)|\d{1,9}[.)](?:[ \t]|$)|#{1,6}(?:[ \t]|$))/;
const QUOTE_MARKERS = /^[ \t>]*/;
/** A table's delimiter row (`| --- | :-: |`), once trimmed: nothing else than these, and a dash. */
const TABLE_DELIMITER_ROW = /^[|:\- \t]+$/;
/** A table row's cells: its unescaped pipes, less one at each end. */
function cellsOf(row) {
  const trimmed = row.trim();
  let pipes = 0;
  for (let i = 0; i < trimmed.length; i += 1) if (trimmed[i] === "|" && trimmed[i - 1] !== "\\") pipes += 1;
  if (trimmed.startsWith("|")) pipes -= 1;
  if (trimmed.length > 1 && trimmed.endsWith("|") && !trimmed.endsWith("\\|")) pipes -= 1;
  return pipes + 1;
}
const ends = (line, i) => i >= line.length || line[i] === " " || line[i] === "\t";

/**
 * How deeply the line may nest: the `>` and list markers it starts with, and its indentation (a level per two
 * columns; the one space that belongs to a marker is not indentation).
 */
function depthOf(line) {
  let markers = 0;
  let columns = 0;
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    let marker = 0;
    if (ch === " ") {
      columns += 1;
    } else if (ch === "\t") {
      columns += 4;
    } else if (ch === ">" || ((ch === "-" || ch === "+" || ch === "*") && ends(line, i + 1))) {
      marker = 1;
    } else {
      const ordered = ORDERED_MARKER.exec(line.slice(i, i + 11));
      if (!ordered || !ends(line, i + ordered[0].length)) break;
      marker = ordered[0].length;
    }
    if (marker === 0) {
      i += 1;
      continue;
    }
    markers += 1;
    i += marker;
    if (line[i] === " " || line[i] === "\t") i += 1;
  }
  return markers + Math.floor(columns / 2);
}

/** Whether `text` is small and shallow enough to be rendered as Markdown. */
export function fitsMarkdown(text) {
  if (typeof text !== "string" || text.length > MAX_CHARS) return false;
  let tableRows = 0;
  /** The open code fence's marker (``` or ~~~, at least as long), or null outside one. */
  let fence = null;
  /** The current block's length and its emphasis and link characters; whether it is a table (each row a block). */
  let blockLength = 0;
  let blockDelimiters = 0;
  let table = false;
  let previous = "";
  for (const line of text.split("\n")) {
    if (line.length > MAX_LINE) return false;
    const marker = FENCE.exec(line)?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = null;
      continue;
    }
    const before = previous;
    previous = line;
    if (marker) {
      fence = marker;
      blockLength = 0;
      blockDelimiters = 0;
      table = false;
      continue;
    }
    if (line.includes("|") && ++tableRows > MAX_TABLE_ROWS) return false;
    if (depthOf(line) > MAX_DEPTH) return false;
    // Blocks, roughly as the parser cuts them; where unsure, two blocks are counted as one (more work, not less).
    const content = line.replace(QUOTE_MARKERS, "");
    const blank = content.trim() === "";
    const starts = BLOCK_START.test(content);
    if (table) table = !blank && !starts && line.includes("|") && !/^ {0,3}>/.test(line);
    else table = before.includes("|") && content.includes("-") && TABLE_DELIMITER_ROW.test(content.trim()) && cellsOf(content) === cellsOf(before.replace(QUOTE_MARKERS, ""));
    if (blank || starts || table) {
      blockLength = 0;
      blockDelimiters = 0;
    }
    blockLength += line.length + 1;
    blockDelimiters += line.match(DELIMITERS)?.length ?? 0;
    if (blockLength * blockDelimiters > MAX_INLINE_WORK) return false;
  }
  return true;
}
