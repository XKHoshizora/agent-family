# Agent Family 开源项目调研

调研日期：2026-11-13（日本时间）。范围：官方仓库元数据、README、许可证与官方文档。没有安装或运行这些项目，也没有验证其线上性能、安全性或全部功能。README 的功能声明与本报告的选型判断分别表述；默认分支内容不能替代稳定版验收。

## 1. 结论与优先级

没有在本次调研中验证到一个现成项目，可以同时满足公众多 Agent 群聊、各 Agent 独立或共同开发、企业权限审批、LINE 群接入和公共服务租户隔离。

推荐拆成三个选择：

1. **产品体验参考**：Cebus 的多模型群聊，SillyTavern 的成员与发言控制，Buzz 的人与 Agent 同群工作。
2. **应用底座候选**：LibreChat 可验证能否扩展群聊；Zulip 适合团队聊天；自有轻量 Web 界面更适合公众的多 Agent 交互。先做差距验证再决定是否 fork，避免维护整个大型产品。
3. **核心与接入组件**：LangGraph 作为执行编排首选候选，LangBot 作为多 IM 接入候选；LINE 第一版优先比较官方 SDK 直连与 LangBot 插件方式。

这不是要求把这些项目全部装在一起。聊天、编排、模型调用和权限各自只保留一个明确的权威实现。

## 2. 多 Agent 群聊与开发协作成品

| 项目 | 已从官方来源确认 | 对本项目的判断 | 许可证／状态 |
|---|---|---|---|
| [Cebus](https://github.com/cebus-ai/cebus) | 同一会话接入 OpenAI、Anthropic、Gemini 等；@成员、并行或轮流回复、角色模式；Web/CLI；基于 LangGraph | 产品概念非常贴近公众版，适合阅读交互和调度代码；不能据此确认公共 SaaS 的隔离、权限及运维能力 | MIT；本次元数据最近 push 为 2026-03-09，后续维护活跃程度需关注 |
| [agentchattr](https://github.com/bcurts/agentchattr) | Claude Code、Codex、Gemini CLI 等经 MCP 参与群聊，@唤醒，有频道及循环限制 | 最适合本机开发协作体验参考；不宜直接开放公网 | MIT；文档明确面向 localhost；部分启动器关闭审批，不应作为公共产品默认 |
| [Buzz 0.X](https://github.com/block/buzz) / [Buzz 1.0](https://github.com/block/buzz-app) | 人与 Agent 同群、频道、身份、工具及项目；可自托管；新版支持 Claude、Codex、Goose、Pi harness | 与开发者／公司项目群最接近，值得优先试用；底层 Nostr、客户端与插件维护成本需评估 | Apache-2.0；新版 beta，插件接口可能变化 |
| [LobeHub](https://github.com/lobehub/lobehub) | README 列出 Agent Team、外部 Agent 和多 IM Channels | 功能完整度值得比较；不能因 README 徽标类似 Apache 就直接认定适合改名商业发布 | [LobeHub Community License](https://github.com/lobehub/lobehub/blob/canary/LICENSE)，含衍生作品开发与分发额外许可条件 |

**Buzz 的平台差异需要保留**：新版 README 写明 Claude/Codex harness 支持 macOS、Linux；Goose/Pi 支持 Windows。不能把“有 Windows 客户端”理解成“Windows 上所有 Agent 已支持”。0.X README 将工作流审批门列在仍在接线的能力中；不能把该版本的规划当成已完成的安全保证。[新版说明](https://github.com/block/buzz-app/blob/main/README.md) · [旧版说明](https://github.com/block/buzz/blob/main/README.md)

**agentchattr 的边界**：它的本地触发器与 CLI 工具权限仍需外部控制。把聊天事件送给 Agent，并不会使该 Agent 原本的 shell 自动受新平台审批约束。公共产品需要受控运行环境和凭证边界。[安全说明](https://github.com/bcurts/agentchattr#security)

## 3. 聊天应用单独比较

| 项目 | 适合借用的能力 | 与 Agent Family 的差距 | 许可观察 |
|---|---|---|---|
| [LibreChat](https://github.com/LibreChat-AI/LibreChat) | 多供应商、Agents、MCP、账号、文件、管理界面；当前 README 也列出 subagents 和实验性代码工作区 | 多账号、分享会话和后台子 Agent 不等于多名真人与多个独立 Agent 同房间；需要验证房间成员和发言模型 | MIT，适合进入二次开发候选 |
| [SillyTavern](https://github.com/SillyTavern/SillyTavern) | 角色卡、群聊、发言次序、静音、点名、自动对话 | 很适合研究公众群聊体验；不能把多角色推断为每个成员可独立绑定供应商或具备企业权限 | AGPL-3.0 |
| [Zulip](https://github.com/zulip/zulip) | 团队聊天、频道／话题组织、成熟 API | 适合内部或公司版；Agent 任务状态、工具卡片、审批中心需另接服务 | Apache-2.0 |
| [Element / Matrix](https://github.com/element-hq/element-web) | 群组、客户端生态、开放消息协议、自托管方向 | 适合重视通信协议及跨客户端的团队；机器人、加密会话和租户边界增加复杂度 | 当前 README 提供 AGPL/GPL/商业许可选项，不能沿用早期许可印象 |
| [Open WebUI](https://github.com/open-webui/open-webui) | 自托管 AI 聊天、本地及兼容 API 模型 | 适合内部体验；白标公众产品需特别核对品牌条款 | [自定义许可证](https://github.com/open-webui/open-webui/blob/main/LICENSE)，含保留品牌要求及例外，不按纯 MIT 项目处理 |

SillyTavern 的官方群聊文档明确区分手动、自然、列表、随机池等发言模式，并说明角色卡的组合会影响身份混淆。Agent Family 可参考这些交互思想，实际发言仍由独立 Agent 实例产生，避免让一个模型冒充所有成员。[群聊文档](https://docs.sillytavern.app/usage/core-concepts/groupchats/)

Zulip 的开发 API 是较明确的外部集成边界，适合先接一个 Agent Family 服务，不必复制它的整个服务端。[API](https://zulip.com/api/)

## 4. Agent 编排框架

| 项目 | 官方能力 | 本项目建议 |
|---|---|---|
| [LangGraph](https://github.com/langchain-ai/langgraph) | 持久执行、状态图、流式事件、人工介入；MIT | 主候选。将群聊发言调度与长任务执行分开，长任务使用它管理暂停／恢复 |
| [AG2](https://github.com/ag2ai/ag2) | 多供应商、工具、人机协作、多 Agent Network；Apache-2.0 | 群体对话强候选；当前 v1 与 Classic 的接口已经分离，旧 GroupChat 示例不能直接套用 |
| [Microsoft Agent Framework](https://github.com/microsoft/agent-framework) | Python/.NET；并行、顺序、交接、群协作、检查点和观测；MIT | .NET 企业生态或重视微软集成时优先比较 |
| [CrewAI](https://github.com/CrewAIInc/crewAI) | Crews 的角色协作、Flows 的流程编排；MIT | 适合业务流程型任务；不要把 AMP 商业控制台功能全部计入开源核心 |
| [AutoGen](https://github.com/microsoft/autogen) | 经典群聊模式和研究示例 | 本次读取的 README 已声明归档且不再由微软维护，并推荐 Microsoft Agent Framework；不作为新项目首选 |

LangGraph 的暂停恢复是执行能力，**不是授权系统**。审批人身份、动作范围、撤销与重放防护仍需 Agent Family 实现；恢复节点也可能重跑前面的逻辑，副作用必须独立记录与防重复。[概览](https://docs.langchain.com/oss/python/langgraph/overview) · [Interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts)

## 5. 社交 App 接入项目

| 项目 | 官方列出的能力 | 建议用途 |
|---|---|---|
| [LangBot](https://github.com/langbot-app/LangBot) | LINE、飞书、Slack、Discord、Telegram 等；插件、模型渠道、工具和 MCP；Apache-2.0 | 多渠道接入优先候选；让它承担收发适配，协作、权限和凭证策略仍归核心 |
| [AstrBot](https://github.com/AstrBotDevs/AstrBot) | 多 IM（含 LINE）、多供应商、插件、MCP、Web ChatUI；AGPL-3.0 | 中文生态和个人助理场景强候选；作为衍生或网络服务部署时须按实际许可方案评估 |
| [OpenClaw 多 Agent 路由](https://docs.openclaw.ai/concepts/multi-agent) | 多 Agent 身份、会话及通道路由 | 可作为外部 Agent 运行器比较；路由能力不自动等于公共租户隔离和多 Agent 群聊治理 |
| [LINE Python SDK](https://github.com/line/line-bot-sdk-python) | 官方 Messaging API SDK；Apache-2.0 | 若首个外部入口只有 LINE，直接接 SDK 的依赖和排障路径更简单 |

平台接入声明不代表每个平台的群消息、审批按钮、流式输出、历史消息和文件都一致。每个适配器都需要能力表和端到端验证。

## 6. LINE 专项结论

LINE 可接入，产品形态为：**一个 Agent Family 官方账号代表多个后台 Agent 在群里发言**。

- 同一群同时只能有一个官方账号，需开启允许加入群聊并由用户邀请；消息事件带群标识，可向群回复或推送。[群聊说明](https://developers.line.biz/en/docs/messaging-api/group-chats/)
- 每条消息可设置发送者名称和头像，但会保留来自官方账号的标记；这只是展示身份，不会增加独立 LINE 群成员。[显示名称与头像](https://developers.line.biz/en/docs/messaging-api/icon-nickname-switch/)
- Reply 不计入官方账号套餐消息数，Push 计入；群推送按收件人数计算，而非单看气泡数。模型推理费另外计算，套餐按地区选择。[计费说明](https://developers.line.biz/en/docs/messaging-api/pricing/)
- Webhook 应使用原始请求体验证 LINE 签名，再处理消息。[签名验证](https://developers.line.biz/en/docs/messaging-api/verify-webhook-signature/)

产品建议：普通聊天短答采用合并回复；长期任务完成后合并推送摘要。聊天中用“问小智”“让大家讨论”或卡片按钮选择虚拟成员，不承诺可以原生 @ 每个虚拟成员。公司业务权限在登录后的 Web 审批页验证，不能只认群昵称或一句“同意”。

## 7. 其他平台差异

- Telegram 官方 FAQ 明确 bot 不能看到其他 bot 消息，所以协作事件必须在自有服务内传递。[FAQ](https://core.telegram.org/bots/faq#why-doesn-39t-my-bot-see-messages-from-other-bots)
- 飞书应使用有接收事件能力的应用机器人；只发送通知的自定义 webhook 不足以支持完整交互。[官方 FAQ](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/guide/faq)
- Slack/Discord 要依据事件订阅、权限和内容访问能力设计接入；不默认可读取所有群历史。[Slack Events](https://docs.slack.dev/apis/events-api/) · [Discord Gateway](https://docs.discord.com/developers/events/gateway)

## 8. 进入实现前的验证任务

1. 选一个候选版本锁定 commit／release，核对该版本 LICENSE、NOTICE 和依赖清单。
2. 用同一套场景比较 Cebus、LibreChat、Buzz：三模型同群、独立身份、点名、停止、断线恢复、多人权限。原始文件与来源链接留存。
3. 比较 LINE 官方 SDK 与 LangBot：群加入／离开、重复 webhook、长响应、角色头像、消息配额、卡片点击身份。
4. 验证公共产品最关键的跨工作空间读取、跨群信息泄露、审批重放、任务取消、外部 Agent 绕过权限等失败场景。
5. 按功能差距与长期 fork 维护成本决定 UI 路线，而非按星数决定。

这轮只做资料研究；上述验证是后续工作，并未执行。Agent Family 的名称可以作工作名，但尚无商标或域名可用性结论。
