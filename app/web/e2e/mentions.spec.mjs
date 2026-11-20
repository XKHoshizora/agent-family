// Task M in a real browser (Chromium): a mention picked from the @ list is a tag meaning the one picked. The composer
// keeps a textarea and draws each tag in a layer behind its text (Composer.jsx); these tests prove in a real layout
// engine that every tag's box lies on the very characters it covers — single line, wrapped, split across a wrap, after
// mixed CJK / Latin / emoji, scrolled inside a tall box, at phone width and at device scale factors 1.25 and 1.5 — that a
// tag deletes and edits as a unit, that the browser's own undo and redo and a real IME composition (Chrome's, through
// the DevTools protocol) keep the tags right, and that what is sent is stored, called and shown as picked. Screenshots
// (E2E_SHOTS=1) go to docs/acceptance/batch2-tools/shots/ as mentions-*.png.
import { test, expect } from "./support/fixtures.mjs";
import { befriend, createGroupApi, signInApi, uniq } from "./support/accounts.mjs";
import { agentMessagesWith, chatPane, composer, messageList, openChat, rail } from "./support/app.mjs";
import { canControlService } from "./support/control.mjs";
import { modelStub } from "./support/model-stub.mjs";
import { captureIn } from "./support/shots.mjs";

const shot = captureIn("batch2-tools");

test.beforeEach(async () => {
  test.skip(!canControlService, "needs the local service and its model stub");
  await modelStub.reset();
});

// --- setup through the API ------------------------------------------------------------------------------------------

const FREE = { source: "site", id: "e2e-free" };

/** Ann (who owns the Agent), Bo and Cy (Cy's display name `cyName` when given), a group of the three and Ann's Agent. */
async function world(people, { cyName, namePart = `ag_${uniq(8)}` } = {}) {
  const ann = await people.member("Ann");
  const bo = await people.member("Bo");
  const cy = await people.member("Cy", cyName ? { displayName: cyName } : {});
  await befriend(ann, bo);
  await befriend(ann, cy);
  const res = await ann.request.post("/api/agents", { data: { namePart, name: `答答${uniq(4)}`, model: FREE, persona: "简短地回答。" } });
  expect(res.status(), await res.text()).toBe(201);
  const agent = await res.json();
  const title = `提到${uniq(6)}`;
  const groupId = await createGroupApi(ann, [bo, cy], title);
  const added = await ann.request.post(`/api/conversations/${groupId}/members`, { data: { principalId: agent.id } });
  expect(added.status(), await added.text()).toBe(201);
  return { ann, bo, cy, agent, groupId, title };
}

/** The open group's composer box of `page`. */
const boxOf = (page, title) => composer(chatPane(page, title));

/**
 * Types `@` at the caret — after a space when the character before it is none, as the composer's @ button does (the list
 * opens for an `@` at the start or after white space) — and picks the member whose name is `name` from the list.
 */
async function pick(page, name) {
  const before = await page.evaluate(() => {
    const el = document.activeElement;
    return el?.value?.slice(0, el.selectionStart).slice(-1) ?? "";
  });
  await page.keyboard.type(before === "" || /\s/.test(before) ? "@" : " @");
  const option = page.getByRole("listbox", { name: "选择要提及的成员" }).getByRole("option").filter({ hasText: name });
  await expect(option.first()).toBeVisible();
  await option.first().click();
}

/** The tags the composer draws (its layer behind the text), as their text. */
const chips = (page) => page.locator(".composer-mirror .mention-chip").allTextContents();

/**
 * For every tag the composer draws: its boxes (one per line it is on) and the boxes of the same characters as the
 * textarea lays them out — measured with a Range in a clone made from the textarea's own computed style (not the
 * layer's), placed where the textarea is and scrolled as it is. Also the tag's text and where it is in the box's value.
 */
function measureTags() {
  const box = document.querySelector(".composer textarea");
  const mirror = document.querySelector(".composer-mirror");
  const cs = getComputedStyle(box);
  const clone = document.createElement("div");
  for (const p of [
    "boxSizing", "width", "height", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "borderTopWidth", "borderRightWidth",
    "borderBottomWidth", "borderLeftWidth", "borderTopStyle", "borderRightStyle", "borderBottomStyle", "borderLeftStyle", "fontFamily",
    "fontSize", "fontWeight", "fontStyle", "fontVariant", "fontStretch", "fontKerning", "fontFeatureSettings", "lineHeight", "letterSpacing",
    "wordSpacing", "textIndent", "textTransform", "tabSize", "whiteSpace", "overflowWrap", "wordBreak", "lineBreak", "direction", "textAlign",
    "scrollbarWidth", "scrollbarGutter", "overflowX", "overflowY",
  ]) clone.style[p] = cs[p];
  const at = box.getBoundingClientRect();
  Object.assign(clone.style, { position: "fixed", left: `${at.left}px`, top: `${at.top}px`, margin: "0", visibility: "hidden", zIndex: "-1" });
  // (The textarea keeps a line for its caret after a final line break; so does the layer, with the same character.)
  clone.textContent = `${box.value}\u200b`;
  document.body.append(clone);
  clone.scrollTop = box.scrollTop;
  const textNode = clone.firstChild;
  // One box per line: a Range may give a line several boxes (a run of another font, the space a line ends with), an
  // element one per line; the boxes of a line (overlapping in height) are put together.
  const rects = (list) => {
    const lines = [];
    for (const r of [...list].filter((b) => b.width > 0.5)) {
      const line = lines.find((l) => r.top < l.bottom - 1 && r.bottom > l.top + 1);
      if (!line) lines.push({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });
      else Object.assign(line, { left: Math.min(line.left, r.left), right: Math.max(line.right, r.right), top: Math.min(line.top, r.top), bottom: Math.max(line.bottom, r.bottom) });
    }
    return lines.sort((a, b) => a.top - b.top).map((l) => ({ x: l.left, y: l.top, w: l.right - l.left, h: l.bottom - l.top }));
  };
  const tags = [];
  let offset = 0;
  for (const node of mirror.childNodes) {
    const text = node.textContent;
    if (node.nodeType === 1 && node.classList.contains("mention-chip")) {
      const range = document.createRange();
      range.setStart(textNode, offset);
      range.setEnd(textNode, offset + text.length);
      tags.push({ text, start: offset, same: box.value.slice(offset, offset + text.length) === text, drawn: rects(node.getClientRects()), laid: rects(range.getClientRects()) });
    }
    offset += text.replace(/\u200b$/, "").length;
  }
  clone.remove();
  return { tags, scrollTop: box.scrollTop, mirrorScrollTop: mirror.scrollTop, boxTop: at.top, lineHeight: parseFloat(cs.lineHeight) };
}

/**
 * Every drawn tag lies on its own characters: the same text, the same number of line boxes, and each box within 1.5 px
 * of the characters' box (x, y, width, height). Resolves with the measurement.
 */
async function expectTagsAligned(page, label) {
  const m = await page.evaluate(measureTags);
  expect(m.tags.length, `${label}: tags drawn`).toBeGreaterThan(0);
  expect(m.mirrorScrollTop, `${label}: the layer scrolled with the box`).toBeCloseTo(m.scrollTop, 0);
  for (const tag of m.tags) {
    expect(tag.same, `${label}: ${tag.text} is drawn over the same characters`).toBe(true);
    expect(tag.drawn.length, `${label}: ${tag.text} line boxes`).toBe(tag.laid.length);
    tag.drawn.forEach((d, i) => {
      const l = tag.laid[i];
      for (const k of ["x", "y", "w", "h"]) expect(Math.abs(d[k] - l[k]), `${label}: ${tag.text} box ${i} ${k} (drawn ${d[k]}, text ${l[k]})`).toBeLessThanOrEqual(1.5);
    });
  }
  return m;
}

/** Clears the box (select all, delete). */
async function clearBox(page, box) {
  await box.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("Delete");
  await expect(box).toHaveValue("");
}

/** The stored messages of the group, through `person`'s API, newest last. */
async function storedMessages(person, groupId) {
  const res = await person.request.get(`/api/conversations/${groupId}/messages`);
  expect(res.ok()).toBe(true);
  return (await res.json()).messages;
}

// --- 1. where the tags are drawn --------------------------------------------------------------------------------------

test("each tag is drawn exactly over its characters: one line, wrapped, split across a wrap, after CJK/Latin/emoji, scrolled, at phone width", async ({ people }) => {
  const { ann, bo, agent, title } = await world(people, { cyName: "Jarvis Lee" });
  const page = ann.page;
  await openChat(page, title);
  const box = boxOf(page, title);

  // One line: a person and the Agent.
  await box.click();
  await page.keyboard.type("你好 ");
  await pick(page, bo.displayName);
  await page.keyboard.type("和 ");
  await pick(page, agent.name);
  expect(await chips(page)).toEqual([`@${bo.displayName}`, `@${agent.name}`]);
  await expect(box).toHaveValue(`你好 @${bo.displayName} 和 @${agent.name} `);
  await expectTagsAligned(page, "one line");
  await shot(page, "mentions-composer");

  // Wrapped: text long enough that both tags are on a later line.
  await clearBox(page, box);
  await page.keyboard.insertText("这一段文字很长，长到会在输入框里折行。".repeat(4));
  await pick(page, bo.displayName);
  await pick(page, agent.name);
  const wrapped = await expectTagsAligned(page, "wrapped");
  expect(wrapped.tags[0].drawn[0].y, "the tag sits below the first line").toBeGreaterThan(wrapped.boxTop + wrapped.lineHeight);

  // Mixed CJK, Latin and emoji right before the tag.
  await clearBox(page, box);
  await page.keyboard.insertText("混合 Mixed text 😀🎉👩‍💻 文字ABC");
  await pick(page, "Jarvis Lee");
  await expectTagsAligned(page, "after CJK, Latin and emoji");

  // Split across a wrap: text is put before the tag until the tag is on two lines.
  await clearBox(page, box);
  await pick(page, "Jarvis Lee");
  let split = false;
  for (let i = 0; i < 200 && !split; i += 1) {
    await box.press("ControlOrMeta+Home");
    await page.keyboard.insertText(i % 2 ? "字" : "a");
    split = (await page.evaluate(() => document.querySelector(".composer-mirror .mention-chip").getClientRects().length)) > 1;
  }
  expect(split, "a tag of two words came to sit across a wrap").toBe(true);
  const across = await expectTagsAligned(page, "split across a wrap");
  expect(across.tags[0].drawn).toHaveLength(2);

  // Scrolled inside a tall box: more lines than the box shows, a tag near the top and one at the end.
  await clearBox(page, box);
  await pick(page, bo.displayName);
  await page.keyboard.insertText(Array.from({ length: 40 }, (_, i) => `第 ${i + 1} 行`).join("\n"));
  await page.keyboard.insertText("\n");
  await pick(page, agent.name);
  const end = await expectTagsAligned(page, "scrolled to the end");
  expect(end.scrollTop, "the box scrolled").toBeGreaterThan(0);
  await box.evaluate((el) => {
    el.scrollTop = Math.floor((el.scrollHeight - el.clientHeight) / 2);
  });
  await page.waitForTimeout(100);
  await expectTagsAligned(page, "scrolled to the middle");
  await box.evaluate((el) => {
    el.scrollTop = 0;
  });
  await page.waitForTimeout(100);
  await expectTagsAligned(page, "scrolled to the top");

  // Phone width: the phone's type and padding for both.
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(box).toBeVisible();
  await clearBox(page, box);
  await page.keyboard.type("手机上 ");
  await pick(page, bo.displayName);
  await page.keyboard.insertText("，然后很长很长很长很长很长很长的一段话，");
  await pick(page, "Jarvis Lee");
  await pick(page, agent.name);
  await expectTagsAligned(page, "phone width");
  await page.setViewportSize({ width: 1280, height: 860 });
});

for (const scale of [1.25, 1.5]) {
  test(`at device scale factor ${scale} each tag is still drawn over its characters`, async ({ people, browser }) => {
    const { ann, bo, agent, title } = await world(people, { cyName: "Jarvis Lee" });
    const context = await browser.newContext({ deviceScaleFactor: scale, viewport: { width: 1280, height: 860 }, locale: "zh-CN" });
    try {
      await signInApi(context.request, ann);
      const page = await context.newPage();
      await page.goto("/");
      await expect(rail(page)).toBeVisible();
      await openChat(page, title);
      const box = boxOf(page, title);
      await box.click();
      await page.keyboard.insertText("缩放 Zoom 😀 ");
      await pick(page, bo.displayName);
      await page.keyboard.insertText("这一段文字很长，长到会在输入框里折行。".repeat(3));
      await pick(page, "Jarvis Lee");
      await pick(page, agent.name);
      await expectTagsAligned(page, `scale ${scale}`);
      await page.setViewportSize({ width: 375, height: 812 });
      await expectTagsAligned(page, `scale ${scale}, phone width`);
    } finally {
      await context.close();
    }
  });
}

// --- 2. a tag is one piece ------------------------------------------------------------------------------------------

test("Backspace at a tag's right edge takes the whole tag; a click inside a tag leaves the caret at an edge; typing with the caret put inside takes the tag whole", async ({ people }) => {
  const { ann, bo, title } = await world(people);
  const page = ann.page;
  await openChat(page, title);
  const box = boxOf(page, title);
  const tag = `@${bo.displayName}`;

  await box.click();
  await page.keyboard.type("你好 ");
  await pick(page, bo.displayName);
  await expect(box).toHaveValue(`你好 ${tag} `);
  await page.keyboard.press("Backspace"); // the space after it
  await expect(box).toHaveValue(`你好 ${tag}`);
  await page.keyboard.press("Backspace"); // the tag, whole
  await expect(box).toHaveValue("你好 ");
  expect(await chips(page)).toEqual([]);

  // A click into the middle of the tag: the caret goes to one of its edges.
  await pick(page, bo.displayName);
  await page.keyboard.type("吗");
  const chip = page.locator(".composer-mirror .mention-chip");
  const r = await chip.evaluate((el) => el.getBoundingClientRect().toJSON());
  await page.mouse.click(r.x + r.width / 2, r.y + r.height / 2);
  const caret = await box.evaluate((el) => [el.selectionStart, el.selectionEnd]);
  expect([3, 3 + tag.length], `the caret (${caret}) is at an edge of the tag`).toContain(caret[0]);
  expect(caret[1]).toBe(caret[0]);

  // The caret put inside the tag by a script (no click, no key): typing there takes the tag whole, keeps what was typed.
  await box.evaluate((el) => el.setSelectionRange(5, 5));
  await page.keyboard.type("x");
  await expect(box).toHaveValue("你好 x 吗");
  expect(await chips(page)).toEqual([]);
});

// --- 3. undo and redo (the browser's own editing: execCommand) --------------------------------------------------------

test("undo takes a picked tag back out, redo puts it back as the tag it was; undo after deleting a tag brings it back", async ({ people }) => {
  const { ann, bo, groupId, title } = await world(people);
  const page = ann.page;
  await openChat(page, title);
  const box = boxOf(page, title);
  const tag = `@${bo.displayName}`;
  await box.click();
  await page.keyboard.type("你好 ");
  await pick(page, bo.displayName);
  await expect(box).toHaveValue(`你好 ${tag} `);
  expect(await chips(page)).toEqual([tag]);

  await page.keyboard.press("ControlOrMeta+Z");
  await expect(box).toHaveValue("你好 @");
  expect(await chips(page)).toEqual([]);
  await page.keyboard.press("ControlOrMeta+Shift+Z");
  await expect(box).toHaveValue(`你好 ${tag} `);
  expect(await chips(page)).toEqual([tag]);
  await expectTagsAligned(page, "after redo");

  // Deleted with Backspace, then undone: the tag is back, with its id (the send carries it).
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await expect(box).toHaveValue("你好 ");
  await page.keyboard.press("ControlOrMeta+Z");
  // (Chrome may undo the two deletions as one step: the space comes back too.)
  await expect(box).toHaveValue(new RegExp(`^你好 ${tag} ?$`));
  expect(await chips(page)).toEqual([tag]);
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await expect(messageList(chatPane(page, title)).locator("li.msg.mine[data-msg^='m'] .mention")).toHaveCount(1);
  expect((await storedMessages(ann, groupId)).at(-1).mentions).toEqual([{ id: bo.id, start: 3, length: tag.length }]);
});

// --- 4. a real IME composition next to a tag ------------------------------------------------------------------------

test("an IME composition (Chrome's, through the DevTools protocol) right before and right after a tag keeps its range and duplicates nothing", async ({ people }) => {
  const { ann, bo, groupId, title } = await world(people);
  const page = ann.page;
  await openChat(page, title);
  const box = boxOf(page, title);
  const tag = `@${bo.displayName}`;
  const ime = await page.context().newCDPSession(page);
  /** Composes `steps` (each the composition's text so far), then commits `done`. */
  const compose = async (steps, done) => {
    for (const text of steps) await ime.send("Input.imeSetComposition", { text, selectionStart: text.length, selectionEnd: text.length });
    await ime.send("Input.insertText", { text: done });
  };

  await box.click();
  await pick(page, bo.displayName);
  await page.keyboard.press("Backspace"); // no space after it: the caret right at its end
  await expect(box).toHaveValue(tag);
  // Right after it.
  await compose(["n", "ni", "nih", "niha", "nihao"], "你好");
  await expect(box).toHaveValue(`${tag}你好`);
  expect(await chips(page)).toEqual([tag]);
  // Right before it.
  await box.evaluate((el) => el.setSelectionRange(0, 0));
  await compose(["w", "wo"], "我");
  await expect(box).toHaveValue(`我${tag}你好`);
  expect(await chips(page)).toEqual([tag]);
  await expectTagsAligned(page, "after composing");
  await page.keyboard.press("Enter");
  await expect(messageList(chatPane(page, title)).locator("li.msg.mine[data-msg^='m'] .mention")).toHaveCount(1);
  const last = (await storedMessages(ann, groupId)).at(-1);
  expect(last.text).toBe(`我${tag}你好`);
  expect(last.mentions).toEqual([{ id: bo.id, start: 1, length: tag.length }]);
});

test("an IME composition inside a tag keeps what was composed and takes the tag; a tap on 发送 with the composition open sends no piece of the tag (fix round 2, M-3)", async ({ people }) => {
  const { ann, bo, groupId, title } = await world(people);
  const page = ann.page;
  await openChat(page, title);
  const box = boxOf(page, title);
  const tag = `@${bo.displayName}`;
  const ime = await page.context().newCDPSession(page);
  const composing = async (steps) => {
    for (const text of steps) await ime.send("Input.imeSetComposition", { text, selectionStart: text.length, selectionEnd: text.length });
  };

  // Composed and committed inside the tag (the caret put there by a script: a click or a key would not leave it there).
  await box.click();
  await page.keyboard.type("你好 ");
  await pick(page, bo.displayName);
  await box.evaluate((el) => el.setSelectionRange(5, 5));
  await composing(["h", "ha"]);
  await ime.send("Input.insertText", { text: "哈" });
  await expect(box).toHaveValue("你好 哈 ");
  expect(await chips(page)).toEqual([]);
  expect(await box.evaluate((el) => [el.selectionStart, el.selectionEnd])).toEqual([4, 4]);

  // Composing inside a tag, then 发送 tapped before the composition is committed.
  await clearBox(page, box);
  await page.keyboard.type("再见 ");
  await pick(page, bo.displayName);
  await box.evaluate((el) => el.setSelectionRange(5, 5));
  await composing(["z", "zai"]);
  await chatPane(page, title).getByRole("button", { name: "发送", exact: true }).click();
  await expect(box).toHaveValue("");
  await expect(messageList(chatPane(page, title)).locator("li.msg.mine[data-msg^='m']").filter({ hasText: "再见" })).toHaveCount(1);
  const last = (await storedMessages(ann, groupId)).at(-1);
  // What was composed is sent as it stood (Chrome commits it when the box loses focus); no piece of the tag is.
  expect(last.text).toBe("再见 zai");
  expect(last.mentions ?? null).toBeNull();
});

// --- 5. what is sent ------------------------------------------------------------------------------------------------

test("sent: stored with its mentions; the picked Agent replies, the picked person starts nothing; both browsers show the tags", async ({ people }) => {
  const { ann, bo, agent, groupId, title } = await world(people);
  const page = ann.page;
  const annChat = await openChat(page, title);
  const boChat = await openChat(bo.page, title);
  await modelStub.reply("收到，我来看看。");
  const box = boxOf(page, title);
  await box.click();
  await pick(page, bo.displayName);
  await pick(page, agent.name);
  await page.keyboard.type("帮忙看看");
  await page.keyboard.press("Enter");
  await expect(messageList(annChat).locator("li.msg.mine[data-msg^='m']").filter({ hasText: "帮忙看看" })).toHaveCount(1);

  const stored = (await storedMessages(ann, groupId)).find((m) => m.text.endsWith("帮忙看看"));
  expect(stored.mentions).toEqual([
    { id: bo.id, start: 0, length: bo.displayName.length + 1 },
    { id: agent.id, start: bo.displayName.length + 2, length: agent.name.length + 1 },
  ]);
  await modelStub.waitForCalls(1);
  await expect(agentMessagesWith(annChat, "收到，我来看看。")).toHaveCount(1);
  await page.waitForTimeout(1500);
  expect(await modelStub.calls(), "one model call: the Agent's; the person called nothing").toHaveLength(1);

  for (const [who, chat] of [
    ["sender", annChat],
    ["member", boChat],
  ]) {
    const mine = messageList(chat).locator(`li.msg[data-msg="m${stored.seq}"]`);
    const tags = mine.locator(".mention");
    await expect(tags, `${who} sees two tags`).toHaveCount(2);
    await expect(tags.nth(0).locator('[aria-hidden="true"]')).toHaveText(`@${bo.displayName}`);
    await expect(tags.nth(1)).toHaveClass(/mention-agent/);
    await expect(tags.nth(1)).toHaveAttribute("title", new RegExp(`^${agent.name} · Agent · 主人：`));
  }
  await shot(bo.page, "mentions-message", { show: messageList(boChat).locator(`li.msg[data-msg="m${stored.seq}"]`) });
});

// --- 6. a name of two words -----------------------------------------------------------------------------------------

test("a person named 「Jarvis Lee」 picked is one tag and calls no Agent, though an Agent of name part jarvis is in the group", async ({ people }) => {
  const { ann, cy, groupId, title } = await world(people, { cyName: "Jarvis Lee", namePart: "jarvis" });
  const page = ann.page;
  await openChat(page, title);
  const box = boxOf(page, title);
  await box.click();
  await pick(page, "Jarvis Lee");
  expect(await chips(page)).toEqual(["@Jarvis Lee"]);
  await page.keyboard.type("明天见");
  await page.keyboard.press("Enter");
  await expect(messageList(chatPane(page, title)).locator("li.msg.mine[data-msg^='m'] .mention")).toHaveCount(1);
  const last = (await storedMessages(ann, groupId)).at(-1);
  expect(last.mentions).toEqual([{ id: cy.id, start: 0, length: 11 }]);
  await page.waitForTimeout(2500);
  expect(await modelStub.calls(), "no Agent was called").toHaveLength(0);
});

// --- 7. an address in a reply ---------------------------------------------------------------------------------------

test("a URL with /@name in an Agent's reply is a link whose href is exactly the URL, with no tag in it", async ({ people }) => {
  const { ann, bo, agent, title } = await world(people);
  const page = ann.page;
  const chat = await openChat(page, title);
  const url = `https://example.com/@${bo.handle}`;
  const target = `https://x.example/u/@${bo.handle}`;
  await modelStub.reply(`主页 ${url} 和 [这里](${target}) @${bo.handle}`);
  const box = boxOf(page, title);
  await box.click();
  await pick(page, agent.name);
  await page.keyboard.type("给个链接");
  await page.keyboard.press("Enter");
  const reply = agentMessagesWith(chat, "主页");
  await expect(reply).toHaveCount(1);
  await expect(reply.locator(".md a").first()).toBeVisible();
  const hrefs = await reply.locator(".md a").evaluateAll((links) => links.map((a) => a.getAttribute("href")));
  expect(hrefs).toEqual([url, target]);
  await expect(reply.locator(".md a .mention")).toHaveCount(0);
  // The handle outside the addresses is the one mention.
  await expect(reply.locator(".mention")).toHaveCount(1);
});
