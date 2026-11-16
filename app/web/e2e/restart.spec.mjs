// spec §7.19: the service process is stopped and started again under two signed-in clients. They reconnect by
// themselves (no reload), catch up what was sent meanwhile, keep their history and go on chatting live.
import { test, expect } from "./support/fixtures.mjs";
import { befriend, sendApi, uniq } from "./support/accounts.mjs";
import { composer, expectOnce, expectStored, messagesWith, openChat, sendText } from "./support/app.mjs";
import { canControlService, startService, stopService } from "./support/control.mjs";

/** Reconnect backoff after a short outage, then catch-up. */
const RECONNECT_MS = 45_000;

test("spec §7.19: after a service restart the clients reconnect and continue; nothing is lost", async ({ people }) => {
  test.skip(!canControlService, "needs control of the service process (local mode)");
  const ann = await people.member("Ann");
  const bo = await people.member("Bo");
  const conversationId = await befriend(ann, bo);
  const annChat = await openChat(ann.page, bo.displayName);
  const boChat = await openChat(bo.page, ann.displayName);
  const tag = uniq(4);
  const before = [`重启前 Ann ${tag}`, `重启前 Bo ${tag}`];
  await sendText(ann.page, bo.displayName, before[0]);
  await sendText(bo.page, ann.displayName, before[1]);
  await expectStored(annChat, before[1]);
  for (const who of [ann, bo]) await who.page.evaluate(() => (window.__sameDocument = true));

  // The next socket each page opens is its reconnection (none can open while the service is down).
  const reconnected = Promise.all(
    [ann, bo].map((who) =>
      who.page.waitForEvent("websocket", { predicate: (ws) => new URL(ws.url()).pathname === "/api/ws", timeout: 2 * RECONNECT_MS }),
    ),
  );
  reconnected.catch(() => {}); // awaited below; a failure before then must not be an unhandled rejection
  const during = `服务停止时发的 ${tag}`;
  await stopService();
  try {
    await composer(annChat).fill(during);
    await composer(annChat).press("Enter");
    await expect(messagesWith(annChat, during).getByText("发送失败，未发布")).toBeVisible();
  } finally {
    await startService(); // also when the test fails here: the specs after it need the service
  }
  // Sent before the clients are back: reaches them by catch-up.
  const meanwhile = `重启后立刻发的 ${tag}`;
  await sendApi(bo, conversationId, meanwhile);
  await reconnected;
  await expect(messagesWith(annChat, meanwhile)).toHaveCount(1, { timeout: RECONNECT_MS });

  // Live again both ways, and the failed send goes through once on retry.
  const after = `重启之后 ${tag}`;
  await sendText(bo.page, ann.displayName, after);
  await expectStored(annChat, after);
  await messagesWith(annChat, during).getByRole("button", { name: "重试" }).click();
  await expectStored(annChat, during);
  await expectStored(boChat, during);

  for (const who of [ann, bo]) expect(await who.page.evaluate(() => window.__sameDocument), `${who.label}'s page was not reloaded`).toBe(true);
  for (const chat of [annChat, boChat]) for (const text of [...before, meanwhile, after, during]) await expectOnce(chat, text);
});
