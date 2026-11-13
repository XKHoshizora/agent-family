# 部署与维护

## 当前在线试用

独立 Railway 项目 Agent-Family，服务 agent-family-web，单副本，持久卷挂载 `/data`，HTTPS 域名：

https://agent-family-web-production.up.railway.app

平台环境名称为 production，但产品开放范围仍是**内部邀请测试**。未修改其他项目。凭据在这台机器 `.local/ACCESS-CLOUD.md`；部署恢复材料在 `.local/cloud-secrets.json`，请另行加密保管。不要把 `.local`、`data`、`.env` 或 API key 文件放进版本库/部署包。

## 配置

| 变量 | 用途 |
| --- | --- |
| APP_URL | 唯一可信应用源，公网必须精确 HTTPS 地址 |
| HOST / PORT | 本机默认 127.0.0.1:4317；容器使用 0.0.0.0 |
| DATA_DIR | 持久数据库及自动生成密钥位置 |
| AUTH_SECRET | 至少 32 字符；改变会影响会话 |
| ENCRYPTION_KEY | 64 位十六进制；丢失将无法解密服务凭据 |
| SETUP_TOKEN | 公网首次设置保护码；初始化后不能重复设置 |
| CANAL_API_KEY / CANAL_BASE_URL | 可选默认服务，亦可在 Web 配置 |
| DAILY_MODEL_CALLS | 每空间每日模型步骤上限；当前在线 100，本机默认 300 |
| MAX_OUTPUT_TOKENS | 每模型步骤最大输出，默认 1600 |
| PROVIDER_ALLOWED_HOSTS | 管理员允许的额外 HTTPS 模型域名，逗号分隔 |
| TRUST_PROXY | 只有确切知道反向代理 IP/CIDR 才配置，不设通配信任 |

未指定三项密钥时首次生成到 DATA_DIR/.secrets.json。环境变量覆盖文件；恢复时必须使用与备份相同的值。不要在重新部署时重新生成 ENCRYPTION_KEY。

## Docker / Railway

Dockerfile 使用 Node 24，多阶段构建，运行用户 node；入口只为固定 `/data` 卷设置权限。构建、生产编译入口和健康检查已在 Railway Linux 环境验证。

```sh
docker build -t agent-family .
docker run --env-file .env -p 4317:4317 -v agent-family-data:/data agent-family
```

容器 `.env` 应设置 `HOST=0.0.0.0`、`DATA_DIR=/data`、正确 APP_URL。只有一副本；不能让多个进程同时操作同一套运行中任务状态。Railway 使用根目录 Dockerfile、`.railway/railway.ts` 和 `/api/health` 健康检查。上传排除规则见 `.railwayignore` / `.dockerignore`。

已迁移到 Railway 当前 IaC，旧 railway.json 不再使用。修改部署配置先 `railway config plan`，核对没有意外删除变量/卷，再 `railway config apply`。当前文件描述本独立项目的服务与持久卷；密钥只使用 `preserve()`，不写实际值。不要在另一项目直接应用；新环境需先配置真实变量。依据 [Railway 官方迁移说明](https://docs.railway.com/infrastructure-as-code#migrating-from-config-as-code)。

## 备份与恢复

```powershell
npm run backup:prod -- E:\secure-backups\agent-family-20261113.zip
npm run restore:prod -- E:\secure-backups\agent-family-20261113.zip E:\Agent-Family-Restored
```

backup 使用 SQLite 在线备份 API，包含 WAL 中已提交数据、实际生效的密钥、SHA-256 清单。恢复只允许空目录，不覆盖现有数据，检查清单、固定文件集合和数据库完整性。备份是 ZIP，**未加密**，应保存在加密磁盘/受控备份服务。

恢复时停止应用，将 DATA_DIR 指向恢复目录；核对环境覆盖密钥与备份相同，再启动并测试登录、历史、模型设置。不要只复制运行中的 sqlite 文件而忽略 WAL。当前提供手工备份工具；**未配置自动备份、异地保管或告警**。Railway 可通过 SSH 在服务容器运行 `node dist-server/backup.js /data/backups/<新文件名>.zip`，随后将备份安全转存到卷外；同卷备份不能防止卷丢失。

部署前备份数据库和密钥，保留上一部署。回滚代码不等于回滚数据库；涉及迁移时应先在备份副本验证。

## 账户恢复

本机/容器运维人员可以执行：

```powershell
npm run reset-password:prod -- owner@agent.family
```

随机新密码写入当前项目 `.local/PASSWORD-RESET.md`，不打印到日志，旧会话全部失效。不要把密码放在命令行参数。新安装也可 `npm run setup:prod -- owner@example.com`，随机凭据写 `.local/ACCESS.md`；已有空间不会重复初始化。

## 排查

- 页面不可达：先 `/api/health`，再看运行日志；部署平台显示成功不等于公网应用健康。
- 模型列表成功但聊天失败：列表可能是公开接口，需验证密钥/账户权限/实际模型调用。Gemini 未列出时配置可用原生 Google 服务，不能凭名称认为已接通。
- LINE 未回复：检查连接验证、Webhook、启用、绑定、指令格式、LINE 配额；设置页查看事件/发送状态。unknown 不自动重发，先到群核实。
- 项目冲突：让伙伴读最新文件重新提交；不要跳过版本检查。
- 重启后任务中断：历史保留，由用户重新发送，不自动重复收费请求。

## 验证命令

`npm run build`、`npm test`、`npm run test:e2e`。浏览器测试在 Windows 用已安装 Chrome；Linux CI 安装 Chromium。单元/契约与浏览器自动测试不需要真实 API key。真实服务测试单独记录，不放进每次 CI。

## 2026-11-13 额度与 LINE 安全边界升级

`DAILY_LINE_MODEL_CALLS` 默认 40，每空间独立限制 LINE 步骤，同时受 `DAILY_MODEL_CALLS` 约束。空间原有调用计数保留；LINE 独立计数从本次升级开始记录。预留按最大可用步骤计，未用释放；跨 UTC 午夜的任务仍归属开始日。

启动执行幂等的增量迁移：消息增加轮次、任务增加说明、用量增加预留／LINE 计数，并建立任务预留表。既有 LINE 绑定改为各自回答、资料工具关闭，历史边界重置为升级时最新消息；网页历史不删除。

更新前先备份。旧版本含按列位置插入的 SQL，不能仅回滚应用镜像后继续使用升级后的数据库；若需退回旧代码，必须停写并按恢复流程恢复对应升级前备份，会失去备份后的新写入。优先修复后向前发布。
