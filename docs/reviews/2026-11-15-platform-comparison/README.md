# 聊天底座实际验证与选型

2026-11-15。结论：**通信底座采用 Element Web＋Synapse；UI 参考与底座采用分开决策；现有 AF 不默认保留。**

这不是三套产品全部功能的验收。下列 R 代表本次实际运行，S 代表固定源码，U 代表未验证。所有账号为合成测试账号，Agent 身份由测试脚本操作，未接入自主模型。本次没有安装本机 Docker；服务运行在临时 Railway 云环境。

**批次 A 已发布**：[发布与验收记录](../../releases/2026-11-15-chat-entry.md)。主入口进入 Element，实验工作台保留。生产 11 项检查通过，应用提交的 GitHub 检查为 226 项测试＋21 项浏览器回归通过。[临时云环境已销毁](evidence/cleanup.json)。这不提升下表 U 项目的验收状态。

## 决定及其依据

| 比较项 | Element＋Synapse | OpenIM | HuLa |
|---|---|---|---|
| 独立服务器互通 | **R：两套独立服务器邀请、入群、双向消息、附件通过** | R：两套独立部署中，A 的好友/邀请接口无法识别仅存在于 B 的用户；需要额外桥接 | S：所查路由是共享服务发现/MQ的集群；独立服务器联邦 U |
| 社交消息 | R：官方 Element 登录、原生会话、加密收发 | R：好友申请/接受、建群；官方 WASM SDK 普通用户令牌真实 WebSocket 收发、历史恢复 | R：后端构建和启动成功；好友/群聊端到端 U |
| 两位主人看 Agent 群 | R：两位主人都是原房间公开成员，均解密两位 Agent 的消息 | R：两位主人作为原群成员实时收到两位 Agent 消息 | U：未完成相同场景 |
| 无关人 / 扩员 | R：无关人读取被拒绝；joined 历史策略阻止新成员读入群前事件；移除后不能发送/读取新事件 | R：无关用户没有取到群消息；默认新成员可以读入群前历史；源码有全局配置开关，关闭后的行为 U | S：需进一步验证成员校验及历史边界；不把静态疑点定性为漏洞 |
| 拉黑 | 原生忽略/房间封禁与产品“停止 Agent 执行”不同；后者需开发 | R：拉黑阻断私信，仍可在共同群发言；不能直接等同产品全局阻断 | S：平台封禁和个人屏蔽不同；业务语义需适配 |
| 浏览器形态 | R：官方 Web 客户端可用；首页扩展打开原生私聊弹窗 | R：官方 Web 登录页；完整聊天验证用官方 SDK 测试台，**没有冒充完整 UI 验收** | R：直接运行 Vite 在浏览器空白，缺少 Tauri `os_type`/`invoke`；原生桌面 U |
| 加密与设备 | R：线上传输事件为密文，两位主人均解密，重载后仍可解密；SAS/遗失设备恢复 U | 未验证原生 E2EE；不能把 TLS 或服务端可读当作端到端加密 | 未验证 E2EE；SQLCipher 本地存储不等于 E2EE |
| Agent 功能 | 独立 Matrix 身份可承载 Agent；owner、授权、运行器仍需扩展 | **S：配套 Chat 项目有 Agent 注册、模型配置和回调模块**；跨主人监督不在其数据模型中 | S：有 AI 对话和系统机器人；未证明符合独立主人 Agent 群 |
| 本项目定位 | **运行底座＋客户端复用** | **社会关系交互、机器人回调设计参考；不引入第二套 IM 后端** | **UI 与信息架构参考；不采用其整套传输/后端** |

开放互通是用户要求的硬条件。OpenIM 更贴近传统好友型 IM，但为了达到此条件再加桥接，会增加身份映射、历史、加密和权限的一致性工作。HuLa 的界面价值不依赖其是否成为后端底座。选择 Matrix 也不意味着保留现有 AF 的消息库或页面。

## 实测记录

### Matrix

- Synapse `v1.165.0` 两实例，各自数据库与签名密钥；Element `v1.12.35`。
- [19 项 API 检查](evidence/matrix-api-result.json)：跨服加入、双方发言、主人原房间读取、无关人拒绝、跨服附件、历史边界、踢出后的权限等。
- [8 项官方 Element 加密检查](evidence/element-e2ee-result.json)：四个独立浏览器设备、两位 Agent 双向消息、三方分别解密、发送事件密文、主人刷新恢复历史。
- [原生聊天截图](evidence/element-owner-encrypted-chat.png)。这是本次运行截图，不是设计稿。
- [首页接入检查](evidence/element-entry-result.json)：官方首页扩展、工作台链接、打开 Element 原生私聊弹窗。
- **边界**：隔离云网络内部使用测试 TLS，关闭联邦证书校验；这不代表公网受信 TLS、外部第三方 homeserver 或生产联邦已验收。明文基线附件传输通过，不代表加密附件和已知媒体地址的未授权访问已验证。API 报告中的 `cryptoVerified:false` 是先于 Element 测试的阶段结果，后续加密证据单独记录。
- **不等于主人监督产品完成**：尚未验证逐消息持久回执、主人设备失效自动暂停、恢复密钥丢失、运行器断线、真实模型自主执行和电脑权限。

### OpenIM

- 运行官方部署的 `openim-server:v3.8.3-patch.18`、`openim-chat:v1.8.4-patch.5`、Web `release-v3.8.3`；SDK `@openim/wasm-client-sdk@3.8.3-patch.15.1`。
- [REST 记录](evidence/openim-api-result.json)是观察列表，**不是全部通过计数**。REST 管理员发送接口拒绝普通令牌是接口边界，不能据此断言普通用户不能发送。
- [10 项官方 SDK 检查](evidence/openim-sdk-result.json)使用四个普通用户令牌、真实 WebSocket：两位 Agent 发群消息，两位主人实时收到，重载历史通过。没有把管理员代发算成 Agent 客户端通过。
- [独立部署验证](evidence/openim-federation-result.json)：在 B 注册 remotebagent，B 可查，A 不存在；A 申请好友/邀请入群返回 user not found。附加带域字符串只是负向探测，不是声称存在官方 OpenIM 联邦地址格式。结论限于原生部署和所测接口，不否定定制桥接的可能性。
- [历史与退出](evidence/openim-history-result.json)：默认新成员取到三条入群前消息，退出仍保留旧历史。全局开关存在，但按房间/主人例外的规则未验证。
- 配套 Chat 的 `internal/api/bot`、`internal/rpc/bot`、`pkg/protocol/bot/bot.proto` 确实实现 Agent 能力。这修正了仅检查 IM Server 得出的“无 Agent 模块”判断。模型真实调用、本次镜像是否启用模块均 U。

### HuLa

- 前端与后端均固定源码提交，见 [来源清单](evidence/source-revisions.json)。后端 Java 25、Maven 3.9.11 构建，单体 BootServer 40 个 reactor 项目成功；[构建摘要](evidence/hula-build-summary.txt)。跳过测试和文档，不代表上游测试通过。
- [后端运行结果](evidence/hula-runtime-result.json)：MySQL 初始化、Redis、RocketMQ、Nacos、BootServer 启动；readiness 200，DB/Redis UP。总 health 503 来自隔离网络不能访问示例 SMTP，不将其算作聊天服务功能失败。
- 两处测试环境问题已纠正：Central-only 镜像仓库缺腾讯依赖，恢复原 Aliyun 仓库后成功；关闭 discovery 导致缺失 NacosServiceManager，补齐 Nacos 后成功。**不以这两处测试配置错误淘汰 HuLa。**
- [纯浏览器实际结果](evidence/hula-web-probe.json)：无 Tauri mock，页面空白；[截图](evidence/hula-web-probe.png)。这不证明 HuLa 原生桌面不可用。
- 原生客户端、合成账号登录、好友/群消息、主人可见、跨实例互通，本次均未完成端到端验收。停止在可运行性和源码边界验证，不凭构建成功宣称这些能力通过。

## UI 参考、代码复用与底座采用分开

| 项目 | 具体使用方式 | 不据此引入的东西 |
|---|---|---|
| Element | 直接使用消息时间线、会话列表、附件、成员、搜索、设备验证/恢复；通过官方配置做品牌与首页入口 | 不再自制消息发送、同步、加密或设备数据库 |
| Synapse | 身份、房间、成员、事件、媒体、联邦；部署与备份配置 | 不直接写数据库表，不把群成员关系当工具授权 |
| HuLa | 参考左侧主导航＋会话列表＋聊天区＋右侧群资料；联系人页、资料卡、群管理、文件入口的位置和层级 | 不复制 Vue/Tauri 传输层到 React，不为 UI 引入另一套 IM 服务；头像、商标与素材另审 |
| OpenIM | 参考新朋友申请、群邀请、资料页和拉黑解释；机器人独立身份注册与回调模式 | 不默认安装 OpenIM Chat/Server 作为第二套消息库；引用具体代码前单独核许可证与适配收益 |
| 现有 AF | 只作为迁移来源和可替换实验实现；现有数据暂保留 | 不把“我们写过”或“单元测试通过”当成成熟模块证据 |
| AI SDK / Codex / Cua | 优先使用现有模型 SDK、Codex 运行协议、Cua 驱动；本次未新增这些集成验收 | 不自制模型协议或桌面驱动；不默认给 Agent 电脑 |

页面规划：主导航依次为**聊天、联系人、我的 Agent、任务与审批、设置**。默认落在聊天。会话详情保留 Element 时间线，右侧扩展显示 Agent 主人、必要主人就绪状态、运行权限；设置里继续复用设备验证/恢复。联系人借鉴 HuLa/OpenIM 的组织方式，增加“人/Agent”和“主人”标识。任务、预算、电脑控制放在需要时打开的面板中，不能占据主聊天页面。

## AF 的保留标准

- 消息列表、正文、附件、发送与同步：由 Element/Matrix 接管，停止继续扩建第二套社交聊天实现。历史迁移另行验证，不直接导入可能改变可见范围的数据。
- 认证/账号：现有 AF 开通 Matrix 身份仅作为过渡；不把两套密码当最终体验。后续评估统一身份入口，不自造认证协议。
- 模型访问：优先保留上游 SDK；AF 的配置包裹层经真实请求验证后才保留。
- 好友/监督/暂停规则：先提取契约和可复用测试；重写或替换均可。既有 SQLite 状态机没有迁入 Matrix 房间的优先权。
- 任务/预算/审批：不在本次三套 IM 中找到完整替代就直接宣称成熟；后续用独立验收证明限额、取消、幂等、重启与跨域隔离。

## 交付批次与验收门槛

不按周估算，也不把 Codex 与 Claude 的并行时间直接相加。

| 批次 | 交付 | 阶段验收 | 分工 |
|---|---|---|---|
| A：社交入口 | Element 成主入口；AF 独立工作台；原生私聊/建群/附件/设备界面 | 主链接打开真实 Element；邀请链接仍留本站；旧工作台可达；不宣传 AI 已接入 | Codex 集成/部署；Claude 核对复用边界 |
| B：关系与身份 | 独立 Agent Matrix 身份、owner 映射、好友申请、主人公开成员 | 同主人、跨主人一对一及群；非好友不自动获私聊权；必要主人加入且密钥就绪才运行 | Codex 身份/客户端；Claude 授权规则与负向测试 |
| C：监督与恢复 | 群扩员、暂停/恢复、拉黑、逐消息回执、密钥失效 | 成员变更需重确认；缺主人停止后续 Agent 操作；拉黑作用域明确；迟到结果隔离；新成员不能补读未授权历史 | Claude 状态/恢复；Codex 跨服、设备与并发验收 |
| D：运行与电脑 | 上游模型 SDK、Codex、Cua；每主人域一台虚拟桌面 | 权限、预算、设备绑定互不隐含；单写入者；接管/撤销/取消/重启失败关闭；实际电脑后续 | Claude 运行适配；Codex 设备与权限交叉复核 |
| E：发布门槛 | 生产公网联邦、E2EE恢复、备份恢复、升级演练 | 真实受信证书双服、失去全部设备恢复、未授权读取、断线重试、迁移与回滚均有证据 | 双方独立验收后集成 |

B、C 不能因为三套 IM 具备群聊就算完成；它们是本产品真正需要开发的差异。未完成 B/C 前，不称“跨主人自主 Agent 群已可用”。

## 审阅与证据边界

Claude Code 使用 **Opus 5.5 / xhigh** 做只读源码核对，[执行回执](evidence/claude-audit.receipt.json)。它的判断不是最终事实；已用实际运行修正 OpenIM bot 模块及 HuLa 构建等结论。没有把业务密钥、生产配置、真实聊天数据提供给它。

源码 HEAD 与运行镜像 tag **不是同一版本证明**；两者分别记录。[镜像与运行清单](evidence/runtime-manifest.json)含 digest，不含环境值。上游仓库根许可证观察：OpenIM Server/Chat、HuLa 前后端为 Apache-2.0；OpenIM Electron Demo、Element 和 Synapse 涉及 AGPL。具体引入文件、素材与传递依赖仍逐项核对，不能以 Server 许可证替代客户端许可证。

官方来源：[Element 配置](https://github.com/element-hq/element-web/blob/v1.12.35/docs/config.md)、[自定义首页](https://github.com/element-hq/element-web/blob/v1.12.35/docs/custom-home.md)、[Synapse](https://github.com/element-hq/synapse/tree/v1.165.0)、[OpenIM Server](https://github.com/openimsdk/open-im-server/tree/a101d85ec16cc21bec60005169725adc1ae5649a)、[OpenIM Chat bot](https://github.com/openimsdk/chat/tree/73e7b82a64fdc997a415f3a55f697e0c5800f1d1/internal/api/bot)、[HuLa UI 预览](https://github.com/HuLaSpark/HuLa/tree/16871546d8f42252ed8b475540b0f74f1ea44fd6/preview)、[HuLa Server](https://github.com/HuLaSpark/HuLa-Server/tree/9125bb42ea16896055ec057e65124f3c684c361a)。
