// An avatar set in Settings is the picture a friend sees, also on a page they already have open.
import { test, expect } from "./support/fixtures.mjs";
import { befriend } from "./support/accounts.mjs";
import { chatPane, goTo, openChat, rail } from "./support/app.mjs";
import { png } from "./support/files.mjs";

/** The picture inside an avatar labelled `name` (the first one on the page), once it has loaded. */
async function expectPicture(page, name, [width, height]) {
  const picture = page.getByRole("img", { name, exact: true }).first().locator("img");
  await expect(picture).toBeVisible();
  await expect.poll(() => picture.evaluate((img) => [img.naturalWidth, img.naturalHeight])).toEqual([width, height]);
  return picture;
}

test("the avatar set in Settings is seen by a friend", async ({ people }) => {
  const ann = await people.member("Ann");
  const bo = await people.member("Bo", { open: false });
  await befriend(ann, bo);
  const picture = png(40, 30);

  await goTo(ann.page, "设置");
  const chooser = ann.page.waitForEvent("filechooser");
  await ann.page.getByRole("button", { name: "更换头像" }).click();
  await (await chooser).setFiles({ name: "我的头像.png", mimeType: "image/png", buffer: picture });
  await expect(ann.page.getByRole("img", { name: "新头像预览" })).toBeVisible();
  await ann.page.getByRole("button", { name: "保存头像" }).click();
  await expect(ann.page.getByRole("status").filter({ hasText: "头像已更新" })).toBeVisible();
  await expectPicture(rail(ann.page), "你", [40, 30]);

  // Bo's app shows Ann's new picture (40×30, not the generated 128×128 one), and it is the uploaded file.
  bo.page = await people.openApp(bo);
  await goTo(bo.page, "通讯录");
  const shown = await expectPicture(bo.page, ann.displayName, [40, 30]);
  const src = await shown.getAttribute("src");
  const served = await bo.request.get(src);
  expect(served.headers()["content-type"]).toBe("image/png");
  expect(Buffer.compare(await served.body(), picture), "Bo gets the uploaded bytes").toBe(0);
});

/** Settings → 更换头像 → `picture` → 保存头像, in `page`. */
async function changeAvatar(page, picture) {
  await goTo(page, "设置");
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "更换头像" }).click();
  await (await chooser).setFiles({ name: "新头像.png", mimeType: "image/png", buffer: picture });
  await page.getByRole("button", { name: "保存头像" }).click();
  await expect(page.getByRole("status").filter({ hasText: "头像已更新" })).toBeVisible();
}

test("spec 6.11 item 1: a friend's open page shows my new avatar at once, without a reload", async ({ people }) => {
  const ann = await people.member("Ann");
  const bo = await people.member("Bo");
  await befriend(ann, bo);
  // Bo has his chat with Ann open: her picture is in its header and in his conversation list.
  await openChat(bo.page, ann.displayName);
  await bo.page.evaluate(() => (window.__sameDocument = true));
  const pictures = bo.page.getByRole("img", { name: ann.displayName, exact: true }).locator("img");
  await expect.poll(() => pictures.count()).toBeGreaterThanOrEqual(2);
  const sizes = () => pictures.evaluateAll((imgs) => imgs.map((img) => (img.complete ? [img.naturalWidth, img.naturalHeight] : null)));
  await expect.poll(sizes, { message: "the generated avatar, everywhere" }).toEqual(Array((await pictures.count())).fill([128, 128]));

  await changeAvatar(ann.page, png(40, 30));

  // Every picture of Ann on Bo's open page is the new one, and the page was not reloaded.
  await expect.poll(sizes, { message: "the new avatar, everywhere" }).toEqual(Array((await pictures.count())).fill([40, 30]));
  await expect(chatPane(bo.page, ann.displayName)).toBeVisible();
  expect(await bo.page.evaluate(() => window.__sameDocument), "Bo's page was not reloaded").toBe(true);
});
