import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { unzipSync, strFromU8 } from "fflate";
test.describe.serial("Web workspace end-to-end", () => {
  let page: Page, context: BrowserContext;
  const errors: string[] = [];
  const email = "browser-owner@example.test",
    password = "Browser-test-password-123!";
  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      baseURL: "http://localhost:4318",
    });
    page = await context.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
  });
  test.afterAll(async () => {
    await context.close();
  });
  test("first-run account setup lands in a real empty room", async () => {
    await page.goto("/");
    await expect(page).toHaveTitle(/Agent Family/);
    await page.getByLabel("怎么称呼你", { exact: true }).fill("浏览器测试员");
    await page.getByLabel("邮箱", { exact: true }).fill(email);
    await page.getByLabel("密码", { exact: true }).fill(password);
    await page.getByRole("button", { name: "创建账户并进入" }).click();
    await expect(page.getByRole("heading", { name: "灵感客厅" })).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "一个问题，听听大家怎么说" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "发送消息" })).toBeDisabled();
  });
  test("admin can configure a model without returning its secret", async () => {
    await page.getByRole("button", { name: "设置模型服务" }).click();
    await page.getByRole("button", { name: "添加", exact: true }).click();
    await page.getByLabel("服务名称", { exact: true }).fill("test-provider");
    await page
      .getByLabel("API 密钥", { exact: true })
      .fill("fake-ui-test-secret");
    await page
      .getByLabel("模型名称", { exact: true })
      .fill("gpt-test-model\nclaude-test-model\ngemini-test-model");
    await page.getByRole("button", { name: "保存服务" }).click();
    await expect(page.getByText("3 个已配置模型")).toBeVisible();
    await page.getByRole("button", { name: "编辑配置" }).click();
    await expect(page.getByLabel("API 密钥", { exact: true })).toHaveValue("");
    await page
      .getByRole("dialog", { name: "编辑模型服务" })
      .getByRole("button", { name: "关闭", exact: true })
      .click();
    await page
      .getByRole("dialog", { name: "空间设置" })
      .getByRole("button", { name: "关闭", exact: true })
      .click();
  });
  test("creates independent developer agents in a team room", async () => {
    await page.getByRole("button", { name: "新建群聊" }).click();
    await page.getByLabel("群聊名称", { exact: true }).fill("开发测试群");
    await page.getByRole("button", { name: "协作开发" }).click();
    await page
      .getByLabel("开发方式", { exact: true })
      .selectOption("independent");
    await page
      .getByLabel("谁可以看到这个群", { exact: true })
      .selectOption("team");
    await page.getByRole("button", { name: "创建群聊", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "开发测试群" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "打开项目工作台" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "编辑 开发者" }).click();
    await expect(page.getByLabel("使用的模型", { exact: true })).toHaveValue(
      "test-provider::claude-test-model",
    );
    await page.getByLabel("伙伴名字", { exact: true }).fill("编码伙伴");
    await page.getByRole("button", { name: "保存伙伴" }).click();
    await expect(
      page.getByRole("button", { name: "编辑 编码伙伴" }),
    ).toBeVisible();
  });
  test("file proposals stay pending until reviewed and export genuine ZIP contents", async () => {
    await page.getByRole("button", { name: "打开项目工作台" }).click();
    await page.getByRole("button", { name: "新文件" }).click();
    await page.getByLabel("文件路径", { exact: true }).fill("src/hello.ts");
    await page
      .getByLabel("变更说明", { exact: true })
      .fill("添加浏览器验收文件");
    await page
      .getByLabel("文件内容", { exact: true })
      .fill('export const greeting = "hello";\n');
    await page.getByRole("button", { name: "提交审查", exact: true }).click();
    await page.getByRole("button", { name: /添加浏览器验收文件/ }).click();
    await expect(
      page.getByRole("button", { name: "批准并保存" }),
    ).toBeVisible();
    await expect(page.locator(".code-diff")).toContainText(
      "export const greeting",
    );
    await page.getByRole("button", { name: "批准并保存" }).click();
    await expect(page.getByText("变更已批准并保存")).toBeVisible();
    await page.getByRole("button", { name: "项目文件", exact: true }).click();
    await expect(page.locator(".project-file pre")).toContainText(
      "export const greeting",
    );
    const downloadEvent = page.waitForEvent("download");
    await page.getByRole("link", { name: "下载 ZIP" }).click();
    const downloaded = await downloadEvent;
    const location = await downloaded.path();
    const zip = unzipSync(fs.readFileSync(location!));
    expect(strFromU8(zip["src/hello.ts"])).toBe(
      'export const greeting = "hello";\n',
    );
    await page
      .getByRole("dialog", { name: "项目工作台" })
      .getByRole("button", { name: "关闭", exact: true })
      .click();
  });
  test("notes persist across refresh and render Markdown safely", async () => {
    await page.getByRole("button", { name: "打开群聊笔记" }).click();
    await page.getByRole("button", { name: "新建笔记" }).click();
    await page.getByLabel("标题", { exact: true }).fill("团队需求");
    await page
      .getByLabel("内容", { exact: true })
      .fill(
        "# 需求\n\n- 支持多伙伴\n\n<script>window.__injected=true</script>",
      );
    await page.getByRole("button", { name: "保存笔记" }).click();
    await page.getByRole("button", { name: /团队需求/ }).click();
    await expect(
      page.getByRole("heading", { name: "需求", exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(() => (window as any).__injected),
    ).toBeUndefined();
    await page.getByRole("button", { name: "关闭", exact: true }).click();
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "开发测试群" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "打开群聊笔记" }).click();
    await expect(page.getByRole("button", { name: /团队需求/ })).toBeVisible();
    await page.getByRole("button", { name: "关闭", exact: true }).click();
  });
  test("LINE shows an honest disconnected state and setup path", async () => {
    await page.getByRole("button", { name: "连接群聊", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "连接 LINE 群聊" }),
    ).toBeVisible();
    await expect(
      page.getByLabel("LINE 默认聊天方式", { exact: true }),
    ).toHaveValue("parallel");
    await expect(
      page.getByRole("checkbox", { name: /允许 LINE 群成员/ }),
    ).not.toBeChecked();
    await page.getByRole("button", { name: "生成绑定码" }).click();
    await expect(page.getByRole("alert")).toContainText("请先验证并启用 LINE");
    await page.getByRole("button", { name: "打开 LINE 服务设置" }).click();
    await expect(page.getByText("尚未配置", { exact: true })).toBeVisible();
    await expect(
      page.getByLabel("Channel secret", { exact: true }),
    ).toHaveValue("");
    await page.getByRole("button", { name: "关闭", exact: true }).click();
  });
  test("single-mode mentions synchronize the target and show reserved call estimates", async () => {
    const rooms = await (await context.request.get("/api/rooms")).json();
    const r = rooms.find((r: any) => r.name === "开发测试群");
    const coder = r.agents.find((a: any) => a.name === "编码伙伴");
    const received: any[] = [];
    const endpoint = `**/api/rooms/${r.id}/messages`;
    await page.route(endpoint, async (route) => {
      received.push(route.request().postDataJSON());
      await route.fulfill({ status: 202, json: { runId: "ui-routing-test" } });
    });
    try {
      await page
        .getByLabel("本轮聊天方式", { exact: true })
        .selectOption("single");
      await page
        .getByLabel("选择回答的伙伴", { exact: true })
        .selectOption(r.agents[0].id);
      await page
        .getByLabel("消息", { exact: true })
        .fill("@编码伙伴 请看看这个方案");
      await expect(
        page.getByLabel("选择回答的伙伴", { exact: true }),
      ).toHaveValue(coder.id);
      await expect(page.locator(".composer-budget")).toContainText(
        "预留最多 3 次",
      );
      await page.getByRole("button", { name: "发送消息", exact: true }).click();
      await expect.poll(() => received.length).toBe(1);
      expect(received[0].targets).toEqual([coder.id]);
      await page
        .getByLabel("消息", { exact: true })
        .fill("@架构师 @编码伙伴 一起看看");
      await page.getByRole("button", { name: "发送消息", exact: true }).click();
      await expect(page.getByRole("alert")).toContainText("只能点名一位");
      expect(received).toHaveLength(1);
      await page
        .getByLabel("本轮聊天方式", { exact: true })
        .selectOption("discuss");
      await expect(page.locator(".composer-budget")).toContainText(
        "预留最多 12 次",
      );
    } finally {
      await page.unroute(endpoint);
      await page.getByLabel("消息", { exact: true }).fill("");
      await page
        .getByLabel("本轮聊天方式", { exact: true })
        .selectOption("parallel");
      await page.reload();
    }
  });
  test("LINE policy controls default to private history and submit explicit sharing choices", async () => {
    const rooms = await (await context.request.get("/api/rooms")).json();
    const r = rooms.find((r: any) => r.name === "开发测试群");
    const endpoint = `**/api/rooms/${r.id}/line`;
    let policy = { mode: "parallel", shareTools: false };
    const updates: any[] = [];
    await page.route(endpoint, async (route) => {
      if (route.request().method() === "PATCH") {
        policy = route.request().postDataJSON();
        updates.push(policy);
        await route.fulfill({ json: { ok: true } });
      } else
        await route.fulfill({
          json: {
            linked: true,
            ...policy,
            challenge: null,
            resources: { messages: 8, notes: 2, files: 1 },
            usage: { lineCalls: 3, lineReserved: 2, lineLimit: 40 },
          },
        });
    });
    try {
      await page.getByRole("button", { name: "连接群聊", exact: true }).click();
      await expect(
        page.getByLabel("LINE 默认聊天方式", { exact: true }),
      ).toHaveValue("parallel");
      await expect(
        page.getByRole("checkbox", { name: /允许 LINE 群成员/ }),
      ).not.toBeChecked();
      await expect(
        page.getByText(/默认只读取本次绑定后的 LINE 对话/),
      ).toBeVisible();
      await page
        .getByLabel("LINE 默认聊天方式", { exact: true })
        .selectOption("discuss");
      await page.getByRole("checkbox", { name: /允许 LINE 群成员/ }).check();
      await page
        .getByRole("button", { name: "保存 LINE 设置", exact: true })
        .click();
      await expect.poll(() => updates.length).toBe(1);
      expect(updates[0]).toEqual({ mode: "discuss", shareTools: true });
      await expect(
        page.getByRole("button", { name: "保存 LINE 设置", exact: true }),
      ).toBeDisabled();
      await page.getByRole("checkbox", { name: /允许 LINE 群成员/ }).uncheck();
      await page
        .getByRole("button", { name: "保存 LINE 设置", exact: true })
        .click();
      await expect.poll(() => updates.length).toBe(2);
      expect(updates[1].shareTools).toBe(false);
      if (process.env.AF_QA_DIR)
        await page.screenshot({
          path: path.join(process.env.AF_QA_DIR, "review-hardening-line.png"),
        });
      await page.getByRole("button", { name: "关闭", exact: true }).click();
    } finally {
      await page.unroute(endpoint);
    }
  });
  test("invites and workspace name changes update real settings", async () => {
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page
      .getByLabel("空间名称", { exact: true })
      .fill("Agent Family 验收空间");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByText("名称已保存")).toBeVisible();
    await page.getByRole("button", { name: "团队成员", exact: true }).click();
    await page.getByRole("button", { name: "创建邀请" }).click();
    await expect(page.locator(".invite-result code")).toContainText(
      "http://localhost:4318/?invite=",
    );
    await page.getByRole("button", { name: "关闭", exact: true }).click();
  });
  test("room rename and exports preserve actual history and metadata", async () => {
    await page.getByRole("button", { name: "群聊设置与导出" }).click();
    await page.getByLabel("群聊名称", { exact: true }).fill("开发验收已完成");
    await page.getByRole("button", { name: "保存设置" }).click();
    await expect(
      page.getByRole("heading", { name: "开发验收已完成" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "群聊设置与导出" }).click();
    const downloaded = page.waitForEvent("download");
    await page.getByRole("link", { name: "导出 JSON" }).click();
    const file = await downloaded;
    const data = JSON.parse(fs.readFileSync((await file.path())!, "utf8"));
    expect(data.room.name).toBe("开发验收已完成");
    expect(data.notes[0].title).toBe("团队需求");
    await page.getByRole("button", { name: "关闭", exact: true }).click();
  });
  test("user bubbles align right and returned reasoning stays collapsed on desktop and mobile", async () => {
    const list = await (await context.request.get("/api/rooms")).json();
    const room = list.find((r: any) => r.name === "开发验收已完成");
    const endpoint = `**/api/rooms/${room.id}`;
    const sample = {
      roomId: room.id,
      runId: "qa-run",
      agentId: null,
      model: null,
      status: "complete",
      source: "web",
      tokens: 0,
      toolEvents: [],
      createdAt: "2026-11-13T01:17:00Z",
    };
    const messages = [
      {
        ...sample,
        id: "qa-user",
        role: "user",
        author: "浏览器测试员",
        content: "Ciallo～今天一起聊聊吧。",
      },
      {
        ...sample,
        id: "qa-plain",
        role: "assistant",
        author: "GPT",
        agentId: "qa-gpt",
        model: "test-gpt",
        content: "你好！今天想聊点什么？",
      },
      {
        ...sample,
        id: "qa-reasoning",
        role: "assistant",
        author: "MiniMax",
        agentId: "qa-mini",
        model: "test-minimax",
        reasoning: "MODEL_RETURNED_THOUGHT\n\n先理解问候，再用简洁的中文回应。",
        content:
          "你好～很高兴见到你。我们可以聊创意、写作，或一起完善你的计划。",
      },
      {
        ...sample,
        id: "qa-cancelled",
        role: "assistant",
        author: "Claude",
        agentId: "qa-claude",
        model: "test-claude",
        status: "cancelled",
        reasoning: "已返回的部分思考",
        content: "",
      },
    ];
    await page.route(endpoint, async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      await route.fulfill({ response, json: { ...body, messages } });
    });
    try {
      await page.reload();
      await expect(page).toHaveTitle(/Agent Family/);
      const user = page.locator(".user-message");
      const reasoning = page
        .locator(".agent-message")
        .filter({ hasText: "MiniMax" });
      await expect(user).toContainText("Ciallo");
      await expect(reasoning.locator(".reasoning-panel")).not.toHaveAttribute(
        "open",
      );
      await expect(
        reasoning.getByText("MODEL_RETURNED_THOUGHT", { exact: true }),
      ).not.toBeVisible();
      await expect(
        reasoning.locator(":scope > .message-main > .markdown"),
      ).toContainText("你好～");
      await expect(
        page
          .locator(".agent-message")
          .filter({ hasText: "GPT" })
          .locator(".reasoning-panel"),
      ).toHaveCount(0);
      await expect(
        page
          .locator(".agent-message")
          .filter({ hasText: "Claude" })
          .locator(".thinking"),
      ).toHaveCount(0);
      const checkAlignment = async () => {
        const avatar = await user.locator(".avatar").boundingBox();
        const bubble = await user.locator(".message-main").boundingBox();
        expect(avatar!.x).toBeGreaterThan(bubble!.x + bubble!.width);
        const agentAvatar = await reasoning.locator(".avatar").boundingBox();
        const agentBubble = await reasoning
          .locator(".message-main")
          .boundingBox();
        expect(agentAvatar!.x).toBeLessThan(agentBubble!.x);
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth > innerWidth,
          ),
        ).toBe(false);
      };
      await checkAlignment();
      const capture = async (name: string) => {
        if (process.env.AF_QA_DIR) {
          fs.mkdirSync(process.env.AF_QA_DIR, { recursive: true });
          await page.screenshot({
            path: path.join(process.env.AF_QA_DIR, name),
          });
        }
      };
      await capture("message-reading-desktop.png");
      const toggle = reasoning.locator("summary");
      await toggle.focus();
      await page.keyboard.press("Enter");
      await expect(reasoning.locator(".reasoning-panel")).toHaveAttribute(
        "open",
        "",
      );
      await expect(
        reasoning.getByText("MODEL_RETURNED_THOUGHT", { exact: true }),
      ).toBeVisible();
      await capture("message-reading-expanded.png");
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
      await reasoning
        .getByRole("button", { name: "复制", exact: true })
        .click();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
        messages[2].content,
      );
      await reasoning.getByRole("button", { name: "存为笔记" }).click();
      await expect(page.getByLabel("内容", { exact: true })).toHaveValue(
        messages[2].content,
      );
      await page.getByRole("button", { name: "关闭", exact: true }).click();
      await page.setViewportSize({ width: 390, height: 844 });
      await page.reload();
      await expect(reasoning.locator(".reasoning-panel")).not.toHaveAttribute(
        "open",
      );
      await checkAlignment();
      await page.locator(".message-scroller").evaluate((el) => {
        el.scrollTop = 0;
      });
      await capture("message-reading-mobile.png");
      await toggle.click();
      await expect(
        reasoning.getByText("MODEL_RETURNED_THOUGHT", { exact: true }),
      ).toBeVisible();
      await toggle.click();
      await expect(
        reasoning.getByText("MODEL_RETURNED_THOUGHT", { exact: true }),
      ).not.toBeVisible();
      expect(errors).toEqual([]);
    } finally {
      await page.unroute(endpoint);
      await page.reload();
    }
  });
  test("mobile drawers, focus and composer remain usable without overflow", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(
      page.getByRole("heading", { name: "开发验收已完成" }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
    ).toBe(false);
    await page.getByRole("button", { name: "打开群聊列表" }).click();
    await expect(page.getByRole("dialog", { name: "群聊列表" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("dialog", { name: "群聊列表" }),
    ).not.toBeVisible();
    await page.getByRole("button", { name: "打开伙伴列表" }).click();
    await expect(
      page.getByRole("dialog", { name: "群里的伙伴" }),
    ).toBeVisible();
    await page.keyboard.press("Tab");
    expect(
      await page.evaluate(
        () => !!document.activeElement?.closest('[role="dialog"]'),
      ),
    ).toBe(true);
    await page.keyboard.press("Escape");
    await page.getByLabel("消息", { exact: true }).fill("这是尚未发送的草稿");
    await page.reload();
    await expect(page.getByLabel("消息", { exact: true })).toHaveValue(
      "这是尚未发送的草稿",
    );
    await page.getByLabel("消息", { exact: true }).fill("");
  });
  test("logout and login retain the same workspace without runtime errors", async () => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "退出登录" }).click();
    await expect(page.getByRole("heading", { name: "欢迎回来" })).toBeVisible();
    await page.getByLabel("邮箱", { exact: true }).fill(email);
    await page.getByLabel("密码", { exact: true }).fill(password);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "开发验收已完成" }),
    ).toBeVisible();
    expect(errors).toEqual([]);
  });
});
