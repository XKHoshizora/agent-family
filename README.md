# Agent Family

在同一个群聊里，与不同模型的 AI 伙伴一起讨论、写作和开发。

**0.1.0 内部邀请测试版 · Web + LINE**。网页已部署；GPT 和 Claude 已进行真实调用验证。Gemini 适配已实现，但本次 CanalAPI 没有返回可用 Gemini 模型。LINE 连接器已通过签名、绑定和消息处理测试，真实群接通仍需 LINE 官方账号的凭据。

## 立即使用

- 在线入口：[打开 Agent Family](https://agent-family-web-production.up.railway.app)
- 这台电脑上的管理员登录信息：`.local/ACCESS-CLOUD.md`。该文件包含密码，不要上传、截图或转发。
- 登录后，在「设置 → 偏好与账户」修改密码。已有真实测试群可查看；新建自己的群聊即可开始。
- 默认是邀请制。管理员在「设置 → 团队成员」创建邀请链接，不开放自行注册。

## 当前功能

| 场景 | 当前版本 |
| --- | --- |
| 日常群聊 | 1–5 位伙伴；不同模型、名字和职责；各自回答、两轮讨论、指定一位；`@小文` 点名 |
| 对话管理 | 流式回答、停止、私有/团队群、归档、搜索群名、持久历史、Markdown/JSON 导出 |
| 写作资料 | 群聊笔记、文本/代码附件、Markdown 与代码复制；有限工具可读笔记和保存草稿 |
| 开发 | 共享项目或伙伴独立分支；读取文件、提出变更、人工审查差异、批准/拒绝、版本冲突检查、合并至共享项目、ZIP 导出 |
| 公司试用 | 邀请制空间、所有者/管理员/成员/只读角色、私有群隔离、审计、模型调用次数限制 |
| LINE | 一个官方账号按伙伴名回复；`/af 问题`；群内绑定码 + 网页确认；普通聊天不保存、不触发 AI |

开发工作台交付经过人工批准的代码文件。**当前不会运行终端命令、自动测试生成的项目或发布生成的应用**。“批准保存”不表示代码已经安全或通过测试。

## 三分钟上手

1. 新建群聊，选择日常聊天、写作、协作开发或团队工作模板。
2. 点击右侧伙伴可改名字、职责和模型。没有可用模型的伙伴会停用，管理员可在模型服务里补充。
3. 输入问题。「一起讨论」先各自回答，再回应彼此，共两轮。
4. 开发群里让伙伴“先读取项目，再提交变更”。到项目工作台审查，批准后才成为项目文件。
5. 邀请同事后把群设为团队可见。接 LINE 前阅读共享范围提示。

## 本机运行

需要 Node.js 24 或更新版本。Windows 可双击 `Start-Agent-Family.cmd`；全新安装首次安装依赖并构建。访问 `http://localhost:4317`。这台电脑的本机版已准备好，凭据在 `.local/ACCESS.md`；全新安装则首次创建自己的账户。本机和在线版数据独立。

```powershell
npm ci
npm run build
npm start
```

开发运行 `npm run dev`。配置见 `.env.example`。默认只监听本机；已有 `CanalAPI-Key.txt` 只在服务器端读取。

停止后台进程：`powershell -ExecutionPolicy Bypass -File .\Stop-Agent-Family.ps1`。数据在 `data/`，停止不会清空。

## 文档

- [使用与 LINE 接入](docs/USER-GUIDE.md)
- [架构、权限、工具与执行流程](docs/ARCHITECTURE.md)
- [部署、备份、恢复与维护](docs/OPERATIONS.md)
- [安全边界](SECURITY.md)
- [测试与交付证据](docs/ACCEPTANCE.md)
- [开源调研](docs/research/2026-11-13-open-source-survey.md)
- [原始产品设计与路线](docs/design/2026-11-13-agent-family-proposal.md)
- [开源组件与许可](THIRD-PARTY-NOTICES.md)

这是内部试用第一版；企业合规、SSO、计费、跨区域灾备和公众运营尚未完成。Agent Family 仍是工作品牌，未完成商标核查。
