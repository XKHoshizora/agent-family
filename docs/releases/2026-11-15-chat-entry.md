# 底座验证后的聊天入口修正

2026-11-15 14:18 JST。应用提交 `de6c410c4ef45333c5c4efb6f883e2145ff4a571`。

原主地址打开 AF 自制工作台，容易把试验讨论系统误认为预定社交客户端。本批把主入口交给官方 Element，保留 `/workbench` 作为实验功能与既有数据入口。聊天、房间、附件、加密和设备界面继续使用 Element。通过其官方首页扩展加入原生私聊、建群、房间目录及工作台链接。

- [主聊天入口](https://agent-family-web-production.up.railway.app)
- [实验工作台](https://agent-family-web-production.up.railway.app/workbench)
- [比较、复用边界、UI 参考与下一批验收](../reviews/2026-11-15-platform-comparison/README.md)

## 验证与发布

- 本地构建通过；19 项入口/账号测试、21 项浏览器回归通过。
- [GitHub 完整检查](https://github.com/XKHoshizora/agent-family/actions/runs/43680237820)：226 项测试、21 项浏览器回归通过。
- [部署记录](../reviews/2026-11-15-platform-comparison/evidence/production-deployments.json)：Web `91e9bf7f-bc65-4516-8919-3f9a1f244bcf`、Element `fd14be4c-36b7-4ded-a841-31bb86fc2729` 均 SUCCESS；Synapse/PostgreSQL 未更改。
- [线上 11 项检查](../reviews/2026-11-15-platform-comparison/evidence/production-entry-result.json)：主地址/聊天快捷地址、邀请留本站、三服务健康、配置与快捷入口、浏览器实际进入 Element、工作台可达、无运行错误。
- 快速浏览器回归曾触发真实请求频率限制；测试改为按响应等待，生产限制没有放宽。
- 临时云环境 `39bfc41a-2ee8-4dd7-94a0-eb95701e6816` 已销毁，本地三个测试服务/隧道会话已停止。本机没有安装 Docker。

## 尚未交付

本批是入口与复用方向修正，不是 v9 全部完成。两套账户仍独立。Matrix 的跨服务器实验是脚本操作独立 Agent 账号，不能等同自主 Agent 运行。主人持续可见、密钥就绪与回执、失效暂停、群扩员重新授权、运行器和电脑权限仍按后续批次验收。HuLa 后端已构建启动，但完整登录/好友/群聊天与原生客户端未验收。

## 回退

Web 可回退上一成功部署 `e7f5fcba-8d5c-4aee-9073-f5cd1ce4882b`，Element 可回退 `94977028-ca28-4398-9467-50faa473d52a`。本批没有数据库迁移、聊天历史搬迁或注册方式变更。已有工作台邀请仍在本站完成，不把邀请参数转发到 Element。
