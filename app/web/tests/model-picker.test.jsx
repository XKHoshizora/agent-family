// @vitest-environment jsdom
// The model picker of the Agent form: site models (免费 / 需余额) and my providers' models, what it says when there is
// nothing to choose, the privacy notice beside it, and how it loads.
import React from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { AG1, MODELS, P1, PRINCIPALS, agentConv, agentOf, agentPrincipal, apiError, deferred, providerOf, syncOf, usageOf } from "./fixtures.js";
import { modelLab } from "../src/pages/ModelPicker.jsx";
import { click, flush, inMain, installBrowser, mainText, openApp } from "./harness.jsx";

beforeEach(installBrowser);
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const rail = (name) => within(screen.getByRole("navigation", { name: "主导航" })).getByRole("button", { name });
const inList = () => within(document.querySelector(".list-col"));
const NO_SITE = { siteModels: [], providerDefaults: MODELS.providerDefaults };

/** The create form, with what `GET /api/models`, `GET /api/providers` and `GET /api/usage` answer. */
async function openForm({ models = MODELS, providers = [providerOf()], usage = usageOf(), agents = [], api = {}, edit = false } = {}) {
  const calls = {
    getModels: vi.fn(async () => models),
    listProviders: vi.fn(async () => ({ providers })),
    getUsage: vi.fn(async () => usage),
    listAgents: vi.fn(() => new Promise(() => {})),
    ...api,
  };
  const principals = [...PRINCIPALS, ...agents.map((a) => agentPrincipal(a.id, a.handle, a.name))];
  const app = await openApp({
    sync: () => syncOf(agents.map((a) => agentConv(a.conversationId, a.id)), [], principals),
    api: calls,
    handlers: { agents: () => ({ agents }), models: () => models },
  });
  fireEvent.click(rail(/^Agent/));
  await flush();
  if (edit) {
    await click(inList().getByText(agents[0].name, { selector: ".row-name" }));
    await click(inMain().getByRole("button", { name: /编辑/ }));
  } else {
    await click(inList().getByRole("button", { name: "创建 Agent" }));
  }
  return { ...app, api: calls };
}

const modelBox = () => inMain().getByLabelText("模型");
const groups = () =>
  [...modelBox().querySelectorAll("optgroup")].map((g) => [g.label, [...g.querySelectorAll("option")].map((o) => (o.disabled ? `(${o.textContent})` : o.textContent))]);
const chooseModel = async (name) => {
  const option = within(modelBox()).getByRole("option", { name });
  fireEvent.change(modelBox(), { target: { value: option.value } });
  await flush();
};
const createButton = () => inMain().getByRole("button", { name: /^创建 Agent$|^创建中…$/ });
const reasonText = () => document.querySelector(".main-col .form-actions .reason")?.textContent ?? null;
const PRIVACY = "你与它的对话内容，包括发给它的图片和文件，会发送给所选模型的服务商。";

describe("the model picker", () => {
  it("lists 站点提供 (each 免费 or 需余额) and 我的供应商 (provider → its models); a model too small to use cannot be chosen", async () => {
    await openForm();
    expect(modelBox().value).toBe("");
    expect(within(modelBox()).getByRole("option", { name: "请选择模型" })).toBeTruthy();
    expect(groups()).toEqual([
      ["站点提供", ["小模型 · 免费", "大模型 · 需余额"]],
      ["我的供应商 · 我的 OpenAI", ["gpt-x", "plain", "(tiny（上下文太小）)"]],
    ]);
  });

  it("re-reads the models, my providers and my usage when the form opens", async () => {
    const { api } = await openForm();
    expect(api.getModels).toHaveBeenCalledTimes(1);
    expect(api.listProviders).toHaveBeenCalledTimes(1);
    expect(api.getUsage).toHaveBeenCalledTimes(1);
  });

  it("a paid model can be chosen with no balance, and says that it needs balance", async () => {
    await openForm({ usage: usageOf({ balance: "0" }) });
    await chooseModel("大模型 · 需余额");
    expect(within(modelBox()).getByRole("option", { name: "大模型 · 需余额" }).selected).toBe(true);
    expect(mainText()).toContain("需要余额：这个模型按用量从余额扣点，你现在的余额是 0 点，余额不足时它不会回复。");
    fireEvent.change(inMain().getByLabelText("名称"), { target: { value: "MyBot" } });
    expect(createButton().disabled).toBe(false);
  });

  it("with a balance, a paid model says what it is charged from; a free model says nothing of it", async () => {
    await openForm({ usage: usageOf({ balance: "1234.500" }) });
    await chooseModel("大模型 · 需余额");
    expect(mainText()).toContain("这个模型按用量从余额扣点，你现在的余额是 1,234.5 点。");
    expect(mainText()).not.toContain("需要余额：");
    await chooseModel("小模型 · 免费");
    expect(mainText()).not.toContain("从余额扣点");
  });

  it("no site model configured: that group reads 尚未开放", async () => {
    await openForm({ models: NO_SITE });
    expect(groups()[0]).toEqual(["站点提供", ["(尚未开放)"]]);
    await chooseModel("gpt-x");
    expect(modelBox().value).not.toBe("");
  });

  it("the picker is a native select, so no logo goes in it; the lab of a choice is read from a site model's id or label, a provider model's name", async () => {
    await openForm();
    expect(modelBox().querySelector("img")).toBeNull();
    const state = { siteModels: [{ id: "site-1", label: "Claude Mini" }, { id: "free-1", label: "小模型" }] };
    expect(modelLab(state, { source: "site", id: "gpt-4o" })).toBe("openai");
    expect(modelLab(state, { source: "site", id: "site-1" })).toBe("anthropic");
    expect(modelLab(state, { source: "site", id: "free-1" })).toBeNull();
    expect(modelLab(state, { source: "provider", providerId: "p", model: "gemini-2" })).toBe("google");
    expect(modelLab(state, { source: "provider", providerId: "p", model: "house-blend" })).toBeNull();
  });

  it("no provider: that group says so; a provider without models says it has none", async () => {
    await openForm({ providers: [] });
    expect(groups()[1]).toEqual(["我的供应商", ["(还没有添加供应商)"]]);
    cleanup();
    await openForm({ providers: [providerOf(P1, { name: "空的", models: [] })] });
    expect(groups()[1]).toEqual(["我的供应商 · 空的", ["(没有可选的模型)"]]);
  });

  it("nothing to choose at all (providers without models included): a notice leading to Settings › 模型供应商", async () => {
    await openForm({ models: NO_SITE, providers: [providerOf(P1, { models: [] })] });
    expect(inMain().queryByLabelText("模型")).toBeNull();
    expect(mainText()).toContain("还没有可用的模型");
    expect(inMain().getByRole("button", { name: "添加模型供应商" })).toBeTruthy();
    expect(mainText()).toContain(PRIVACY);
  });

  it("the privacy notice stands beside the picker", async () => {
    await openForm();
    const field = modelBox().closest(".field");
    expect(field.parentElement.textContent).toContain(PRIVACY);
  });

  it("every notice in the form sits inside form.page-body, whose notices stop at the fields' width (same token)", async () => {
    await openForm();
    const form = modelBox().closest("form");
    expect(form.classList.contains("page-body")).toBe(true);
    const privacy = [...form.querySelectorAll(".notice")].find((n) => n.textContent.includes(PRIVACY));
    expect(privacy).toBeTruthy();
    for (const n of form.querySelectorAll(".notice")) expect(n.closest("form.page-body")).toBe(form);
    const css = readFileSync(resolve(__dirname, "../src/styles.css"), "utf8");
    expect(css).toMatch(/form.page-body .notice\s*\{[^}]*max-width:\s*var\(--field-w\)/);
    expect(css).toMatch(/\.field\s*\{[^}]*max-width:\s*var\(--field-w\)/);
  });

  it("the model rows and the opened 高级 panel stop at the fields' width (the same token); on a phone the open panel takes the row's full width", () => {
    const css = readFileSync(resolve(__dirname, "../src/styles.css"), "utf8");
    expect(css).toMatch(/form\.page-body \.member-rows\s*\{[^}]*max-width:\s*var\(--field-w\)/);
    expect(css).toMatch(/\.model-panel\s*\{[^}]*max-width:\s*var\(--field-w\)/);
    const phone = css.slice(css.indexOf("@media (max-width: 480px)"));
    expect(phone).toMatch(/li:has\(\.model-panel\)\s*\{[^}]*flex-wrap:\s*wrap/);
    expect(phone).toMatch(/li:has\(\.model-panel\) > \.member-body\s*\{[^}]*flex:\s*1 1 100%/);
    expect(css).toMatch(/\.model-panel \.checks label span\s*\{[^}]*min-width:\s*0/);
  });

  it("while it loads it says so (not that nothing is available), and creating waits", async () => {
    const pending = deferred();
    await openForm({ api: { listProviders: vi.fn(() => pending.promise) } });
    expect(mainText()).toContain("正在读取可用的模型…");
    expect(mainText()).not.toContain("还没有可用的模型");
    expect(reasonText()).toBe("正在读取可用的模型…");
    pending.resolve({ providers: [providerOf()] });
    await flush();
    expect(modelBox()).toBeTruthy();
  });

  it("my providers failing to load says so, keeps the site models, and can be tried again", async () => {
    const listProviders = vi.fn(async () => {
      throw apiError(503, "busy");
    });
    await openForm({ api: { listProviders } });
    expect(mainText()).toContain("没能读取你的模型供应商，请重试。");
    expect(groups()[0][1]).toEqual(["小模型 · 免费", "大模型 · 需余额"]);
    listProviders.mockImplementation(async () => ({ providers: [providerOf()] }));
    await click(inMain().getByRole("button", { name: "重试" }));
    expect(listProviders).toHaveBeenCalledTimes(2);
    expect(mainText()).not.toContain("没能读取你的模型供应商");
    expect(groups()[1][0]).toBe("我的供应商 · 我的 OpenAI");
  });

  it("editing an Agent whose model is no longer offered keeps it as the current choice; saving other fields leaves it alone", async () => {
    const agent = agentOf(AG1, { model: { source: "site", id: "gone" }, reasoning: "none" });
    const patchAgent = vi.fn(async (_id, patch) => ({ ...agent, ...patch }));
    await openForm({ agents: [agent], api: { patchAgent }, edit: true });
    const current = within(modelBox()).getByRole("option", { name: "gone（当前，已不可用）" });
    expect(current.selected).toBe(true);
    fireEvent.change(inMain().getByLabelText("简介"), { target: { value: "新的" } });
    await click(inMain().getByRole("button", { name: "保存" }));
    expect(patchAgent).toHaveBeenCalledWith(AG1, { intro: "新的" });
  });
});
