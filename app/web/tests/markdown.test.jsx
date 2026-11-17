// @vitest-environment jsdom
// An Agent's text is shown as Markdown, rendered by a renderer that treats it as hostile: the model writing it can be
// steered by anything in the conversation, and it is shown in the reader's signed-in page. Raw HTML is text, a URL is a
// link only when it is http(s), an image is never fetched, nothing gets an id, a handler or a style of its own, and a
// text too big (or too deep) to render safely is shown as plain text. A person's message is never Markdown.
import { useTimeLimits } from "./markdown-ready.js";
import React from "react";
import { readFileSync } from "node:fs";
import katex from "katex";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AgentText, StreamingAgentText } from "../src/pages/AgentChatBits.jsx";
import { fitsMarkdown } from "../src/ui/markdownLimits.js";
import { APP_CLASSES, safeHref } from "../src/ui/Markdown.jsx";
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
  // KaTeX's output never carries a class the app's stylesheet styles.
  for (const el of bubble.querySelectorAll(".katex *, .katex-display *")) {
    for (const cls of el.classList) expect(APP_CLASSES.has(cls), `class ${cls} in KaTeX output`).toBe(false);
  }
  for (const a of bubble.querySelectorAll("a")) {
    expect(a.getAttribute("href") ?? "", a.outerHTML).toMatch(/^https?:\/\//);
    expect(a.getAttribute("title"), a.outerHTML).toBe(a.getAttribute("href"));
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

  it("a line break is a line break in a paragraph, a list item and a heading alike (no stray space); a hard one once", () => {
    const bubble = show("第一行\n第二行\n\n甲\\\n乙\n\n- 项一行\n  项二行\n\n标题上\n标题下\n===");
    const [soft, hard] = bubble.querySelectorAll("p");
    for (const [el, text] of [[soft, "第一行第二行"], [hard, "甲乙"], [bubble.querySelector("li"), "项一行项二行"], [bubble.querySelector("h1"), "标题上标题下"]]) {
      expect(el.textContent).toBe(text);
      expect(el.querySelectorAll("br")).toHaveLength(1);
    }
    expectSafe(bubble);
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

  it("a link opens in a new tab, without the opener or the referrer; its tooltip is its real address, not the text's", () => {
    const bubble = show("看 [文档](https://docs.example/a?b=1#c \"说明\")");
    const a = bubble.querySelector("a");
    expect(a.textContent).toBe("文档");
    expect(a.getAttribute("href")).toBe("https://docs.example/a?b=1#c");
    expect(a.getAttribute("title")).toBe("https://docs.example/a?b=1#c");
    expect(bubble.textContent).not.toContain("说明");
    expectSafe(bubble);
  });

  it("a link whose text is an address on another host is followed by the real host", () => {
    const bubble = show(
      "[https://bank.example/](https://evil.example/ \"https://bank.example/\") 和 [www.bank.example](https://evil.example:8443/x) 和 " +
        "[https://a.example/x](https://a.example/y) 和 ![https://bank.example/](https://evil.example/p.png) 和 https://plain.example/",
    );
    const after = (a) => a.nextSibling?.textContent ?? "";
    const [bank, www, same, image, plain] = bubble.querySelectorAll("a");
    expect(bank.getAttribute("title")).toBe("https://evil.example/");
    expect(after(bank).startsWith(" （实际指向 evil.example）")).toBe(true);
    expect(after(www).startsWith(" （实际指向 evil.example:8443）")).toBe(true);
    expect(after(same)).not.toContain("实际指向");
    expect(after(image).startsWith(" （实际指向 evil.example）")).toBe(true);
    expect(after(plain)).not.toContain("实际指向");
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
    ["diff", "+ a\n- b"],
  ])("highlights %s", (lang, source) => {
    const bubble = show(`\`\`\`${lang}\n${source}\n\`\`\``);
    expect(bubble.querySelector("pre > code").textContent).toBe(`${source}\n`);
    expect(bubble.querySelector("pre > code span[class^='hljs-']"), lang).not.toBeNull();
  });

  it.each(["mermaid", "plantuml", "kotlin", "markdown", "md", ""])("renders a %s fence (unknown, a diagram, Markdown, or none) as plain code", (lang) => {
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

  // The note cannot be dodged: invisible characters, words around the address, no scheme, `//`, look-alike letters.
  it.each([
    ["a zero-width space before the scheme", "[​https://bank.example/](https://evil.example/)", "evil.example"],
    ["a word joiner before the scheme", "[⁠https://bank.example/](https://evil.example/)", "evil.example"],
    ["a left-to-right mark before the scheme", "[‎https://bank.example/](https://evil.example/)", "evil.example"],
    ["a zero-width space inside the host", "[https://bank​.example/](https://evil.example/)", "evil.example"],
    ["a soft hyphen inside the host", "[https://bank­.example/](https://evil.example/)", "evil.example"],
    ["a fullwidth colon", "[https：//bank.example/](https://evil.example/)", "evil.example"],
    ["words before the address", "[登录 https://bank.example/](https://evil.example/)", "evil.example"],
    ["a protocol-relative address", "[//bank.example/](https://evil.example/)", "evil.example"],
    ["a bare domain", "[bank.example](https://evil.example/)", "evil.example"],
    ["the address in a code span", "[`https://bank.example/`](https://evil.example/)", "evil.example"],
    ["the address in emphasis", "[*https://bank.example/*](https://evil.example/)", "evil.example"],
    ["a user name that looks like the host", "[https://bank.example@evil.example/](https://evil.example/)", "evil.example"],
    ["an ideographic full stop for a dot", "[bank。example](https://evil.example/)", "evil.example"],
    ["an IPv4 address", "[http://10.0.0.1/](https://evil.example/)", "evil.example"],
    ["an IDN look-alike target", "[https://apple.com/](https://аррӏе.com/)", "xn--80ak6aa92e.com"],
  ])("a link whose text shows another host gets the note: %s", (_, text, host) => {
    const bubble = show(text);
    expect(bubble.querySelector("a").nextSibling?.textContent).toBe(` （实际指向 ${host}）`);
    expectSafe(bubble);
  });

  it.each([
    ["plain words", "[文档](https://example.com/docs)"],
    ["an autolink", "https://example.com/docs"],
    ["the text equal to the target", "[https://example.com/a](https://example.com/a)"],
    ["the same host, other path", "[example.com/a](https://example.com/b)"],
    ["www. on one side only", "[https://www.example.com/](https://example.com/b)"],
    ["the same IDN host on both sides", "[https://аррӏе.com/](https://аррӏе.com/)"],
    ["a version number, not a host", "[v1.2](https://example.com/releases)"],
  ])("an ordinary link gets no note: %s", (_, text) => {
    expect(show(text).textContent).not.toContain("实际指向");
  });

  it("maths is $$…$$ only: a single $ is text (`$5 和 $10` stays a sentence)", () => {
    const bubble = show("价格 $5 和 $10，以及 $x$");
    expect(bubble.textContent).toBe("价格 $5 和 $10，以及 $x$");
    expect(bubble.querySelector(".katex")).toBeNull();
  });

  it("inline and block maths, and a ```math fence", () => {
    const bubble = show("质能 $$E=mc^2$$ 与\n\n$$\n\\sum_{i=1}^n i = \\frac{n(n+1)}{2}\n$$\n\n```math\n\\sqrt{2}\n```");
    expect(bubble.querySelectorAll(".katex")).toHaveLength(3);
    expect(bubble.querySelectorAll(".katex-display")).toHaveLength(2);
    expect(bubble.querySelector("annotation").textContent).toBe("E=mc^2");
    // KaTeX draws a few shapes (here the root sign) as inline SVG: allowed inside its own output only.
    expect(bubble.querySelector(".katex svg")).not.toBeNull();
    expectSafe(bubble, { katexSvg: true });
  });

  it("maths KaTeX cannot read is shown as its source, without the error message", () => {
    const bubble = show("坏的 $$\\frac{1}{$$ 和 $$\\notacommand{x}$$");
    expect(bubble.textContent).toContain("\\notacommand{x}");
    expect(bubble.textContent).not.toMatch(/ParseError|Undefined control sequence/);
    expect(bubble.querySelector("[title]")).toBeNull();
    expectSafe(bubble);
  });

  it("a maths block over 2 000 characters is shown as code, not typeset", () => {
    const long = "x+".repeat(1001);
    const bubble = show(`$$\n${long}\n$$\n\n行内 $$${long}$$\n\n\`\`\`math\n${long}\n\`\`\``);
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
    ["KaTeX links, images, ids, styles and data", "$$\\href{javascript:alert(1)}{x}$$ $$\\url{https://evil.example/}$$ $$\\includegraphics{https://evil.example/p.png}$$ $$\\htmlId{root}{x}$$ $$\\htmlStyle{position:fixed}{x}$$ $$\\htmlClass{toast}{x}$$ $$\\htmlData{x=y}{z}$$"],
    ["KaTeX's \\tag, which makes a class the app styles", "$$\nx = 1 \\tag*{假标签}\n$$\n\n$$\ny \\tag{2}\n$$"],
    ["a link to an address with a user name", "[x](https://bank.example@evil.example/) [y](https://u:p@evil.example/)"],
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

  it("KaTeX's \\tag keeps its label but not the app's `tag` class", () => {
    const bubble = show("$$\nx = 1 \\tag*{假标签}\n$$");
    expect(bubble.querySelector(".katex-display").textContent).toContain("假标签");
    expect(bubble.querySelector(".tag")).toBeNull();
  });

  it("KaTeX output carrying the app's classes (as KaTeX before 0.18 gave \\tag) keeps only its own", () => {
    vi.spyOn(katex, "renderToString").mockReturnValue('<span class="katex"><span class="tag card msg bubble btn row mord">x</span></span>');
    const bubble = show("$$y^{classes}$$");
    expect(bubble.querySelector(".katex > span").className).toBe("mord");
    expect(bubble.querySelector(".tag, .card, .msg, .bubble, .btn, .row")).toBeNull();
  });

  it("the classes left out of KaTeX's output are every class styles.css styles", () => {
    const css = readFileSync("src/styles.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const styled = new Set([...css.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1]).filter((name) => !/^(katex|hljs)/.test(name)));
    expect(styled.size).toBeGreaterThan(100);
    for (const name of styled) expect(APP_CLASSES.has(name), name).toBe(true);
  });
});

describe("safeHref", () => {
  it.each([
    ["https://a.example/x?y#z", "https://a.example/x?y#z"],
    ["http://a.example", "http://a.example/"],
    ["  https://a.example/  ", "https://a.example/"],
    ["HTTPS://A.EXAMPLE/", "https://a.example/"],
  ])("keeps %s", (url, kept) => expect(safeHref(url)).toBe(kept));

  it.each(["javascript:alert(1)", " JaVaScRiPt:alert(1)", "data:text/html,x", "vbscript:x", "mailto:a@b.example", "//evil.example", "/api/auth/sign-out", "#top", "relative/path", "", "file:///etc/passwd", "ftp://a.example", "https://bank.example@evil.example/", "https://user:pass@a.example/", "http://:pass@a.example/", null, undefined])(
    "refuses %s",
    (url) => expect(safeHref(url)).toBeNull(),
  );
});

/** The brief's "within a second", with room for a machine that runs other work at the same time. */
const WALL_MS = 3000;
const elementsIn = (bubble) => bubble.querySelectorAll("*").length;
const timed = (text) => {
  const start = performance.now();
  const bubble = show(text);
  return { bubble, ms: performance.now() - start };
};

describe("what is shown as plain text without trying", () => {
  const plainShown = (bubble, text) => {
    expect(md(bubble)).toBeNull();
    expect(bubble.textContent).toBe(text);
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
    expect(elementsIn(bubble)).toBe(0);
    expect(ms).toBeLessThan(WALL_MS);
  });

  it("lists nested 200 deep (by indentation or on one line), within a second", () => {
    const indented = Array.from({ length: 200 }, (_, i) => `${"  ".repeat(i)}- 第${i}层`).join("\n");
    const inline = `${"- ".repeat(200)}x`;
    const quotes = `${"> ".repeat(200)}x`;
    for (const text of [indented, inline, quotes]) {
      const { bubble, ms } = timed(text);
      plainShown(bubble, text);
      expect(elementsIn(bubble)).toBe(0);
      expect(ms).toBeLessThan(WALL_MS);
      cleanup();
    }
  });

  it("fitsMarkdown: the limits, exactly", () => {
    expect(fitsMarkdown("x".repeat(50000))).toBe(false); // one line over 10 000 as well
    expect(fitsMarkdown(`${"x".repeat(9999)}\n`.repeat(5))).toBe(true);
    expect(fitsMarkdown(`${"x".repeat(9999)}\n`.repeat(6))).toBe(false); // 60 000 characters
    expect(fitsMarkdown("y".repeat(10000))).toBe(true);
    expect(fitsMarkdown("y".repeat(10001))).toBe(false);
    // Lines starting with |, | characters, code fences and $$: each counted in the same single pass.
    expect(fitsMarkdown("| a |\n".repeat(400))).toBe(true);
    expect(fitsMarkdown("| a |\n".repeat(401))).toBe(false);
    expect(fitsMarkdown("a | b\n".repeat(2000))).toBe(true);
    expect(fitsMarkdown("a | b\n".repeat(2001))).toBe(false);
    expect(fitsMarkdown("```\nx\n```\n".repeat(300))).toBe(true);
    expect(fitsMarkdown("```\nx\n```\n".repeat(301))).toBe(false);
    expect(fitsMarkdown("$$x$$\n\n".repeat(1000))).toBe(true);
    expect(fitsMarkdown("$$x$$\n\n".repeat(1001))).toBe(false);
    // Table rows and $$ inside a code fence are code: not counted.
    expect(fitsMarkdown(`\`\`\`\n${"| a | $$ |\n".repeat(2001)}\`\`\``)).toBe(true);
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
    expect(fitsMarkdown(`| a | b |\n|---|---|\n${Array.from({ length: 300 }, (_, i) => `| **${i}** | _x_ |`).join("\n")}`)).toBe(true);
    expect(fitsMarkdown(Array.from({ length: 40 }, () => "这是**一句**话，含 `snake_case` 和 [链接](https://a.example/)。".repeat(20)).join("\n\n"))).toBe(true);
    // Indented lines inside a fence are code.
    expect(fitsMarkdown(`\`\`\`\n${" ".repeat(200)}x\n\`\`\``)).toBe(true);
    expect(fitsMarkdown(`~~~\n${" ".repeat(200)}x\n~~~\n${" ".repeat(200)}x`)).toBe(false);
  });
});

/** Rendered or shown plain, safely, within the time, with no more than `maxElements` elements made. */
function bounded(text, maxElements = 12000) {
  const { bubble, ms } = timed(text);
  expect(ms, text.slice(0, 40)).toBeLessThan(WALL_MS);
  expect(elementsIn(bubble), text.slice(0, 40)).toBeLessThanOrEqual(maxElements);
  expectSafe(bubble, { katexSvg: true });
  cleanup();
  return bubble;
}

describe("half-written and pathological text", () => {
  it("an unclosed code fence renders as code to the end", () => {
    const bubble = show("前文\n\n```js\nconst a = 1;\nconst b");
    expect(bubble.querySelector("pre > code").textContent).toBe("const a = 1;\nconst b\n");
    expect(errors).not.toHaveBeenCalled();
  });

  it("an unbalanced $$ is text; an unclosed maths block is its plain text until it closes, never typeset half-written", () => {
    const typesets = vi.spyOn(katex, "renderToString");
    expect(show("价格 $$5，没有闭合").textContent).toBe("价格 $$5，没有闭合");
    cleanup();
    const open = "前文\n\n$$\n\\frac{1}{2open}";
    const { container, rerender } = render(<div className="bubble"><AgentText text={open} /></div>);
    expect(container.querySelector(".md-plain").textContent).toBe("$$\n\\frac{1}{2open}");
    rerender(<div className="bubble"><AgentText text={`${open}\n\\cdot 3`} /></div>);
    rerender(<div className="bubble"><AgentText text={"前文\n\n```math\n\\sqrt{2open}"} /></div>);
    expect(container.querySelector(".md-plain").textContent).toBe("```math\n\\sqrt{2open}");
    expect(typesets).not.toHaveBeenCalled();
    rerender(<div className="bubble"><AgentText text={`${open}\n\\cdot 3\n$$`} /></div>);
    expect(container.querySelector(".katex-display")).not.toBeNull();
    expect(typesets).toHaveBeenCalledTimes(1);
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
    ["many formulas", Array.from({ length: 10 }, () => "$$x_1$$ ".repeat(20)).join("\n\n")],
    ["many code blocks", "```js\nlet a = 1;\n```\n".repeat(100)],
  ])("%s: rendered or plain within a second, without an error", (_, text) => {
    bounded(asLines(text));
  });

  it("a text the parser nests too deeply is shown as its plain text", () => {
    const text = "*a _b ".repeat(200) + "x" + " b_ a*".repeat(200);
    expect(fitsMarkdown(text)).toBe(true);
    const bubble = show(text);
    expect(bubble.querySelector(".md .md-plain").textContent).toBe(text);
    expect(bubble.querySelector("em, strong")).toBeNull();
  });

  it("a text with more than 500 formulas typesets the first 500 and shows the rest as code", () => {
    const bubble = show(Array.from({ length: 6 }, () => "$$x$$ ".repeat(100)).join("\n\n"));
    expect(bubble.querySelectorAll(".katex")).toHaveLength(500);
    expect(bubble.querySelectorAll("p > code")).toHaveLength(100);
  });

  it("every prefix of a reply being written renders without an error", async () => {
    const reply = [
      "# 计划",
      "",
      "1. **第一步**：读 [文档](https://docs.example/)",
      "2. 第二步 $$a^2+b^2=c^2$$",
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
    // (As the streaming bubble renders it: at a lower priority, each piece settled before the next.)
    const { container, rerender } = render(<div className="bubble"><StreamingAgentText text="" /></div>);
    for (let i = 1; i <= reply.length; i += 1) {
      await act(async () => rerender(<div className="bubble"><StreamingAgentText text={reply.slice(0, i)} /></div>));
      expect(container.querySelector(".md"), reply.slice(0, i)).not.toBeNull();
      if (i === 30) expect(container.querySelector("strong")?.textContent).toBe("第一步"); // the latest piece is shown
      if (i % 10 === 0) expectSafe(container.firstChild, { katexSvg: true });
    }
    expectSafe(container.firstChild, { katexSvg: true });
    expect(container.querySelector("h1").textContent).toBe("计划");
    expect(container.querySelector(".katex-display")).not.toBeNull();
    expect(container.querySelector(".hljs-keyword").textContent).toBe("def");
  });
});

describe("the work a text can cause is bounded", () => {
  const wideTable = (cols, rows, row = "x") => `${"|a".repeat(cols)}|\n${"|-".repeat(cols)}|\n${`${row}\n`.repeat(rows)}`;
  const cells = (bubble) => bubble.querySelectorAll("td, th").length;

  it("a table with more | than a text may have is shown plain without being parsed", () => {
    for (const text of [wideTable(2000, 20000), wideTable(100, 60, `${"|b".repeat(100)}|`), Array.from({ length: 1200 }, () => "|a|b|\n|-|-|\n|c|d|").join("\n\n")]) {
      expect(fitsMarkdown(text)).toBe(false);
      const { bubble, ms } = timed(text);
      expect(md(bubble)).toBeNull();
      expect(elementsIn(bubble)).toBe(0);
      expect(ms).toBeLessThan(WALL_MS);
      cleanup();
    }
  });

  it("a table that would have more than 5 000 cells (rows padded to a wide header, pipes or none) is shown as plain text", () => {
    for (const text of [wideTable(300, 2000), wideTable(60, 100), wideTable(100, 300, "|b|")]) {
      expect(fitsMarkdown(text)).toBe(true);
      const { bubble, ms } = timed(text);
      expect(cells(bubble)).toBe(0);
      expect(bubble.querySelector(".md-plain").textContent).toBe(text);
      expect(ms).toBeLessThan(WALL_MS);
      cleanup();
    }
  });

  it("a wide table within the cap is rendered, padded as GFM pads it", () => {
    const bubble = show(wideTable(20, 40, `${"|b".repeat(20)}|`));
    expect(bubble.querySelectorAll("th")).toHaveLength(20);
    expect(bubble.querySelectorAll("td")).toHaveLength(800);
    expect(show(wideTable(5, 3)).querySelectorAll("td")).toHaveLength(15);
  });

  it("a formula that defines macros is shown as code, never typeset (the reviewer's 10×10×10×100 expansion)", () => {
    const typesets = vi.spyOn(katex, "renderToString");
    const macro = `\\def\\a#1{#1#1#1#1#1#1#1#1#1#1}\\a{\\a{\\a{${"x".repeat(100)}}}}`;
    const others = ["\\gdef\\b{y}\\b", "\\newcommand{\\c}{z}\\c", "\\let\\d=\\alpha \\d", "\\color{#ff0000}{r}", "\\global\\def\\e{1}"];
    const { bubble, ms } = timed([`$$\n${macro}\n$$`, ...others.map((tex) => `$$${tex}$$`)].join("\n\n"));
    expect(typesets).not.toHaveBeenCalled();
    expect(bubble.querySelector(".katex")).toBeNull();
    expect(bubble.querySelector("pre > code").textContent).toBe(`${macro}\n`);
    expect(bubble.querySelectorAll("p > code")).toHaveLength(others.length);
    expect(ms).toBeLessThan(WALL_MS);
  });

  it("KaTeX output over 100 000 characters is discarded (the formula shown as code), and not typeset again", () => {
    const typesets = vi.spyOn(katex, "renderToString");
    const big = `x^{1}`.repeat(380); // 1 900 characters, ~180 000 of HTML
    const text = `$$\n${big}\n$$`;
    const { container, rerender } = render(<div className="bubble"><AgentText text={text} /></div>);
    expect(typesets).toHaveBeenCalledTimes(1);
    expect(typesets.mock.results[0].value.length).toBeGreaterThan(100000);
    expect(container.querySelector(".katex")).toBeNull();
    expect(container.querySelector("pre > code").textContent).toBe(big);
    rerender(<div className="bubble"><AgentText text={`${text}\n\n后文`} /></div>);
    expect(typesets).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".katex")).toBeNull();
  });

  /** A clock that moves only while KaTeX works: each typeset "takes" `cost(tex)` milliseconds. */
  function slowKatex(cost) {
    let clock = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const real = katex.renderToString;
    return vi.spyOn(katex, "renderToString").mockImplementation((tex, options) => {
      clock += cost(tex);
      return real.call(katex, tex, options);
    });
  }

  describe("within the app's time limits", () => {
  useTimeLimits();

  it("past 150 ms of KaTeX in one text the remaining formulas are code; the next pieces typeset the rest", () => {
    const typesets = slowKatex(() => 40);
    const formulas = Array.from({ length: 8 }, (_, i) => `$$b_{${i}}^{budget}$$`).join(" ");
    const { container, rerender } = render(<div className="bubble"><AgentText text={formulas} /></div>);
    // 40, 80, 120, 160 ms: after the fourth the budget is spent.
    expect(typesets).toHaveBeenCalledTimes(4);
    expect(container.querySelectorAll(".katex")).toHaveLength(4);
    expect(container.querySelectorAll("p > code")).toHaveLength(4);
    rerender(<div className="bubble"><AgentText text={`${formulas} 。`} /></div>);
    expect(typesets).toHaveBeenCalledTimes(8);
    expect(container.querySelectorAll(".katex")).toHaveLength(8);
  });

  it("a formula that alone takes too long spends the text's budget, and is never typeset again", () => {
    const typesets = slowKatex((tex) => (tex.includes("slow") ? 300 : 1));
    const text = "$$\\text{slow}^{once}$$ 和 $$q^{fast}$$";
    const { container, rerender } = render(<div className="bubble"><AgentText text={text} /></div>);
    expect(typesets).toHaveBeenCalledTimes(1); // the slow one spent the budget: the other is code this time
    expect(container.querySelectorAll(".katex")).toHaveLength(1);
    expect(container.querySelector("p > code").textContent).toBe("q^{fast}");
    for (const tail of [" 。", " 。。", " 。。。"]) rerender(<div className="bubble"><AgentText text={text + tail} /></div>);
    expect(typesets).toHaveBeenCalledTimes(2); // the fast one, once; the slow one never again (shown while kept)
    expect(container.querySelectorAll(".katex")).toHaveLength(2);
  });
  });

  it("typeset formulas and highlighted code are used again unchanged, in every bubble and on every piece", () => {
    const text = "$$\\frac{a}{b}^{reuse}$$\n\n```js\nconst reuse = 1;\n```";
    const typesets = vi.spyOn(katex, "renderToString");
    const first = show(text);
    const second = show(text);
    expect(typesets).toHaveBeenCalledTimes(1);
    expect(second.innerHTML).toBe(first.innerHTML);
    const { container, rerender } = render(<div className="bubble"><AgentText text={text} /></div>);
    for (const tail of ["\n\n。", "\n\n。。", "\n\n。。。"]) rerender(<div className="bubble"><AgentText text={text + tail} /></div>);
    expect(typesets).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".katex")).not.toBeNull();
    expect(container.querySelector(".hljs-keyword").textContent).toBe("const");
    expect(errors).not.toHaveBeenCalled();
  });

  // Hostile sizes, as a table: each renders or falls back with bounded work (elements made, KaTeX runs).
  const LINE = 9000;
  const asLines = (text) => Array.from({ length: Math.ceil(text.length / LINE) }, (_, i) => text.slice(i * LINE, (i + 1) * LINE)).join("\n");
  const MIX = "[*_`$|>-a ";
  const mixed = Array.from({ length: 49999 }, (_, i) => MIX[(i * 7 + Math.floor(i / 13)) % MIX.length]).join("");
  it.each([
    ["a wide header over pipe-less rows", wideTable(300, 2000)],
    ["a wide header over piped rows", wideTable(100, 300, "|b|")],
    ["nested macros", `$$\n\\def\\a#1{#1#1#1#1#1#1#1#1#1#1}\\a{\\a{\\a{${"x".repeat(400)}}}}\n$$`],
    ["many small formulas", Array.from({ length: 40 }, (_, i) => Array.from({ length: 10 }, (_, j) => `$$s_{${i}}^{${j}}$$`).join(" ")).join("\n\n")],
    ["deeply nested emphasis", "*a _b ".repeat(400) + "x" + " b_ a*".repeat(400)],
    ...["[", "*", "_", "`", "$", "|", ">", "-"].flatMap((ch) => [
      [`49 999 × ${ch} on one line`, ch.repeat(49999)],
      [`49 999 × ${ch} in lines`, asLines(ch.repeat(49999))],
    ]),
    ["49 999 mixed on one line", mixed],
    ["49 999 mixed in lines", asLines(mixed)],
  ])("%s", (_, text) => {
    const typesets = vi.spyOn(katex, "renderToString");
    const bubble = bounded(text, 25000);
    expect(typesets.mock.calls.length).toBeLessThanOrEqual(500);
    expect(bubble.querySelectorAll(".katex").length).toBeLessThanOrEqual(500);
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
