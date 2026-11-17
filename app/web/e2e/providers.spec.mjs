// A person's own model providers in a real browser. The provider that answers is the local model stub
// (support/model-stub.mjs) at http://127.0.0.1, an address the form itself refuses (it asks for https, its own check
// before any request, also when editing): that provider is added through the API with the page's session, and
// everything after that is done in the page — 测试连接, 从供应商读取, an Agent choosing its model and answering with it.
// The form's own handling of a typed key is then shown on providers at an https address that is never called: a key
// typed in reaches the service once and stays nowhere in the page or the browser's storage.
import { randomBytes } from "node:crypto";
import { test, expect } from "./support/fixtures.mjs";
import { uniq } from "./support/accounts.mjs";
import { createAgentUi, expectStored, goTo, sendText } from "./support/app.mjs";
import { canControlService } from "./support/control.mjs";
import { STUB_MODELS, modelStub } from "./support/model-stub.mjs";
import { capture } from "./support/shots.mjs";

test.beforeEach(async () => {
  test.skip(!canControlService, "needs the local service and its model stub");
  await modelStub.reset();
});

/** A fake key, different every time (the stub takes any). */
const fakeKey = () => `sk-e2e-${randomBytes(12).toString("hex")}`;
/** An https address that is only stored, never called (the service checks an address when it calls it). */
const NEVER_CALLED = "https://api.example.test/v1";

/** Settings › 模型供应商. */
async function openProviders(page) {
  await goTo(page, "设置");
  await page.getByRole("button", { name: /模型供应商/ }).click();
  const section = page.getByRole("region", { name: "模型供应商" });
  await expect(section.getByRole("heading", { name: "我的模型供应商" })).toBeVisible();
  return section;
}

const providerRow = (section, name) => section.getByRole("list", { name: "我的模型供应商" }).getByRole("listitem").filter({ hasText: name });
const toast = (page, text) => page.getByRole("status").filter({ hasText: text });
const editForm = (page) => page.getByRole("region", { name: "编辑模型供应商" });

/** Everything of the page a key could be left in: the markup, every field's value, and both storages. */
const leftovers = (page) =>
  page.evaluate(() => {
    const values = [...document.querySelectorAll("input, textarea, select")].map((e) => e.value);
    const stored = (s) => Object.keys(s).map((k) => `${k}=${s.getItem(k)}`);
    return [document.documentElement.outerHTML, ...values, ...stored(localStorage), ...stored(sessionStorage)].join("\n");
  });

test("my own provider: 测试连接 and 从供应商读取 reach it with its key; an Agent on its model answers through it; the key is nowhere in the page", async ({ people }) => {
  const ann = await people.member("Ann");
  const name = `我的演示供应商${uniq(4)}`;
  const key = fakeKey();
  const added = await ann.request.post("/api/providers", { data: { name, protocol: "openai_chat", baseUrl: modelStub.baseUrl, apiKey: key } });
  expect(added.status(), await added.text()).toBe(201);

  const section = await openProviders(ann.page);
  const row = providerRow(section, name);
  await expect(row).toContainText(`密钥 …${key.slice(-4)}`);
  await expect(row).toContainText("还没有模型");

  // 测试连接: the provider is asked for its model list, with the key.
  await row.getByRole("button", { name: "测试连接" }).click();
  await expect(row.getByRole("status")).toHaveText("连接成功，供应商正常回应。");
  const listing = () => modelStub.state().then((s) => s.requests.filter((r) => r.method === "GET").map((r) => [r.path, r.authorization]));
  expect(await listing()).toEqual([["/v1/models", `Bearer ${key}`]]);

  // 从供应商读取 (in its form) lists the provider's models; the service keeps them.
  await row.getByRole("button", { name: "编辑" }).click();
  const form = editForm(ann.page);
  await form.getByRole("button", { name: "从供应商读取" }).click();
  await expect(form.getByRole("status").filter({ hasText: "找到" })).toHaveText(`找到 ${STUB_MODELS.length} 个模型，已把其中 ${STUB_MODELS.length} 个新的加入列表。`);
  await expect(form.getByRole("list", { name: "模型列表" }).getByRole("listitem")).toHaveCount(STUB_MODELS.length);
  expect(await listing()).toHaveLength(2);
  await form.getByRole("button", { name: "返回" }).click();
  await expect(row).toContainText(`${STUB_MODELS.length} 个模型`);

  // An Agent on the provider's first model answers through it, with that key.
  const agent = `自带模型${uniq(4)}`;
  await modelStub.reply("这是供应商模型的回答。");
  const chat = await createAgentUi(ann.page, { name: agent, model: STUB_MODELS[0], persona: "你是一个用自己供应商的助手。" });
  await sendText(ann.page, agent, `你好 ${uniq(4)}`);
  await expectStored(chat, "这是供应商模型的回答。");
  const [call] = await modelStub.calls();
  expect([call.path, call.authorization, call.body.model]).toEqual(["/v1/chat/completions", `Bearer ${key}`, STUB_MODELS[0]]);

  // The key never came back to the page: not in it, not in its storage, also after a reload.
  expect(await leftovers(ann.page)).not.toContain(key);
  await ann.page.reload();
  await openProviders(ann.page);
  expect(await leftovers(ann.page)).not.toContain(key);
});

test("keys typed into the form are sent once and kept nowhere; a save refused with a new key asks for it again; 保留原密钥 with nothing else changed says so", async ({ people }) => {
  const ann = await people.member("Ann");
  const tag = uniq(4);
  const main = `主力供应商${tag}`;
  const spare = `备用供应商${tag}`;
  const keys = [fakeKey(), fakeKey(), fakeKey()];
  const section = await openProviders(ann.page);

  // Two providers added in the form.
  for (const [i, name] of [main, spare].entries()) {
    await section.getByRole("button", { name: "添加供应商" }).click();
    const add = ann.page.getByRole("region", { name: "添加模型供应商" });
    await add.getByLabel("名称", { exact: true }).fill(name);
    await add.getByLabel("接口地址", { exact: true }).fill(NEVER_CALLED);
    await add.getByLabel("密钥", { exact: true }).fill(keys[i]);
    await add.getByLabel("模型名称", { exact: true }).fill("demo-model");
    await add.getByRole("button", { name: "添加模型" }).click();
    await add.getByRole("button", { name: "保存", exact: true }).click();
    const added = editForm(ann.page);
    await expect(added.getByRole("status").filter({ hasText: "已添加。" })).toBeVisible();
    await expect(added.getByLabel("密钥", { exact: true })).toHaveValue("");
    if (i === 0) await capture(ann.page, "settings-providers-form");
    await added.getByRole("button", { name: "返回" }).click();
    await expect(providerRow(section, name)).toContainText(`密钥 …${keys[i].slice(-4)}`);
  }
  await capture(ann.page, "settings-providers-list");

  // The other provider's name and a new key: refused (name_taken), the key field emptied.
  await providerRow(section, main).getByRole("button", { name: "编辑" }).click();
  const form = editForm(ann.page);
  const nameBox = form.getByLabel("名称", { exact: true });
  const keyBox = form.getByLabel("密钥", { exact: true });
  await nameBox.fill(spare);
  await keyBox.fill(keys[2]);
  await form.getByRole("button", { name: "保存", exact: true }).click();
  await expect(form.getByText("你已经有一个同名的供应商了，请换个名称。")).toBeVisible();
  await expect(keyBox).toHaveValue("");
  // Under the key field: one sentence, the error (no hint beside it).
  const keyField = form.locator(".field").filter({ has: ann.page.getByLabel("密钥", { exact: true }) });
  await expect(keyField.locator(".field-msg, .field-hint")).toHaveCount(1);
  await expect(keyField.locator(".field-msg")).toHaveText("上次填写的密钥没有保存，请重新填写；如果不想更换，点“保留原密钥”。");
  await capture(ann.page, "settings-providers-refused-key");

  // The name back as it was, the saved key kept: nothing to send, and it says so.
  await nameBox.fill(main);
  await form.getByRole("button", { name: "保留原密钥" }).click();
  await form.getByRole("button", { name: "保存", exact: true }).click();
  await expect(toast(ann.page, "没有改动，原来的密钥保持不变")).toBeVisible();
  await expect(providerRow(section, main)).toContainText(`密钥 …${keys[0].slice(-4)}`);

  for (const key of keys) expect(await leftovers(ann.page)).not.toContain(key);
  await ann.page.reload();
  await openProviders(ann.page);
  for (const key of keys) expect(await leftovers(ann.page)).not.toContain(key);
});
