// spec §7.5: the network goes away and comes back. What the peer sent meanwhile arrives exactly once (catch-up),
// and a send that failed is stored exactly once after the retry — also when the service stored it and only its
// answer was lost.
import { test, expect } from "./support/fixtures.mjs";
import { uniq } from "./support/accounts.mjs";
import { composer, expectStored, messageList, messagesWith, openChat, sendText } from "./support/app.mjs";

/** Waits long enough for the client's reconnect backoff (up to 8 s after a short outage) and its catch-up. */
const RECONNECT_MS = 45_000;

test("spec §7.5: offline, the peer's five messages arrive once; the failed send, retried, is stored once", async ({ people }) => {
  const [ann, bo] = await people.friendsOf(["Ann", "Bo"]);
  const annChat = await openChat(ann.page, bo.displayName);
  const boChat = await openChat(bo.page, ann.displayName);
  const tag = uniq(4);
  await sendText(bo.page, ann.displayName, `在线 ${tag}`);
  await expectStored(annChat, `在线 ${tag}`);

  await ann.context.setOffline(true);
  const burst = Array.from({ length: 5 }, (_, i) => `离线期间第${i + 1}条 ${tag}`);
  for (const text of burst) await sendText(bo.page, ann.displayName, text);
  const mine = `我断网时发的 ${tag}`;
  await composer(annChat).fill(mine);
  await composer(annChat).press("Enter");
  const failed = messagesWith(annChat, mine);
  await expect(failed.getByText("发送失败，未发布")).toBeVisible();
  await expect(messagesWith(annChat, "离线期间")).toHaveCount(0);

  await ann.context.setOffline(false);
  for (const text of burst) await expect(messagesWith(annChat, text)).toHaveCount(1, { timeout: RECONNECT_MS });
  const order = (await messageList(annChat).getByRole("listitem").allInnerTexts()).filter((t) => t.includes("离线期间"));
  expect(order.map((t) => burst.findIndex((b) => t.includes(b)))).toEqual([0, 1, 2, 3, 4]);

  await failed.getByRole("button", { name: "重试" }).click();
  await expectStored(annChat, mine);
  await expectStored(boChat, mine);

  // After reloads, still exactly one of each.
  for (const who of [ann, bo]) {
    await who.page.reload();
    const chat = await openChat(who.page, who === ann ? bo.displayName : ann.displayName);
    for (const text of [...burst, mine]) await expect(messagesWith(chat, text)).toHaveCount(1);
  }
});

test("spec §7.5: a send whose answer was lost is stored once after the retry", async ({ people }) => {
  const [ann, bo] = await people.friendsOf(["Ann", "Bo"]);
  const annChat = await openChat(ann.page, bo.displayName);
  const boChat = await openChat(bo.page, ann.displayName);
  const text = `答复丢了的消息 ${uniq(4)}`;

  // The request reaches the service and is stored; its answer never reaches the browser.
  await ann.page.route(
    "**/api/conversations/*/messages",
    async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      await route.fetch();
      return route.abort("connectionreset");
    },
    { times: 1 },
  );
  await composer(annChat).fill(text);
  await composer(annChat).press("Enter");
  await expect(messagesWith(annChat, text).getByText("发送失败，未发布")).toBeVisible();
  await expectStored(boChat, text);

  await messagesWith(annChat, text).getByRole("button", { name: "重试" }).click();
  await expectStored(annChat, text);
  await bo.page.reload();
  await expect(messagesWith(await openChat(bo.page, ann.displayName), text)).toHaveCount(1);
});
