# Agent 工具编写规范

> 本文规定如何编写面向大模型的 Agent 工具描述（docstring）、参数校验与前端卡片展示信息。
> - 插件装配机制见 [architecture.md](architecture.md)
> - 业务概念见 [CONTEXT.md](CONTEXT.md)

## 1. 指引文字写在哪里

不同层级的指引各司其职，同一条规则只写在一处，不要在多个地方重复抄写：

| 指引内容 | 应该写在哪里 |
|---|---|
| 单个工具是干什么的、参数从哪来、适用范围、数量上限、能否重复调用、失败后怎么处理 | **工具函数的 docstring** |
| 什么时候该调哪个工具、多个工具之间的配合顺序、创作判断标准与交付格式 | **技能库（`SKILL.md` 及 `references/` 参考文档）**，在管理后台编辑 |
| 整个插件（一组工具）共用的背景规则，写在单个工具里不合适的 | **插件类的 `get_instructions` 方法**（没有则返回 `None`） |
| 当次调用失败的原因，以及模型下一步该怎么修正 | **工具抛出的错误消息（`ModelRetry` 或 `ToolFailed`）** |

---

## 2. 面向大模型的 docstring 写法

工具的 docstring 是直接给大模型看的指令，**只写会影响模型调用行为的信息**（完整范例可参考 [WorkspaceToolset.read_media_file](../runtime/src/agent_runtime/plugins/workspace/capability.py)）：

- **首行一句话定性**：第一行直接写清楚这个工具做什么。
- **写清边界与调用时机**：明确说明什么时候该调、什么时候不要调、重复调用是否会直接复用已有结果，以及是否支持并发/分批调用。
- **使用明确指令，不用含糊词汇**：直接写「必须……」「禁止……」，不要写「尽量」「最好」这类模棱两可的建议。
- **写明数字上限与超限后的做法**：例如报错或说明写*「镜头组 3 的时长为 42 秒，超出 4～30 秒允许范围；请将该组拆分为两组后重新交付」*——既给出具体数字，又告诉模型下一步该怎么做。
- **`Args:` 只补充取值来源**：参数的类型、默认值和是否必填已经在 JSON Schema 里表达了，不要在 `Args:` 里重复抄一遍；只写模型该从哪里获取这个参数值。
- **不写内部设计理由**：不要向模型解释为什么定这个规则或背后的计费逻辑；如需防止模型盲目重复发起付费调用，直接规定「遇到某类错误时禁止重试，并直接告知用户原因」。

---

## 3. 工具注册与参数校验

工具统一通过 `Tool(..., args_validator=...)` 注册到插件（Capability）中（参考 [workspace](../runtime/src/agent_runtime/plugins/workspace/capability.py)、[shot_video](../plugins/video/src/iclip_video/shot_video/toolset.py) 与 [skills](../runtime/src/agent_runtime/harness/skills.py)）：

- **前置参数校验放 `args_validator`**：像媒体地址、已挂载的技能这类单工具入参范围检查，统一放在 `args_validator` 中拦截，不要散落在工具主体代码里。地址不在参数里、要从工程文件读出来的（`check_film`、`generate_images`）在工具主体里检查，`check_film` 把不能用的地址列进问题清单。共用的地址校验在 [harness/materials.py](../runtime/src/agent_runtime/harness/materials.py)：
  - `require_http` 只检查地址形状是否为合法的 HTTP(S) 链接。
  - 提交类工具用 `require_media` 检查链接能否打开、类型是否正确。有不能用的地址时抛 `ModelRetry`，按位置称呼（如「第 2 组第 1 张」）逐条列出称呼与原因，让模型换地址，不回显地址。
  - 读取类工具不做这项检查（规则见 [CONTEXT.md「媒体地址」](CONTEXT.md#术语)）。
- **正确区分三种异常**：
  - `ModelRetry("...")`：模型传错了参数格式或漏了前置步骤，让模型根据提示修正参数后重试。
  - `ToolFailed("...")`：外部服务报错或业务条件不满足（例如后台未启用对应模型），直接结束本次调用并把原因返回给模型，不消耗模型的参数纠错重试次数。
  - `ApprovalRequired(metadata=...)`：操作需要人工审批，暂停当前运行并等待用户确认。
- **安全与权限边界**：`args_validator` 和人工审批不能替代底层权限检查。用户数据隔离依然在工具执行层和数据库存储层按 `AgentRunDeps` 中的所属用户 ID 严格校验。

---

## 4. 工具返回值与前端卡片展示

- **返回值长度限制**：单次返回给大模型的文本不得超过 `50,000` 个字符；如果产出内容过长（如 `video_parser` 的长视频分析），应先写入工作区文件，再向模型返回文件路径与简短摘要。
- **分离「给模型看的内容」与「给用户界面看的数据」**：
  使用 `ToolReturn(return_value=给模型看的文本, metadata=给前端渲染卡片的结构化数据)`。其中 `metadata` 会随聊天记录持久化落库并推送给前端，但不会放进发给大模型的上下文窗口（数据结构见 [transcript/display.py](../runtime/src/agent_runtime/transcript/display.py)）。
- **前端工具卡片标题规范（`generic` 卡片）**：
  - `summary`（主标题）：使用 4～5 个字的书面动宾短语（如「读取图片」「生成画面」「拆解视频」），不带数字、文件路径或口语简写。
  - `detail`（副标题/操作对象）：写本次操作的具体目标（如文件名、路径、镜头号），没有则留空。
  - **数字统一放角标**：行数、图片张数、文件大小、命中条数等数字统一放进 `metadata` 的角标字段，不要拼在标题里。
