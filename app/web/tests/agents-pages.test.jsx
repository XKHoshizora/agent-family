// @vitest-environment jsdom
// The Agent pages (list, create, edit, detail, pause, delete) and the "我的 Agent" group of the contacts, over the real
// data layer with the fake transport and fake routes.
import "./markdown-ready.js";
import { readFileSync } from "node:fs";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import {
  A1,
  A2,
  AG1,
  AG2,
  ANN,
  D1,
  G1,
  ME_ID,
  MODELS,
  P1,
  PRINCIPALS,
  agentConv,
  agentOf,
  agentPrincipal,
  apiError,
  at,
  deferred,
  direct,
  emptySocial,
  fakeFile,
  group,
  providerOf,
  syncOf,
  usageOf,
  wire,
} from "./fixtures.js";
import { PEOPLE, click, dialog, flush, goContacts, inMain, installBrowser, mainText, openApp, push, rowNames, toastText } from "./harness.jsx";

beforeEach(() => {
  installBrowser();
  let n = 0;
  URL.createObjectURL = vi.fn(() => `blob:preview-${++n}`);
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const PROVIDER = providerOf();
const SITE_MODEL = { source: "site", id: "free-1" };

/** The routes the Agent form reads, answering as the service would; `over` replaces any of them. */
const formApi = (over = {}) => ({
  getModels: vi.fn(async () => MODELS),
  listProviders: vi.fn(async () => ({ providers: [PROVIDER] })),
  getUsage: vi.fn(async () => usageOf()),
  listAgents: vi.fn(() => new Promise(() => {})),
  ...over,
});

const rail = (name) => within(screen.getByRole("navigation", { name: "主导航" })).getByRole("button", { name });
const inList = () => within(document.querySelector(".list-col"));
const goAgents = async () => {
  fireEvent.click(rail(/^Agent/));
  await flush();
};
const openRow = async (name) => click(inList().getByText(name, { selector: ".row-name" }));
const rowOf = (name) => inList().getByText(name, { selector: ".row-name" }).closest("button");

/**
 * The app with my Agents (as `GET /api/agents` answers them) and their conversations, on the Agent page.
 * `models` and `providers` are what the form reads.
 */
async function openAgents({ agents = [], api = {}, models = MODELS, providers = [PROVIDER], social = emptySocial(), extra = [], others = [] } = {}) {
  const principals = [...PRINCIPALS, ...agents.map((a) => agentPrincipal(a.id, a.handle, a.name)), ...others];
  const conversations = [...extra, ...agents.map((a) => agentConv(a.conversationId, a.id, { agent: { paused: a.paused, deleted: a.deleted } }))];
  const sync = () => syncOf(conversations, [], principals);
  const app = await openApp({
    sync,
    social,
    api: formApi({ getModels: vi.fn(async () => models), listProviders: vi.fn(async () => ({ providers })), ...api }),
    handlers: { agents: () => ({ agents }), models: () => models },
  });
  await goAgents();
  return app;
}

const openCreate = async () => {
  await click(inList().getByRole("button", { name: "创建 Agent" }));
};
const type = (label, value) => fireEvent.change(inMain().getByLabelText(label), { target: { value } });
const modelBox = () => inMain().getByLabelText("模型");
const chooseModel = async (name) => {
  const option = within(modelBox()).getByRole("option", { name });
  fireEvent.change(modelBox(), { target: { value: option.value } });
  await flush();
};
const levels = () => within(inMain().getByLabelText("思考程度")).getAllByRole("option").map((o) => o.textContent);
const createButton = () => inMain().getByRole("button", { name: /^创建 Agent$|^创建中…$/ });
const personaBox = () => inMain().getByLabelText("人格文档");
const sectionShown = () => document.querySelector(".rail-item.active").textContent;
/** The open chat's title (before the Agent tag the header puts after an Agent's name). */
const chatTitle = () => document.querySelector(".main-col .chat-head h2").firstChild.textContent;

describe("the Agent list", () => {
  it("lists my Agents with the prototype's row (status tag, field, model); a deleted one last, marked 已删除", async () => {
    const agents = [
      agentOf(AG2, { handle: "cook", name: "厨师", conversationId: A2, deleted: true, field: "做饭", model: SITE_MODEL, createdAt: at(1) }),
      agentOf(AG1, { field: "旅行规划", model: SITE_MODEL, createdAt: at(2) }),
    ];
    await openAgents({ agents });
    expect(document.querySelector(".list-col h1").textContent).toBe("我的 Agent");
    expect(rowNames()).toEqual(["小助手", "厨师"]);
    expect(rowOf("小助手").querySelector(".tag").textContent).toBe("可回复");
    expect(rowOf("小助手").querySelector(".row-preview").textContent).toBe("旅行规划 · 小模型");
    // 小模型 is of no known lab: no logo.
    expect(rowOf("小助手").querySelector(".row-preview img")).toBeNull();
    expect(rowOf("厨师").querySelector(".tag").textContent).toBe("已删除");
  });

  it("says how to start when there is none", async () => {
    await openAgents();
    expect(document.querySelector(".list-col .rows-empty").textContent).toBe("还没有 Agent，点右上角的“+”创建一个");
    expect(document.querySelector(".main-col .empty-main").textContent).toBe("选择一个 Agent");
  });

  it("an Agent whose record is not loaded yet shows its row in a neutral state, and never a form", async () => {
    const principals = [...PRINCIPALS, agentPrincipal(AG1)];
    await openApp({
      sync: () => syncOf([agentConv(A1, AG1)], [], principals),
      api: formApi(),
      handlers: { agents: () => new Promise(() => {}), models: () => MODELS },
    });
    await goAgents();
    expect(rowOf("小助手").querySelector(".row-preview").textContent).toBe("正在读取…");
    expect(rowOf("小助手").querySelector(".tag")).toBeNull();
    await openRow("小助手");
    expect(mainText()).toContain("正在读取它的资料…");
    expect(inMain().queryByRole("button", { name: /编辑/ })).toBeNull();
    expect(inMain().queryByRole("button", { name: /暂停/ })).toBeNull();
    expect(inMain().queryByRole("button", { name: /删除/ })).toBeNull();
    expect(document.querySelector(".main-col input, .main-col textarea, .main-col select")).toBeNull();
  });

  it("an Agent without a model says so instead of 可回复", async () => {
    await openAgents({ agents: [agentOf(AG1, { model: null })] });
    expect(rowOf("小助手").querySelector(".tag").textContent).toBe("未选模型");
    expect(rowOf("小助手").querySelector(".row-preview").textContent).toBe("未填写擅长领域 · 未选择模型");
  });
});

describe("creating an Agent", () => {
  it("with only a name and a site model posts exactly that and lands in its conversation", async () => {
    let app;
    const createAgent = vi.fn(async () => {
      app.env.sync = () => syncOf([agentConv(A1, AG1)], [wire(A1, 1, AG1, "你好，我是 MyBot。")], [...PRINCIPALS, agentPrincipal(AG1, "mybot", "MyBot")]);
      return agentOf(AG1, { handle: "mybot", name: "MyBot", model: SITE_MODEL });
    });
    app = await openAgents({ api: { createAgent } });
    await openCreate();
    type("名称", "  MyBot ");
    expect(inMain().getByLabelText("账号名").value).toBe("mybot");
    await chooseModel("小模型 · 免费");
    await click(createButton());
    expect(createAgent).toHaveBeenCalledTimes(1);
    expect(createAgent.mock.calls[0][0]).toEqual({ handle: "mybot", name: "MyBot", replyMode: "always", groupMentions: "members", reasoning: "none", model: SITE_MODEL });
    await flush();
    expect(sectionShown()).toContain("消息");
    expect(chatTitle()).toBe("MyBot");
  });

  it("keeps the create button disabled until a model is chosen, and says why", async () => {
    const createAgent = vi.fn();
    await openAgents({ api: { createAgent } });
    await openCreate();
    type("名称", "MyBot");
    expect(createButton().disabled).toBe(true);
    expect(document.querySelector(".main-col .form-actions .reason").textContent).toBe("请先选择一个模型，否则它不会回复");
    await chooseModel("小模型 · 免费");
    expect(createButton().disabled).toBe(false);
    expect(document.querySelector(".main-col .form-actions .reason")).toBeNull();
  });

  it("suggests an account name from an ASCII name, a random one otherwise, and never changes one I typed", async () => {
    await openAgents();
    await openCreate();
    const handleBox = () => inMain().getByLabelText("账号名");
    expect(handleBox().value).toMatch(/^agent_[a-z0-9]{6}$/);
    const random = handleBox().value;
    type("名称", "My Bot 2");
    expect(handleBox().value).toBe("my_bot_2");
    type("名称", "小助手");
    expect(handleBox().value).toBe(random);
    type("名称", "ab");
    expect(handleBox().value).toBe(random);
    type("账号名", "my_own");
    type("名称", "Different");
    expect(handleBox().value).toBe("my_own");
    expect(mainText()).toContain("创建后不可修改");
  });

  it("checks the fields as the service does, inline, before any request", async () => {
    const createAgent = vi.fn();
    await openAgents({ api: { createAgent } });
    await openCreate();
    await chooseModel("小模型 · 免费");
    type("名称", "   ");
    type("账号名", "No");
    type("简介", "介".repeat(41));
    type("擅长领域", "领".repeat(21));
    fireEvent.change(personaBox(), { target: { value: "人".repeat(20001) } });
    await click(createButton());
    for (const text of ["请填写名称", "账号名为 3 到 24 位小写字母、数字或下划线", "简介不超过 40 个字", "擅长领域不超过 20 个字", "人格文档不超过 20000 个字"]) {
      expect(screen.getByText(text)).toBeTruthy();
    }
    type("名称", "名".repeat(21));
    expect(screen.getByText("名称不超过 20 个字")).toBeTruthy();
    expect(createAgent).not.toHaveBeenCalled();
    expect(inMain().getByLabelText("名称").getAttribute("aria-invalid")).toBe("true");
    expect(mainText()).toContain("20001 / 20000");
  });

  it("sends what was filled in: intro, field, persona (trimmed), reply mode, reasoning, a provider model", async () => {
    const createAgent = vi.fn(async () => agentOf(AG1));
    await openAgents({ api: { createAgent } });
    await openCreate();
    type("名称", "旅行家");
    type("账号名", "traveller");
    type("简介", " 陪你规划旅行 ");
    type("擅长领域", "旅行");
    await chooseModel("gpt-x");
    fireEvent.change(inMain().getByLabelText("思考程度"), { target: { value: "high" } });
    fireEvent.change(personaBox(), { target: { value: "\n你是一位旅行家。\n" } });
    fireEvent.change(inMain().getByLabelText("私聊回复方式"), { target: { value: "mention" } });
    await click(createButton());
    expect(createAgent.mock.calls[0][0]).toEqual({
      handle: "traveller",
      name: "旅行家",
      intro: "陪你规划旅行",
      field: "旅行",
      persona: "你是一位旅行家。",
      replyMode: "mention",
      groupMentions: "members",
      reasoning: "high",
      model: { source: "provider", providerId: P1, model: "gpt-x" },
    });
  });

  it("handle_taken shows under the account name, not as a toast", async () => {
    const createAgent = vi.fn(async () => {
      throw apiError(409, "handle_taken");
    });
    await openAgents({ api: { createAgent } });
    await openCreate();
    type("名称", "MyBot");
    await chooseModel("小模型 · 免费");
    await click(createButton());
    const handleField = inMain().getByLabelText("账号名").closest(".field");
    expect(handleField.textContent).toContain("这个账号名已被占用，请换一个。");
    expect(inMain().getByLabelText("账号名").getAttribute("aria-invalid")).toBe("true");
    expect(toastText()).toBeNull();
    expect(sectionShown()).toContain("Agent");
  });

  it("agent_limit shows inline with the tier's limit, not as a toast", async () => {
    const createAgent = vi.fn(async () => {
      throw apiError(403, "agent_limit");
    });
    const getUsage = vi.fn(async () => usageOf({ agentLimit: 20, agentCount: 20 }));
    await openAgents({ api: { createAgent, getUsage } });
    await openCreate();
    type("名称", "MyBot");
    await chooseModel("小模型 · 免费");
    await click(createButton());
    expect(mainText()).toContain("你的 Agent 数量已达到当前档位的上限（最多 20 个）。删除不用的 Agent 后可以再创建。");
    expect(toastText()).toBeNull();
  });

  it("shows a pending state and cannot be sent twice", async () => {
    const pending = deferred();
    const createAgent = vi.fn(() => pending.promise);
    await openAgents({ api: { createAgent } });
    await openCreate();
    type("名称", "MyBot");
    await chooseModel("小模型 · 免费");
    await click(createButton());
    expect(createButton().textContent).toBe("创建中…");
    expect(createButton().disabled).toBe(true);
    fireEvent.submit(createButton().closest("form"));
    await flush();
    expect(createAgent).toHaveBeenCalledTimes(1);
  });

  it("uploads the picked avatar once the Agent exists", async () => {
    let app;
    const order = [];
    const createAgent = vi.fn(async () => {
      order.push("create");
      app.env.sync = () => syncOf([agentConv(A1, AG1)], [], [...PRINCIPALS, agentPrincipal(AG1, "mybot", "MyBot")]);
      return agentOf(AG1, { handle: "mybot", name: "MyBot", model: SITE_MODEL });
    });
    const uploadAgentAvatar = vi.fn(async () => {
      order.push("avatar");
      return { ok: true };
    });
    app = await openAgents({ api: { createAgent, uploadAgentAvatar } });
    await openCreate();
    const file = fakeFile("bot.png", 1000, "image/png");
    fireEvent.change(inMain().getByLabelText("选择头像图片"), { target: { files: [file] } });
    await flush();
    expect(document.querySelector('img[alt="新头像预览"]').getAttribute("src")).toBe("blob:preview-1");
    expect(uploadAgentAvatar).not.toHaveBeenCalled();
    type("名称", "MyBot");
    await chooseModel("小模型 · 免费");
    await click(createButton());
    expect(order).toEqual(["create", "avatar"]);
    expect(uploadAgentAvatar).toHaveBeenCalledWith(AG1, file);
    await flush();
    expect(sectionShown()).toContain("消息");
  });

  it("an avatar that fails to upload leaves the Agent created and says why on its page", async () => {
    let app;
    const createAgent = vi.fn(async () => {
      app.env.sync = () => syncOf([agentConv(A1, AG1)], [], [...PRINCIPALS, agentPrincipal(AG1, "mybot", "MyBot")]);
      return agentOf(AG1, { handle: "mybot", name: "MyBot", model: SITE_MODEL });
    });
    const uploadAgentAvatar = vi.fn(async () => {
      throw apiError(413, "too_large");
    });
    app = await openAgents({ api: { createAgent, uploadAgentAvatar } });
    await openCreate();
    fireEvent.change(inMain().getByLabelText("选择头像图片"), { target: { files: [fakeFile("bot.png", 1000, "image/png")] } });
    await flush();
    type("名称", "MyBot");
    await chooseModel("小模型 · 免费");
    await click(createButton());
    await flush();
    expect(sectionShown()).toContain("Agent");
    expect(document.querySelector(".main-col .profile-head h2").textContent).toContain("MyBot");
    expect(mainText()).toContain("Agent 已创建，但头像没有上传成功：头像不能超过 2 MB。");
    expect(rowNames()).toEqual(["MyBot"]);
  });
});

describe("帮我起草", () => {
  const ready = async (api) => {
    const app = await openAgents({ api });
    await openCreate();
    return app;
  };

  it("is enabled once a name and a model are set; it fills the persona box and sends nothing else", async () => {
    const draftPersona = vi.fn(async () => ({ persona: "你是一位美食助手。" }));
    const createAgent = vi.fn();
    await ready({ draftPersona, createAgent });
    const draft = () => inMain().getByRole("button", { name: /帮我起草|起草中…/ });
    expect(draft().disabled).toBe(true);
    type("名称", "美食家");
    expect(draft().disabled).toBe(true);
    type("简介", "推荐好吃的");
    await chooseModel("小模型 · 免费");
    expect(draft().disabled).toBe(false);
    await click(draft());
    expect(draftPersona).toHaveBeenCalledWith({ name: "美食家", intro: "推荐好吃的", model: SITE_MODEL });
    expect(personaBox().value).toBe("你是一位美食助手。");
    expect(mainText()).toContain("已填入起草的内容，创建后才会生效。");
    expect(createAgent).not.toHaveBeenCalled();
    expect(createButton().disabled).toBe(false);
  });

  it("sits in one row with the persona's character count, the count centred on the button", async () => {
    await ready();
    const row = inMain().getByRole("button", { name: "帮我起草" }).parentElement;
    expect(row.matches(".field > .member-actions")).toBe(true);
    expect(row.textContent).toContain("0 / 20000");
    // jsdom has no layout (e2e/agents.spec.mjs measures it): here, the rule the row relies on.
    const css = readFileSync("src/styles.css", "utf8");
    const rule = css.split("\n").find((line) => line.startsWith(".field > .member-actions {")) ?? "";
    expect(rule).toMatch(/align-items:\s*center/);
  });

  it("asks before replacing text I wrote; cancelling keeps it and sends nothing", async () => {
    const draftPersona = vi.fn(async () => ({ persona: "起草的人格" }));
    await ready({ draftPersona });
    type("名称", "美食家");
    await chooseModel("小模型 · 免费");
    fireEvent.change(personaBox(), { target: { value: "我自己写的" } });
    await click(inMain().getByRole("button", { name: "帮我起草" }));
    expect(dialog().textContent).toContain("起草的内容会替换人格文档里现有的文字。");
    await click(within(dialog()).getByRole("button", { name: "取消" }));
    expect(draftPersona).not.toHaveBeenCalled();
    expect(personaBox().value).toBe("我自己写的");
    await click(inMain().getByRole("button", { name: "帮我起草" }));
    await click(within(dialog()).getByRole("button", { name: "起草并替换" }));
    expect(draftPersona).toHaveBeenCalledTimes(1);
    expect(personaBox().value).toBe("起草的人格");
  });

  it("shows a busy state while drafting and cannot be pressed twice; the box cannot be typed into meanwhile", async () => {
    const pending = deferred();
    const draftPersona = vi.fn(() => pending.promise);
    await ready({ draftPersona });
    type("名称", "美食家");
    await chooseModel("小模型 · 免费");
    await click(inMain().getByRole("button", { name: "帮我起草" }));
    const busy = inMain().getByRole("button", { name: "起草中…" });
    expect(busy.disabled).toBe(true);
    await click(busy);
    expect(draftPersona).toHaveBeenCalledTimes(1);
    expect(personaBox().readOnly).toBe(true);
    await act(async () => pending.resolve({ persona: "好了" }));
    await flush();
    expect(personaBox().value).toBe("好了");
    expect(personaBox().readOnly).toBe(false);
  });

  it("a refusal is said under the persona box, never as a toast", async () => {
    const draftPersona = vi.fn(async () => {
      throw apiError(402, "no_quota", "balance");
    });
    await ready({ draftPersona });
    type("名称", "美食家");
    await chooseModel("大模型 · 需余额");
    await click(inMain().getByRole("button", { name: "帮我起草" }));
    const field = personaBox().closest(".field");
    expect(field.textContent).toContain("余额不足：这个模型需要余额才能使用。");
    expect(toastText()).toBeNull();
    expect(personaBox().value).toBe("");
    draftPersona.mockImplementation(async () => {
      throw apiError(400, "context_too_small");
    });
    await click(inMain().getByRole("button", { name: "帮我起草" }));
    expect(field.textContent).toContain("所选模型的上下文太小，放不下起草所需的内容，请换一个模型。");
    fireEvent.change(personaBox(), { target: { value: "我自己来写" } });
    expect(field.textContent).not.toContain("所选模型的上下文太小");
    expect(field.querySelector('[role="alert"]')).toBeNull();
  });
});

describe("思考程度", () => {
  it("lists only the levels the chosen model allows, and is hidden for a model that allows none", async () => {
    await openAgents();
    await openCreate();
    expect(inMain().queryByLabelText("思考程度")).toBeNull();
    await chooseModel("小模型 · 免费");
    expect(inMain().queryByLabelText("思考程度")).toBeNull();
    await chooseModel("大模型 · 需余额");
    expect(levels()).toEqual(["不思考", "低", "高"]);
    await chooseModel("gpt-x");
    expect(levels()).toEqual(["不思考", "低", "中", "高", "很高", "最高"]);
    fireEvent.change(inMain().getByLabelText("思考程度"), { target: { value: "max" } });
    await chooseModel("大模型 · 需余额");
    expect(inMain().getByLabelText("思考程度").value).toBe("none");
    await chooseModel("plain");
    expect(inMain().queryByLabelText("思考程度")).toBeNull();
  });

  it("a provider model that lists its reasoningLevels offers 不思考 and those only", async () => {
    const listing = providerOf(undefined, {
      models: [
        { name: "some-levels", vision: false, pdf: false, reasoning: true, contextTokens: 64000, reasoningLevels: ["low", "high", "max"] },
        { name: "all-levels", vision: false, pdf: false, reasoning: true, contextTokens: 64000 },
      ],
    });
    await openAgents({ providers: [listing] });
    await openCreate();
    await chooseModel("some-levels");
    expect(levels()).toEqual(["不思考", "低", "高", "最高"]);
    fireEvent.change(inMain().getByLabelText("思考程度"), { target: { value: "max" } });
    await chooseModel("all-levels");
    expect(levels()).toEqual(["不思考", "低", "中", "高", "很高", "最高"]);
    expect(inMain().getByLabelText("思考程度").value).toBe("max");
  });
});

describe("no model source at all", () => {
  it("the form says so and leads to Settings › 模型供应商; nothing can be created", async () => {
    const createAgent = vi.fn();
    await openAgents({ api: { createAgent }, models: { siteModels: [], providerDefaults: MODELS.providerDefaults }, providers: [] });
    await openCreate();
    expect(mainText()).toContain("还没有可用的模型");
    expect(inMain().queryByLabelText("模型")).toBeNull();
    type("名称", "MyBot");
    expect(createButton().disabled).toBe(true);
    expect(document.querySelector(".main-col .form-actions .reason").textContent).toBe("还没有可用的模型，需要先添加模型供应商");
    await click(inMain().getByRole("button", { name: "添加模型供应商" }));
    expect(sectionShown()).toContain("设置");
    expect(createAgent).not.toHaveBeenCalled();
  });
});

describe("editing an Agent", () => {
  const agent = () =>
    agentOf(AG1, { intro: "旧简介", field: "旅行", persona: "你是旅行家。", personaVersion: 1, model: { source: "site", id: "paid-1" }, reasoning: "low" });

  it("opens filled in, sends only what changed, and returns to the detail", async () => {
    const patchAgent = vi.fn(async (_id, patch) => ({ ...agent(), ...patch }));
    await openAgents({ agents: [agent()], api: { patchAgent } });
    await openRow("小助手");
    await click(inMain().getByRole("button", { name: /编辑/ }));
    expect(inMain().getByLabelText("名称").value).toBe("小助手");
    expect(inMain().getByLabelText("简介").value).toBe("旧简介");
    expect(personaBox().value).toBe("你是旅行家。");
    expect(inMain().getByLabelText("思考程度").value).toBe("low");
    expect(inMain().queryByLabelText("账号名")).toBeNull();
    expect(mainText()).toContain("@helper");
    type("简介", "新简介");
    await click(inMain().getByRole("button", { name: "保存" }));
    expect(patchAgent).toHaveBeenCalledWith(AG1, { intro: "新简介" });
    expect(document.querySelector(".main-col .lead").textContent).toBe("新简介");
  });

  it("a changed model is sent with its reasoning level", async () => {
    const patchAgent = vi.fn(async (_id, patch) => ({ ...agent(), ...patch }));
    await openAgents({ agents: [agent()], api: { patchAgent } });
    await openRow("小助手");
    await click(inMain().getByRole("button", { name: /编辑/ }));
    await chooseModel("小模型 · 免费");
    await click(inMain().getByRole("button", { name: "保存" }));
    expect(patchAgent).toHaveBeenCalledWith(AG1, { model: SITE_MODEL, reasoning: "none" });
  });

  it("a refusal stays on the form, inline; an Agent deleted meanwhile is then shown as deleted", async () => {
    const patchAgent = vi.fn(async () => {
      throw apiError(400, "invalid_request");
    });
    const app = await openAgents({ agents: [agent()], api: { patchAgent } });
    app.transport.handlers.agent = () => agent();
    await openRow("小助手");
    await click(inMain().getByRole("button", { name: /编辑/ }));
    type("简介", "新简介");
    await click(inMain().getByRole("button", { name: "保存" }));
    expect(mainText()).toContain("填写的内容有误，或所选模型、思考程度不可用。");
    expect(toastText()).toBeNull();
    expect(inMain().getByLabelText("简介").value).toBe("新简介");

    patchAgent.mockImplementation(async () => {
      throw apiError(409, "agent_deleted");
    });
    app.transport.handlers.agent = () => ({ ...agent(), deleted: true });
    await click(inMain().getByRole("button", { name: "保存" }));
    expect(document.querySelector(".main-col .profile-head h2").textContent).toContain("已删除");
    expect(inMain().queryByRole("button", { name: "保存" })).toBeNull();
    expect(toastText()).toBeNull();
  });

  const CHANGED_ELSEWHERE = "这个 Agent 的配置刚刚在别处有改动，保存会用你这里的内容覆盖你改过的几项。";
  /** The record changes elsewhere while the form is open (another device, a confirmed proposal): an `agent` push. */
  const changeElsewhere = async (app, fields) => {
    app.transport.handlers.agent = () => ({ ...agent(), ...fields });
    await push(app.transport, { type: "agent", id: AG1 });
    await flush();
  };
  const openEdit = async (api = {}) => {
    const app = await openAgents({ agents: [agent()], api });
    await openRow("小助手");
    await click(inMain().getByRole("button", { name: /编辑/ }));
    return app;
  };

  it("a field changed elsewhere that I did not touch shows the new value and is not sent back", async () => {
    const patchAgent = vi.fn(async (_id, patch) => ({ ...agent(), persona: "别处改的人格", personaVersion: 2, ...patch }));
    const app = await openEdit({ patchAgent });
    await changeElsewhere(app, { persona: "别处改的人格", personaVersion: 2 });
    expect(personaBox().value).toBe("别处改的人格");
    type("简介", "新简介");
    expect(mainText()).not.toContain(CHANGED_ELSEWHERE);
    await click(inMain().getByRole("button", { name: "保存" }));
    expect(patchAgent).toHaveBeenCalledTimes(1);
    expect(patchAgent.mock.calls[0][1]).toEqual({ intro: "新简介" });
  });

  it("a field I touched that changes elsewhere keeps my text, says that saving overwrites it, and sends only mine", async () => {
    const patchAgent = vi.fn(async (_id, patch) => ({ ...agent(), ...patch }));
    const app = await openEdit({ patchAgent });
    fireEvent.change(personaBox(), { target: { value: "我改过的人格" } });
    await changeElsewhere(app, { persona: "别处改的人格", personaVersion: 2, intro: "别处改的简介" });
    expect(personaBox().value).toBe("我改过的人格");
    expect(inMain().getByLabelText("简介").value).toBe("别处改的简介");
    expect(mainText()).toContain(CHANGED_ELSEWHERE);
    await click(inMain().getByRole("button", { name: "保存" }));
    expect(patchAgent.mock.calls[0][1]).toEqual({ persona: "我改过的人格" });
  });

  it("a stored reasoning level the model no longer takes is not reset by saving another field", async () => {
    const stale = agentOf(AG1, { intro: "旧简介", model: { source: "site", id: "free-1" }, reasoning: "high" });
    const patchAgent = vi.fn(async (_id, patch) => ({ ...stale, ...patch }));
    await openAgents({ agents: [stale], api: { patchAgent } });
    await openRow("小助手");
    await click(inMain().getByRole("button", { name: /编辑/ }));
    expect(inMain().queryByLabelText("思考程度")).toBeNull();
    type("简介", "新简介");
    await click(inMain().getByRole("button", { name: "保存" }));
    expect(patchAgent.mock.calls[0][1]).toEqual({ intro: "新简介" });
  });

  describe("the avatar", () => {
    const png = () => fakeFile("bot.png", 1000, "image/png");
    const pick = async (file) => {
      fireEvent.change(inMain().getByLabelText("选择头像图片"), { target: { files: [file] } });
      await flush();
    };

    it("is held and sent by 保存, after the other changes; the form has no separate 保存头像", async () => {
      const order = [];
      const patchAgent = vi.fn(async (_id, patch) => {
        order.push("patch");
        return { ...agent(), ...patch };
      });
      const uploadAgentAvatar = vi.fn(async () => {
        order.push("avatar");
        return { ok: true };
      });
      await openEdit({ patchAgent, uploadAgentAvatar });
      const file = png();
      await pick(file);
      expect(document.querySelector('img[alt="新头像预览"]')).toBeTruthy();
      expect(inMain().queryByRole("button", { name: "保存头像" })).toBeNull();
      expect(uploadAgentAvatar).not.toHaveBeenCalled();
      type("简介", "新简介");
      await click(inMain().getByRole("button", { name: "保存" }));
      expect(order).toEqual(["patch", "avatar"]);
      expect(uploadAgentAvatar).toHaveBeenCalledWith(AG1, file);
      expect(document.querySelector(".main-col .lead").textContent).toBe("新简介");
    });

    it("alone, 保存 uploads it without any other request", async () => {
      const patchAgent = vi.fn();
      const uploadAgentAvatar = vi.fn(async () => ({ ok: true }));
      await openEdit({ patchAgent, uploadAgentAvatar });
      await pick(png());
      await click(inMain().getByRole("button", { name: "保存" }));
      expect(uploadAgentAvatar).toHaveBeenCalledTimes(1);
      expect(patchAgent).not.toHaveBeenCalled();
      expect(document.querySelector(".main-col [role=tablist]")).toBeTruthy();
    });

    it("that fails to upload keeps the form, says the rest was saved, and is sent alone when saving again", async () => {
      const patchAgent = vi.fn(async (_id, patch) => ({ ...agent(), ...patch }));
      const uploadAgentAvatar = vi.fn(async () => {
        throw apiError(413, "too_large");
      });
      await openEdit({ patchAgent, uploadAgentAvatar });
      await pick(png());
      type("简介", "新简介");
      await click(inMain().getByRole("button", { name: "保存" }));
      expect(mainText()).toContain("其他修改已保存，但头像没有上传成功：头像不能超过 2 MB。");
      expect(toastText()).toBeNull();
      expect(inMain().getByLabelText("简介").value).toBe("新简介");
      uploadAgentAvatar.mockImplementation(async () => ({ ok: true }));
      await click(inMain().getByRole("button", { name: "保存" }));
      expect(patchAgent).toHaveBeenCalledTimes(1);
      expect(uploadAgentAvatar).toHaveBeenCalledTimes(2);
      expect(document.querySelector(".main-col [role=tablist]")).toBeTruthy();
    });

    it("picked and not saved: 取消 asks once before dropping it", async () => {
      const uploadAgentAvatar = vi.fn();
      await openEdit({ uploadAgentAvatar });
      await pick(png());
      await click(inMain().getByRole("button", { name: "取消" }));
      expect(dialog().textContent).toContain("头像还没有保存，确定放弃吗？");
      await click(within(dialog()).getByRole("button", { name: "继续编辑" }));
      expect(dialog()).toBeNull();
      expect(inMain().getByLabelText("简介")).toBeTruthy();
      await click(inMain().getByRole("button", { name: "取消" }));
      await click(within(dialog()).getByRole("button", { name: "放弃" }));
      expect(document.querySelector(".main-col [role=tablist]")).toBeTruthy();
      expect(uploadAgentAvatar).not.toHaveBeenCalled();
    });

    it("nothing picked, or the pick dropped (不用这张): 取消 leaves at once and nothing is uploaded", async () => {
      const uploadAgentAvatar = vi.fn();
      await openEdit({ uploadAgentAvatar });
      await pick(png());
      await click(inMain().getByRole("button", { name: "不用这张" }));
      expect(document.querySelector('img[alt="新头像预览"]')).toBeNull();
      await click(inMain().getByRole("button", { name: "取消" }));
      expect(dialog()).toBeNull();
      expect(document.querySelector(".main-col [role=tablist]")).toBeTruthy();
      expect(uploadAgentAvatar).not.toHaveBeenCalled();
    });
  });
});

describe("群里谁可以叫它 (groupMentions)", () => {
  const box = () => inMain().getByLabelText("群里谁可以叫它");

  it("creating: 所有群成员 by default, 仅我 sends owner; the hint says the owner pays", async () => {
    const createAgent = vi.fn(async () => agentOf(AG1));
    await openAgents({ api: { createAgent } });
    await openCreate();
    expect(box().value).toBe("members");
    expect(within(box()).getAllByRole("option").map((o) => o.textContent)).toEqual(["所有群成员", "仅我"]);
    expect(box().closest(".field").textContent).toContain("被叫到时它会在群里回复，费用算你的。");
    type("名称", "MyBot");
    fireEvent.change(box(), { target: { value: "owner" } });
    await chooseModel("小模型 · 免费");
    await click(createButton());
    expect(createAgent.mock.calls[0][0]).toMatchObject({ groupMentions: "owner" });
  });

  it("editing: opens with the stored choice and sends it only when changed; the Agent's page shows it", async () => {
    const record = agentOf(AG1, { model: SITE_MODEL, groupMentions: "owner" });
    const patchAgent = vi.fn(async (_id, patch) => ({ ...record, ...patch }));
    await openAgents({ agents: [record], api: { patchAgent } });
    await openRow("小助手");
    expect(document.querySelector(".main-col .kv").textContent).toContain("群里谁可以叫它仅我");
    await click(inMain().getByRole("button", { name: /编辑/ }));
    expect(box().value).toBe("owner");
    type("简介", "新简介");
    await click(inMain().getByRole("button", { name: "保存" }));
    expect(patchAgent.mock.calls[0][1]).toEqual({ intro: "新简介" });
    await click(inMain().getByRole("button", { name: /编辑/ }));
    fireEvent.change(box(), { target: { value: "members" } });
    await click(inMain().getByRole("button", { name: "保存" }));
    expect(patchAgent.mock.calls[1][1]).toEqual({ groupMentions: "members" });
    expect(document.querySelector(".main-col .kv").textContent).toContain("群里谁可以叫它所有群成员");
  });
});

describe("someone else's Agent (batch 2C)", () => {
  it("in a group I share with its owner is not one of my Agents: not listed here, nor under 我的 Agent", async () => {
    const OAG = "00000000-0000-4000-8000-0000000000b9";
    const annBot = { ...agentPrincipal(OAG, "annbot", "安的助手"), ownerId: ANN, intro: "帮小安记事", field: "记事" };
    const members = [ME_ID, ANN, OAG].map((id, i) => ({ id, role: "speaker", isCreator: i === 0 }));
    const listAgents = vi.fn(async () => ({ agents: [agentOf(AG1, { model: SITE_MODEL })] }));
    await openAgents({
      agents: [agentOf(AG1, { model: SITE_MODEL })],
      extra: [group(G1, { members })],
      others: [annBot],
      social: { ...emptySocial(), friends: [PEOPLE[ANN]] },
      api: { listAgents },
    });
    expect(rowNames()).toEqual(["小助手"]);
    // (Nothing of mine is waiting for its record: the list is not asked for again.)
    expect(listAgents).not.toHaveBeenCalled();
    await goContacts();
    expect(rowNames()).toEqual(["小安", "小助手"]);
  });
});

describe("the model's logo", () => {
  it("shows the lab's logo before a known model's name in the list and on the page", async () => {
    const agents = [agentOf(AG1, { field: "旅行", model: { source: "provider", providerId: P1, model: "gpt-x" } })];
    await openAgents({ agents });
    expect(rowOf("小助手").querySelector(".row-preview img").getAttribute("src")).toBe("/logos/labs/openai.svg");
    await openRow("小助手");
    expect(document.querySelector(".main-col .kv img").getAttribute("src")).toBe("/logos/labs/openai.svg");
  });
});

describe("the Agent's page", () => {
  const live = () => agentOf(AG1, { intro: "陪你规划旅行", field: "旅行", persona: "你是旅行家。", model: SITE_MODEL });

  it("shows the profile; the device tab only says 尚未开放", async () => {
    await openAgents({ agents: [live()] });
    await openRow("小助手");
    expect(document.querySelector(".main-col .profile-head h2").textContent).toContain("可回复");
    expect(mainText()).toContain("@helper · 主人：你");
    const kv = document.querySelector(".main-col .kv").textContent;
    for (const text of ["你（不可修改）", "旅行", "小模型", "你是旅行家。", "收到消息时回复"]) expect(kv).toContain(text);
    expect(kv).not.toContain("群内回复方式");
    expect(document.querySelector(".main-col .kv img")).toBeNull();
    const tabs = within(inMain().getByRole("tablist", { name: "Agent 分区" })).getAllByRole("tab").map((t) => t.textContent);
    expect(tabs).toEqual(["资料", "参与的会话", "能力与设备"]);
    await click(inMain().getByRole("tab", { name: "能力与设备" }));
    expect(document.querySelector(".main-col .page-body").textContent).toBe("尚未开放");
    expect(document.querySelector(".main-col input, .main-col select")).toBeNull();
  });

  it("参与的会话 lists its one conversation and opens it", async () => {
    await openAgents({ agents: [live()] });
    await openRow("小助手");
    await click(inMain().getByRole("tab", { name: "参与的会话" }));
    expect(inMain().getAllByRole("listitem")).toHaveLength(1);
    await click(inMain().getByRole("button", { name: "进入查看" }));
    expect(sectionShown()).toContain("消息");
    expect(chatTitle()).toBe("小助手");
  });

  it("pause and resume toggle the tag and call their routes", async () => {
    const pauseAgent = vi.fn(async () => ({ ...live(), paused: true }));
    const resumeAgent = vi.fn(async () => ({ ...live(), paused: false }));
    await openAgents({ agents: [live()], api: { pauseAgent, resumeAgent } });
    await openRow("小助手");
    await click(inMain().getByRole("button", { name: "暂停全部会话" }));
    expect(pauseAgent).toHaveBeenCalledWith(AG1);
    expect(resumeAgent).not.toHaveBeenCalled();
    expect(document.querySelector(".main-col .profile-head h2").textContent).toContain("已暂停全部会话");
    expect(rowOf("小助手").querySelector(".tag").textContent).toBe("已暂停");
    expect(mainText()).toContain("已暂停全部会话：它不会有新回复。");
    await click(inMain().getByRole("button", { name: "恢复全部会话" }));
    expect(resumeAgent).toHaveBeenCalledWith(AG1);
    expect(pauseAgent).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".main-col .profile-head h2").textContent).toContain("可回复");
  });

  it("a refused pause says why", async () => {
    const pauseAgent = vi.fn(async () => {
      throw apiError(409, "agent_deleted");
    });
    await openAgents({ agents: [live()], api: { pauseAgent } });
    await openRow("小助手");
    await click(inMain().getByRole("button", { name: "暂停全部会话" }));
    expect(toastText()).toBe("这个 Agent 已删除。");
  });

  it("delete asks first, then the Agent is listed last as 已删除 and offers no actions; its chat stays reachable", async () => {
    const other = agentOf(AG2, { handle: "cook", name: "厨师", conversationId: A2, model: SITE_MODEL, createdAt: at(5) });
    const deleteAgent = vi.fn(async () => ({ ...live(), deleted: true }));
    await openAgents({ agents: [live(), other], api: { deleteAgent } });
    expect(rowNames()).toEqual(["小助手", "厨师"]);
    await openRow("小助手");
    await click(inMain().getByRole("button", { name: /删除 Agent/ }));
    expect(dialog().textContent).toContain("删除后不可恢复。");
    expect(dialog().textContent).toContain("聊天记录会保留，只能查看。");
    await click(within(dialog()).getByRole("button", { name: "取消" }));
    expect(deleteAgent).not.toHaveBeenCalled();
    await click(inMain().getByRole("button", { name: /删除 Agent/ }));
    await click(within(dialog()).getByRole("button", { name: "确认删除" }));
    expect(deleteAgent).toHaveBeenCalledWith(AG1);
    expect(dialog()).toBeNull();
    expect(rowNames()).toEqual(["厨师", "小助手"]);
    expect(rowOf("小助手").querySelector(".tag").textContent).toBe("已删除");
    expect(document.querySelector(".main-col .profile-head h2").textContent).toContain("已删除");
    for (const name of [/编辑/, /暂停/, /恢复/, /删除 Agent/]) expect(inMain().queryByRole("button", { name })).toBeNull();
    await click(inMain().getByRole("tab", { name: "参与的会话" }));
    await click(inMain().getByRole("button", { name: "进入查看" }));
    expect(chatTitle()).toBe("小助手");
  });
});

describe("contacts: 我的 Agent", () => {
  it("lists my Agents that are not deleted under 我的 Agent, below my friends; a row opens its chat", async () => {
    const agents = [agentOf(AG1, { model: SITE_MODEL }), agentOf(AG2, { handle: "cook", name: "厨师", conversationId: A2, deleted: true })];
    await openAgents({
      agents,
      social: { ...emptySocial(), friends: [PEOPLE[ANN]] },
      extra: [direct(D1, ANN, { lastSeq: 1, readSeq: 1 })],
    });
    await goContacts();
    const labels = [...document.querySelectorAll(".list-col .rows-label")].map((x) => x.textContent);
    expect(labels).toEqual(["好友", "我的 Agent"]);
    expect(rowNames()).toEqual(["小安", "小助手"]);
    const row = rowOf("小助手");
    expect(row.querySelector(".tag").textContent).toBe("Agent");
    expect(row.querySelector(".row-preview").textContent).toBe("@helper");
    expect(document.querySelector(".list-col [role=tablist]")).toBeNull();
    expect(inList().getByRole("button", { name: "添加好友" })).toBeTruthy();
    expect(document.querySelector(".list-col").textContent.replace("Agent Family", "").match(/Agent/g)).toHaveLength(2);
    await click(row);
    expect(sectionShown()).toContain("消息");
    expect(chatTitle()).toBe("小助手");
  });

  it("the search box finds my Agents by name or account name", async () => {
    await openAgents({ agents: [agentOf(AG1, { model: SITE_MODEL })], social: { ...emptySocial(), friends: [PEOPLE[ANN]] } });
    await goContacts();
    const box = screen.getByLabelText("搜索联系人的名字或账号");
    fireEvent.change(box, { target: { value: "@help" } });
    expect(rowNames()).toEqual(["小助手"]);
    fireEvent.change(box, { target: { value: "小安" } });
    expect(rowNames()).toEqual(["小安"]);
  });
});
