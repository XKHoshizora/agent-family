# Agent Family 0.2 部署

本目录只封装官方上游容器的配置。没有重写 Matrix 协议、消息同步、端到端加密、联邦或 Element 客户端。

2026-11-15 底座实测后的入口调整：当 Matrix 配置齐备，AF 的 `/` 和 `/chat` 跳转官方 Element；`/workbench` 保留实验工作台。带查询参数的入口留在本站 `/workbench`，不会把邀请令牌转发给 Element。Element 通过官方 `embedded_pages.home_url` 和 `branding.auth_footer_links` 提供原生私聊、建群及工作台入口。没有将 AF 讨论伪装成 Matrix 消息；自主 Agent 接入仍待后续验收。未配置 Matrix 的本地安装保持原入口。

底座、UI 借鉴及未验证范围见 [实际比较报告](../docs/reviews/2026-11-15-platform-comparison/README.md)。

| 服务 | 来源 | 持久化 | 入口 |
| --- | --- | --- | --- |
| agent-family-web | 仓库根 Dockerfile，Node 24 | SQLite 与恢复材料，`/data`，单副本 | `/api/health` |
| agent-family-synapse | `ghcr.io/element-hq/synapse:v1.165.0` | 身份签名密钥、配置与媒体，`/data` | `/health`，8008 |
| agent-family-matrix-db | `postgres:17-bookworm`，已固定镜像 digest | `/var/lib/postgresql/data`，单副本 | 仅 Railway 私网 |
| agent-family-element | `vectorim/element-web:v1.12.35` | 无状态；用户设备密钥在客户端 | `/version`，8080 |

精确环境结构及 PostgreSQL 镜像 digest 见 [Railway 定义](../.railway/railway.ts)。`preserve()` 表示保留远端变量，不把密钥写进 Git；该文件是已部署环境的快照，不是给陌生项目直接执行的完整初始化脚本。

## 发布顺序

1. PostgreSQL：创建私网服务和持久卷，随机生成独立密码；数据库与用户名 `synapse`，初始化 UTF-8 / C locale。
2. Synapse：以 `deploy/synapse` 为构建根；设置固定 `SYNAPSE_SERVER_NAME`、`SYNAPSE_PUBLIC_BASEURL`、PostgreSQL 连接项及随机 `SYNAPSE_REGISTRATION_SHARED_SECRET`。具体名称见 bootstrap.py。`/data` 必须持久化，已经开始使用后不能改 server name。
3. Element：以 `deploy/element` 为构建根。新部署要先将 config.json 的默认 homeserver 改为自己的服务器。
4. Agent Family：以仓库根构建，设置 `.env.example` 中的四个 `MATRIX_*` 项；注册 secret 引用 Synapse 服务变量。保留原有 AUTH_SECRET、ENCRYPTION_KEY 和数据库卷。
5. 检查每个部署为 SUCCESS，再验证健康接口、邀请登录、模型收发、审批/暂停和真实加密收发。构建上传成功不代表部署通过。

注册关闭，Agent Family 只为当前受邀且可写的成员开通确定归属的 Matrix 身份。AF 不保存 Matrix 密码或访问令牌。Matrix 是独立账户：AF 工作空间角色与 Matrix 房间成员资格不同步，移出 AF 空间不会自动停用 Matrix 账户。需要撤销 Matrix 时，应单独按 Synapse 管理流程处置。

## 信任边界与首版运行限制

- Agent 好友与监督群运行在 AF 服务内，服务端处理明文。所有必要主人共同审批、均可读取；模型服务地址随审批冻结。
- Matrix 人际聊天独立运行。已验证 Element 双向加密收发和联邦发现；未将 Agent Runner 接到这些房间，也未宣称跨服务器 Agent 监督通过。
- AF 的数据库和任务取消器是单实例设计，保持一个副本；多副本、无停机迁移和任务自动重放需要后续实现。
- Synapse 与 PostgreSQL 分开持久化；不要只备份其中之一。Element 用户应保存恢复密钥，服务器备份不能替代客户端恢复材料。
- 当前只是邀请测试规模，没有将小卷容量当作长期生产容量承诺。持续监测数据库、媒体、日志及模型调用成本。

## 备份与恢复

AF 复用已有 `backup:prod` / `restore:prod`，备份含数据库及恢复密钥，按敏感材料保管。恢复必须到新的空目录并做完整性检查，不覆盖在线目录。发布前备份保存于 AF 数据卷；同卷副本不能替代异地灾备。

Matrix 需要独立备份 PostgreSQL（例如 PostgreSQL 官方 `pg_dump`）和 Synapse `/data` 的签名密钥、配置及媒体。首次上线并未完成异地灾备恢复演练，后续必须在隔离服务中验证。不要把密钥、数据库或聊天历史加入仓库。

## 上游与许可

- [Synapse v1.165.0 源码](https://github.com/element-hq/synapse/tree/v1.165.0)，[许可证](https://github.com/element-hq/synapse/blob/v1.165.0/LICENSE)：AGPL-3.0。
- [Element Web v1.12.35 源码](https://github.com/element-hq/element-web/tree/v1.12.35)，[许可证](https://github.com/element-hq/element-web/blob/v1.12.35/LICENSE)：AGPL-3.0。
- [PostgreSQL 官方镜像源码](https://github.com/docker-library/postgres)，[PostgreSQL 许可证](https://www.postgresql.org/about/licence/)。

部署保留上游界面和许可入口，没有将上游代码改标为本项目许可。项目 MIT 许可不改变上述独立服务的许可。本项目 JavaScript 依赖清单见 [THIRD-PARTY-NOTICES](../THIRD-PARTY-NOTICES.md)。将来修改或分发上游代码时，应保留对应版本源码及其许可要求。
