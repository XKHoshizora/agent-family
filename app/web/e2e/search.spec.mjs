// Global search finds a Chinese fragment in an older message and jumps to it; in-conversation search hides the
// list while its results show and gives it back where it was (at the newest messages, or scrolled up).
import { test, expect } from "./support/fixtures.mjs";
import { befriend, sendApi, uniq } from "./support/accounts.mjs";
import { chatPane, expectStored, hitFor, messageList, messagesWith, openChat, scrollState, searchEverywhere, sendText } from "./support/app.mjs";

const HAN = "春夏秋冬山水风云花月星河林海雪雨松竹梅兰江湖日光";
/** Chinese characters no other test writes: the fragment is found only where this test put it. */
const hanTag = (n = 4) => Array.from({ length: n }, () => HAN[Math.floor(Math.random() * HAN.length)]).join("");

/** Ann and Bo with `target` followed by `count` more messages (so the target is older than the first load holds). */
async function chatWithHistory(people, target, count) {
  const ann = await people.member("Ann", { open: false });
  const bo = await people.member("Bo", { open: false });
  const conversationId = await befriend(ann, bo);
  if (target) await sendApi(bo, conversationId, target);
  for (let i = 1; i <= count; i += 1) await sendApi(i % 2 ? ann : bo, conversationId, `填充消息 第${i}条，只是为了让历史变长一些`);
  ann.page = await people.openApp(ann);
  bo.page = await people.openApp(bo);
  return { ann, bo };
}

test("global search finds a Chinese fragment in an older message and jumps to it", async ({ people }) => {
  const han = hanTag();
  const target = `周末一起去${han}爬山吧，记得带水`;
  const fragment = `去${han}爬山`;
  const { ann, bo } = await chatWithHistory(people, target, 45);

  await searchEverywhere(ann.page, fragment);
  const hit = hitFor(ann.page, fragment);
  await expect(hit).toHaveCount(1);
  await expect(hit).toContainText(bo.displayName);
  await hit.click();

  const chat = chatPane(ann.page, bo.displayName);
  await expect(chat).toBeVisible();
  await expect(messagesWith(chat, target)).toBeInViewport();
});

test("closing in-conversation search keeps the list where it was: at the newest message, or scrolled up", async ({ people }) => {
  const { ann, bo } = await chatWithHistory(people, null, 45);
  await openChat(bo.page, ann.displayName);
  const chat = await openChat(ann.page, bo.displayName);
  const search = chat.getByRole("textbox", { name: "在本会话中搜索" });
  const results = chat.getByRole("list", { name: "搜索结果" });
  await expect.poll(async () => (await scrollState(chat)).fromBottom).toBeLessThanOrEqual(1);

  // At the newest message: a message that arrives while the results cover the list is shown on return.
  await chat.getByRole("button", { name: "搜索本会话" }).click();
  await search.fill("填充消息");
  await expect(results.getByRole("button").first()).toBeVisible();
  await expect(messageList(chat)).toBeHidden();
  const late = `搜索时到的新消息 ${uniq(4)}`;
  await sendText(bo.page, ann.displayName, late);
  await chat.getByRole("button", { name: "关闭会话搜索" }).click();
  await expectStored(chat, late);
  await expect.poll(async () => (await scrollState(chat)).fromBottom).toBeLessThanOrEqual(1);

  // Scrolled up: the same position afterwards.
  const top = await messageList(chat).evaluate(
    (list) =>
      new Promise((resolve) => {
        list.addEventListener("scroll", () => resolve(list.scrollTop), { once: true });
        list.scrollTop = Math.floor((list.scrollHeight - list.clientHeight) / 2);
      }),
  );
  expect(top).toBeGreaterThan(200);
  await chat.getByRole("button", { name: "搜索本会话" }).click();
  await search.fill("第1条");
  await expect(results.getByRole("button").first()).toBeVisible();
  await chat.getByRole("button", { name: "关闭会话搜索" }).click();
  await expect(messageList(chat)).toBeVisible();
  await expect.poll(async () => Math.abs((await scrollState(chat)).top - top)).toBeLessThanOrEqual(1);
});
