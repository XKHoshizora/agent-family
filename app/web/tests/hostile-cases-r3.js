// Hostile texts of the third review (rr3 cases.mjs, copied verbatim below this header; all under 50 000 characters).
// Each is rendered by tests/markdown-hostile.test.jsx: its outcome class, and for the slow ones that the main thread
// gives up on them.
const lines = (unit, lineLen, total) => {
  const line = unit.repeat(Math.ceil(lineLen / unit.length)).slice(0, lineLen);
  const count = Math.floor((total + 1) / (lineLen + 1));
  return Array.from({ length: count }, () => line).join("\n");
};
const fence = (lang, body) => "```" + lang + "\n" + body + "\n```";
const fitTo = (unit, max) => unit.repeat(Math.floor(max / unit.length));
/** Paragraph lines, each starting with a word (so no line starts an HTML block), each <= lineLen. */
const para = (unit, lineLen, total, lead = "a ") => {
  const body = lead + unit.repeat(Math.ceil((lineLen - lead.length) / unit.length));
  const line = body.slice(0, lineLen);
  const count = Math.floor((total + 1) / (lineLen + 1));
  return Array.from({ length: count }, () => line).join("\n");
};
/** Backtick runs of distinct lengths 1..k, separated by a letter, ascending (each opener scans to the end). */
function distinctRuns(ch, max) {
  let out = "a ";
  for (let k = 1; out.length + k + 1 < max; k += 1) out += ch.repeat(k) + "a";
  return out;
}

export const CASES = {
  // highlighting: the xml grammar (html, svg, xhtml… are its aliases) on short lines of <script>
  hl_html_script_160: () => fence("html", lines("<script>", 160, 10000)),
  hl_xml_script_160: () => fence("xml", lines("<script>", 160, 10000)),
  hl_svg_script_80: () => fence("svg", lines("<script>", 80, 10000)),
  hl_html_script_x4: () => [0, 1, 2, 3].map((i) => fence("html", `${i}\n` + lines("<script>", 160, 9990))).join("\n\n"),
  hl_c_case_80: () => fence("c", lines("case ", 80, 10000)),
  hl_cpp_def_80: () => fence("cpp", lines("def ", 80, 10000)),
  hl_shell_dollar_80: () => fence("shell", lines("${", 80, 10000)),
  // micromark inline: raw HTML is not rendered, but it is tokenised
  md_html_comment: () => para("<!--", 9990, 49990),
  md_html_pi: () => para("<?", 9990, 49990),
  md_html_decl: () => para("<!A", 9990, 49990),
  md_html_attr_dq: () => para('<a b="', 9990, 49990),
  md_html_attr_sq: () => para("<a b='", 9990, 49990),
  md_html_open: () => para("<a ", 9990, 49990),
  md_backticks: () => {
    // one paragraph of soft-broken lines (no line over 10 000)
    const flat = distinctRuns("`", 49900);
    return flat.match(/[^]{1,9000}/g).join("\n");
  },
  md_dollars: () => {
    const flat = distinctRuns("$", 49900);
    return flat.match(/[^]{1,9000}/g).join("\n");
  },
  md_tildes: () => {
    const flat = distinctRuns("~", 49900);
    return flat.match(/[^]{1,9000}/g).join("\n");
  },
  md_lt_autolink: () => para("<a:", 9990, 49990),
  md_entities: () => para("&#x", 9990, 49990),
  md_backslash: () => para("\\", 9990, 49990),
  md_ref_title: () => Array.from({ length: 1 }, () => `[a]: b "` + "\n" + lines("x", 9000, 49000)).join(""),
  md_setext: () => Array.from({ length: 2000 }, () => "a\n=").join("\n"),
  md_lists_flat: () => fitTo("- a\n", 49990),
  md_lists_nest: () => Array.from({ length: 1700 }, (_, i) => `${"  ".repeat(i % 15)}- a`).join("\n"),
  md_quote_lazy: () => Array.from({ length: 2400 }, (_, i) => `${"> ".repeat(i % 15)}a`).join("\n"),
  md_table_pipeless: () => `${"|a".repeat(990)}|\n${"|-".repeat(990)}|\n${"x\n".repeat(22500)}`,
  md_footnote_defs_400: () => Array.from({ length: 1200 }, (_, i) => `x[^${i}]\n\n[^${i}]: y`).join("\n\n"),
  md_em_under: () => Array.from({ length: 22 }, () => fitTo("*a* ", 2230)).join("\n\n"),
};
// R5: fences the pre-parse scan does not see as fences (inside list items and quotes)
CASES.md_fence_in_list = () => Array.from({ length: 1500 }, (_, i) => `- \`\`\`js\n  let a${i} = 1;\n  \`\`\``).join("\n").slice(0, 49990);
CASES.md_fence_in_quote = () => Array.from({ length: 1400 }, (_, i) => `> \`\`\`js\n> let a${i} = 1;\n> \`\`\``).join("\n\n").slice(0, 49990);
// deep nesting within the gate (lines <= 500, block <= 10 000)
CASES.hl_js_tpl_deep = () => "```js\n" + lines("`${", 498, 10000) + "\n```";
CASES.hl_shell_tpl_deep = () => "```shell\n" + lines("`${", 498, 10000) + "\n```";
CASES.hl_rust_cmt_deep = () => "```rust\n" + lines("/*", 500, 10000) + "\n```";
CASES.hl_bash_deep = () => "```bash\n" + lines("$(", 500, 10000) + "\n```";
CASES.hl_ts_deep = () => "```ts\n" + lines("`${", 498, 10000) + "\n```";
