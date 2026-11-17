// An Agent's reply as Markdown in a real browser: what renders (a heading, code, a table, display maths), and what
// never happens (a remote image fetched, a raw <script> run, a link hiding where it goes). The reply comes from the
// local model stub (support/model-stub.mjs); the people fixture also fails the test on any CSP violation, uncaught
// error or injected markup (support/fixtures.mjs).
import { test, expect } from "./support/fixtures.mjs";
import { HOSTILE } from "./support/fixtures.mjs";
import { uniq } from "./support/accounts.mjs";
import { agentMessagesWith, createAgentUi, sendText } from "./support/app.mjs";
import { canControlService } from "./support/control.mjs";
import { modelStub } from "./support/model-stub.mjs";
import { capture } from "./support/shots.mjs";

test.beforeEach(async () => {
  test.skip(!canControlService, "needs the local service and its model stub");
  await modelStub.reset();
});

/** Where the reply's image points: a host nothing on the page may ever ask for. */
const IMAGE_HOST = "images.example.test";

const REPLY = [
  "# 三日行程",
  "",
  "先看一段代码：",
  "",
  "```python",
  'print("出发")',
  "```",
  "",
  "| 城市 | 天数 |",
  "| --- | --- |",
  "| 杭州 | 2 |",
  "| 苏州 | 1 |",
  "",
  "$$",
  "E = mc^2",
  "$$",
  "",
  `![西湖风景](https://${IMAGE_HOST}/west-lake.png)`,
  "",
  "<script>window.__markdownScript = 1</script>",
  "",
  HOSTILE,
  "",
  "资料见 [https://docs.example.com/guide](https://evil.example.net/steal)。",
].join("\n");

test("an Agent's reply renders its heading, code, table and maths; its remote image is never fetched, its script never runs, a link says where it really goes", async ({ people }) => {
  const ann = await people.member("Ann");
  const name = `排版${uniq(4)}`;
  const chat = await createAgentUi(ann.page, { name, persona: "你用 Markdown 回答。" });
  const asked = [];
  ann.page.on("request", (request) => asked.push(request.url()));

  await modelStub.reply(REPLY, { chunkSize: 16 });
  await sendText(ann.page, name, `排一下行程 ${uniq(4)}`);
  const reply = agentMessagesWith(chat, "三日行程");
  await expect(reply).toHaveCount(1);
  const body = reply.locator(".bubble");

  await expect(body.getByRole("heading", { name: "三日行程" })).toBeVisible();
  await expect(body.locator(".md-code code")).toHaveText('print("出发")');
  const table = body.getByRole("table");
  await expect(table.getByRole("cell", { name: "杭州" })).toBeVisible();
  await expect(table.getByRole("row")).toHaveCount(3);
  await expect(body.locator(".katex-display .katex")).toBeVisible();

  // The image is its alt text as a link, never an <img>; nothing asked the image's host for anything.
  await expect(body.locator("img")).toHaveCount(0);
  await expect(body.getByRole("link", { name: "西湖风景" })).toHaveAttribute("href", `https://${IMAGE_HOST}/west-lake.png`);
  // A link whose text is an address on another host says where it really goes.
  await expect(body.getByText("（实际指向 evil.example.net）")).toBeVisible();
  // Raw HTML is not markup: no <script> in the page from it, and it never ran.
  await expect(chat.locator("script")).toHaveCount(0);
  expect(await ann.page.evaluate(() => window.__markdownScript)).toBeUndefined();

  // (Give anything that would load a moment to try, and look at the shot meanwhile.)
  await capture(ann.page, "agent-chat-markdown");
  await ann.page.waitForTimeout(500);
  expect(asked.filter((url) => new URL(url).host === IMAGE_HOST), "requests to the image's host").toEqual([]);
});
