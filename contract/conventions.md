# 跨端接口与协议约定 (API Conventions)

> - 所有 HTTP 接口路径、权限要求与请求/响应字段定义均以 [`openapi.json`](openapi.json) 为准（生成流程见 [开发约定](../AGENTS.md)）。
> - 本文只补充 OpenAPI 无法表达的**认证细节、状态机流转、特殊错误码与 WebSocket 实时流协议**。
> - 领域概念与业务规则见 [CONTEXT.md](../docs/CONTEXT.md)。运行时服务的接口以运行时项目的 `openapi.json` 为准，见本文 §20。

## 1. 部署与路由路径

- **同源反向代理**：前端代码只请求同域名的 `/api/*`（本地开发由 Vite Proxy 转发，线上由 Nginx/Ingress 将开头的 `/api` 去掉后转发给后端根路径）。禁止使用 `3xx` 跨域名重定向；登录 Cookie 不设置 `Domain`，登录与接口调用必须使用同一个主机名（不要混用 `localhost` 和 `127.0.0.1`）。
- **WebSocket 代理**：反向代理需支持 `/api/ws` 的协议升级（Upgrade），并原样保留浏览器的 `Origin` 和 `Host` 请求头（后端会校验同源，不能通过删掉 `Origin` 头来绕过检查）。

## 2. 双主体认证 (Dual Principals)

系统同时支持「浏览器用户」和「API Key 机器调用方」，两者使用同一套权限体系：

- **浏览器登录态（`SessionCookie`）**：后端通过 HttpOnly Cookie `iclip_session` 维护会话，前端 JS 不读写该 Cookie，也不保存 API Key。企业 SSO 登录跳回前端时，落地页读取 URL 上的 `jwt_token`（兼容 `jwt`）调用 `GET /auth/sso/callback?jwt=...` 换取 Cookie，随后立即用 `replace` 清除地址栏里的票据参数。前端判断当前是否已登录，唯一以 `GET /users/me` 的结果为准（返回 `401` 即未登录）。
- **机器调用方（`BearerToken`）**：在请求头携带 `Authorization: Bearer <token>`（明文仅在创建时返回一次）。**凭证优先级**：只要请求头里带了 `Authorization: Bearer`，后端就只按 API Key 验证；如果 Key 无效直接返回 `401`，不会回退去看浏览器 Cookie（WebSocket 握手同理）。
- **接口权限声明**：每个接口需要什么权限，直接看 `openapi.json` 中该接口的 `security` 字段（数组各项之间为「或」关系，内部的 scopes 为必须同时具备的权限名；空数组代表只需登录；无 `security` 代表公开接口；`POST /auth/logout` 仅限浏览器 Cookie 调用）。
- **修改用户时的防越权检查**：调用 `PATCH /users/{id}` 修改他人账号（包括仅启停账号）时，如果对方现有的权限、或修改后的权限里包含当前操作者自己没有的权限，接口会返回 `403`。尝试修改自己的权限或停用自己会返回 `400`。
- **代指定用户操作（`users:act_as`）**：持有 `users:act_as` 权限的 API Key，在调用以下 6 个写接口时传入目标用户名，即可将数据直接记在该用户名下：
  - `POST /conversations`（`userName`）
  - `POST /tasks`（`userName`）
  - `POST /conversations/{id}/prompts`（`user_name`）
  - `POST /generations/*`（`user_name` 或 `userName`）
  - `POST /references/{id}/test-generations`（`userName`）
  - `POST /uploads/{uploadId}/confirm`（`userName`）
  - 注意：如果是普通浏览器登录用户调用这些接口，这些字段只能填自己的用户名，填别人会返回 `422`。

## 3. 数据载荷与格式 (Payload Formatting)

- **字段命名**：常规业务接口统一使用 `camelCase`（小驼峰）。少数历史或透传接口保留 `snake_case`（前端直接按生成的类型消费即可，新增业务接口不再使用 `snake_case`）：SSO 的 `authorization_url`、注册接口的用户状态字段、§5 的 Transcript 协议外层字段、§11 镜像上游的视频生成与查询接口、§19 Agent 的 `config` 配置文档以及 §8 需求单的 `inputs` 内部字段。
- **时间与默认排序**：所有时间均为 ISO 8601 UTC 格式。除非另有说明，列表接口默认按创建时间倒序排列（`createdAt DESC, id DESC`），游标分页（`cursor` / `nextCursor`）也按这一顺序续接。
- **客户端幂等 ID**：发消息的 `prompt_id`、新建对话的 `id` 和新建需求单的 `id` 支持由客户端生成，用于网络重试时的幂等去重；如果传入的 ID 与其他用户的记录冲突，服务端统一按「资源不可见」返回 `404`（详见 [CONTEXT.md 不变量 8](../docs/CONTEXT.md#不变量)）。

## 4. 错误处理与响应信封

所有业务错误统一返回 JSON 格式：`{ "detail": "<可直接向用户或开发者展示的中文错误原因>" }`。HTTP 状态码与业务错误的对应关系固定如下：

| 内部错误类型 | HTTP 状态码 | 含义与特殊附加字段 |
|---|---|---|
| `AuthenticationFailed` | `401` | 未登录、会话已过期或 API Key 无效 |
| `PermissionDenied` | `403` | 看得见该资源，但没有操作权限（例如治理者尝试修改别人的对话、管理员越权修改用户） |
| `NotFound` | `404` | 资源不存在，**或者该资源属于别人、对当前用户不可见**（不对外暴露资源是否存在） |
| `Conflict` | `409` | 与当前状态冲突：例如乐观锁版本号过期、状态机不允许当前操作、资源正在被引用无法删除。当对话绑定的 Agent 版本无法装配时，额外附带 `code: "agent_unavailable"` |
| `ValidationFailed` | `422` | 请求参数校验不通过（格式为 `<字段路径>: <原因>`，单次返回第一个错误）。当发布 Agent 编译检查不通过时，额外附带字段级错误列表 `problems: [{ path, message }]` |

- **网关与下游错误**：取消成片导出时若渲染服务连不上，返回 `502`；Agent 运行时服务连不上或报错时，统一返回 `503`。
- **异步任务失败**：视频、图片等生成接口返回 `202` 仅代表任务已入队；后续生成失败不会报错在 HTTP 状态码上，而是体现在任务记录的 `status: "failed"` 及 `errorCode` / `errorMessage` 字段中。

---

## 5. Agent 对话 (Transcript)

Agent 聊天记录（Transcript）协议参考了 Kimi Code 的协议结构并做了定制扩展（内容层结构见 [vendor README](../web/src/shared/transcript/vendor/README.md)）。连接 WebSocket 需要 `agent:run` 权限；只有对话创建者本人可以发消息和修改，治理者可以只读查看他人的对话；测试预览会话仅限创建者本人（且仍持有 `agent:manage`）访问。

### 与 Kimi 协议的区别及字段约定

- **连接层定制扩展**：
  - 增加流生命周期标识 `stream_epoch`（配合订阅时的 `transcript_epoch`，防止服务重启后旧连接把从 1 重新编号的新消息误接到旧聊天记录后面）。
  - 全局广播帧增加 `owner_user_id`（方便前端区分是不是自己的对话）。
  - 新增工作区文件变更帧 `event.fs.changed`、生成任务状态帧 `event.generation.changed`、对话行更新帧 `event.session.updated`。
  - 中止原因统一命名为 `aborted`；停止运行统一走 HTTP 接口，不使用 WebSocket 上的 `abort` 帧。
- **大小写约定**：协议外层信封和查询参数保持 `snake_case`（如 `agent_id`, `has_more`, `latest_seq`, `since_seq`, `before_turn`, `after_turn`, `stream_epoch`）；内部包裹的实体与操作使用 `camelCase`（如 `turnId`, `stepId`, `frameId`, `toolCallId`）。
- **向后兼容原则**：已发布的 Transcript 字段只增不改（不改名、不改类型、不删除）；新增可选字段时，必须在同一个 PR 中同步更新后端模型、前端 vendored schema 和金样测试（Golden Test）。

### 发消息、读历史与运行控制

- **发消息 `POST /conversations/{id}/prompts`**：
  - 请求体为 `{ prompt_id, content, user_name? }`。在同一段对话里用相同的 `prompt_id` 重复发送会幂等返回原记录；如果在另一段对话里重用已有的 `prompt_id` 会返回 `409`。
  - `user_name` 为上游计费对账标签：API Key 调用时必填；浏览器调用时可省略（若填写则必须等于当前登录用户名，否则返回 `422`）。
  - 接口返回该条消息的状态：当前对话空闲时为 `running`，当前正忙时为 `queued`。如果该对话绑定的 Agent 版本此刻无法装配（例如所选模型已被停用），直接返回 `409`（带 `code: "agent_unavailable"`）。
- **读聊天记录 `GET /conversations/{id}/transcript`**：
  - 默认返回最新一页轮次；传 `before_turn` 向更早的历史翻页，传 `after_turn` 向更新的轮次翻页（两者不能同时传），`has_more` 始终代表「前面是否还有更早的历史轮次」。
  - `agent_id` 默认为 `main`；传入子 Agent 的运行 ID（取自工具卡片的 `agentRefs`）即可查看该子 Agent 的执行记录。
  - 响应顶层除了聊天内容，还会返回对话标题 `title`、所属用户 `owner_user_id`，以及当前实时流的最新序号 `seq` 和流标识 `stream_epoch`（供紧接着发起 WebSocket 订阅使用）。
- **机器端补漏 `GET .../transcript/ops?since_seq=&stream_epoch=`**：供脚本调用方拉取断线期间漏掉的增量批次。如果 `stream_epoch` 不匹配或请求的序号已超出服务端缓存窗口，会返回 `complete: false`，此时调用方应重新拉取整页 `transcript`。
- **查询排队与状态**：`GET .../prompts` 返回当前正在跑和排队中的消息 `{ active, queued }`；`GET .../status` 返回简要状态（`running | awaiting | completed | failed | aborted | idle`）。
- **停止、插队、重新生成与审批**：
  - **撤回单条消息** `POST .../prompts/{prompt_id}:abort`：排队中的直接撤回，正在跑的触发取消（已经结束的返回 `409`）。
  - **停止整段对话** `POST /conversations/{id}:abort`：一次性撤回所有排队消息并取消当前运行（哪怕当前空闲也正常返回 `204`）。**注意**：想停掉整段对话时必须调用这个接口，不要循环调用单条撤回，否则撤到一半时后面的排队消息可能会被自动顶上来开始运行。
  - **消息插队** `POST .../prompts:steer`：传入排队中的 `prompt_ids`，让它们不必等当前轮结束，直接在模型下一次请求时插进当前轮次一起处理（当前没有运行中的任务时返回 `409`）。
  - **重新生成** `POST .../turns/{turn_id}:regenerate`：仅允许对空闲对话的**最后一轮**（`t{N}`）重新生成（正忙或非最后一轮返回 `409`），支持传入新 `content` 替换原提问。
  - **提交人工审批** `POST .../interactions/{interaction_id}`：提交同意或拒绝决定（返回 `204`；同一决定重复提交幂等，修改决定返回 `409`，审批已结束返回 `404`）。

### 后台工具

像 `breakdown_video`（视频拆解）这类耗时较长的后台异步工具，模型调用后会先拿到一条「已启动」回执并继续往下执行，等拆解真正完成后再把结果送回对话中（金样示例见 [transcript/background-turn.json](transcript/background-turn.json)）：
- **原工具卡片**：收到回执的那一刻状态就变成 `done`（显示回执文字），后续不再改变；只有当整次运行已经结束却依然没等到拆解结果时，卡片才会变成 `error`（显示已中断）。
- **后台任务列表（`tasks`）**：收到回执时会在 `tasks` 中新增一条 `kind: "tool", detached: true, taskId: toolCallId` 的任务；等拆解结果送达后更新为 `completed` 或 `failed`；如果中途被用户手动停止则记为 `killed`。
- **完成通知块**：当拆解结果送达时，会在当时的最后一个步骤里插入一条 `role: "user"`、带有相同 `taskId` 的通知块（文案为「已{工具标题}」或「{工具标题} 失败」）。

### 订阅

前端通过一条 `WS /ws`（经代理为 `/api/ws`）连接同时订阅多段对话的实时消息（帧结构定义见 [connection.ts](../web/src/shared/transcript/connection.ts)）：

1. **握手与「先拉基线、再发订阅」**：
   - 连接建立后，服务端首先发送一帧 `server_hello`（告知心跳间隔 `heartbeat_ms`）。
   - 前端打开某段对话时，先调用 `GET .../transcript` 拿到首屏数据和当时的水位（`seq` 与 `stream_epoch`），然后发送 `subscribe_v2` 帧（带上 `session_id`、各 Agent 的订阅档位 `transcript`、以及刚才拿到的 `transcript_since` 和 `transcript_epoch`）。
   - 如果水位和 `stream_epoch` 都能对上，服务端会直接从断点处接着推 `transcript.ops` 增量帧；如果不带水位、或者服务重启导致 `stream_epoch` 变了、或者调高了订阅档位，服务端会先发一帧 `transcript.reset`（**前端收到 reset 时必须无条件用它携带的 `seq` 和 `stream_epoch` 覆盖本地记录**），然后再推增量帧。
2. **权限校验与退订**：如果订阅的对话不存在或当前用户无权查看，服务端会在回执 `ack.payload.not_found` 中列出该对话 ID，不会断开整条 WebSocket 连接。离开页面不再关注某段对话时，发送 `unsubscribe_v2` 退订。
3. **心跳与断线重连**：服务端每 10 秒发送一帧 `ping`，如果连续 20 秒没收到客户端任何消息则以 `1001` 断开连接。当后端与运行时之间的内部连接断开或重连时，也会主动以 `1001` 断开所有浏览器连接；前端重连后需重新发送订阅并刷新对话列表与工作区文件。

#### 档位

`subscribe_v2` 中 `transcript: { [agentId]: 档位 }` 支持以下 4 个档位（未指定时默认为 `off`）：

| 档位 | 推送的 Transcript 内容 | 适用场景 |
|---|---|---|
| `off` | 不推送任何聊天内容（连 `reset` 也不发），但保持对该对话的订阅，因此**依然能收到工作区文件变更帧 `event.fs.changed`** | 只需要监听文件变化的场景（如果完全不看该对话，请发 `unsubscribe_v2` 退订以释放服务端内存） |
| `turn` | 只推轮次级变化：`turn.upsert`、`prompt.upsert`、`interaction.upsert`、`attachment.upsert`、`meta.merge`、`items.remove` | 侧边栏列表监听对话状态 |
| `block` | 在 `turn` 基础上增加步骤和块：`step.upsert`、`frame.upsert`（不含逐字打字机增量 `append`） | 卡片级状态预览 |
| `delta` | 推送全部操作（包含逐字流式输出的 `append`） | 当前正在打开聊天的窗口 |

#### 全局帧

以下 6 种全局帧不需要提前发 `subscribe_v2` 订阅，服务端会自动推送给**该对话的创建者**以及**在线的治理者（持 `users:manage`）**（外层结构统一为 `{ type, session_id, owner_user_id, timestamp, payload }`）：

| 帧类型 | `payload` 内容 | 什么时候推送 |
|---|---|---|
| `session.meta.updated` | `{ title }` | 系统自动生成了对话标题，或用户手动修改了标题 |
| `event.session.work_changed` | `{ busy, pending_interaction, last_turn_reason? }` | 对话的运行忙闲状态发生变化（测试预览不发；`last_turn_reason` 仅在 `busy: false` 时出现） |
| `event.session.created` | 完整的对话行 `ConversationOut` | 新建了对话或分叉出了新对话 |
| `event.session.updated` | 完整的对话行 `ConversationOut` | 修改了标题、更换了需求单/合集归属、标记/取消了已收尾状态、或开始了新一轮运行（注意：前端收到此帧更新列表时，如果本地已有该对话的实时 `activity`，不要用帧里的旧快照覆盖它） |
| `event.session.deleted` | 无 `payload` | 创建者删除了这段对话 |
| `event.generation.changed` | `{ id, kind, operation, status, shot_index?, metadata? }` | 生成任务的状态发生变化（不包含产物链接，前端收到后按需重新拉取生成任务列表或视频生成进度） |

#### 文件变化

- `event.fs.changed`（`payload: { changes: [{ path, change: "created" | "modified" | "deleted" }] }`）：只要连接通过 `subscribe_v2`（任意档位，包括 `off`）订阅了某段对话，当 Agent 工具或用户在页面上修改了该对话的工作区文件时，就会收到此通知，前端据此重新读取对应文件即可（分叉和做同款初始复制文件时不发此通知）。

---

## 6. 对话 (Conversations)

- **UUID 格式与幂等创建**：接口路径、请求体和 WebSocket 帧中的对话 ID 有无连字符（`-`）均可识别，服务端返回时统一使用带连字符的标准格式。`POST /conversations` 支持客户端传入自定义 `id`：如果是自己的已有对话，会幂等返回该对话且状态码为 `200`（首次创建为 `201`）；如果该 ID 属于别人的对话，或者是一段已被删除的对话，则返回 `404`。
- **创建对话时锁定 Agent 版本**：传入的 `agentId` 必须在首页可选列表 `GET /conversations/agents` 中（不存在或未上架返回 `422`，已归档或从未发布过返回 `409`）。对话创建后即固定使用该 Agent 当时的最新版本。
- **侧边栏列表与筛选**：
  - `GET /conversations` 一次性返回用户最近创建的最多 100 个合集（含各合集第一页对话）以及未分组的第一页对话，并附带真实的未分组总数 `ungroupedCount` 和各合集内对话总数 `conversationCount`（如需查看超过 100 个之外的更早合集，调用 `GET /collections`）。
  - 支持按 `state` 筛选：`all`（全部，默认）、`open`（未标记收尾）、`done`（已标记收尾，即 `completedAt` 非空）、`running`（当前有对话轮次正在运行）。
  - `GET /conversations/by-collection/{id}` 是只看自己对话的工作台接口，对「合集不存在、合集是别人的、合集是空的」三种情况统一返回空列表，不报错。
- **查询对话下的视频生成进度 `GET /conversations/video-progress`**：返回所有当前还有视频（出片、局部编辑段、合成视频）正在排队或生成中的对话状态映射：`{ "conversations": { "<对话ID>": "queued" | "running" } }`。
- **自动生成标题**：当后台配置了默认的 `llm` 模型（§18）、且用户在创建对话后没有手动改过标题时，每轮对话开始时服务端会在后台自动生成标题，成功后通过 `session.meta.updated` 帧推送给前端。
- **保存工作区文件 `PUT /conversations/{id}/workspace/file`**：
  - 只有对话创建者本人可以写入（治理者调用会返回 `403`）。请求体必须带上读取文件时的版本号 `expectedVersion`，如果版本号与数据库不一致（或文件根本不存在），返回 `409`；保存成功后版本号加 1。
  - 保存 `video_shot.json` 时会校验分镜结构、参考图数量（每组 0～30 张，url 不能重复）及每组提示词长度（不超过 4000 字）；保存 `film.icml` 或 `film.icrun` 时会校验工程文件语法；`review.md` 为纯文本人工复核清单，不做格式校验。保存时都不检查文件里的地址能否打开，agent 交付镜头组表或检查工程时才查（见 [CONTEXT.md「媒体地址」](../docs/CONTEXT.md#术语)）。
- **AI 导演制作页接口 `/conversations/{id}/film`**（业务概念见 [CONTEXT.md「导演工程文件与制作页」](../docs/CONTEXT.md#术语)，设计背景见 [ADR-0002](../docs/adr/0002-director-project-files.md)）：
  - **读取制作页** `GET .../film`：如果工作区没有 `film.icml` 返回 `404`。返回两个文件的版本号（`filmVersion` / `runVersion`）、语法检查问题数 `problems`（大于 0 时 `groups` 为空，提示等待 AI 导演修复）、背景音乐提示词 `musicDescription` 以及按视频生成请求分组的 `groups[]`（包含参考图与机位图 `frames`、全局设定 `settings`、以及按台词切分的镜头段落 `shots`）。
  - **修改文案与增删参考图** `PATCH .../film/text`：校验 `filmVersion`，支持修改设定描述、镜头正文和台词文字（不能增删台词句数或调换顺序，多组共用的设定文字里不能插入图片）。如果在某组独占的镜头文字里通过 `images` 新插入了图片（用 `@Image(M+1)` 编号），后端会在写文件前检查一次新进列表的图片（口径同 `PUT .../film/image`，列表里原有的图不查），再追加到该组的参考图列表中，并自动顺延后面机位图的编号；如果删掉了某张元素图的所有引用，也会自动从列表中移除并重排编号。
  - **选用或更换图片** `PUT .../film/image`：校验 `filmVersion` 和 `runVersion`，为指定节点选用图片或取消选用（传 `url: null`，不检查地址）。选用的 `url` 不限来源，写文件前检查一次能否打开、是不是图片（规则见 [CONTEXT.md「媒体地址」](../docs/CONTEXT.md#术语)）：不行就返回 `422`，说明是哪张、什么原因，如「这张图打不开，请换一张图」（不回显地址），什么都不写。首次选用或取消选用镜头机位图时，后端会自动在 `film.icml` 的参考图列表和对应镜头开头同步增删 `参考@ImageN，`。
  - **一键修改全片画幅** `PUT .../film/aspect-ratio`：校验 `filmVersion`，将工程中所有视频节点和机位图的画幅统一改为指定比例（人物/场景设定图比例保持不变）。
  - **在制作页发起生图或出片** `POST .../film/image-generations` 与 `POST .../film/video-generations`：先检查该节点或该组视频的参考图列表是否有缺图（有缺图则返回 `422` 并列出具体缺哪几张），再按 `PUT .../film/image` 的口径检查这次要发的参考图（生图给了 `prompt` 时查它的 `referenceImageUrls`，`detail` 按「第 N 张参考图」说明是哪张），通过后创建生成任务（返回 `202` 与 `jobId`，并在 `metadata.film_node` 中记录节点名）。注意：新生成的图片不会自动替换当前选用的图片，需要用户在页面上点击选用才会写入 `film.icrun`。

### 成片草稿

业务规则见 [CONTEXT.md「成片草稿」](../docs/CONTEXT.md#术语)。草稿是一份成片文件（HTML 字符串 `html`），写法由 [composition/film.ts](../web/src/features/storyboard/whole-film/composition/film.ts) 定义：
- **读取草稿** `GET /conversations/{id}/whole-film/draft`：如果还没保存过草稿，正常返回 `{ revision: 0, html: null, updatedAt: null }`。
- **保存草稿** `PUT .../whole-film/draft`：仅对话创建者可保存，传入读取时的版本号 `revision`（首次保存传 `0`）与整份 `html`；版本冲突返回 `409`，保存成功后 `revision` 加 1。存下的是渲染服务按写法重写后的那一份（`<head>`、根上的属性和变量声明都按块重新算出），所以读回来的文本可以和提交的不一样。组件块的摆放和字体也由 `<head>` 按块的编号给出（块上不另带样式）：组件库目录里条目的 `size` 和画面不一样大时，块定成这个尺寸、居中，按 `min(画面宽 / 组件宽, 画面高 / 组件高)` 缩放；第一个字体类可填项取到组件库 `fonts` 里的字体族时（块上没填就取默认值），`--font-display` 和 `--font-body` 都设成 `'<字体族>', '<中文字体族>', sans-serif`，取到别的值不写。
- **草稿校验规则（违反返回 `422`）**：
  - 写法由渲染服务检查：根下面只能有三种块——画面块 `<video class="clip picture">`、组件块 `<div class="clip component">`、音频块 `<audio class="clip audio">`，每种块只能带写法规定的属性（不能有脚本、事件属性、注释和别的标签）；块的编号不能重复、每块不短于 100 毫秒；同一个区同一行上的块不能时间重叠（画面块和组件块在画面区，音频块在声音区，两个区的 `data-track-index` 各算各的）；画面块和组件块上的样式只能是叠放顺序（`style="z-index: N"`，N 为 0 到 9999 的整数），音频块不能带样式；隐藏的块带不写值的 `data-hidden`；组件块的 `data-composition-id` 和 `data-composition-src` 要是组件库目录里同一个条目的名字和文件，`data-variable-values` 要是一个 JSON 对象、值是字符串、数字或布尔；画面块和音频块的 `data-volume` 是 0 到 3.981072（+12 dB）的倍数，速度 `data-playback-rate` 是 0.1 到 10 的倍数（1 倍不写），淡入淡出 `data-fade-in` / `data-fade-out` 是秒数（0 不写）；画面块有声音时带 `data-has-audio="true"`，静音时换成 `muted="true"`，两个不能同时带，音频块不能带 `muted`；音频块循环时写 `loop="true"`；素材地址变量的声明要和画面块、音频块一一对应，默认值等于块上的地址；重写后还要通过渲染前的检查。
  - 素材由后端检查：画面块绑的变量 `src-<记录 id>` 指向的记录必须是本对话（或分叉继承）已完成的素材片，音频块绑的变量指向的记录必须是本对话（或分叉继承）已完成的音频记录（`kind` 为 `audio`）；块上的地址都必须等于这条记录的产物地址。
  - 服务器未配置渲染服务时保存返回 `422`，渲染服务连不上返回 `502`。

### 成片导出

业务规则见 [CONTEXT.md「成片导出」](../docs/CONTEXT.md#术语)。以下三个接口仅限对话创建者本人调用（服务器未配置渲染服务时统一返回 `422`）：
- **发起导出** `POST /conversations/{id}/whole-film/exports`：传入当前草稿版本号 `{ revision }`（与数据库最新草稿版本不一致返回 `409`，成片里还没有画面返回 `422`，渲染服务连不上返回 `502`）。受理后创建一条 `whole_film` 生成记录排入渲染队列，返回 `202 { exportId }`；记录里只存版本号和用到的素材（画面块的素材片、音频块的音频），交给渲染服务时按版本号取草稿里的成片文件，草稿这时已经不是那一版就把记录记为失败（`FILM_CHANGED`）。
- **查询最新导出进度** `GET .../whole-film/exports/latest`：返回该对话下最新一次导出的状态 `{ export: { id, status, progress, queuePosition, error, downloadUrl } }`（从未导出过则 `export` 为 `null`；`status` 取值为 `queued | rendering | uploading | done | failed | cancelled`）。
- **取消导出** `DELETE .../whole-film/exports/{exportId}`：取消排队中或正在渲染的导出任务（返回 `204`；如果刚好卡在向渲染服务提交的那一瞬间返回 `409`；如果渲染服务连不上返回 `502`）。

### 分叉

`POST /conversations/{id}:fork` 从指定对话的第 `turn` 轮分叉出一段归属于当前调用者的新对话（需具备 `agent:run` 权限且能看到源对话，**治理者也可以从已删除的对话分叉**）：
- 请求体为 `{ turn, title?, agentId?, collectionId? }`。如果源对话还有正在运行、等待审批或排队的消息，返回 `409`；如果 `turn` 超出范围或源对话从未运行过，返回 `422`。
- **复制与继承的内容**：新对话会复制源对话截至第 `turn` 轮的聊天历史和当时的工作区文件（版本号重置为 1）；不会复制源对话关联的需求单。源对话已生成的视频记录不会复制行数据，而是由新对话**按血缘只读继承**（调用 `GET /generations?conversationId=新对话ID` 时会一并列出，可直接下载或拿来剪辑，但不能对继承来的旧轮次点重新生成）。

### 做同款

`POST /conversations` 传入 `sameAs`（资料库中某张关联了对话的素材卡 ID）：
- 只要调用者拥有 `generation:read` 权限，且源对话的工作区里有 `film.icml` 或 `video_shot.json`（缺少制作文件返回 `422`），即使调用者打不开源对话或源对话已被删除，也可以创建同款新对话。
- 系统会将源对话工作区里的 `treatment.md`、`film.icrun` 按原名复制，把 `film.icml` 改名为 `old_film.icml`、把 `video_shot.json` 改名为 `old_video_shot.json` 复制到新对话中（不复制聊天历史，也不继承原视频）。
- 新对话的 `conversations.same_as` 列记下源对话 ID，接口不返回这一列；分叉不写它。

### 两处归属、收尾标记与治理者复盘

- **修改归属与标记收尾**：通过 `PUT .../task` 和 `PUT .../collection` 绑定或解绑（传 `null`）需求单与合集；通过 `PUT .../completion` 传入 `{ completed: true | false }` 手动标记或取消「已收尾」状态（当创建者继续发消息或提交视频生成时，收尾标记会自动清空）。
- **治理者全局复盘（需 `users:manage` 权限）**：
  - `GET /conversations/audit` 支持按所属用户 `ownerUserId`、需求单 `taskId`、创建时间范围 `since` / `until`（左闭右开）、状态 `state` 以及删除状态 `deleted`（`live` 仅未删、`deleted` 仅已删、`all` 全部）检索全站对话，并返回符合条件的总数 `total` 与当前正在运行数 `runningTotal`。
  - 治理者可以查看任何对话（包括已删除对话）的聊天记录、工作区文件并订阅实时流，但不能修改别人的对话。

### 附件

- 发消息时 `content` 里的图片和视频附件只接收合法的 `http://` 或 `https://` 链接（本地文件请先走 §10 直传获取链接）。
- **外部图片自动转存**：因为后续给模型生成缩略图、查宽高和裁剪都依赖本系统 OSS 的图片处理参数，如果消息里传入的图片链接不是本系统 OSS 的纯净链接（比如是外部网站链接，或者带有过期签名 Query 参数），服务端在接收消息前会自动去公网下载这张图片（仅限 80/443 端口、最多跟随 3 次重定向、30 秒超时），转存为发送者本人的一条上传记录，并把消息里的链接替换成新地址；如果下载或校验失败，整条消息直接返回 `422`。视频附件不做自动转存。

---

## 7. 合集 (Collections)

- 普通用户只能看到和操作自己的合集（访问他人合集返回 `404`）。
- 持有 `users:manage` 权限的治理者可以通过 `GET /collections?scope=all` 查看全站所有人的合集（无权限传 `scope=all` 返回 `403`），并可以重命名或删除他人的合集，但不会因此获得合集内他人对话的修改权限。

## 8. 创作需求单 (Tasks)

业务概念见 [CONTEXT.md「创作需求单」](../docs/CONTEXT.md#术语)。需求单没有个人私有所属，只要持有 `tasks:read` 权限即可查看全部需求单（无权修改时返回 `403`）：
- **创建与更新**：`POST /tasks` 支持客户端传入幂等 `id`（重发已有 ID 返回 `200`）和初始状态 `status`（`draft` 或 `published`）。`PUT /tasks/{id}` 为**整单全量覆盖**（更新时不能再传 `id` 和 `status`）。请求体中的 `inputs` 内部字段使用 `snake_case`；其中商品列表 `inputs.products`（1～20 款，款号不重复）的款号与排列顺序在创建时即锁定，后续不可增删或调换顺序。
- **状态流转与字段冻结规则**：

| 当前状态 | 允许执行的操作 | 所需权限 | 允许修改与冻结的字段 |
|---|---|---|---|
| `draft`（草稿） | `PUT` 修改、`DELETE` 删除、`POST .../publish` 下发（要求至少填了一项创作内容或参考素材，且截止时间 `deadline` 未过期） | 创建者本人或治理者（`users:manage`） | 除商品款号与排列顺序外，其余商品资料、视频规格和参考素材均可修改 |
| `published`（已下发） | `POST .../confirm` 认领（状态变为 `confirmed`）、`POST .../withdraw` 撤回（变为 `withdrawn`）、`PUT` 修改 | `tasks:write` | **冻结**商品信息以及 `video_spec` 中的 `platform`、`video_type`、`content_type`（尝试改动这些字段会返回 `409`）；标题、优先级、截止时间、时长/画幅/分辨率、创作要求与参考素材仍可修改 |
| `confirmed`（已认领） | `POST .../confirm` 追加新认领人（状态保持 `confirmed`）、`POST .../withdraw` 撤回、`PUT` 修改 | `tasks:write` | 同 `published` |
| `withdrawn`（已撤回） | **终态**，禁止任何修改、删除或再次认领（一律返回 `409`） | — | 全部冻结 |

- **关联对话自动认领**：当用户在创建对话时传入 `taskId`，或通过 `PUT /conversations/{id}/task` 将对话关联到一张处于 `published` 或 `confirmed` 状态的需求单时，系统会自动将该对话的所属用户加入需求单的认领人列表（后续解绑对话不会移除已认领记录）。

## 9. 爆款视频查询 (Inspirations)

`POST /inspirations/videos/search` 根据商品的 **PDM 款号**（`styleNos`）检索高表现参考视频：
- **三级回退寻找替身**：如果某个款号自己没有爆款视频，服务端会自动按「同款（`exact`）→ 同品牌同类目（`sameBrandCategory`）→ 同类目（`sameCategory`）→ 无匹配（`none`）」逐级放宽查找，并在返回结果的 `matches` 中逐款标明匹配到了哪一级。
- **过滤条件不影响匹配层级**：请求传入的指标下限过滤条件（`filters`）只用来筛选最终返回的视频列表；如果某款原本有自己的爆款视频，只是因为没达到过滤门槛而被筛空，它的匹配层级依然记为 `exact`，不会因此去拿替身视频凑数。

## 10. 上传 (Uploads)

客户端文件直传分两步完成（文件大小、格式与图片宽高限制见 [uploads/models.py](../server/src/iclip/domains/uploads/models.py)）：
1. **获取直传签名 `POST /uploads/sign`**：返回 `uploadId`、限时上传地址 `upload.url` 和必须原样携带的请求头 `upload.headers`（里面签入了 `Content-Type` 和审计元数据 `x-oss-meta-*`，前端 PUT 上传到 OSS 时少传或改传任何一个 Header 都会被 OSS 拒绝并返回 `403`）。
2. **确认上传完成 `POST /uploads/{uploadId}/confirm`**：服务端检查 OSS 桶内文件的真实类型和大小（文件还没传上去返回 `409`，格式或大小超限返回 `422`），通过后生成一条 `operation: "upload"` 的记录并返回永久公开地址 `{ url, contentType, sizeBytes }`（重复调用 `confirm` 幂等返回同一结果）：
   - **相同视频自动去重**：确认视频文件时，服务端会根据 OSS 对象的 MD5 查找是否已有完全相同的视频；如果以前有人传过，会直接返回最早那份视频的 `url` 并删掉刚传的重复文件，但仍会在当前用户名下记一条上传记录。
   - **上传音乐关联对话**：只有上传音频文件时，才允许在 `confirm` 请求体中传入 `conversationId`（必须是自己的未删除对话，否则返回 `404` / `403`），关联后即可在该对话的成片草稿里选作背景音乐。

---

## 11. 媒体生成 (Generations)

系统共有 7 个异步生成提交接口（受理成功后均返回 `202`），任务状态每次变化都会通过 WebSocket 推送 `event.generation.changed` 帧。10 种生成记录的完整分类见 [CONTEXT.md「生成任务」](../docs/CONTEXT.md#术语)。

| 提交接口 | 记录类型 (`kind` / `operation`) | 核心参数、校验规则与产物说明 |
|---|---|---|
| `POST /generations/video` | `video` / `generate`（出片） | 字段与上游视频异步接口保持一致（`snake_case`），额外支持传入 `conversation_id`、`task_id`、镜头组编号 `shot_index`、`metadata`，以及二选一的纯文本 `prompt` 或结构化分镜 `shot`（服务端会按固定模板拼成不超过 4000 字的 `prompt` 发给上游，参考图/视频/音频各不超过 30 个）。支持通过 `GET /generations/video/{task_id}` 按上游格式轮询状态 |
| `POST /generations/video-edits` | `video` / `generate`（局部编辑段） | 基于一条已完成的素材片（`sourceJobId`），替换其中 `[rangeStartMs, rangeEndMs]` 区间（结束时间允许超出原片最多 50 毫秒）。不传参考视频时为**图生模式**（传 1 张图作首帧、2 张作首尾帧、3 张以上作参考图）；传入 1 条本人上传的视频时为**视频编辑模式**（服务端会根据 [clip_models.py](../server/src/iclip/domains/generation/clip_models.py) 自动补齐模型所需的前缀或参数） |
| `POST /generations/video-composites` | `video` / `compose`（视频合成） | 传入基底素材片 `baseJobId` 和 1～100 段片段列表 `segments: [{ sourceJobId, start, end? }]`（每段必须取自该基底本身、或基于该基底生成的已完成编辑段）。服务端在本地用 ffmpeg 重新编码拼接（自动对齐原片的画幅与帧率），合成期间可通过 `clipStage`（`fetching | processing | uploading`）查看当前阶段 |
| `POST /generations/image` | `image` / `generate`（生图 / 帧图编辑） | 模型、画幅、分辨率和可选的渠道 `channel` 必须在 `GET /generations/image-models` 声明的范围内。如果是基于已有图片修图（帧图编辑），传入底图地址 `sourceUrl`（服务端会优先在本对话/继承图片或本人上传记录里查找并关联 `sourceJobId`，找不到则记录为外部底图地址） |
| `POST /generations/subtitles` | `subtitle` / `generate`（字幕识别） | 识别指定素材片（`sourceJobId`）原片的口播字幕（每当素材片生成完成时后台也会自动创建一条）。识别结果保存在 `sentences: [{ startMs, endMs, text, speaker, words }]` 中；如果视频没有音轨或全程无人说话，任务同样正常完成（`completed`），`sentences` 为空数组 `[]` |
| `POST /generations/music` | `audio` / `generate`（生成背景音乐） | 必须传入关联的对话 `conversationId` 和提示词 `prompt`（1～3000 字，前端默认填入制作页的 `musicDescription`）。服务端调用千问音乐模型后，会自动切除首尾静音、统一响度并转存为 m4a 文件，同时记录实测时长 `durationMs` |
| `POST /generations/video-enhancements` | `video` / `enhance`（超分高清版） | 传入 `{ sourceJobId, resolution: "720p" | "1080p", userName }`。**不限制源视频是谁生成的**，任何人都可以对素材片或已导出的成片发起超分（只允许提升到比源视频更高的分辨率档位）。同一源视频的同一档位只要已有未失败的记录，就会直接幂等返回该记录。可通过 `GET /generations/{id}/enhancements` 查询某条视频可做的超分档位与各档最新状态 |

- **通用列表查询 `GET /generations`**：支持按 `kind`、`operation`、`conversationId`（查询分叉副本时会自动包含继承来的祖先出片记录）、`taskId`、`shotIndex`、`rootJobId`（一键查出某条原始出片下的所有编辑段与合成版本）、`sourceJobId` 以及 `metadata`（JSONB 包含匹配，例如分镜页按 `{"shot":1,"frame":2}` 查格子图，制作页按 `{"film_node":"hero"}` 查节点图）筛选，使用上一页最后一条的 `id` 作为 `before` 游标向下翻页。

---

## 12. 审计报表 (Audit)

供治理者查看团队产能、一次通过率、耗时与 Token 消耗的三个只读报表接口（业务统计口径见 [CONTEXT.md「审计口径」](../docs/CONTEXT.md#术语)，**分叉出的对话副本、局部编辑段、合成视频一律不计入**）：
- **时间范围与统计锚点**：三个接口均必传起点 `since`，时间窗为左闭右开 `[since, until)`（若 `since >= until` 返回 `422`）。各项指标按各自事件发生的时刻落入时间窗（例如：出片数与片长按视频完成时刻，镜数与一次通过按该镜首条视频成功时刻，运行次数按发起时刻，交付周期按最后一条视频完成时刻，任务执行列表按对话创建时刻）。
- **团队总览 `GET /audit/overview?since&until&timezone`**：
  - 时间跨度 `n`（按所选时区计算的本地日历天数，上限 366 天）：`n ≤ 2` 按小时（`hour`）聚合，`n ≤ 120` 按天（`day`）聚合，超过 120 天按周（`week`）聚合。同时会自动计算往前平移 `n` 天的上一周期数据用于环比对比。
  - **移动均线 `ma7` / `ma30`**（按周聚合时为 `null`）：件数类指标只在按天聚合时返回，且只对有人发起过运行的「活跃日」求平均（周末或节假日无人使用不会拉低日均值）；比率和耗时类指标如果当前窗口内样本太少（活跃日不足 3 天、镜数不足 30、单任务不足 10、视频不足 30、出片不足 10），系统会自动向更早的日期补齐样本（最远往前推到 `min(上一期起点, since - 60天)`），并在均线结果中如实返回实际使用的起点 `since`。
- **按人员统计 `GET /audit/people`**：列出时间窗内有过出片或发起过运行的所有成员，按「出片件数降序 → 运行次数降序 → 用户名升序」排列，并附带每人的分期趋势 `trend[]`。
- **按任务执行明细 `GET /audit/executions`**：每一行代表一段在时间窗内创建的、有过运行或带镜号出片的正式对话（支持按创建时间 `start`、平均重试次数 `retries`、单任务时长 `cycle`、总 Token 消耗 `tokens` 排序，翻页游标与排序参数绑定）。系统会自动在异常对话上标记 4 种预警标签：`retry`（单镜成功生成 ≥ 3 次）、`stuck`（视频提交上游超过 1 小时仍未完成）、`spend`（单对话 Token 消耗超过当期平均每件出片消耗的 3 倍）、`task_stuck`（关联的需求单在当期已有 ≥ 3 段对话尝试却始终零出片）。

## 13. 资料库 (Library)

面向全站用户（需 `generation:read` 权限）开放的只读作品与素材库（定义见 [CONTEXT.md「资料库」](../docs/CONTEXT.md#术语)）：
- **成片素材 `GET /library/videos` 与详情 `GET /library/videos/{id}`**：
  - 列表按每张素材卡最新一条自有素材片的完成时间（`face.finishedAt`）倒序分页，支持按作者 `userName`、完成时间范围 `since` / `until`、横竖屏 `orientation`（`portrait | landscape`）和关键词 `q`（匹配提示词正文与对话标题）筛选。
  - 卡详情返回按镜头组排列的所有历史版本 `groups[]`（有镜号的组按镜号从小到大排在前面，无镜号的排在后面；组内按完成先后编为第 1..N 版），以及布尔值 `canMakeSame`（只要该卡关联了对话，且对话工作区里有 `film.icml` 或 `video_shot.json`，`canMakeSame` 就为 `true`，任何浏览者都可以点它做同款）。
- **成片列表 `GET /library/whole-films`**：按对话聚合展示全站已导出的完整成片（不含分叉继承），每张卡直接返回该对话下所有的导出版本 `versions[]`。
- **品牌字体模板 `/brand-templates`**（需开启媒体生成功能）：管理员通过 `/brand-templates/fonts/sign` 和 `.../confirm` 上传不超过 32 MiB 的静态 TTF/OTF 字体文件；前端通过 `GET .../{id}/font-info` 获取字体族名与包含的 Unicode 字符范围（如果渲染或预览时发现缺字或字体加载失败，必须明确报错提示，禁止悄悄回退成系统默认字体）。

## 14. 参考视频 (References)

灵感库中的外部参考视频及其拆解报告（定义见 [CONTEXT.md「参考视频」](../docs/CONTEXT.md#术语)）：
- **上传添加 `POST /references`**：传入本人已确认上传的视频 `uploadId`。如果是新视频则返回 `201` 并排入后台拆解队列；如果该视频以前已经有人传过，则直接返回已有记录（`200`）不再重复拆解；如果该视频以前被移除过，则会恢复显示并将所属人更新为本次上传者。
- **拆解状态与错误码**：`breakdownStatus` 取值为 `pending | running | completed | failed`。如果重拆失败，原有的拆解报告 `document` 会保留，并在 `errorCode` 中返回具体原因供前端展示对应提示语：
  - `video_unreadable`：视频文件无法打开或损坏，建议换一条视频。
  - `model_call_failed`：模型调用临时失败（限流、网络波动、5xx 或返回格式截断），重新点一次拆解通常可恢复。
  - `model_failed`：模型拒绝请求或等待超时。
  - `model_unavailable`：后台未启用拆解模型，需联系管理员开启。
  - `timeout`：拆解执行超过 20 分钟未结束。
- **编辑拆解、重拆与试生成**（仅创建者本人、治理者或代办 Key 可修改）：
  - `PATCH /references/{id}`：带上版本号 `version` 修改拆解 Markdown 正文（正在排队或拆解中时返回 `409`）。
  - `POST .../breakdowns`（重新拆解，成功后会覆盖人工改过的正文并自动触发重新打标）与 `POST .../tagging`（按当前拆解报告重新打标）。
  - `POST .../test-generations`：仅根据当前拆解报告的文字拼出提示词，生成一条 wan3 480p 测试视频，用来对照检验拆解报告写得全不全（拆解未完成或上一次试生成还在跑时返回 `409`；如果之后又修改了拆解报告，详情里的 `testVideo.stale` 会变为 `true` 提示已过时）。

## 15. 资料库标签 (Library Tags)

灵感库（§14）与爆款素材库（§16）共用的分类标签树（定义见 [CONTEXT.md「标签」](../docs/CONTEXT.md#术语)）：
- **获取标签树与筛选规则**：`GET /library-tags` 返回完整的维度与多级标签树，以及每个标签节点在两个库中的去重条目数量 `counts`。在列表接口使用 `tags` 参数筛选时，**同一维度下的多个标签为「或（OR）」关系（且选中父标签会自动包含其下所有子孙标签），不同维度之间为「且（AND）」关系**。
- **自动打标状态与错误码**：`tagStatus` 取值为 `null | pending | running | completed | failed`。失败时 `tagError` 取值为：`no_source_text`（没有拆解报告或没有新片执行方案 `treatment.md`）、`model_call_failed`、`model_failed`、`model_unavailable`（未启用打标模型）、`timeout`（打标超过 10 分钟）。当条目处于排队或打标中时，禁止手动修改标签或再次点击重打标（返回 `409`）。
- **管理标签树（`POST / PATCH / DELETE /library-tags`）**：
  - 顶层为维度（`parentId: null`），维度下最多支持 3 级标签值；不同维度之间不能重名，同一维度下的任意层级之间也不能重名。
  - `autoFill: "ai"` 只能设置在维度上；为了保证大模型打标质量，所有开启了 `autoFill: "ai"` 的维度下的标签值总数合计不能超过 500 个（违反任何一条均返回 `422`）。

## 16. 爆款素材 (Hit Cases)

从「成片素材」中挑选进爆款素材库的优秀单版视频（定义见 [CONTEXT.md「爆款素材」](../docs/CONTEXT.md#术语)，路径在 `/library/hit-cases` 下）：
- **检查能否入选 `GET /library/hit-cases/{jobId}`**：返回布尔值 `eligible` 及不可入选原因 `ineligibleReason`（`not_material` 不是素材片、`no_conversation` 未关联对话、`no_treatment` 所属对话的工作区里没有新片执行方案 `treatment.md`）。
- **入选、改标与移出**：调用 `PUT .../{jobId}` 入选（如果已入选则幂等返回原记录；首次入选会保存初始传入的 `tagIds` 并自动读取所属对话的 `treatment.md` 排入 AI 打标队列）。支持 `PUT .../{jobId}/tags` 修改标签、`POST .../{jobId}/tagging` 重新打标、`DELETE .../{jobId}` 移出爆款素材库。列表按入选时间倒序（`addedAt DESC, jobId DESC`）分页。

---

## 17. 技能库 (Skills)

管理后台的技能库接口（路径在 `/skills` 下，概念见 [CONTEXT.md「技能库」](../docs/CONTEXT.md#术语)）：
- **文件限制与防覆盖乐观锁**：每个技能只允许包含根目录的 `SKILL.md`（禁止删除或改名）以及 `references/` 目录下的 UTF-8 纯文本文件（单文件不超过 1 MB，总计不超过 5 MB、最多 200 个文件）。创建或修改单个文件（`PUT .../draft/files/{path}`）、删除文件（`DELETE ...?baseHash=`）和重命名文件（`POST .../draft/files/rename`）时，都必须传入读取该文件时的内容哈希 `baseHash`（新建文件时传 `null`）；如果与数据库当前哈希不一致，返回 `409` 提示先刷新。
- **修改名称与发布版本**：`PATCH /skills/{id}` 可修改显示名 `displayName` 或唯一标识 `name`（标识与其他技能重名返回 `409`，修改后立即生效、不产生新版本）。`POST /skills/{id}/versions` 在校验 `SKILL.md` 头部 frontmatter 包含非空 `description`（不超过 1024 字）后发布为不可变的新版本（如果草稿文件清单哈希与最新版完全相同，返回 `422`「没有可发布的改动」）。
- **Zip 导入与导出**：`POST /skills/import`（上传不超过 6 MB 的 zip 包，传 `dryRun=true` 只做预检并返回 `{ action, problems, ... }`，不传 `dryRun` 则正式写入草稿、不自动发布）。`GET /skills/{id}/export` 导出指定版本的 zip 包时，会自动将包内顶层目录名和 `SKILL.md` 里的 `name` 替换为该技能当前的最新标识。

## 18. 模型供应商 (Model Providers)

管理后台的模型供应商、密钥与默认模型接口（路径在 `/model-providers` 与 `/default-models` 下，概念见 [CONTEXT.md「供应商」](../docs/CONTEXT.md#术语)）：
- **敏感字段打码与按需更新**：凡是供应商声明中标记为 `secret` 的字段（如 API Key），在所有接口响应中一律只返回打码值（`••••` 加末 4 位，原长不足 8 位则只返回 `••••`）。调用 `PATCH .../credentials/{id}` 更新密钥时，只需传入要修改的字段，未传的字段会保留原值（注意：不要把打码后的 `••••` 字符串原样传回，否则会被当成新的明文密码保存）。
- **连通性测试（不保存数据，测试失败也返回 HTTP `200`，通过响应体内的 `{ ok, elapsedMs, reason }` 判断结果）**：
  - `POST .../credentials/test`：用表单里填写的密钥字段（或已有密钥 ID）对该供应商第一个启用的 `llm` 模型发一条最小测试请求（如果该供应商下还没有启用任何 `llm` 模型，返回 `422`）。
  - `POST .../models/test`：用指定密钥（不传则用默认密钥）单独测试某一个 `llm` 模型是否可用。
- **删除与停用保护（冲突返回 `409`）**：供应商的默认密钥不能直接删除（需先将默认密钥切换到另一把）；被设为全局默认模型（`PUT /default-models/{type}`）的模型不能停用或删除；正在被任何 Agent 草稿或当前版本引用的供应商、模型、密钥均不能停用或删除。

## 19. Agent 配置 (Agents)

管理后台的 Agent 配置接口（路径在 `/agents` 下，概念见 [CONTEXT.md「Agent 标识、草稿与版本」](../docs/CONTEXT.md#术语)）：
- **配置文档格式（`snake_case`）**：草稿、历史版本与 YAML 导出包中的 `config` 使用相同的结构：`schema_version: 1`、`instructions`、`model: { provider, name, credential_id?, settings: { thinking? } }`、`tools`（`type: "cap"` 代码插件或 `type: "mcp"` 远程服务）以及 `subagents`。MCP 挂载项是 `{ type: "mcp", server, tools, approval_tools? }`，对应工具的三种状态（见 [CONTEXT.md「MCP 服务」](../docs/CONTEXT.md#术语)）：在 `tools` 里是允许；同时在 `tools` 与 `approval_tools` 里是要求审批；不在 `tools` 里是关闭。新挂的服务写 `tools: []`；`tools: null` 表示全部工具（包括服务以后新加的）；`approval_tools` 必须是 `tools` 的子集（`tools` 为 `null` 时不限），为空时配置里不写出这一项。绑定的技能列表通过同级的 `skillIds` 数组按先后顺序传入。
- **乐观锁与发布编译检查**：
  - 保存草稿（`PUT /agents/{id}/draft`）、发布新版本（`POST .../versions`）和恢复历史版本（`POST .../restore`）都必须传入当前草稿的 `lockVersion`（不一致返回 `409`）。保存草稿只检查 JSON 格式，允许还没选模型等未完成状态。
  - **发布检查**：点击发布时如果配置不完整或引用的资源不可用，返回 `422 { detail, problems: [{ path, message }] }`，前端可根据 `path`（如 `model.provider`、`tools[1].server`、`skills[0]`）直接高亮对应的表单项；如果草稿与当前版本毫无差异，返回 `422`「没有可发布的改动」。
- **YAML 导出与导入**：`GET /agents/{id}/export` 将该 Agent 及其当前版本引用的所有子 Agent 打包导出为 YAML 文件（自动去掉环境相关的 `credential_id`）。`POST /agents/import` 支持先传 `dryRun=true` 预检（返回阻断性的错误 `problems` 和不阻断导入的提醒 `warnings`），正式导入时在单个事务内创建或覆盖草稿，不自动发布。
- **反向引用保护（`usedBy` 与 `409`）**：查询技能详情、模型列表、密钥列表、MCP 服务和 Agent 详情时，都会附带 `usedBy: [{ agentId, agentName, inDraft, inActiveVersion }]`，标明有哪些 Agent 的草稿或当前版本正在引用它；只要 `usedBy` 不为空，尝试归档、停用或删除该资源都会返回 `409`。

### 测试预览

供管理员在发布前试聊 Agent 草稿或指定版本的接口（概念见 [CONTEXT.md「测试预览」](../docs/CONTEXT.md#术语)）：
- **开启预览** `POST /agents/{id}/previews`：传入可选的 `{ versionId }`（不传则代表实时预览草稿），返回 `201 { id, agentId, versionId, createdAt }`。每个管理员在每个 Agent 下同时只有一段有效预览：调用该接口会先开启一段新预览会话，并自动撤回和中断该管理员在该 Agent 下的旧预览（旧预览的 `id` 随即失效，再次访问返回 `404`）。
- **复用聊天接口与严格私有**：拿到返回的预览 `id` 后，可直接当作对话 ID 调用 §5 的发消息、读聊天记录、停止、审批、WebSocket 订阅接口，以及 §6 的工作区文件只读接口，也可作为 §22 `GET /mcp-connections` 的 `conversationId`（调用其他正式对话接口均返回 `404`）。**一段预览只有创建者本人（且当前仍持有 `agent:manage` 权限）可以访问**，其他任何人（包括治理者）访问一律返回 `404`。

---

## 20. 运行时服务 (Agent Runtime)

运行时服务的接口（`/v1/*`）只供业务后端在服务端调用，不对浏览器开放。接口定义以运行时项目的 `openapi.json` 为准，应用密钥、模型调用、实时流与回调等协议见运行时项目的 `docs/protocol.md`。

### 跨版本兼容

- **读取方忽略不认识的字段**：读对方的答复、回调请求体和实时帧时，遇到不认识的字段直接忽略，不报错。
- **接口只加不改**：可以加字段，不删字段，不改字段的类型和含义。
- **新增枚举值、消息块或工具卡类型不算兼容改动**：旧后端和旧前端认不出这些新值。
- **两边的升级顺序**：
  - 运行时新增接口时，运行时先发。
  - 新增枚举值、消息块或工具卡类型时，应用先发。
  - 视频插件用到后端新增的内部接口（§21）时，后端先发。

## 21. 后端给运行时的内部接口

挂载在视频后端的 `/internal/runtime/` 路径下（不进入公开的 `openapi.json`，统一校验请求头 `Authorization: Bearer <RUNTIME_INTERNAL_TOKEN>`，令牌不对返回 `401`）：

- **接收运行时的 3 个回调**：
  - `POST .../hooks/gate`：检查会话所属用户是否存在（不存在返回 `404`）且未被停用（已停用返回 `403`）；如果是测试预览会话，还会额外检查该用户当前是否仍持有 `agent:manage` 权限（已无权限返回 `403`）。
  - `POST .../hooks/run-started`：正式对话记录最新的 `lastRunId`、清空已收尾标记，并向前端广播 `event.session.updated`（测试预览会话不做任何处理）。
  - `POST .../hooks/turn-started`：如果是正式对话且还没改过默认标题，在后台异步调用运行时的 `POST /v1/titles` 自动生成标题。
- **供视频插件调用的内部服务**（请求与响应结构定义在各插件的 `wire.py` 与 [plugin_services.py](../plugins/video/src/iclip_video/plugin_services.py) 中）：
  - `GET .../plugins/services`：返回后端当前已开启的插件支撑服务清单（`shot_video` 与 `video_breakdown`），供运行时在启动时核对。
  - `POST .../plugins/generations` 与 `GET .../plugins/generations/{job_id}`：供分镜出图插件提交和轮询图片生成任务（轮询时如果遇到后端短暂网络不通或 `502/503/504`，插件不会立刻报错，而是继续轮询直到总超时）。
  - `POST .../plugins/frame-boards`：抽取视频帧并合成时间码拼板（失败返回 `422`，附带 `code: "shots_out_of_range" | "boards_unreadable" | "boards_not_stored"`）。
  - `POST .../plugins/grid-cuts`：将生成的宫格大图切分为单张图片并存入 OSS（失败返回 `422`，附带 `code: "grid_cut_failed"`）。
  - `POST .../plugins/reference-breakdowns`：查询或排队等待某条参考视频的拆解报告。

## 22. MCP 服务 (MCP Servers)

管理后台的远程 MCP 工具服务接口（路径在 `/mcp-servers` 下，概念见 [CONTEXT.md「MCP 服务」](../docs/CONTEXT.md#术语)）：
- **唯一性与加密存储**：服务标识 `id`（格式同 Agent ID，创建后不可修改）、名称 `name` 和服务地址 `url` 均不能与已有服务重复（冲突返回 `409`）。连接方式 `transport` 必须明确指定为 `streamable_http` 或 `sse`（不支持本地子进程 `stdio`），超时时间 `timeoutSeconds` 为 1～300 秒（默认 30 秒）。`url` 和自定义请求头 `headers` 的值均使用 `CREDENTIAL_ENCRYPTION_KEYS` 加密存储：管理接口会返回完整 `url`，但所有 `headers` 的值一律只返回打码值（`PATCH` 更新时，如果不传 `url` 或某个请求头不传 `value`，会自动保留原值）。
- **测试连接与拉取工具列表**：调用 `POST /mcp-servers/{id}/check` 测试已保存的服务（测试成功后会更新服务上保存的 `lastCheck` 状态和发现的工具列表 `tools`），或调用 `POST /mcp-servers/check` 在保存前测试表单配置（不落库）。一旦修改了服务的 `url` 或 `transport`，原有的 `lastCheck` 和 `tools` 会自动清空，需重新测试连接后才能被 Agent 发布引用。使用自有账户的服务要先保存再测试：`POST /mcp-servers/check` 带 `authMode: "per_user"`（或 `serverId` 指向这样的服务而没给 `authMode`）答 `422`；`POST /mcp-servers/{id}/check` 用当前管理员自己的连接，他未连接答 `409 mcp_not_connected`，连接已失效答 `409 mcp_reconnect_required`，一时续不上答 `409 mcp_oauth_unavailable`，都不记结果，前端引导他连接后再测；测试通过时一并重读服务公布的权限范围。
- **工具命名与前端卡片展示**：挂载后暴露给大模型的工具名格式为 `mcp_<服务标识>_<原工具名>`（总长不超过 64 字符且仅含字母、数字、下划线和连字符）。在前端聊天记录的工具卡片上，标题（`display.summary`）显示为「MCP 服务名称 · 工具显示名（`title`）」，副标题（`display.detail`）自动提取本次调用参数中第一个非空字符串的首行内容。
- **使用自有账户**：`authMode: "per_user"`（界面上的「使用自有账户」开关；默认 `shared`）。`oauthScopes` 是要请求的权限范围，`null` 表示服务公布的全部；`oauthClient: { clientId, clientSecret? }` 是管理员填的客户端，给不能自动注册的服务用，它要在服务那边登记回调地址 `<前端源>/mcp/callback`：`GET /mcp-servers:callback-url`（要 `agent:manage`）答 `{ callbackUrl }`，就是连接时后端发给授权服务器的那个地址，没配 SSO 时为 `null`。`PATCH` 里这两项给 `null` 等于不改。答复里的 `oauth` 是按用户登录的现状：`client` 为 `required` 时要管理员填客户端 ID，`presetClient.clientSecret` 只返回打码值，`connectedUsers` 是已连接的人数。
- **影响已连接用户的修改（`409 mcp_connections_affected`）**：`PATCH /mcp-servers/{id}` 会断开或作废已连接用户的连接时，不带 `confirmReconnect: true` 就答 `409 { detail, code: "mcp_connections_affected", affectedUsers }`，什么都不改；向管理员确认后带上 `confirmReconnect: true` 重发。

### 用户的连接

路径在 `/mcp-connections` 下，只要登录、不要 `agent:manage`，代的总是当前登录的这个人：
- **列出** `GET /mcp-connections`：启用的、使用自有账户的服务与我在各服务上的连接，`state` 为 `connected`（已连接）、`invalid`（连接已失效）或 `none`（未连接）。不带参数列全部；带下面任一个参数时只列运行会连的服务，即这份配置与其子 Agent 当前版本挂着、且有工具放给模型的（一个工具都不放的不算；子 Agent 不放要求审批的工具），对话页据此提示「X 未连接」：
  - 已有的对话（含测试预览）给 `conversationId`：按这段对话锁定的版本算（测试预览按它跑的那份），管理员后来发布的版本不影响它。对话要是我能发消息的那段（我自己的、未删除的对话，或我自己的测试预览且我仍有 `agent:manage`），否则 `404`，能只读查看的别人的对话也是 `404`；对话没有能跑的版本答 `409 agent_unavailable`。
  - 还没建的对话给 `agentId`：按这个 Agent 的当前版本算，Agent 不存在是 `404`；再加 `draft=true` 按草稿算，要 `agent:manage`（否则 `403`）。
  - `conversationId` 与 `agentId` 或 `draft=true` 一起给答 `422`。
- **连接** `POST /mcp-connections/{serverId}/authorize`：答 `{ authorizationUrl }`，浏览器跳过去，5 分钟内有效。授权服务器回调到前端的 `/mcp/callback?state=…&code=…`（可能带 `iss`），前端把这几个参数原样交给 `POST /mcp-connections/complete`，答 `{ serverId, name, account }`，替换我在这个服务上原有的连接。回调地址由后端用 `SSO_REDIRECT_URL` 的源加 `/mcp/callback` 拼出，不取自请求；没配 SSO 时答 `409 mcp_callback_unconfigured`。
- **断开** `DELETE /mcp-connections/{serverId}`：答 `204`，本来没连也是 `204`。
- **错误码**：都是 `409`，按 `code` 区分：

| `code` | 含义 |
|---|---|
| `agent_unavailable` | 按 `conversationId` 列出时，这段对话没有能跑的 Agent 版本 |
| `mcp_callback_unconfigured` | 后端没配 SSO，拼不出回调地址 |
| `mcp_client_required` | 服务不能自动注册客户端，要管理员先填客户端 ID |
| `mcp_oauth_unsupported` | 服务没有公布 OAuth 授权服务器 |
| `mcp_oauth_unavailable` | 一时连不上服务或它的授权服务器，可以重试 |
| `mcp_oauth_rejected` | 授权服务器拒绝了 |
| `mcp_sign_in_expired` | 这次登录不存在、已用过、过期或服务设置已变，要重新连接 |
| `mcp_sign_in_foreign` | 这次登录是别人发起的 |
| `mcp_not_connected` | 测试连接时，当前管理员还没有连接这个服务 |
| `mcp_reconnect_required` | 测试连接时，当前管理员的连接已失效，要重新连接 |
