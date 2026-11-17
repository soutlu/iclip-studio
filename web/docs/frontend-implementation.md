# 前端实现规范

命令、目录职责与验证要求见 [AGENTS.md](../AGENTS.md)。基础视觉 Token 定义见根目录 [design-system.html](../../design-system.html)，本文规定组件编写、界面文案、登录守卫与测试分层规范。

## 组件与状态管理

- **优先复用基础组件**：基础按钮、弹窗、输入框等优先使用 `src/shared/ui/` 中的组件；Toast 提示统一使用 `@/shared/ui/toast`；列表里的音频试听统一使用 `@/shared/ui/audition` 的 `useAudition`（同一时间只放一条，所在区域藏起来或卸掉时停下）；组件进退场动画统一使用 `tw-animate-css` 的 `animate-in` / `animate-out` 及设计系统 Token，不单独手写一套新的动画 Keyframes。
- **类型与样式约定**：组件 Props 声明明确的 TypeScript 类型（优先靠近组件定义，跨模块复用时再提取到公共文件）。列表渲染 `key` 必须使用稳定的业务 ID（不要用数组下标）。动态合并 `className` 统一使用 `cn()`，多变体组件样式使用 `cva` 定义。
- **异步请求与自定义 Hook**：支持取消的查询需透传 `AbortSignal`；自定义 Hook 统一以 `use*` 命名并保持返回结构稳定。
- **深浅色主题**：全局主题由 `src/app/theme.ts` 统一控制在 `<html>` 标签的 `.dark` 类名上；组件内部直接使用语义化主题 Token，不要各自维护一套独立的主题状态。

## 交互体验与无障碍（Accessibility）

- **不暴露底层内部标识**：界面文案统一使用中文；严禁向普通用户直接展示底层工具函数名（raw tool name）、`member_id`、内部文件路径或原始 JSON 参数。
- **语义化与键盘可操作**：使用语义化的 HTML 标签；有实际含义的图片填写描述性 `alt`，纯装饰图片设置 `alt=""`；所有核心交互需同时支持鼠标、触摸和键盘操作（保证焦点清晰可见，弹窗打开后正确接管焦点）。
- **加载与错误反馈**：按钮和面板在加载过程中保持原有尺寸不跳动，并防止用户重复点击提交；报错信息用清晰的中文说明，并关联到对应的表单项或操作区域。
- **统一图标库**：通用图标统一从 `@/shared/icons` 导入，颜色默认继承父级文字颜色；纯图标按钮必须提供无障碍名称（`aria-label`），且保证足够大的点击热区。

### 界面文字

界面文案遵循书面语规范（详见 [ADR-0001](../../docs/adr/0001-ui-copy-formal-register.md)）。以下句式适用于各类提示文案（错误提示、禁用原因、进行中状态、完成反馈、空状态、操作引导、确认弹窗说明、输入框占位符及悬停提示）：

| 提示类型 | 标准写法示例 |
|---|---|
| **前置阻止** | 时长不足 1 秒，无法生成视频；请点击相邻的段一并选中 |
| **操作失败** | 分镜保存失败，请重试保存 |
| **进行中** | AI 生成中，关闭窗口不影响生成 |
| **操作完成** | 已复制 |
| **空状态** | 暂无可编辑的图片，请先在版本中选择一张已生成的图片 |
| **操作引导** | 描述画面与动作，输入 @ 引用首帧，也可粘贴或拖入图片 |

- **写具体数值与按钮原名**：数量与限制直接写具体数字；提到界面上的按钮或入口时，用直角引号「」包裹它的真实名称。
- **标点规范**：单句提示末尾不加句号；前因后果之间用逗号，说明原因后给出操作建议时中间用分号；多句说明每句以句号结尾。

## 登录与守卫

- **首页允许未登录浏览**：未登录用户可以直接进入首页并看到应用外框（不设独立的登录跳转页）。当用户点击需要登录的操作时，通过 `useLoginPrompt()` 唤起应用外框持有的全局登录弹窗；登录成功后关闭弹窗并留在当前页。
- **需要登录的整页路由守卫**：需要登录后才能查看的页面，在路由的 `beforeLoad` 中使用 `ensureSessionUser()` 拦截；未登录时直接跳回首页，不自动弹出登录框。
- **SSO 登录回调处理**：飞书 SSO 采用整页跳转；如果回调失败会跳回 `/?ssoError=<code>`，由应用外框展示错误提示，并在关闭弹窗时清除 URL 上的 `ssoError` 参数。
- **普通接口返回 401 / 403 时的处理**：业务接口返回 `401` 或 `403` 时，前端不会立刻当成已退登，而是触发一次 `/users/me` 重新核对当前登录状态并重算路由守卫。
- **账号切换时自动重置 WebSocket 连接**：由于 WebSocket 的订阅身份是在握手那一刻确定的（见[跨端合同 §5](../../contract/conventions.md#5-agent-对话-transcript)），一旦检测到登录用户发生变化（退出、重新登录或切换了账号），`src/app/` 下的 `IdentityTranscriptProvider` 会自动让 `TranscriptProvider` 重建一套新的 WebSocket 连接与本地读取池，同时保持外层页面 DOM 树不重新挂载（侧边栏展开状态、输入框里正在打的字不会丢失）。

## final-cut 编辑器

- **工作台里的一个页签**：编辑器是工作台的「final-cut」页签，和对话并排；对话的工作区里有分镜或工程文件时出现，只读查看时没有。快捷键和 Esc 只认焦点在编辑器里时按的键，不在 window 上抢（[editor-keys.ts](../src/features/storyboard/final-cut/editor-keys.ts)）。
- **不做小屏适配**：任何宽度下都是同一种摆法，宽度不够时内容被所在的卡片裁掉，不换行、不折叠，也不出现横向滚动条。

## 组件库

组件目录的数据结构见 [catalog.ts](../src/features/storyboard/final-cut/composition/catalog.ts)，组件库源目录的打包规则见[组装脚本](../scripts/hyperframes-registry.mjs)文件头说明：

- **组件字体 CSS 变量机制**：组件内部标题统一读取 `var(--font-display, <组件默认字体>)`，正文读取 `var(--font-body, <组件默认字体>)`。
- **中文字体只声明用到的字**：播放运行时会把主文件声明的字体全部加载完才运行组件脚本，所以主文件 `<head>` 的字体块只为出现的字声明 Noto Sans SC 的分片（[fonts.ts](../src/features/storyboard/final-cut/composition/fonts.ts)）——final-cut 里写出的文字、所用组件文件里的非 ASCII 字符（组件目录每个条目的 `chars`），西文基本字符总是带上；用到的西文字体族按组件目录里的 `cjk` 描述各带一组指向同样分片的规则。组件文件不要自己链接整份中文字体样式，组装时会去掉这样的链接。
- **组件的字体配置项**：只要组件源码中使用了上述字体变量，打包脚本会自动为它补充一个 `{ "id": "font", "type": "font", "label": "字体", "default": "" }` 可填项。
- **条目的文件清单**：组件目录每个条目的 `files` 是把它用进 final-cut 工程时要按原路径拷进工程的文件，路径相对版本目录，第一项是 `src`。`src` 所在目录（含子目录）里没有别的条目时，这个目录归它专有，后面按路径顺序跟上目录下其余的文件；多个条目共用的目录只列 `src`。`vendor/` 下的公共文件不在清单里。final-cut 工程只能放文本，专有目录里有不是文本的文件（含 NUL 字节）时组装失败，报错列出条目和文件。

## final-cut 工程

编辑器编辑对话工作区里的 final-cut 工程（业务规则见 [CONTEXT.md「final-cut」](../../docs/CONTEXT.md#术语)，接口见 [conventions「final-cut 的主文件」](../../contract/conventions.md#final-cut-的主文件)），主文件的写法在 [composition/film.ts](../src/features/storyboard/final-cut/composition/film.ts)：

- **只经 SDK 改片段**：编辑器用 SDK 打开主文件，每个编辑动作是一次 SDK 操作；撤销重做由编辑器自己管（SDK 自带的关掉），每个编辑动作恰好一步，按 SDK 报的补丁退回、重做，不按时间合并；不直接拼改 HTML 字符串。片段列表来自 SDK 的 `getElementTimings()`，元素按 SDK 的编号（`data-hf-id`）操作。SDK 的编辑引擎按需加载，不进主包，它自带的保存队列不用。
- **新片段用写法里的函数写**：往工程里加片段时，用 `film.ts` 里对应的函数写出元素（如 `videoElement`、`hostElement`），组件或块的摆放和字体变量写在宿主元素的行内样式上。切开片段时后半段是原元素的整份复制，不经过写法里的函数，这样代理写进去的属性也不会丢。
- **`<head>` 只动字体块**：SDK 改不了 `<head>`，存出主文件时用 `withFontBlock` 只重算带标记的字体块，别的内容原样留着。
- **保存交给会话**：[use-film-session.ts](../src/features/storyboard/final-cut/use-film-session.ts) 管打开着的几个工程文件（主文件，有字幕时还有字幕场景文件，加了语言时还有各语言的 JSON 值表，有贴片、场景时还有它们挂载的组件文件），停下后哪个改了整份存哪个（第一次新建、之后带版本号，主文件最后存）；有一个 `409` 或被别处改了时都换成工作区里的那一份。一步撤销可以同时改几个文件；值表不是 SDK 会话，由会话自己按同样的补丁格式记改动，几种文件的区别只在会话里的一处。工程用自己的查询键，不挂在工作区文件下面：工作台每次文件变化都让工作区文件的查询失效，挂在下面的话一存就会重开引擎、清空撤销历史。
- **预览发当前的主文件和字幕场景**：预览页拿到的就是会话里当前的主文件和字幕场景（没存的改动也在里面），加上指向凭令牌取别的工程文件的 `<base>` 和预览专用的媒体加载方式（[preview-document.ts](../src/features/storyboard/final-cut/preview-document.ts)）。字幕场景以 `<template id="<场景 id>-template">` 放进发出去的主文件，运行库挂载字幕宿主时先用它，不去取工作区里存着的那份。
- **改动直接打进预览**：预览页给正在播的那一份开 SDK 副本会话，主文件一个（打开的就是播放器加载的那份文档）、字幕场景一个（打开的就是放进文档里的那份场景），`data-hf-id` 都和播放器里的一一对上，用 SDK 的 iframe 预览适配器把补丁同步进播放器。编辑器每做完一步编辑（含撤销、重做），能直接打的就把这一步主文件、字幕场景各自的补丁带着序号发过去，不换播放器；哪些能打由 [preview-sync.ts](../src/features/storyboard/final-cut/preview-sync.ts) 判断（运行库只在加载时读的改动、`<head>` 里中文字体规则以外的部分变了、原文以外的语言下改主文件、总长变短等都整份重新加载）。改字用到新字形时字体块里的中文字体规则跟着变，编辑器把新的规则随补丁发过去，预览页先换掉播放器里字体块的 `<style>`，浏览器按新规则取字形。原文以外的语言下，运行库只在加载时按值表写字幕的字，之后这种语言里字幕的字变了，编辑器给那几句补上改字的补丁。序号对不上、要改的元素不在、打的时候出错时，预览页回报，编辑器改发整份。
- **画面上的编辑：编辑器定层，预览页量**：预览画面上盖着一层编辑层（[canvas-overlay.tsx](../src/features/storyboard/final-cut/canvas-overlay.tsx)）。预览页回报的只能是数字，所以层是谁由编辑器定：会话按主文件、字幕场景和打开着的组件文件列出层表（[canvas-layers.ts](../src/features/storyboard/final-cut/canvas-layers.ts)，每层是「挂在哪个宿主下、运行库的稳定选择器、第几个匹配」），发给预览页。按下时预览页用运行库的 `pointerTargets` 找指针下的层（跳过宿主、铺满画面的容器、空容器、不接收指针的；照运行库取元素时的做法，判断的那一刻临时让组件的内层根和最外层的根接收指针，判断完马上撤掉，所以根写着 `pointer-events: none` 的组件里的层也点得中），按表答复是第几层，连同量出来的样子（运行库 `elementCornerPoints` 量的画面上的框、父元素的线性变换、能不能改；变换链由预览页自己一直合到文档、算上单独写的 `scale`，因为贴片宿主是用 `scale` 缩进画面的，运行库的变换快照只合到最近的合成根、也不算它）；能不能改用引擎的 `resolveEditingAffordances`，再拦掉动画脚本在动的（[layer-abilities.ts](../src/features/storyboard/final-cut/layer-abilities.ts)）。拖动中编辑器让预览页直接摆这一层（不经副本会话，缩放时预览页再挪一下让中心回原处），松手经会话把改动写进这一层所在的文件（写法见 [layer-edits.ts](../src/features/storyboard/final-cut/layer-edits.ts) 和 [conventions「final-cut 的主文件」](../../contract/conventions.md#final-cut-的主文件)），算一步；取消时摆回去。主文件、字幕场景里的改动照上一条打补丁；组件文件在预览里是从工程里取的，改了的层由预览页按表直接改样式和属性，之后按 SDK `moveElement` 的写法重新摆一遍，组件文件存下以后预览整份重新加载。原地改字时预览页找出那段文字、藏起来、报回它的位置和字号，编辑器在上面放自己的输入框，写法和「属性」里改字是同一个；字幕自己是带时间的片段，运行库按时间改它的 `visibility`，所以用 `opacity` 藏。
- **预览在预览域名下运行**：工程里的脚本不能拿到应用的登录态，所以播放器和 final-cut 都放在预览域名下的预览页（[preview-page.ts](../src/features/storyboard/final-cut/preview-page.ts)）里，编辑器只嵌入它、靠消息控制它（协议见 [preview-protocol.ts](../src/features/storyboard/final-cut/preview-protocol.ts)）。缓冲、素材失败等要读 final-cut 页面的判断都在预览页里做，结果用消息报回；编辑器收到的每条消息先按协议校验，只当数据用。运行库地址用预览域名下的组件库。

## 测试

每一项功能选择**最贴近用户真实体验的一层**编写测试，不在多个测试层重复测同一件事：

| 要验证的行为 | 选择的测试层与工具 |
|---|---|
| 跨页面的核心用户流程 | **Playwright E2E 测试**（`e2e/` 目录），由浏览器端 MSW 提供模拟后端响应 |
| 单个业务模块内的组件交互、Hook 与接口联动 | **Vitest 组件测试**（jsdom 环境），使用 `src/testing/render.tsx` 的 `renderWithProviders` 挂载真实组件树，通过 MSW `server.use(...)` 模拟接口返回（参考 [login-form.test.tsx](../src/features/auth/components/login-form.test.tsx)） |
| 纯函数、数据转换、时间线布局算法、解析器 | **Vitest 单元测试**（Node 环境），直接测输入与输出，不使用任何 Mock |
| 接口路径、请求参数、Zod 校验边界与错误映射 | **API 契约测试**，验证发出的请求结构或解析结果 |

### 编写测试的注意事项

- **按用户可见的方式查找元素**：优先使用 `getByRole`、无障碍名称（`aria-label` / 按钮文字）或必要的 `data-testid` 定位元素；**严禁通过 CSS 类名（`className`）或内联样式来定位元素或做行为断言**。
- **使用 MSW 拦截网络请求**：所有 HTTP 请求测试统一通过 MSW 处理，禁止手写 `vi.spyOn(global, 'fetch')`；同样禁止对仓库内部的模块、Hook 或工具函数打 spy（`toHaveBeenCalled*` 只用于组件对外的回调 Prop，或 `navigator.clipboard`、`window.open` 等浏览器原生系统边界）。
- **final-cut 编辑器测试使用内置固定夹具**：测试 final-cut 编辑器代码时，只使用仓库内置的测试组件库（`scripts/hyperframes-fixtures/`，单测直接用 `src/testing/final-cut.ts` 中的 `fixtureCatalog`），不依赖外部正式组件库。
