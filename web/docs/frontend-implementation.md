# 前端实现规范

命令、目录职责与验证要求见 [AGENTS.md](../AGENTS.md)。基础视觉 Token 定义见根目录 [design-system.html](../../design-system.html)，本文规定组件编写、界面文案、登录守卫与测试分层规范。

## 组件与状态管理

- **优先复用基础组件**：基础按钮、弹窗、输入框、用户头像（`@/shared/ui/user-avatar`）及只读源码预览（`@/shared/ui/source-editor` 的 `SourceViewer`）等优先复用 `src/shared/ui/` 中的组件；Toast 提示统一使用 `@/shared/ui/toast`；列表中的音频试听统一使用 `@/shared/ui/audition` 的 `useAudition`（全局互斥播放，所在区域隐藏或卸载时自动停止）；组件进退场动画统一使用 `tw-animate-css` 的 `animate-in` / `animate-out` 及设计系统 Token，不单独手写一套新的动画 Keyframes。
- **类型与样式约定**：组件 Props 声明明确的 TypeScript 类型（优先靠近组件定义，跨模块复用时再提取到公共文件）。列表渲染 `key` 必须使用稳定的业务 ID（不要用数组下标）。动态合并 `className` 统一使用 `cn()`，多变体组件样式使用 `cva` 定义。
- **异步请求与自定义 Hook**：支持取消的查询需透传 `AbortSignal`；自定义 Hook 统一以 `use*` 命名并保持返回结构稳定。
- **深浅色主题**：全局主题由 `src/shared/lib/theme.ts` 统一控制在 `<html>` 标签的 `.dark` 类名上；组件内部直接使用语义化主题 Token，不要各自维护一套独立的主题状态。

## 交互体验与无障碍（Accessibility）

- **不暴露底层内部标识**：界面文案统一使用中文（固定功能名称 `final-cut` 除外）；严禁向普通用户直接展示底层工具函数名（raw tool name）、`member_id`、内部文件路径或原始 JSON 参数。审批卡的「参数」列表除外：用户同意前要能看到将要发送的内容。
- **语义化与键盘可操作**：使用语义化的 HTML 标签；有实际含义的图片填写描述性 `alt`，纯装饰图片设置 `alt=""`；所有核心交互需同时支持鼠标、触摸和键盘操作（保证焦点清晰可见，弹窗打开后正确接管焦点）。
- **加载与错误反馈**：按钮和面板在加载过程中保持原有尺寸不跳动，并防止用户重复点击提交；报错信息用清晰的中文说明，并关联到对应的表单项或操作区域。
- **统一图标库**：通用图标统一从 `@/shared/icons` 导入，颜色默认继承父级文字颜色；纯图标按钮必须提供无障碍名称（`aria-label`），且保证足够大的点击热区。

### 界面文字

界面文案遵循书面语规范（详见 [ADR-0001](../../docs/adr/0001-ui-copy-formal-register.md)）。以下句式适用于各类提示文案（错误提示、禁用原因、进行中状态、完成反馈、空状态、操作引导、确认弹窗说明、输入框占位符及悬停提示）：

| 提示类型 | 标准写法示例 |
| --- | --- |
| **前置阻止** | 时长不足 1 秒，无法生成视频；请点击相邻的段一并选中 |
| **操作失败** | 分镜保存失败，请重试保存 |
| **进行中** | AI 生成中，关闭窗口不影响生成 |
| **操作完成** | 已复制 |
| **空状态** | 暂无可编辑的图片，请先在版本中选择一张已生成的图片 |
| **操作引导** | 描述画面与动作，输入 @ 引用首帧，也可粘贴或拖入图片 |

- **写具体数值与按钮原名**：数量与限制直接写具体数字；提到界面上的按钮或入口时，用直角引号「」包裹它的真实名称（`final-cut` 保留小写带连字符，与中文相邻两侧各留一个空格）。
- **标点规范**：单句提示末尾不加句号；前因后果之间用逗号，说明原因后给出操作建议时中间用分号；多句说明每句以句号结尾。

## 登录与守卫

- **首页允许未登录浏览**：未登录用户可以直接进入首页并看到应用外框（不设独立的登录跳转页）。当用户点击需要登录的操作时，通过 `useLoginPrompt()` 唤起应用外框持有的全局登录弹窗；登录成功后关闭弹窗并留在当前页。
- **需要登录的整页路由守卫**：需要登录后才能查看的页面，在路由的 `beforeLoad` 中使用 `ensureSessionUser()` 拦截；未登录时直接跳回首页，不自动弹出登录框。
- **SSO 登录回调处理**：飞书 SSO 采用整页跳转；如果回调失败会跳回 `/?ssoError=<code>`，由应用外框展示错误提示，并在关闭弹窗时清除 URL 上的 `ssoError` 参数。
- **普通接口返回 401 / 403 时的处理**：业务接口返回 `401` 或 `403` 时，前端不会立刻当成已退登，而是触发一次 `/users/me` 重新核对当前登录状态并重算路由守卫。
- **账号切换时自动重置 WebSocket 连接**：由于 WebSocket 的订阅身份是在握手那一刻确定的（见[跨端合同 §5](../../contract/conventions.md#5-agent-对话-transcript)），一旦检测到登录用户发生变化（退出、重新登录或切换了账号），`src/app/` 下的 `IdentityTranscriptProvider` 会自动让 `TranscriptProvider` 重建一套新的 WebSocket 连接与本地读取池，同时保持外层页面 DOM 树不重新挂载（侧边栏展开状态、输入框里正在打的字不会丢失）。

## final-cut 编辑器与组件库

- **工作台面板与沙箱隔离**：编辑器作为工作台的「final-cut」页签运行（仅在可写对话且工作区存在主文件 `final-cut/index.html` 时显示；未创建时可通过工作台顶栏「+」、空态卡片或折叠竖条按默认模板新建，对话打开期间由 Agent 创建主文件时自动切换至该页签），采用固定三区桌面网格布局（不做窄屏折行重排），支持拖拽分隔条调节右栏宽度与时间线高度、将右栏折叠为竖向图标轨（布局持久化于浏览器本地），右栏窄于最小内容宽度时按容器横向滑动访问。全局快捷键与 `Esc` 仅在焦点位于编辑器内部时生效，不在 `window` 上抢占（[editor-keys.ts](../src/features/storyboard/final-cut/editor-keys.ts)）。预览播放器与工程脚本统一运行在独立预览域名的沙箱页（[preview-page.ts](../src/features/storyboard/final-cut/preview-page.ts)）中，编辑器仅通过经协议校验的 `postMessage` 与之通信（见[跨端合同 §6](../../contract/conventions.md#final-cut-工程与预览域名)、[ADR-0008](../../docs/adr/0008-final-cut-workspace-project.md)）。
- **组件库与按需中文字体分片**：组件目录结构见 [catalog.ts](../src/features/storyboard/final-cut/composition/catalog.ts)，打包规则见[组装脚本](../scripts/hyperframes-registry.mjs)（组件内部标题与正文分别读取 `var(--font-display)` 与 `var(--font-body)`，使用该变量的组件在打包时自动补齐 `font` 可填项；组件专有目录仅允许包含文本文件）。由于播放运行时会等待主文件声明的全部字体加载完毕后才启动脚本，主文件 `<head>` 字体块仅按工程实际出现的字符声明 Noto Sans SC 子集分片（[fonts.ts](../src/features/storyboard/final-cut/composition/fonts.ts)），组件源码内禁止直接引入整包中文字体样式。

## 测试

每一项功能选择**最贴近用户真实体验的一层**编写测试，不在多个测试层重复测同一件事：

| 要验证的行为 | 选择的测试层与工具 |
| --- | --- |
| 跨页面的核心用户流程 | **Playwright E2E 测试**（`e2e/` 目录），由浏览器端 MSW 提供模拟后端响应 |
| 单个业务模块内的组件交互、Hook 与接口联动 | **Vitest 组件测试**（jsdom 环境），使用 `src/testing/render.tsx` 的 `renderWithProviders` 挂载真实组件树，通过 MSW `server.use(...)` 模拟接口返回（参考 [login-form.test.tsx](../src/features/auth/components/login-form.test.tsx)） |
| 纯函数、数据转换、时间线布局算法、解析器 | **Vitest 单元测试**（Node 环境），直接测输入与输出，不使用任何 Mock |
| 接口路径、请求参数、Zod 校验边界与错误映射 | **API 契约测试**，验证发出的请求结构或解析结果 |

### 编写测试的注意事项

- **按用户可见的方式查找元素**：优先使用 `getByRole`、无障碍名称（`aria-label` / 按钮文字）或必要的 `data-testid` 定位元素；**严禁通过 CSS 类名（`className`）或内联样式来定位元素或做行为断言**。
- **使用 MSW 拦截网络请求**：所有 HTTP 请求测试统一通过 MSW 处理，禁止手写 `vi.spyOn(global, 'fetch')`；同样禁止对仓库内部的模块、Hook 或工具函数打 spy（`toHaveBeenCalled*` 只用于组件对外的回调 Prop，或 `navigator.clipboard`、`window.open` 等浏览器原生系统边界）。
- **final-cut 编辑器测试使用内置固定夹具**：测试 `final-cut` 编辑器代码时，只使用仓库内置的测试组件库（`scripts/hyperframes-fixtures/`，单测直接用 `src/testing/final-cut.ts` 中的 `fixtureCatalog`），不依赖外部正式组件库。
