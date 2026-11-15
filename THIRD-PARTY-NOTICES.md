# 开源复用与许可

Agent Family 自有代码采用 MIT。没有复制 Cebus/LibreChat 等完整应用代码；开源调研后复用成熟 SDK 和组件，以满足独立群成员、LINE 绑定和项目审查的产品流程。

完整依赖许可文本在 [THIRD-PARTY-LICENSES.txt](public/THIRD-PARTY-LICENSES.txt)，构建后同路径公开提供。以下版本来自 package-lock.json；依赖升级后运行 npm run notices 更新。此清单不授予模型服务、LINE 商标或第三方账号的权利。

| 直接依赖 | 版本 | 许可 |
| --- | --- | --- |
| @ai-sdk/anthropic | 4.0.102 | Apache-2.0 |
| @ai-sdk/google | 4.0.118 | Apache-2.0 |
| @ai-sdk/openai | 4.0.115 | Apache-2.0 |
| @ai-sdk/openai-compatible | 3.0.90 | Apache-2.0 |
| @better-auth/oauth-provider | 1.7.25 | MIT |
| @fastify/helmet | 13.2.0 | MIT |
| @fastify/rate-limit | 11.2.2 | MIT |
| @fastify/static | 10.1.10 | MIT |
| @line/bot-sdk | 11.4.0 | Apache-2.0 |
| @radix-ui/react-dialog | 1.3.1 | MIT |
| @tanstack/react-query | 5.107.1 | MIT |
| @vector-im/matrix-bot-sdk | 0.11.0-element.0 | MIT |
| ai | 7.0.170 | Apache-2.0 |
| better-auth | 1.7.25 | MIT |
| better-sqlite3 | 13.1.1 | MIT |
| diff | 9.0.0 | BSD-3-Clause |
| dotenv | 18.0.10 | BSD-2-Clause |
| fastify | 5.12.8 | MIT |
| fflate | 0.8.3 | MIT |
| lucide-react | 1.72.0 | ISC |
| react | 19.3.1 | MIT |
| react-dom | 19.3.1 | MIT |
| react-markdown | 10.1.0 | MIT |
| remark-gfm | 4.0.1 | MIT |
| sonner | 2.0.8 | MIT |
| zod | 4.6.7 | MIT |

构建时安装的生产与可选依赖共 413 个包；完整锁定列表见 package-lock.json。开发测试复用 TypeScript、Vite、Vitest、Playwright、Prettier、tsup 等工具，它们不作为客户端产品功能重新实现。
