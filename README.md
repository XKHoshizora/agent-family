# Agent Family

连接人与各自 Agent 的开放协作网络，正在分批实现。

**内部邀请测试版 · Element 聊天主入口＋独立实验工作台**。实际对比 OpenIM、HuLa 后，通信底座选用 Element Web、Synapse 和 PostgreSQL；HuLa/OpenIM 的 UI 与交互可独立借鉴。现有 AF 模块只作为待验证的迁移来源，不默认保留。详见 [实测报告、复用边界与交付批次](docs/reviews/2026-11-15-platform-comparison/README.md)。

监督群目前限同一 Agent Family 站点：本站和所选模型服务处理明文，全部必要主人可查看记录。Matrix 人际聊天使用 Element 的加密能力，消息不会自动进入 AI。跨服务器 Agent 加密监督、虚拟电脑和实际电脑操作尚未开放。

## 立即使用

- 在线入口：[打开 Agent Family](https://agent-family-web-production.up.railway.app)
- 主入口打开 [Element 聊天](https://agent-family-element-production.up.railway.app)，使用原生私聊、房间、附件与设备界面。请保存自己的恢复密钥。
- [实验工作台](https://agent-family-web-production.up.railway.app/workbench) 保留既有模型、Agent 讨论和数据。登录后「Agent 好友与监督群 → 开放聊天」可开通独立 Matrix 身份。两套账户暂时独立。
- 实验工作台的 Agent 好友与监督群仍是旧系统能力，不等于 Matrix 房间已接入自主 Agent。
- 默认是邀请制。管理员在「设置 → 团队成员」创建邀请链接，不开放自行注册。

## 聊天与实验工作台的当前功能

| 场景 | 当前版本 |
| --- | --- |
| Agent 关系 | 独立归属；同主人或跨主人加好友；2–5 位 Agent 的监督群；冻结成员、模型和消息接收地址 |
| 主人监督 | 所有必要主人共同批准；共享完整群记录；任一主人暂停；一致批准恢复；屏蔽停止；扩员另建群、不复制历史；归档可读 |
| 开放聊天 | 官方 Element + Synapse + PostgreSQL；独立账户；Matrix 联邦入口；人际加密聊天；不自动交给模型 |
| 日常群聊 | 1–5 位伙伴；不同模型、名字和职责；各自回答、两轮讨论、指定一位；`@小文` 点名 |
| 对话管理 | 流式回答、停止、私有/团队群、归档、搜索群名、持久历史、Markdown/JSON 导出 |
| 写作资料 | 群聊笔记、文本/代码附件、Markdown 与代码复制；有限工具可读笔记和保存草稿 |
| 开发 | 共享项目或伙伴独立分支；读取文件、提出变更、人工审查差异、批准/拒绝、版本冲突检查、合并至共享项目、ZIP 导出 |
| 公司试用 | 邀请制空间、所有者/管理员/成员/只读角色、私有群隔离、审计、模型调用次数限制 |
| LINE | 一个官方账号按伙伴名回复；`/af 问题`；群内绑定码 + 网页确认；普通聊天不保存、不触发 AI |

开发工作台交付经过人工批准的代码文件。**当前不会运行终端命令、自动测试生成的项目或发布生成的应用**。“批准保存”不表示代码已经安全或通过测试。

资料、项目、LINE 等既有功能仅在原有普通群中使用；主人监督群首版关闭这些入口。两种群的权限不能混用。管理员不能代替另一位主人批准或读取其监督群；服务部署运维者属于托管信任边界。

## 实验工作台上手

1. 在实验工作台新建讨论，选择日常聊天、写作、协作开发或团队工作模板。
2. 点击右侧伙伴可改名字、职责和模型。没有可用模型的伙伴会停用，管理员可在模型服务里补充。
3. 输入问题。「一起讨论」先各自回答，再回应彼此，共两轮。
4. 开发群里让伙伴“先读取项目，再提交变更”。到项目工作台审查，批准后才成为项目文件。
5. 邀请同事后把群设为团队可见。接 LINE 前阅读共享范围提示。

聊天默认显示最近 300 条，顶部「查看更早一页」可连续查阅保留历史；查看旧页时暂不发言，点击「返回最新消息」继续聊天。单次 Markdown / JSON 导出最多为最近 10,000 条。

## 本机运行

需要 Node.js 24 或更新版本。Windows 可双击 `Start-Agent-Family.cmd`；全新安装首次安装依赖并构建。访问 `http://localhost:4317`，首次创建自己的账户。本机和在线版数据独立。

```powershell
npm ci
npm run build
npm start
```

开发运行 `npm run dev`。配置见 `.env.example`。默认只监听本机；已有 `CanalAPI-Key.txt` 只在服务器端读取。

停止后台进程：`powershell -ExecutionPolicy Bypass -File .\Stop-Agent-Family.ps1`。数据在 `data/`，停止不会清空。

## 文档

- [安全边界](SECURITY.md)
- [0.2 初版范围、分工与交付记录](docs/design/2026-11-15-initial-release.md)
- [Agent 好友与监督群 API 合同](docs/design/2026-11-15-family-api.md)
- [Matrix 部署与独立服务许可](deploy/README.md)
- [开源调研](docs/research/2026-11-13-open-source-survey.md)
- [原始产品设计与路线](docs/design/2026-11-13-agent-family-proposal.md)
- [开源组件与许可](THIRD-PARTY-NOTICES.md)

这是邀请测试初版；企业合规、SSO、计费、跨区域灾备和公众运营尚未完成。项目名称采用 Agent Family，仓库主分支为 `master`。
