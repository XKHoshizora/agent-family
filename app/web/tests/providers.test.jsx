// @vitest-environment jsdom
// Settings › 模型供应商: the list, adding and editing a provider (the key sent once and never kept or shown), its
// models with the 高级 disclosure, 从供应商读取, 测试连接 and deleting one that Agents use. Over the real data layer.
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { AG1, AG2, MODELS, P1, apiError, deferred, providerOf, syncOf } from "./fixtures.js";
import { click, dialog, flush, inMain, installBrowser, mainText, openApp, toastText } from "./harness.jsx";

beforeEach(() => installBrowser());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const P2 = "00000000-0000-4000-8000-0000000000e2";
const KEY = "sk-test-SECRET-key-0123456789";
const NEW_KEY = "sk-another-SECRET-9876";

/** What the service answers for a provider it stored: every model with its flags and a context. */
const stored = (id, body, keyLast4) => ({
  id,
  name: body.name,
  protocol: body.protocol,
  baseUrl: body.baseUrl,
  keyLast4,
  models: (body.models ?? []).map((m) => ({ vision: false, pdf: false, reasoning: false, contextTokens: 16000, ...m })),
});

const rail = (name) => within(screen.getByRole("navigation", { name: "主导航" })).getByRole("button", { name });
const settingsRow = (name) => screen.getByText(name, { selector: ".list-col .row-name" });
const goSettings = async () => {
  fireEvent.click(rail(/^设置/));
  await flush();
};

/** The app on Settings › 模型供应商 with `providers` held by the fake service; `api` replaces any route. */
async function openProviders({ providers = [providerOf()], api = {} } = {}) {
  const env = { providers: structuredClone(providers) };
  const routes = {
    listProviders: vi.fn(async () => ({ providers: structuredClone(env.providers) })),
    createProvider: vi.fn(async (body) => {
      const p = stored(P2, body, body.apiKey.slice(-4));
      env.providers.push(p);
      return structuredClone(p);
    }),
    patchProvider: vi.fn(async (id, patch) => {
      const at = env.providers.findIndex((p) => p.id === id);
      const { apiKey, ...rest } = patch;
      const next = { ...env.providers[at], ...rest, ...(apiKey ? { keyLast4: apiKey.slice(-4) } : {}) };
      if (rest.models) next.models = stored(id, { models: rest.models }).models;
      env.providers[at] = next;
      return structuredClone(next);
    }),
    deleteProvider: vi.fn(async (id) => {
      env.providers = env.providers.filter((p) => p.id !== id);
      return { ok: true };
    }),
    testProvider: vi.fn(async () => ({ ok: true })),
    refreshProviderModels: vi.fn(),
    ...api,
  };
  const app = await openApp({ sync: () => syncOf([]), api: routes, handlers: { models: () => MODELS } });
  await goSettings();
  await click(settingsRow("模型供应商"));
  return { ...app, env };
}

const type = (label, value) => fireEvent.change(inMain().getByLabelText(label), { target: { value } });
const keyBox = () => inMain().getByLabelText("密钥");
const providerRow = (name) => inMain().getByText(name, { selector: ".member-body strong" }).closest("li");
const inRow = (name) => within(providerRow(name));
const modelRow = (name) => within(inMain().getByRole("list", { name: "模型列表" })).getByText(name, { selector: "strong" }).closest("li");
const modelNames = () => [...within(inMain().getByRole("list", { name: "模型列表" })).queryAllByRole("listitem")].map((li) => li.querySelector("strong").textContent);
/** Every argument any route was called with, as one string (to find where a key went). */
const sentAnywhere = (api) =>
  JSON.stringify(
    Object.values(api)
      .filter((fn) => fn?.mock)
      .flatMap((fn) => fn.mock.calls),
  );
const occurrences = (text, part) => text.split(part).length - 1;

describe("the settings entries", () => {
  it("Settings lists 模型供应商 and 用量与余额; each opens its own section", async () => {
    await openApp({ sync: () => syncOf([]), api: { listProviders: vi.fn(async () => ({ providers: [] })), getUsage: vi.fn(() => new Promise(() => {})) } });
    await goSettings();
    expect([...document.querySelectorAll(".list-col .row-name")].map((x) => x.textContent)).toEqual(["我的资料", "模型供应商", "用量与余额", "拉黑", "通讯录与申请"]);
    await click(settingsRow("模型供应商"));
    expect(document.querySelector(".main-col .profile-head h2").textContent).toBe("我的模型供应商");
    await click(settingsRow("用量与余额"));
    expect(document.querySelector(".main-col .profile-head h2").textContent).toBe("我的用量");
    await click(settingsRow("我的资料"));
    expect(document.querySelector(".main-col .profile-head .eyebrow").textContent).toBe("我的资料");
  });

  it("the Agent form's 添加模型供应商 lands on this section", async () => {
    const empty = { siteModels: [], providerDefaults: MODELS.providerDefaults };
    await openApp({
      sync: () => syncOf([]),
      api: { getModels: vi.fn(async () => empty), listProviders: vi.fn(async () => ({ providers: [] })), getUsage: vi.fn(async () => ({})) },
      handlers: { models: () => empty },
    });
    fireEvent.click(rail(/^Agent/));
    await flush();
    await click(within(document.querySelector(".list-col")).getByRole("button", { name: "创建 Agent" }));
    await click(inMain().getByRole("button", { name: "添加模型供应商" }));
    expect(document.querySelector(".main-col .profile-head h2").textContent).toBe("我的模型供应商");
    expect(mainText()).toContain("还没有添加模型供应商");
  });
});

describe("the provider list", () => {
  it("shows each provider's name, interface type, address, the key's last four characters and its models", async () => {
    const second = providerOf(P2, { name: "Gemini", protocol: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta", keyLast4: "wxyz", models: [] });
    await openProviders({ providers: [providerOf(), second] });
    const first = providerRow("我的 OpenAI").textContent;
    expect(first).toContain("OpenAI Chat Completions");
    expect(first).toContain("https://api.example.com/v1");
    expect(first).toContain("…abcd");
    expect(first).toContain("3 个模型");
    const gemini = providerRow("Gemini").textContent;
    expect(gemini).toContain("Gemini API");
    expect(gemini).toContain("…wxyz");
    expect(gemini).toContain("还没有模型");
  });

  it("offers no more than 10 providers", async () => {
    const ten = Array.from({ length: 10 }, (_, i) => providerOf(`00000000-0000-4000-8000-0000000001${String(i).padStart(2, "0")}`, { name: `P${i}` }));
    await openProviders({ providers: ten });
    expect(inMain().getByRole("button", { name: /添加供应商/ }).disabled).toBe(true);
    expect(mainText()).toContain("最多只能添加 10 个模型供应商");
  });

  it("says when the list cannot be read, and reads it again on 重试", async () => {
    const listProviders = vi.fn(async () => {
      throw apiError(503, "busy");
    });
    await openProviders({ api: { listProviders } });
    expect(mainText()).toContain("没能读取你的模型供应商");
    listProviders.mockResolvedValueOnce({ providers: [providerOf()] });
    await click(inMain().getByRole("button", { name: "重试" }));
    expect(providerRow("我的 OpenAI")).toBeTruthy();
  });
});

describe("adding a provider", () => {
  const fillNew = async ({ protocol = "anthropic", baseUrl = "https://api.anthropic.com/v1", key = KEY } = {}) => {
    await click(inMain().getByRole("button", { name: /添加供应商/ }));
    type("名称", " 我的 Claude ");
    fireEvent.change(inMain().getByLabelText("接口类型"), { target: { value: protocol } });
    type("接口地址", baseUrl);
    fireEvent.change(keyBox(), { target: { value: key } });
  };

  it("offers the four interface types by their common names, and says the conversations go to the provider", async () => {
    await openProviders({ providers: [] });
    await click(inMain().getByRole("button", { name: /添加供应商/ }));
    const options = within(inMain().getByLabelText("接口类型")).getAllByRole("option");
    expect(options.map((o) => [o.value, o.textContent])).toEqual([
      ["openai_chat", "OpenAI Chat Completions"],
      ["openai_responses", "OpenAI Responses"],
      ["anthropic", "Anthropic Messages"],
      ["gemini", "Gemini API"],
    ]);
    expect(mainText()).toContain("你与它的对话内容，包括发给它的图片和文件，会发送给这个供应商");
    expect(mainText()).toContain("https://");
  });

  it("sends the key once, empties the field as soon as the request is sent, and never shows it again", async () => {
    const pending = deferred();
    const createProvider = vi.fn(() => pending.promise);
    const app = await openProviders({ providers: [], api: { createProvider } });
    await fillNew();
    const box = keyBox();
    expect(box.type).toBe("password");
    expect(box.getAttribute("autocomplete")).toBe("new-password");
    // Typed, it lives only in the input: never in an attribute or anywhere else on the page.
    expect(box.value).toBe(KEY);
    expect(document.documentElement.outerHTML).not.toContain(KEY);
    type("模型名称", "claude-x");
    await click(inMain().getByRole("button", { name: "添加模型" }));
    await click(inMain().getByRole("button", { name: "保存" }));
    expect(createProvider).toHaveBeenCalledTimes(1);
    expect(createProvider).toHaveBeenCalledWith({
      name: "我的 Claude",
      protocol: "anthropic",
      baseUrl: "https://api.anthropic.com/v1",
      apiKey: KEY,
      models: [{ name: "claude-x", vision: false, pdf: false, reasoning: false }],
    });
    // Sent: the field is empty before the answer comes.
    expect(keyBox().value).toBe("");
    expect(inMain().getByRole("button", { name: "保存中…" }).disabled).toBe(true);
    await act(async () => pending.resolve(stored(P2, createProvider.mock.calls[0][0], "6789")));
    await flush();
    // Saved: the form now edits the new provider, the key shows as its last four characters only.
    expect(mainText()).toContain("已添加");
    expect(keyBox().value).toBe("");
    expect(mainText()).toContain("…6789");
    expect(document.documentElement.outerHTML).not.toContain(KEY);
    expect(occurrences(sentAnywhere(app.api), KEY)).toBe(1);
    await click(inMain().getByRole("button", { name: /返回/ }));
    expect(providerRow("我的 Claude").textContent).toContain("…6789");
    expect(document.documentElement.outerHTML).not.toContain(KEY);
  });

  it("a refusal keeps the form but not the key: it asks for the key again", async () => {
    const createProvider = vi.fn(async () => {
      throw apiError(409, "name_taken");
    });
    await openProviders({ providers: [], api: { createProvider } });
    await fillNew();
    await click(inMain().getByRole("button", { name: "保存" }));
    expect(createProvider).toHaveBeenCalledTimes(1);
    expect(screen.getByText("你已经有一个同名的供应商了，请换个名称。")).toBeTruthy();
    expect(inMain().getByLabelText("名称").value).toBe(" 我的 Claude ");
    expect(keyBox().value).toBe("");
    expect(mainText()).toContain("刚才填写的密钥已经清空，请重新填写");
    expect(document.documentElement.outerHTML).not.toContain(KEY);
  });

  it("checks the fields before any request: an https address, a key, a name", async () => {
    const app = await openProviders({ providers: [] });
    await fillNew({ baseUrl: "http://api.example.com/v1", key: "" });
    type("名称", "");
    await click(inMain().getByRole("button", { name: "保存" }));
    expect(mainText()).toContain("请填写名称");
    expect(mainText()).toContain("接口地址需要以 https:// 开头");
    expect(mainText()).toContain("请填写密钥");
    type("接口地址", "https://user:pw@api.example.com/v1");
    fireEvent.change(keyBox(), { target: { value: "short" } });
    await click(inMain().getByRole("button", { name: "保存" }));
    expect(mainText()).toContain("接口地址里不能包含用户名或密码");
    expect(mainText()).toContain("密钥需要是 8 到 1000 个字符");
    expect(app.api.createProvider).not.toHaveBeenCalled();
  });
});

describe("editing a provider", () => {
  const openEdit = async (options) => {
    const app = await openProviders(options);
    await click(inRow("我的 OpenAI").getByRole("button", { name: "编辑" }));
    return app;
  };

  it("shows the interface type read-only and the saved key as its last four characters, never filled in", async () => {
    await openEdit();
    expect(inMain().queryByLabelText("接口类型")).toBeNull();
    expect(mainText()).toContain("OpenAI Chat Completions（创建后不可修改）");
    expect(keyBox().value).toBe("");
    expect(mainText()).toContain("…abcd");
  });

  it("without a key the key is left out: only what changed is sent", async () => {
    const app = await openEdit();
    type("名称", "工作用");
    await click(inMain().getByRole("button", { name: "保存" }));
    expect(app.api.patchProvider).toHaveBeenCalledTimes(1);
    expect(app.api.patchProvider).toHaveBeenCalledWith(P1, { name: "工作用" });
    expect(app.api.patchProvider.mock.calls[0][1]).not.toHaveProperty("apiKey");
    expect(toastText()).toBe("供应商已保存");
    expect(providerRow("工作用")).toBeTruthy();
  });

  it("another path on the same address needs no key", async () => {
    const app = await openEdit();
    type("接口地址", "https://API.example.com:443/v2");
    expect(mainText()).not.toContain("接口地址换了域名");
    await click(inMain().getByRole("button", { name: "保存" }));
    expect(app.api.patchProvider).toHaveBeenCalledWith(P1, { baseUrl: "https://API.example.com:443/v2" });
  });

  it("another address needs the key again: it says so and sends nothing until the key is filled in", async () => {
    const app = await openEdit();
    type("接口地址", "https://other.example.com/v1");
    expect(mainText()).toContain("接口地址换了域名，需要重新填写密钥。");
    await click(inMain().getByRole("button", { name: "保存" }));
    expect(app.api.patchProvider).not.toHaveBeenCalled();
    expect(keyBox().getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById(keyBox().getAttribute("aria-describedby")).textContent).toBe("接口地址换了域名，需要重新填写密钥。");
    fireEvent.change(keyBox(), { target: { value: NEW_KEY } });
    await click(inMain().getByRole("button", { name: "保存" }));
    expect(app.api.patchProvider).toHaveBeenCalledWith(P1, { baseUrl: "https://other.example.com/v1", apiKey: NEW_KEY });
    expect(document.documentElement.outerHTML).not.toContain(NEW_KEY);
    expect(providerRow("我的 OpenAI").textContent).toContain("…9876");
  });

});

describe("a refused save that carried a new key", () => {
  const KEY_NOT_SAVED = "上次填写的密钥没有保存，请重新填写；如果不想更换，点“保留原密钥”。";
  const save = () => click(inMain().getByRole("button", { name: "保存" }));
  const keyMessage = () => document.getElementById(keyBox().getAttribute("aria-describedby"))?.textContent;
  /** Edits the provider; the first save is refused (busy), the next ones answer as the service would. */
  const openRefusingOnce = async () => {
    const patchProvider = vi.fn(async (_id, patch) => {
      const { apiKey, ...rest } = patch;
      return { ...providerOf(), ...rest, ...(apiKey ? { keyLast4: apiKey.slice(-4) } : {}) };
    });
    patchProvider.mockRejectedValueOnce(apiError(503, "busy"));
    await openProviders({ api: { patchProvider } });
    await click(inRow("我的 OpenAI").getByRole("button", { name: "编辑" }));
    return patchProvider;
  };

  it("key only: the field is emptied once sent; saving again sends nothing and points at the key until it is typed again", async () => {
    // focusInvalid moves the focus on the next frame: here, at once.
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 0;
    });
    const patchProvider = await openRefusingOnce();
    fireEvent.change(keyBox(), { target: { value: NEW_KEY } });
    await save();
    expect(patchProvider).toHaveBeenCalledTimes(1);
    expect(patchProvider).toHaveBeenCalledWith(P1, { apiKey: NEW_KEY });
    expect(keyBox().value).toBe("");
    expect(mainText()).toContain("服务现在有点忙，请稍后再试。");
    expect(keyBox().getAttribute("aria-invalid")).toBe("true");
    expect(keyMessage()).toBe(KEY_NOT_SAVED);
    expect(document.documentElement.outerHTML).not.toContain(NEW_KEY);

    // Saving again: no request, no "saved", still in the form, the key field focused with its message.
    keyBox().blur();
    expect(document.activeElement).not.toBe(keyBox());
    await save();
    expect(patchProvider).toHaveBeenCalledTimes(1);
    expect(toastText()).toBeNull();
    expect(document.activeElement).toBe(keyBox());
    expect(keyMessage()).toBe(KEY_NOT_SAVED);

    fireEvent.change(keyBox(), { target: { value: NEW_KEY } });
    expect(inMain().queryByRole("button", { name: "保留原密钥" })).toBeNull();
    await save();
    expect(patchProvider).toHaveBeenCalledTimes(2);
    expect(patchProvider).toHaveBeenLastCalledWith(P1, { apiKey: NEW_KEY });
    expect(toastText()).toBe("供应商已保存");
    expect(providerRow("我的 OpenAI").textContent).toContain("…9876");
  });

  it("key plus a name change: the same rule; 保留原密钥 saves the other changes without the key", async () => {
    const patchProvider = await openRefusingOnce();
    type("名称", "工作用");
    fireEvent.change(keyBox(), { target: { value: NEW_KEY } });
    await save();
    expect(patchProvider).toHaveBeenCalledWith(P1, { name: "工作用", apiKey: NEW_KEY });
    expect(keyMessage()).toBe(KEY_NOT_SAVED);
    await save();
    expect(patchProvider).toHaveBeenCalledTimes(1);
    expect(toastText()).toBeNull();

    await click(inMain().getByRole("button", { name: "保留原密钥" }));
    expect(keyBox().getAttribute("aria-invalid")).toBeNull();
    expect(mainText()).not.toContain(KEY_NOT_SAVED);
    expect(mainText()).toContain("已保存的密钥：…abcd");
    expect(document.activeElement).toBe(keyBox());
    await save();
    expect(patchProvider).toHaveBeenCalledTimes(2);
    expect(patchProvider).toHaveBeenLastCalledWith(P1, { name: "工作用" });
    expect(patchProvider.mock.calls[1][1]).not.toHaveProperty("apiKey");
    expect(toastText()).toBe("供应商已保存");
    expect(providerRow("工作用").textContent).toContain("…abcd");
  });

  it("保留原密钥 with nothing else changed sends nothing, goes back and says the saved key was kept", async () => {
    const patchProvider = await openRefusingOnce();
    fireEvent.change(keyBox(), { target: { value: NEW_KEY } });
    await save();
    expect(patchProvider).toHaveBeenCalledTimes(1);
    await click(inMain().getByRole("button", { name: "保留原密钥" }));
    await save();
    expect(patchProvider).toHaveBeenCalledTimes(1);
    expect(toastText()).toBe("没有改动，原来的密钥保持不变");
    expect(providerRow("我的 OpenAI").textContent).toContain("…abcd");
  });

  it("a form with nothing changed (no key refused) still goes back quietly", async () => {
    const patchProvider = await openRefusingOnce();
    await save();
    expect(patchProvider).not.toHaveBeenCalled();
    expect(toastText()).toBeNull();
    expect(providerRow("我的 OpenAI").textContent).toContain("…abcd");
  });

  it("an address on another origin still needs the key: 保留原密钥 is not offered", async () => {
    const patchProvider = await openRefusingOnce();
    type("接口地址", "https://other.example.com/v1");
    fireEvent.change(keyBox(), { target: { value: NEW_KEY } });
    await save();
    expect(patchProvider).toHaveBeenCalledTimes(1);
    expect(keyMessage()).toBe("接口地址换了域名，需要重新填写密钥。");
    expect(inMain().queryByRole("button", { name: "保留原密钥" })).toBeNull();
    await save();
    expect(patchProvider).toHaveBeenCalledTimes(1);
  });
});

describe("a connection test result never outlives what it tested", () => {
  /** What the form's 测试连接 shows under its button (a refusal notice elsewhere in the form is not it). */
  const result = () => inMain().getByRole("button", { name: /测试/ }).closest(".field").querySelector('[role="status"], [role="alert"]');
  const openTested = async () => {
    await openProviders();
    await click(inRow("我的 OpenAI").getByRole("button", { name: "编辑" }));
    await click(inMain().getByRole("button", { name: "测试连接" }));
    expect(result().textContent).toBe("连接成功，供应商正常回应。");
  };

  it("is cleared when the address is edited", async () => {
    await openTested();
    type("接口地址", "https://api.example.com/v2");
    await flush();
    expect(result()).toBeNull();
  });

  it("is cleared when the key is edited", async () => {
    await openTested();
    fireEvent.change(keyBox(), { target: { value: NEW_KEY } });
    await flush();
    expect(result()).toBeNull();
  });

  it("is cleared when the provider is saved, also when that save is refused", async () => {
    const patchProvider = vi.fn(async () => {
      throw apiError(503, "busy");
    });
    await openProviders({ api: { patchProvider } });
    await click(inRow("我的 OpenAI").getByRole("button", { name: "编辑" }));
    await click(inMain().getByRole("button", { name: "测试连接" }));
    expect(result().textContent).toBe("连接成功，供应商正常回应。");
    type("名称", "工作用");
    await click(inMain().getByRole("button", { name: "保存" }));
    expect(patchProvider).toHaveBeenCalledTimes(1);
    expect(result()).toBeNull();
  });

  it("an answer that arrives after the address was edited is not shown", async () => {
    const pending = deferred();
    await openProviders({ api: { testProvider: vi.fn(() => pending.promise) } });
    await click(inRow("我的 OpenAI").getByRole("button", { name: "编辑" }));
    await click(inMain().getByRole("button", { name: "测试连接" }));
    type("接口地址", "https://api.example.com/v2");
    await act(async () => pending.resolve({ ok: true }));
    await flush();
    expect(result()).toBeNull();
  });
});

describe("the models of a provider", () => {
  it("adds and removes models; 高级 sets what each can do and its context; only the changed list is sent", async () => {
    const app = await openProviders();
    await click(inRow("我的 OpenAI").getByRole("button", { name: "编辑" }));
    expect(modelNames()).toEqual(["gpt-x", "plain", "tiny"]);
    expect(modelRow("tiny").textContent).toContain("上下文太小");
    await click(within(modelRow("tiny")).getByRole("button", { name: /移除/ }));
    type("模型名称", "  vision-1 ");
    fireEvent.keyDown(inMain().getByLabelText("模型名称"), { key: "Enter" });
    await flush();
    expect(modelNames()).toEqual(["gpt-x", "plain", "vision-1"]);
    expect(inMain().getByLabelText("模型名称").value).toBe("");
    type("模型名称", "plain");
    await click(inMain().getByRole("button", { name: "添加模型" }));
    expect(mainText()).toContain("列表里已经有这个模型了");

    const advanced = within(modelRow("vision-1")).getByRole("button", { name: /高级/ });
    expect(advanced.getAttribute("aria-expanded")).toBe("false");
    await click(advanced);
    expect(advanced.getAttribute("aria-expanded")).toBe("true");
    const panel = within(modelRow("vision-1"));
    // The output limit every call gets, from /api/models: a context not above it cannot be used.
    expect(modelRow("vision-1").textContent).toContain("2,048");
    fireEvent.click(panel.getByLabelText(/能看图片/));
    fireEvent.click(panel.getByLabelText(/能直接读 PDF/));
    fireEvent.change(panel.getByLabelText("上下文容量"), { target: { value: "500" } });
    await click(inMain().getByRole("button", { name: "保存" }));
    expect(app.api.patchProvider).not.toHaveBeenCalled();
    expect(mainText()).toContain("上下文容量需要是 1000 到 2000000 之间的整数");
    fireEvent.change(panel.getByLabelText("上下文容量"), { target: { value: "128,000" } });
    await click(inMain().getByRole("button", { name: "保存" }));
    expect(app.api.patchProvider).toHaveBeenCalledWith(P1, {
      models: [
        { name: "gpt-x", vision: false, pdf: false, reasoning: true, contextTokens: 64000 },
        { name: "plain", vision: false, pdf: false, reasoning: false, contextTokens: 16000 },
        { name: "vision-1", vision: true, pdf: true, reasoning: false, contextTokens: 128000 },
      ],
    });
  });

  it("从供应商读取 says how many it found and adds the new ones to the list", async () => {
    const refreshProviderModels = vi.fn(async () => ({
      listed: ["gpt-x", "gpt-y", "gpt-z"],
      provider: providerOf(P1, {
        models: [
          ...providerOf().models,
          { name: "gpt-y", vision: false, pdf: false, reasoning: false, contextTokens: 16000 },
          { name: "gpt-z", vision: false, pdf: false, reasoning: false, contextTokens: 16000 },
        ],
      }),
    }));
    await openProviders({ api: { refreshProviderModels } });
    await click(inRow("我的 OpenAI").getByRole("button", { name: "编辑" }));
    await click(inMain().getByRole("button", { name: "从供应商读取" }));
    expect(refreshProviderModels).toHaveBeenCalledWith(P1);
    expect(mainText()).toContain("找到 3 个模型");
    expect(modelNames()).toEqual(["gpt-x", "plain", "tiny", "gpt-y", "gpt-z"]);
  });

  it("从供应商读取 and 测试连接 wait until a new address or key is saved", async () => {
    await openProviders();
    await click(inRow("我的 OpenAI").getByRole("button", { name: "编辑" }));
    fireEvent.change(keyBox(), { target: { value: NEW_KEY } });
    await flush();
    expect(inMain().getByRole("button", { name: "从供应商读取" }).disabled).toBe(true);
    expect(inMain().getByRole("button", { name: "测试连接" }).disabled).toBe(true);
    expect(mainText()).toContain("请先保存");
  });
});

describe("测试连接", () => {
  const NO_LIST = (status) => `这个供应商没有提供模型列表（状态码 ${status}），所以没能确认密钥是否可用。对话可能仍然可以使用，模型名称需要手动添加。`;
  const cases = [
    [{ ok: true }, "连接成功，供应商正常回应。"],
    [{ ok: false, error: "provider_rejected", upstreamStatus: "401" }, "供应商拒绝了这个密钥，或已保存的密钥无法再使用。请重新填写密钥并保存，然后再试。（供应商返回的状态码：401）"],
    [{ ok: false, error: "provider_rejected" }, "供应商拒绝了这个密钥，或已保存的密钥无法再使用。请重新填写密钥并保存，然后再试。"],
    [{ ok: false, error: "provider_unavailable", upstreamStatus: "500" }, "暂时连不上供应商，或它没有给出可用的回答，请稍后再试。（供应商返回的状态码：500）"],
    [{ ok: false, error: "provider_unavailable" }, "暂时连不上供应商，或它没有给出可用的回答，请稍后再试。"],
    [{ ok: false, error: "address_not_allowed" }, "这个接口地址不被允许：需要是 https 开头的公网地址。"],
    [{ ok: false, error: "provider_unavailable", upstreamStatus: "404" }, NO_LIST("404")],
    [{ ok: false, error: "provider_unavailable", upstreamStatus: "405" }, NO_LIST("405")],
  ];

  it("shows success, or the sentence for the error the service returned (with the provider's status when there is one)", async () => {
    const testProvider = vi.fn();
    await openProviders({ api: { testProvider } });
    for (const [answer, sentence] of cases) {
      testProvider.mockResolvedValueOnce(answer);
      await click(inRow("我的 OpenAI").getByRole("button", { name: "测试连接" }));
      const shown = providerRow("我的 OpenAI").querySelector('[role="status"], [role="alert"]');
      expect(shown.textContent, JSON.stringify(answer)).toBe(sentence);
    }
    expect(testProvider).toHaveBeenCalledTimes(cases.length);
    expect(testProvider).toHaveBeenCalledWith(P1);
  });

  it("a refused request (not the provider's answer) says why too, and the button shows it is busy meanwhile", async () => {
    const pending = deferred();
    const testProvider = vi.fn(() => pending.promise);
    await openProviders({ api: { testProvider } });
    await click(inRow("我的 OpenAI").getByRole("button", { name: "测试连接" }));
    expect(inRow("我的 OpenAI").getByRole("button", { name: "测试中…" }).disabled).toBe(true);
    await act(async () => pending.reject(apiError(429, "rate_limited")));
    await flush();
    expect(providerRow("我的 OpenAI").querySelector('[role="alert"]').textContent).toBe("操作太频繁了，请稍等一分钟再试。");
  });
});

describe("deleting a provider", () => {
  it("asks first; while Agents use it, the refusal lists them and the provider stays", async () => {
    const deleteProvider = vi.fn(async () => {
      throw apiError(409, "provider_in_use", null, { agents: [{ id: AG1, name: "小助手" }, { id: AG2, name: "写作助手" }] });
    });
    await openProviders({ api: { deleteProvider } });
    await click(inRow("我的 OpenAI").getByRole("button", { name: "删除" }));
    expect(dialog().textContent).toContain("不可恢复");
    await click(within(dialog()).getByRole("button", { name: "取消" }));
    expect(deleteProvider).not.toHaveBeenCalled();
    await click(inRow("我的 OpenAI").getByRole("button", { name: "删除" }));
    await click(within(dialog()).getByRole("button", { name: "确认删除" }));
    expect(deleteProvider).toHaveBeenCalledWith(P1);
    const users = within(within(dialog()).getByRole("list", { name: "正在使用它的 Agent" })).getAllByRole("listitem");
    expect(users.map((li) => li.textContent)).toEqual(["小助手", "写作助手"]);
    expect(dialog().textContent).toContain("请先给它们换一个模型");
    await click(within(dialog()).getByRole("button", { name: "取消" }));
    expect(providerRow("我的 OpenAI")).toBeTruthy();
  });

  it("removes it once confirmed", async () => {
    const app = await openProviders();
    await click(inRow("我的 OpenAI").getByRole("button", { name: "删除" }));
    await click(within(dialog()).getByRole("button", { name: "确认删除" }));
    expect(app.api.deleteProvider).toHaveBeenCalledWith(P1);
    expect(dialog()).toBeNull();
    expect(inMain().queryByText("我的 OpenAI", { selector: ".member-body strong" })).toBeNull();
    expect(mainText()).toContain("还没有添加模型供应商");
  });
});
