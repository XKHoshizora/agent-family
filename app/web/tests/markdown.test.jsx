// @vitest-environment jsdom
// An Agent's text is shown as Markdown, rendered by a renderer that treats it as hostile: the model writing it can be
// steered by anything in the conversation, and it is shown in the reader's signed-in page. Raw HTML is text, a URL is a
// link only when it is http(s), an image is never fetched, nothing gets an id, a handler or a style of its own, and a
// text too big (or too deep) to render safely is shown as plain text. A person's message is never Markdown.
import "./markdown-ready.js";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AgentText } from "../src/pages/AgentChatBits.jsx";
import { fitsMarkdown } from "../src/ui/markdownLimits.js";
import { safeHref } from "../src/ui/Markdown.jsx";
import { A1, AG1, D1, ME_ID, ANN, MODELS, PRINCIPALS, agentConv, agentOf, agentPrincipal, direct, syncOf, wire } from "./fixtures.js";
import { click, installBrowser, openApp } from "./harness.jsx";

/** Elements an Agent's text must never produce under its bubble. */
const FORBIDDEN = [
  "img", "script", "iframe", "style", "form", "base", "meta", "svg", "object", "embed", "link", "input", "textarea", "select",
  "button", "video", "audio", "source", "track", "frame", "frameset", "template", "noscript", "canvas", "picture", "area", "map",
];
const REL = ["noopener", "noreferrer", "nofollow"];

let spies;
let errors;
beforeEach(() => {
  Object.defineProperty(navigator, "sendBeacon", { value: vi.fn(() => true), configurable: true, writable: true });
  spies = {
    fetch: vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("no network here");
    }),
    xhr: vi.spyOn(XMLHttpRequest.prototype, "open"),
    image: vi.spyOn(window, "Image"),
    beacon: navigator.sendBeacon,
    open: vi.spyOn(window, "open").mockImplementation(() => null),
  };
  errors = vi.spyOn(console, "error");
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** The Agent's text in a bubble, as the conversation shows it. */
function show(text) {
  const { container } = render(
    <div className="bubble">
      <AgentText text={text} />
    </div>,
  );
  return container.firstChild;
}

/**
 * Everything the renderer must never let through, checked on the real DOM. The renderer's own 复制 buttons are allowed,
 * and (`katexSvg`) the SVG shapes KaTeX draws inside its own output, for texts that typeset such maths.
 */
function expectSafe(bubble, { katexSvg = false } = {}) {
  for (const tag of FORBIDDEN) {
    const own = (el) => (tag === "button" && el.matches(".md-code > button.md-copy")) || (tag === "svg" && katexSvg && el.closest(".katex") !== null);
    const found = [...bubble.querySelectorAll(tag)].filter((el) => !own(el));
    expect(found[0] ?? null, `<${tag}>`).toBeNull();
  }
  for (const el of bubble.querySelectorAll("*")) {
    for (const attr of el.attributes) {
      expect(attr.name.toLowerCase().startsWith("on"), `${el.tagName} ${attr.name}`).toBe(false);
      expect(["id", "name", "src", "srcset", "action", "formaction", "xlink:href", "background", "poster", "data"]).not.toContain(attr.name.toLowerCase());
    }
    if (el.hasAttribute("style")) {
      // Only KaTeX's own layout, and a table cell's alignment.
      const cellAlign = /^(TH|TD)$/.test(el.tagName) && /^text-align: (left|right|center);$/.test(el.getAttribute("style"));
      expect(cellAlign || el.closest(".katex") !== null, `style on ${el.tagName}: ${el.getAttribute("style")}`).toBe(true);
    }
  }
  for (const a of bubble.querySelectorAll("a")) {
    expect(a.getAttribute("href") ?? "", a.outerHTML).toMatch(/^https?:\/\//);
    expect(a.getAttribute("target")).toBe("_blank");
    const rel = (a.getAttribute("rel") ?? "").split(/\s+/);
    for (const word of REL) expect(rel, a.outerHTML).toContain(word);
  }
  expect(spies.fetch).not.toHaveBeenCalled();
  expect(spies.xhr).not.toHaveBeenCalled();
  expect(spies.image).not.toHaveBeenCalled();
  expect(spies.beacon).not.toHaveBeenCalled();
  expect(spies.open).not.toHaveBeenCalled();
  expect(errors).not.toHaveBeenCalled();
}

const md = (bubble) => bubble.querySelector(".md");
const hrefs = (bubble) => [...bubble.querySelectorAll("a")].map((a) => a.getAttribute("href"));

describe("what an Agent's Markdown renders to", () => {
  it("paragraphs, emphasis, strikethrough and inline code", () => {
    const bubble = show("第一段 *斜体* **粗体** ~~删掉~~ `code`\n\n第二段");
    expect(md(bubble)).not.toBeNull();
    expect(bubble.querySelectorAll("p")).toHaveLength(2);
    expect(bubble.querySelector("em").textContent).toBe("斜体");
    expect(bubble.querySelector("strong").textContent).toBe("粗体");
    expect(bubble.querySelector("del").textContent).toBe("删掉");
    expect(bubble.querySelector("p > code").textContent).toBe("code");
    expectSafe(bubble);
  });

  it("a paragraph keeps its line breaks (shown by styles.css), a hard break only once", () => {
    const bubble = show("第一行\n第二行\n\n甲\\\n乙");
    const [soft, hard] = bubble.querySelectorAll("p");
    expect(soft.textContent).toBe("第一行\n第二行");
    expect(hard.querySelector("br")).not.toBeNull();
    expect(hard.textContent).toBe("甲乙");
  });

  it("headings h1 to h6, with no id of their own", () => {
    const bubble = show("# 一\n## 二\n### 三\n#### 四\n##### 五\n###### 六");
    for (const [i, text] of ["一", "二", "三", "四", "五", "六"].entries()) expect(bubble.querySelector(`h${i + 1}`).textContent).toBe(text);
    expectSafe(bubble);
  });

  it("lists, nested lists and task lists (a box, never a form control)", () => {
    const bubble = show("- 甲\n- 乙\n  1. 一\n  2. 二\n\n- [x] 做完\n- [ ] 没做");
    expect(bubble.querySelectorAll("ul > li").length).toBeGreaterThanOrEqual(2);
    expect([...bubble.querySelectorAll("ol > li")].map((li) => li.textContent)).toEqual(["一", "二"]);
    expect(bubble.textContent).toContain("☑ 做完");
    expect(bubble.textContent).toContain("☐ 没做");
    expectSafe(bubble);
  });

  it("block quotes and rules", () => {
    const bubble = show("> 引用的话\n\n---\n\n后文");
    expect(md(bubble).querySelector("blockquote").textContent.trim()).toBe("引用的话");
    expect(bubble.querySelector("hr")).not.toBeNull();
    expectSafe(bubble);
  });

  it("a table, inside a horizontally scrolling wrapper", () => {
    const bubble = show("| 名称 | 数量 |\n|:--|--:|\n| 苹果 | 3 |\n| 梨 | 5 |");
    const table = bubble.querySelector(".md-table > table");
    expect(table).not.toBeNull();
    expect([...table.querySelectorAll("th")].map((th) => th.textContent)).toEqual(["名称", "数量"]);
    expect(table.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(table.querySelector("td").getAttribute("style")).toBe("text-align: left;");
    expectSafe(bubble);
  });

  it("a link opens in a new tab, without the opener or the referrer", () => {
    const bubble = show("看 [文档](https://docs.example/a?b=1#c \"说明\")");
    const a = bubble.querySelector("a");
    expect(a.textContent).toBe("文档");
    expect(a.getAttribute("href")).toBe("https://docs.example/a?b=1#c");
    expect(a.getAttribute("title")).toBe("说明");
    expectSafe(bubble);
  });

  it("autolinked www. and bare URLs are links like any other", () => {
    const bubble = show("见 www.example.com 和 https://bare.example/path 以及 <https://angle.example>");
    expect(hrefs(bubble)).toEqual(["http://www.example.com/", "https://bare.example/path", "https://angle.example/"]);
    expectSafe(bubble);
  });

  it("fenced code is highlighted for a known language, with a 复制 button", () => {
    const bubble = show("```js\nconst a = 1; // 注释\n```");
    const code = bubble.querySelector(".md-code pre > code");
    expect(code.textContent).toBe("const a = 1; // 注释\n");
    expect(code.querySelector(".hljs-keyword").textContent).toBe("const");
    expect(code.querySelector(".hljs-comment")).not.toBeNull();
    expect(screen.getByRole("button", { name: "复制" })).toBeTruthy();
    // (The copy button is the renderer's own control: the only button there may be.)
    expect(bubble.querySelectorAll("button")).toHaveLength(1);
  });

  it.each([
    ["ts", "const a: number = 1;"],
    ["tsx", "const a = <b />;"],
    ["jsx", "const a = <b />;"],
    ["json", '{"a": 1}'],
    ["html", "<div>x</div>"],
    ["xml", "<a>x</a>"],
    ["css", "a { color: red; }"],
    ["python", "def f(): pass"],
    ["bash", "echo hi"],
    ["shell", "$ echo hi"],
    ["sh", "echo hi"],
    ["sql", "SELECT 1;"],
    ["go", "func main() {}"],
    ["rust", "fn main() {}"],
    ["java", "class A {}"],
    ["c", "int main() {}"],
    ["cpp", "int main() {}"],
    ["yaml", "a: 1"],
    ["markdown", "# x"],
    ["diff", "+ a\n- b"],
  ])("highlights %s", (lang, source) => {
    const bubble = show(`\`\`\`${lang}\n${source}\n\`\`\``);
    expect(bubble.querySelector("pre > code").textContent).toBe(`${source}\n`);
    expect(bubble.querySelector("pre > code span[class^='hljs-']"), lang).not.toBeNull();
  });

  it.each(["mermaid", "plantuml", "kotlin", ""])("renders a %s fence (unknown, a diagram, or none) as plain code", (lang) => {
    const source = "graph TD\n  A-->B";
    const bubble = show(`\`\`\`${lang}\n${source}\n\`\`\``);
    const code = bubble.querySelector("pre > code");
    expect(code.textContent).toBe(`${source}\n`);
    expect(code.querySelector("span")).toBeNull();
    expect(bubble.querySelector("svg")).toBeNull();
  });

  it("复制 copies the code; a refused clipboard fails quietly", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    show("```python\nprint('hi')\n```");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "复制" })));
    expect(writeText).toHaveBeenCalledWith("print('hi')\n");
    expect(screen.getByRole("button", { name: "已复制" })).toBeTruthy();
    cleanup();

    Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn(async () => Promise.reject(new Error("denied"))) }, configurable: true });
    show("```\nx\n```");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "复制" })));
    expect(screen.getByRole("button", { name: "复制" })).toBeTruthy();
    cleanup();

    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    show("```\nx\n```");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "复制" })));
    expect(screen.getByRole("button", { name: "复制" })).toBeTruthy();
    expect(errors).not.toHaveBeenCalled();
  });

  it("inline and block maths, and a ```math fence", () => {
    const bubble = show("质能 $E=mc^2$ 与\n\n$$\n\\sum_{i=1}^n i = \\frac{n(n+1)}{2}\n$$\n\n```math\n\\sqrt{2}\n```");
    expect(bubble.querySelectorAll(".katex")).toHaveLength(3);
    expect(bubble.querySelectorAll(".katex-display")).toHaveLength(2);
    expect(bubble.querySelector("annotation").textContent).toBe("E=mc^2");
    // KaTeX draws a few shapes (here the root sign) as inline SVG: allowed inside its own output only.
    expect(bubble.querySelector(".katex svg")).not.toBeNull();
    expectSafe(bubble, { katexSvg: true });
  });

  it("maths KaTeX cannot read is shown as its source, without the error message", () => {
    const bubble = show("坏的 $\\frac{1}{$ 和 $\\notacommand{x}$");
    expect(bubble.textContent).toContain("\\notacommand{x}");
    expect(bubble.textContent).not.toMatch(/ParseError|Undefined control sequence/);
    expect(bubble.querySelector("[title]")).toBeNull();
    expectSafe(bubble);
  });

  it("a maths block over 2 000 characters is shown as code, not typeset", () => {
    const long = "x+".repeat(1001);
    const bubble = show(`$$\n${long}\n$$\n\n行内 $${long}$\n\n\`\`\`math\n${long}\n\`\`\``);
    expect(bubble.querySelector(".katex")).toBeNull();
    expect(bubble.querySelectorAll("pre > code")).toHaveLength(2);
    expect(bubble.querySelectorAll("p > code")).toHaveLength(1);
    expect(bubble.querySelector("pre > code").textContent).toContain(long);
  });

  it("footnotes: the reference and the note, with no ids and no in-page links", () => {
    const bubble = show("正文[^1]。\n\n[^1]: 注释内容");
    expect(bubble.querySelector("sup").textContent).toBe("1");
    expect(bubble.textContent).toContain("注释内容");
    expect(bubble.querySelector("a")).toBeNull();
    expectSafe(bubble);
  });
});

describe("what an Agent's Markdown never renders", () => {
  const HOSTILE = [
    ["an image tag with a handler", '<img src=x onerror="alert(1)">'],
    ["a script tag", "<script>alert(1)</script>"],
    ["an iframe", '<iframe src="https://evil.example/"></iframe>'],
    ["an inline style", '<span style="position:fixed;inset:0;background:red">盖住页面</span>'],
    ["a javascript: link", "[x](javascript:alert(1))"],
    ["a remote image", "![a](https://evil.example/p.png)"],
    ["a data: link", "[x](data:text/html,%3Cscript%3Ealert(1)%3C/script%3E)"],
    ["a raw HTML javascript: anchor", '<a href="javascript:alert(1)">点我</a>'],
    ["a link whose text is another URL", "[https://good.example/](https://evil.example/)"],
    ["a javascript: link with leading whitespace and mixed case", "[x](  JaVaScRiPt:alert(1))"],
    ["a vbscript: link", "[x](vbscript:msgbox(1))"],
    ["a protocol-relative link", "[x](//evil.example/a)"],
    ["a same-origin relative link", "[退出](/api/auth/sign-out)"],
    ["an entity-encoded scheme", "[x](java&#115;cript:alert(1))"],
    ["a javascript: autolink", "<javascript:alert(1)>"],
    ["a mailto link", "[信](mailto:a@example.com)"],
    ["a reference-style javascript: link", "[x][r]\n\n[r]: javascript:alert(1)"],
    ["a reference-style image", "![pic][r]\n\n[r]: https://evil.example/p.png"],
    ["entities that decode to a script tag", "&lt;script&gt;alert(1)&lt;/script&gt; &#60;script&#62;alert(2)&#60;/script&#62;"],
    ["a style block", "<style>body{display:none}</style>"],
    ["a base tag", '<base href="https://evil.example/">'],
    ["a meta refresh", '<meta http-equiv="refresh" content="0;url=https://evil.example/">'],
    ["a form", '<form action="https://evil.example/"><input name="q"><button>go</button></form>'],
    ["an svg with onload", '<svg onload="alert(1)"><circle r="9" /></svg>'],
    ["raw MathML tags", "<math><mi>x</mi><maction actiontype=\"statusline\">y</maction></math>"],
    ["object and embed", '<object data="https://evil.example/x"></object><embed src="https://evil.example/y">'],
    ["an image inside a link", "[![alt](https://evil.example/p.png)](https://ok.example/)"],
    ["an empty-alt image", "![](https://evil.example/p.png)"],
    ["a javascript: image", "![a](javascript:alert(1))"],
    ["a footnote named like an app id", "文[^root]\n\n[^root]: 注"],
    ["a heading with an id attempt", "# root {#root}\n\n<h1 id=\"root\">x</h1><a name=\"root\">y</a>"],
    ["KaTeX links, images, ids, styles and data", "$\\href{javascript:alert(1)}{x}$ $\\url{https://evil.example/}$ $\\includegraphics{https://evil.example/p.png}$ $\\htmlId{root}{x}$ $\\htmlStyle{position:fixed}{x}$ $\\htmlClass{toast}{x}$ $\\htmlData{x=y}{z}$"],
    ["an HTML comment and a CDATA section", "<!-- <img src=x onerror=alert(1)> --><![CDATA[<script>alert(1)</script>]]>"],
    ["a link with a quoting title", "[x](https://ok.example/ \"\\\" onmouseover=\\\"alert(1)\")"],
  ];

  it.each(HOSTILE)("%s", (_, text) => {
    expectSafe(show(text));
  });

  it("raw HTML is shown as text, not parsed", () => {
    const bubble = show('<img src=x onerror="alert(1)"> and <b>bold</b>');
    expect(bubble.textContent).toContain('<img src=x onerror="alert(1)">');
    expect(bubble.textContent).toContain("<b>bold</b>");
    expect(bubble.querySelector("b")).toBeNull();
  });

  it("a URL that is not http(s) is shown as its text, not as a link", () => {
    for (const [text, shown] of [
      ["[点我](javascript:alert(1))", "点我"],
      ["[x](//evil.example/a)", "x"],
      ["[退出](/api/auth/sign-out)", "退出"],
      ["<javascript:alert(1)>", "javascript:alert(1)"],
    ]) {
      const bubble = show(text);
      expect(bubble.querySelector("a"), text).toBeNull();
      expect(bubble.textContent.trim()).toBe(shown);
      cleanup();
    }
  });

  it("an image becomes a link labelled by its alt text (or its URL), never an <img>", () => {
    const bubble = show("![一张图](https://evil.example/p.png) ![](https://evil.example/q.png)");
    expect([...bubble.querySelectorAll("a")].map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["一张图", "https://evil.example/p.png"],
      ["https://evil.example/q.png", "https://evil.example/q.png"],
    ]);
    expect(bubble.querySelector("img")).toBeNull();
  });

  it("an image inside a link is the link's text, never a link in a link", () => {
    const bubble = show("[![图](https://evil.example/p.png)](https://ok.example/)");
    expect(hrefs(bubble)).toEqual(["https://ok.example/"]);
    expect(bubble.querySelector("a").textContent).toBe("图");
  });
});

describe("safeHref", () => {
  it.each([
    ["https://a.example/x?y#z", "https://a.example/x?y#z"],
    ["http://a.example", "http://a.example/"],
    ["  https://a.example/  ", "https://a.example/"],
    ["HTTPS://A.EXAMPLE/", "https://a.example/"],
  ])("keeps %s", (url, kept) => expect(safeHref(url)).toBe(kept));

  it.each(["javascript:alert(1)", " JaVaScRiPt:alert(1)", "data:text/html,x", "vbscript:x", "mailto:a@b.example", "//evil.example", "/api/auth/sign-out", "#top", "relative/path", "", "file:///etc/passwd", "ftp://a.example", null, undefined])(
    "refuses %s",
    (url) => expect(safeHref(url)).toBeNull(),
  );
});

describe("what is shown as plain text without trying", () => {
  const plainShown = (bubble, text) => {
    expect(md(bubble)).toBeNull();
    expect(bubble.textContent).toBe(text);
  };
  const timed = (text) => {
    const start = performance.now();
    const bubble = show(text);
    return { bubble, ms: performance.now() - start };
  };

  it("over 50 000 characters", () => {
    const text = `**粗** ${"字".repeat(50000)}`;
    plainShown(show(text), text);
  });

  it("a line over 10 000 characters", () => {
    const text = `# 标题\n${"a".repeat(10001)}`;
    plainShown(show(text), text);
  });

  it("a 5 000-row table, within a second", () => {
    const text = `| a | b |\n|---|---|\n${"| 1 | 2 |\n".repeat(5000)}`;
    const { bubble, ms } = timed(text);
    plainShown(bubble, text);
    expect(ms).toBeLessThan(1000);
  });

  it("lists nested 200 deep (by indentation or on one line), within a second", () => {
    const indented = Array.from({ length: 200 }, (_, i) => `${"  ".repeat(i)}- 第${i}层`).join("\n");
    const inline = `${"- ".repeat(200)}x`;
    const quotes = `${"> ".repeat(200)}x`;
    for (const text of [indented, inline, quotes]) {
      const { bubble, ms } = timed(text);
      plainShown(bubble, text);
      expect(ms).toBeLessThan(1000);
      cleanup();
    }
  });

  it("fitsMarkdown: the limits, exactly", () => {
    expect(fitsMarkdown("x".repeat(50000))).toBe(false); // one line over 10 000 as well
    expect(fitsMarkdown(`${"x".repeat(9999)}\n`.repeat(5))).toBe(true);
    expect(fitsMarkdown(`${"x".repeat(9999)}\n`.repeat(6))).toBe(false); // 60 000 characters
    expect(fitsMarkdown("y".repeat(10000))).toBe(true);
    expect(fitsMarkdown("y".repeat(10001))).toBe(false);
    expect(fitsMarkdown("| a |\n".repeat(2000))).toBe(true);
    expect(fitsMarkdown("| a |\n".repeat(2001))).toBe(false);
    // Table rows inside a code fence are code, not a table.
    expect(fitsMarkdown(`\`\`\`\n${"| a |\n".repeat(2001)}\`\`\``)).toBe(true);
    expect(fitsMarkdown(`${"- ".repeat(30)}x`)).toBe(true);
    expect(fitsMarkdown(`${"- ".repeat(31)}x`)).toBe(false);
    expect(fitsMarkdown(`${"> ".repeat(31)}x`)).toBe(false);
    expect(fitsMarkdown(`${"1. ".repeat(31)}x`)).toBe(false);
    // An item 30 levels deep by indentation: 29 indents of two columns, then its marker.
    expect(fitsMarkdown(`${"  ".repeat(29)}- x`)).toBe(true);
    expect(fitsMarkdown(`${"  ".repeat(30)}- x`)).toBe(false);
    expect(fitsMarkdown(`${"\t".repeat(15)}- x`)).toBe(false);
    // A block full of emphasis and link characters does not fit (the parser's work grows with both); long replies of
    // the ordinary kind do.
    expect(fitsMarkdown(Array.from({ length: 5 }, () => "a_ ".repeat(3000)).join("\n"))).toBe(false);
    expect(fitsMarkdown(`${"[a](b) ".repeat(1200)}`)).toBe(false);
    expect(fitsMarkdown(Array.from({ length: 1500 }, (_, i) => `- **项${i}**：说明`).join("\n"))).toBe(true);
    expect(fitsMarkdown(`| a | b |\n|---|---|\n${Array.from({ length: 1500 }, (_, i) => `| **${i}** | _x_ |`).join("\n")}`)).toBe(true);
    expect(fitsMarkdown(Array.from({ length: 40 }, () => "这是**一句**话，含 `snake_case` 和 [链接](https://a.example/)。".repeat(20)).join("\n\n"))).toBe(true);
    // Indented lines inside a fence are code.
    expect(fitsMarkdown(`\`\`\`\n${" ".repeat(200)}x\n\`\`\``)).toBe(true);
    expect(fitsMarkdown(`~~~\n${" ".repeat(200)}x\n~~~\n${" ".repeat(200)}x`)).toBe(false);
  });
});

describe("half-written and pathological text", () => {
  const within1s = (text) => {
    const start = performance.now();
    const bubble = show(text);
    expect(performance.now() - start, text.slice(0, 40)).toBeLessThan(1000);
    expectSafe(bubble);
    cleanup();
    return bubble;
  };

  it("an unclosed code fence renders as code to the end", () => {
    const bubble = show("前文\n\n```js\nconst a = 1;\nconst b");
    expect(bubble.querySelector("pre > code").textContent).toBe("const a = 1;\nconst b\n");
    expect(errors).not.toHaveBeenCalled();
  });

  it("an unbalanced $ is text; an unclosed $$ renders as far as it can", () => {
    expect(show("价格 $5，没有闭合").textContent).toBe("价格 $5，没有闭合");
    cleanup();
    const bubble = show("$$\n\\frac{1}{2");
    expect(bubble.querySelector(".md")).not.toBeNull();
    expect(bubble.textContent).not.toMatch(/ParseError/);
    expect(errors).not.toHaveBeenCalled();
  });

  // The parser's known worst cases (cmark's pathological tests, and a few more), as long as a message may be: one
  // paragraph of lines under the line limit. Each is either rendered or shown plain, within a second.
  const LINE = 9000;
  const asLines = (text) => Array.from({ length: Math.ceil(text.length / LINE) }, (_, i) => text.slice(i * LINE, (i + 1) * LINE)).join("\n");
  const fill = (unit) => unit.repeat(Math.floor(45000 / unit.length));
  it.each([
    ["nested strong and emphasis", "*a **a ".repeat(3000) + "b" + " a** a*".repeat(3000)],
    ["emphasis closers without openers", fill("a_ ")],
    ["emphasis openers without closers", fill("_a ")],
    ["link closers without openers", fill("a]")],
    ["link openers without closers", fill("[a")],
    ["mismatched openers and closers", fill("*a_ ")],
    ["openers and closers in multiples of 3", fill("a**b").slice(0, 22500) + fill("c* ").slice(0, 22500)],
    ["link openers and emphasis closers", fill("[ a_")],
    ["[ (](", fill("[ (](")],
    ["hard link and emphasis", "**x [a*b**c*](d)".repeat(2500)],
    ["nested brackets", "[".repeat(20000) + "a" + "]".repeat(20000)],
    ["nested block quotes", "> ".repeat(20000) + "a"],
    ["backticks", Array.from({ length: 250 }, (_, i) => "e" + "`".repeat(i)).join("")],
    ["unclosed links <", fill("[a](<b")],
    ["unclosed links", fill("[a](b")],
    ["many references", Array.from({ length: 4000 }, (_, i) => `[${i}]: u\n`).join("") + "[0]"],
    ["links in link labels", fill("[[a](b)")],
    ["footnote references", fill("[^a]")],
    ["dollars", fill("$a")],
    ["strikethrough", fill("~a")],
    ["blanks to fill in", fill("答案______ ")],
    ["angle brackets", fill("<a ")],
    ["entities", fill("&#")],
    ["emphasis nested by alternating markers", "*a _b ".repeat(200) + "x" + " b_ a*".repeat(200)],
    // (And long replies of the ordinary kind, rendered.)
    ["a long list of bold items", Array.from({ length: 500 }, (_, i) => `- **项${i}**：说明`).join("\n")],
    ["a long table of bold cells", "| a | b |\n|---|---|\n" + Array.from({ length: 500 }, (_, i) => `| **${i}** | _x_ |`).join("\n")],
    ["many links", Array.from({ length: 20 }, () => "[a](https://a.example/) ".repeat(25)).join("\n\n")],
    ["many formulas", Array.from({ length: 10 }, () => "$x_1$ ".repeat(20)).join("\n\n")],
    ["many code blocks", "```js\nlet a = 1;\n```\n".repeat(100)],
  ])("%s: rendered or plain within a second, without an error", (_, text) => {
    within1s(asLines(text));
  });

  it("a text the parser nests too deeply is shown as its plain text", () => {
    const text = "*a _b ".repeat(200) + "x" + " b_ a*".repeat(200);
    expect(fitsMarkdown(text)).toBe(true);
    const bubble = show(text);
    expect(bubble.querySelector(".md .md-plain").textContent).toBe(text);
    expect(bubble.querySelector("em, strong")).toBeNull();
  });

  it("a text with more than 500 formulas typesets the first 500 and shows the rest as code", () => {
    const bubble = show(Array.from({ length: 6 }, () => "$x$ ".repeat(100)).join("\n\n"));
    expect(bubble.querySelectorAll(".katex")).toHaveLength(500);
    expect(bubble.querySelectorAll("p > code")).toHaveLength(100);
  });

  it("every prefix of a reply being written renders without an error", () => {
    const reply = [
      "# 计划",
      "",
      "1. **第一步**：读 [文档](https://docs.example/)",
      "2. 第二步 $a^2+b^2=c^2$",
      "",
      "| 列 | 值 |",
      "|---|---|",
      "| x | 1 |",
      "",
      "```python",
      "def f(x):",
      "    return x * 2",
      "```",
      "",
      "$$",
      "\\int_0^1 x\\,dx",
      "$$",
      "",
      "> 结束[^1]",
      "",
      "[^1]: 注",
    ].join("\n");
    const { container, rerender } = render(<div className="bubble"><AgentText text="" /></div>);
    for (let i = 1; i <= reply.length; i += 1) {
      rerender(<div className="bubble"><AgentText text={reply.slice(0, i)} /></div>);
      expect(container.querySelector(".md"), reply.slice(0, i)).not.toBeNull();
      if (i % 10 === 0) expectSafe(container.firstChild, { katexSvg: true });
    }
    expectSafe(container.firstChild, { katexSvg: true });
    expect(container.querySelector("h1").textContent).toBe("计划");
    expect(container.querySelector(".katex-display")).not.toBeNull();
    expect(container.querySelector(".hljs-keyword").textContent).toBe("def");
  });
});

describe("whose messages are Markdown", () => {
  beforeEach(() => installBrowser());
  afterEach(() => vi.useRealTimers());

  async function openChat(conversationId, messages) {
    const record = agentOf(AG1, { model: { source: "site", id: "free-1" } });
    const sync = () =>
      syncOf(
        [direct(D1, ANN, { lastSeq: 1, readSeq: 1 }), agentConv(A1, AG1, { lastSeq: 3, readSeq: 3 })],
        messages,
        [...PRINCIPALS, agentPrincipal()],
      );
    await openApp({ sync, handlers: { agents: () => ({ agents: [record] }), agent: () => record, run: () => ({ run: null }), models: () => MODELS } });
    await click(screen.getByText(conversationId === A1 ? "小助手" : "小安", { selector: ".list-col .row-name" }));
  }
  const bubbleOf = (seq) => document.querySelector(`li[data-msg="m${seq}"] .bubble`);
  const MARKDOWN = "# 标题\n**粗体** [链接](https://a.example/) <b>x</b>";

  it("a person's message containing Markdown is shown literally; the Agent's is rendered", async () => {
    const proposal = { id: "00000000-0000-4000-8000-0000000000f7", status: "open", persona: "# 人格\n**认真**", intro: "", field: "" };
    await openChat(A1, [
      wire(D1, 1, ANN, MARKDOWN),
      wire(A1, 1, AG1, "你好"),
      wire(A1, 2, ME_ID, MARKDOWN),
      wire(A1, 3, AG1, MARKDOWN, { reasoning: "**想** `一下`", proposal }),
    ]);
    const mine = bubbleOf(2);
    expect(mine.textContent).toBe(MARKDOWN);
    expect(mine.querySelector("h1, strong, a, b, .md")).toBeNull();

    const agents = bubbleOf(3);
    expect(agents.querySelector("h1").textContent).toBe("标题");
    expect(agents.querySelector("strong").textContent).toBe("粗体");
    expect(agents.querySelector("a").getAttribute("href")).toBe("https://a.example/");
    // Its thinking and its proposal's persona are plain text too.
    const li = document.querySelector('li[data-msg="m3"]');
    expect(li.querySelector(".thinking-text").textContent).toBe("**想** `一下`");
    expect(li.querySelector(".thinking-text strong, .thinking-text code")).toBeNull();
    expect(li.querySelector(".proposal-persona").textContent).toBe("# 人格\n**认真**");
    expect(li.querySelector(".proposal-persona *")).toBeNull();

    await click(screen.getByText("小安", { selector: ".list-col .row-name" }));
    const friends = bubbleOf(1);
    expect(friends.textContent).toBe(MARKDOWN);
    expect(friends.querySelector("h1, strong, a, b, .md")).toBeNull();
  });
});
