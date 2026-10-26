# 前端实现规范

命令、职责边界和验证入口见 [AGENTS.md](../AGENTS.md)。基础 token 见[设计系统](../../design-system.html)，交互规则见本文；组件 props、变体和尺寸以实现为准。

## 组件与状态

- 优先复用 `src/shared/ui/`。
- 组件 props 使用显式类型；类型靠近使用处，跨模块复用时再提取。通过判别字段或结构化校验收窄类型，先处理空值分支。
- 列表 key 使用稳定业务标识。className 组合使用 `cn()`；多变体样式用 `cva` 声明。
- 可取消的查询传递 `AbortSignal`。自定义 Hook 使用 `use*` 命名，返回值保持稳定结构。
- 主题由 `src/app/theme.ts` 统一作用于 `<html>` 的 `.dark`；组件使用主题 token，不各自维护主题状态。
- toast 使用 `@/shared/ui/toast`；进退场动画使用 `tw-animate-css` 的 `animate-in` / `animate-out`，时长与曲线取设计系统 token，不另写一套 toast 或进退场 keyframes。

## 内容与可访问性

- UI 文案使用中文，代码标识符使用英文。面向用户的界面不泄露 raw tool name、`member_id`、skill name、reference path 或原始 JSON 参数。
- 使用语义化元素。图片 alt 描述内容，装饰图片使用空 alt。
- 键盘、鼠标与触摸均可完成核心任务：控件可用键盘操作且焦点可见，浮层打开后管理焦点。
- 悬停与按压的反馈一致，不改变布局；选中、禁用的视觉状态与可访问语义一致。
- 加载时保持尺寸并阻止重复提交；错误用文字说明，并关联到对应字段或操作。
- 通用图标统一取自 `@/shared/icons`，使用同一尺寸刻度，按用途命名，颜色继承所在控件。语义图标与图标按钮提供可访问名称，装饰图标对辅助技术隐藏；控件热区独立于图形尺寸。

### 界面文字

界面文字的要求见 [ADR-0001](../../docs/adr/0001-ui-copy-formal-register.md)。提示指错误、置灰或阻止原因、进行中状态、完成反馈、空状态、操作引导、确认说明、输入框占位，以及解释原因的悬停提示与 toast；按钮名、标题、字段名与可访问名是名字，不套提示句式。

| 类型   | 例                                                 |
| ------ | -------------------------------------------------- |
| 阻止   | 时长不足 1 秒，无法生成视频；请点击相邻的段一并选中 |
| 失败   | 分镜保存失败，请重试保存                           |
| 进行中 | AI 生成中，关闭窗口不影响生成                      |
| 完成   | 已复制                                             |
| 空状态 | 暂无可编辑的图片，请先在版本中选择一张已生成的图片 |
| 引导   | 拖动两端可裁剪，按住中间拖动可调整顺序             |

- 写具体：数量与阈值写实际值；提到界面上的按钮或入口时用「」加它的原名。
- 标点：分句用逗号，原因与操作之间用分号；多句说明每句以句号结尾。

## 登录与守卫

- 未登录可进首页并看到应用壳；需要登录的动作经 `useLoginPrompt()` 请应用壳打开登录弹窗，账号密码登录成功后关闭弹窗、留在当前页。不设独立登录页，应用壳不统一拦截未登录用户。
- 整页需登录的路由用 `beforeLoad` + `ensureSessionUser()` 守卫，未登录回首页，不带 next、不自动弹窗。
- 登录弹窗只由应用壳持有，feature 不自行创建；登录通道只有飞书 SSO 与账号密码。
- SSO 整页跳转；回调失败回 `/?ssoError=<code>`，由应用壳展示错误，关弹窗时移除该参数。
- 普通接口的 401 / 403 只触发 `/users/me` 复核再重算路由，不据此认定已退出，也不自动弹窗；登录、登出、SSO 与会话探测中预期的 401 由认证流程自己处理。
- 登录状态变化后重算路由。退出登录停留当前页，由守卫决定是否回首页。
- 身份一变（退出、登录、接口复核发现换了人），`src/app/` 的 `IdentityTranscriptProvider` 让 `TranscriptProvider` 换一套连接、本地发送状态与读取池，因为订阅身份按握手时定（见[跨端合同 §5](../../contract/conventions.md#5-agent-对话-transcript)）；界面树不重新挂载，侧栏展开、输入中的内容等界面状态照旧。按连接缓存的组件内状态在连接变化时清空。

## 成片组件

组件目录的结构见 [catalog.ts](../src/features/storyboard/whole-film/composition/catalog.ts)，组件库源目录的格式见[组装工具](../scripts/hyperframes-registry.mjs)的文件头。

- **字体变量**：组件按 HyperFrames 的设计规范，标题读 `var(--font-display, <自带字体>)`，正文读 `var(--font-body, <自带字体>)`，自己不定义这两个变量。选了字体时，合成页在组件宿主的行内样式上设这两个变量（字体名加 `sans-serif` 兜底），经 CSS 继承传进组件，并引用这个字体的 CSS；`--font-mono` 不动。
- **字体可填项**：`{ "id": "font", "type": "font", "label": "字体", "default": "" }`，取值是组件目录 `fonts` 里的字体名，空字符串是组件自带的字体。组件文件读了上面任一变量、自己没写 `font` 项的，组装时自动加上；品牌组件可以自己写这一项，把默认值设成本品牌的字体。它不进 `data-variable-values`。界面上是下拉，选项是「默认」加上目录里每个带 `brand` 的字体，选项文字是品牌缩写；选回目录里的默认值时草稿里不再存这一项。
- **字幕的可填项**：草稿的 `captions.variables` 同特效块的 `variables`，全部字幕共用一套；换样式时保留，合成时只取当前样式声明过的项。字幕不开浮层，字体在字幕轨标题的样式菜单里选，当前样式有 `font` 项时菜单里才有「字体」一组。

## 测试

每个行为选择最接近用户可观察边界的一层，不在多层重复相同断言。可观察边界包括界面、交互结果、HTTP 请求与响应、路由变化。

| 行为                                  | 测试层与入口                                                                                                               |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 跨页面核心用户旅程                    | `e2e/` 中的 Playwright 用例，浏览器 MSW 提供后端响应                                                                       |
| feature 内组件、Hook 与 API 协作      | 组件测试，使用 `src/testing/render.tsx` 的 `renderWithProviders` 挂载真实子树；HTTP 通过 MSW，响应覆盖用 `server.use(...)` |
| 纯函数、投影、布局算法、解析器        | 纯输入输出单测，不 mock                                                                                                    |
| HTTP 路径、请求体、zod 边界与错误映射 | API 契约测试，断言请求形状或返回结果                                                                                       |

组件测试样例见 [login-form.test.tsx](../src/features/auth/components/login-form.test.tsx)。单测与被测源码同目录，使用 `*.test.ts[x]`；同一校验规则的多个分支用 `it.each` 表达。

- 按角色、可访问名或必要的 `data-testid` 定位，不依赖样式类；不把 className、style 或哈希类名作为行为断言。
- 不写读取 Provider / Hook 内部状态再投射成 DOM 的探针组件。测试所需浏览器边界使用现有测试适配器或 `vi.stubGlobal`。
- HTTP 使用 MSW，不手写 `fetch` stub。组件对外的回调 prop 可以用 `toHaveBeenCalledWith` / `toHaveBeenCalledTimes` 断言入参与次数；不对内部模块、Hook 或同仓函数做 spy；`toHaveBeenCalled*` 另用于剪贴板、`window.open` 等真实系统边界。
- 不快照 prompt 或自然语言措辞；通过可访问名定位控件与断言业务结果即可，文案本身是明确合同的情况除外。
- 成片编辑器的测试只用入库的测试组件库（`scripts/hyperframes-fixtures/`），测代码、不测具体组件，不引用正式组件库里的组件。单测用 `src/testing/whole-film.ts` 的 `fixtureCatalog`（目录加固定版本号，不需要先组装），`/hyperframes/catalog.json` 由 MSW 返回它；e2e 读 `dev:mock`、`build:mock` 先组装好的 `public/hyperframes/`。

同仓模块 mock 等语法限制由 [ESLint](../eslint.config.js) 检查。
