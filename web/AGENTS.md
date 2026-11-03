# AGENTS.md — 前端开发约定

本文适用于 `web/` 目录，需与根目录 [AGENTS.md](../AGENTS.md) 一起遵守；组件编写与测试细则见[前端实现规范](docs/frontend-implementation.md)。

## 1. 常用命令

以下命令在 `web/` 目录下执行（Node.js 与 pnpm 版本以 [package.json](package.json) 的 `engines` 和 `packageManager` 为准）：

| 命令                                | 用途                                                                                |
| ----------------------------------- | ----------------------------------------------------------------------------------- |
| `pnpm dev`                          | 启动连接真实后端的开发服务器（自定义端口与代理目标见 [README](README.md#启动参数)） |
| `pnpm dev:mock`                     | 启动纯前端 MSW Mock 环境（未定义 Mock 的 API 请求会直接报错）                       |
| `pnpm ci:check`                     | 运行全套前端检查（格式、ESLint、设计系统、死代码、合同对齐、类型检查与单元测试）    |
| `pnpm verify`                       | 运行 `ci:check` 并执行一次生产构建（不含 E2E 测试）                                 |
| `pnpm test`                         | 运行 Vitest 单元测试与组件测试                                                      |
| `pnpm test:e2e`                     | 运行 Playwright 端到端测试（本地自动启动 `dev:mock`）                               |
| `pnpm build` / `pnpm serve`         | 执行生产构建 / 本地预览构建产物                                                     |
| `pnpm contract:generate`            | 根据后端导出的 `openapi.json` 生成前端 TypeScript 类型与 Zod Schema                 |
| `pnpm format` / `pnpm format:check` | 运行 Prettier 格式化代码 / 检查格式                                                 |

- **环境隔离原则**：连接真实后端（`pnpm dev`）与纯前端 Mock（`pnpm dev:mock`）严格分开运行，不要把局部的 Mock 数据混进默认开发环境。

---

## 2. 目录职责与实现边界

| 目录 / 路径                           | 核心职责                                                                                                                                |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `src/app/`                            | 全局 Provider、路由实例、主题切换与工作台面板注册                                                                                       |
| `src/routes/`                         | TanStack Router 文件路由与应用外框（`_shell.tsx`）：只负责路由装配、权限守卫、URL 参数解析与跨模块组合，具体业务逻辑放在 `features/` 中 |
| `src/features/`                       | 各业务功能模块（登录、首页、合集、对话、需求单、审计报表、工作区文件、分镜与制作页、成片编辑器、管理后台配置等）                        |
| `src/features/storyboard/whole-film/` | 成片时间线编辑器；其中 `composition/` 目录下的合成代码会同时被打包进后端的独立渲染服务 `../render/`                                     |
| `src/shared/api/`                     | 统一 REST 请求客户端（`apiFetch`）与根据后端 OpenAPI 自动生成的类型和 Zod Schema（`generated/`）                                        |
| `src/shared/auth/`                    | 登录状态管理与权限判断                                                                                                                  |
| `src/shared/shell/`                   | 应用外框向子页面暴露的布局状态上下文（`ShellChromeContext`）                                                                            |
| `src/shared/icons/`、`src/shared/ui/` | 统一图标库与基础通用 UI 组件                                                                                                            |
| `src/shared/transcript/`              | Agent 聊天记录（Transcript）协议解析、WebSocket 订阅与状态合并（升级上游协议见[目录说明](src/shared/transcript/vendor/README.md)）      |
| `src/shared/workbench/`               | 右侧产物工作台面板宿主、分栏布局与选中态管理（产物注册与认领规则见 [artifact.ts](src/shared/workbench/artifact.ts)）                    |
| `src/testing/`、`e2e/`                | Vitest 测试辅助工具、MSW Mock 处理器与 Playwright 端到端测试用例                                                                        |
| `vite/`、`scripts/`                   | Vite 构建插件、开发辅助脚本与 HyperFrames 组件库打包工具（`scripts/hyperframes-*`）                                                     |
| `../design/cue-mascot/`               | 首页吉祥物素材源文件与生成说明（见[目录说明](../design/cue-mascot/README.md)）                                                          |

### 核心编码约束

- **统一使用 `apiFetch` 调接口**：所有后端 REST 请求必须使用 `@/shared/api/client` 的 `apiFetch`（需要读取响应头或状态码时用 `apiFetchWithResponse`），自动享受同源代理、登录态复核与 Zod 校验。原生的 `fetch` 或 `XMLHttpRequest` 仅允许用于 OSS 预签名文件直传、外部素材下载以及读取组件库目录 `/hyperframes/catalog.json`。
- **直接消费生成的合同 Schema**：接口请求与响应直接使用 `src/shared/api/generated/` 下的生成物（严禁手改生成文件）；如果后端某个字段返回 `null` 或缺省，保留其空值语义，不要在前端擅自编造业务默认值。
- **权限控制只看 `user.permissions`**：页面守卫（见[前端实现规范](docs/frontend-implementation.md#登录与守卫)）与按钮显隐统一根据后端返回的 `user.permissions` 权限数组判断，严禁在代码里写死用户名白名单。
- **成片合成代码（`composition/`）跨环境约束**：由于 `src/features/storyboard/whole-film/composition/` 会同时在浏览器和 Node.js 渲染服务（`../render/`）中运行，该目录下严禁直接操作浏览器 DOM 或 `window` API，且对仓内其他模块只能做 `import type`（引用生成的合同类型）。修改该目录或生成合同后，需同时按[根开发约定](../AGENTS.md#1-命令与验证)跑一遍 `render/` 目录下的检查。
- **静态门禁工具**：模块导入边界与语法规范由 [ESLint](eslint.config.js) 自动检查，未使用的死代码由 [knip](knip.json) 检查，基础视觉 Token 定义在根目录 [design-system.html](../design-system.html) 中。

---

## 3. 提交前验证要求

- **修改前端代码**：推送前在 `web/` 下执行 `pnpm ci:static` 和 `pnpm typecheck`，并运行与改动直接相关的 Vitest 测试文件；如果改动了核心用户流程，额外跑对应的 Playwright E2E 用例（全量单测、生产构建与全量 E2E 由 CI 执行，本地无需重复跑 `pnpm ci:check`）。
- **新增功能或修改交互**：按[测试分层规范](docs/frontend-implementation.md#测试)补充或更新对应测试；仅修改文档或纯文案时，检查格式（`pnpm format:check`）与链接（根目录 `make docs-check`）即可。
- **修改 UI 样式与布局**：需同时检查桌面端与移动端宽度、浅色与深色主题、键盘无障碍操作以及中文长文本折行；验收截图统一保存到 `.artifacts/design-qa/`（正式 E2E 测试代码中只写断言，不留截图调用）。
- **修改 Nginx 反代配置**：需验证 `/api` 路径前缀剥离、`/api/ws` WebSocket 协议升级以及同源 `Host` / `Origin` 头传递（详见[跨端合同](../contract/conventions.md)）。
