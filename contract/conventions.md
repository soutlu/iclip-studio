# 跨端接口与协议约定 (API Conventions)

> - 所有 HTTP 接口路径、权限要求与请求/响应字段定义均以 [`openapi.json`](openapi.json) 为准（生成流程见 [开发约定](../AGENTS.md)）。
> - 本文只补充 OpenAPI 无法表达的**认证细节、状态机流转、特殊错误码、工程文件格式与 WebSocket 实时流协议**。
> - 领域概念与业务规则见 [CONTEXT.md](../docs/CONTEXT.md)。运行时服务的接口以运行时项目的 `openapi.json` 为准，见本文 §20。

## 1. 部署与路由路径

- **同源反向代理**：前端代码只请求同域名的 `/api/*`（本地开发由 Vite Proxy 转发，线上由 Nginx/Ingress 将开头的 `/api` 去掉后转发给后端根路径）。禁止使用 `3xx` 跨域名重定向；登录 Cookie 不设置 `Domain`，登录与接口调用必须使用同一个主机名（不要混用 `localhost` 和 `127.0.0.1`）。
- **WebSocket 代理**：反向代理需支持 `/api/ws` 的协议升级（Upgrade）。
- **保留 `Origin` 与 `Host`**：反向代理必须对所有请求原样保留浏览器的 `Origin` 和 `Host` 请求头。后端按两者核对写请求与 WebSocket 握手的来源（规则见 §2），不能通过删掉 `Origin` 头来绕过检查。

## 2. 双主体认证 (Dual Principals)

系统同时支持「浏览器用户」和「API Key 机器调用方」，两者使用同一套权限体系：

- **浏览器登录态（`SessionCookie`）**：后端通过 HttpOnly Cookie 维护会话，前端 JS 不读写该 Cookie，也不保存 API Key。开启 `cookie_secure` 时 Cookie 名为 `__Host-iclip_session`（带 `Secure`、`Path=/`、不设 `Domain`，禁止子域名覆盖同名 Cookie，见 [ADR-0008](../docs/adr/0008-final-cut-workspace-project.md)），未开启时（HTTP 访问）名为 `iclip_session`；后端只识别当前配置对应的名称。企业 SSO 登录跳回前端时，落地页读取 URL 上的 `jwt_token`（兼容 `jwt`）调用 `GET /auth/sso/callback?jwt=...` 换取 Cookie，随后立即用 `replace` 清除地址栏票据参数。前端判断当前是否已登录，唯一以 `GET /users/me` 的结果为准（返回 `401` 即未登录）。
- **机器调用方（`BearerToken`）**：在请求头携带 `Authorization: Bearer <token>`（明文仅在创建时返回一次）。**凭证优先级**：只要请求头携带了 `Authorization: Bearer`，后端就只按 API Key 验证；若 Key 无效直接返回 `401`，绝不回退读取浏览器 Cookie（WebSocket 握手同理）。
- **请求来源检查**：`POST`、`PUT`、`PATCH`、`DELETE` 请求与 WebSocket 握手携带 `Origin` 头时，其主机和端口必须等于请求的 `Host`，或命中配置 `security.cors_allow_origins`；否则写请求在所有路由之前直接返回 `403`（`{ detail }`），WebSocket 握手以 `1008` 关闭。`Origin: null` 与同站其他子域名（含预览域名）均不放行；不带 `Origin` 的非浏览器请求（如 API Key 调用方与运行时内部回调）不受影响。
- **接口权限声明**：每个接口所需权限以 `openapi.json` 的 `security` 字段为准（数组各项之间为「或」关系，内部 scopes 为必须同时具备的权限名；空数组代表只需登录；无 `security` 代表公开接口；`POST /auth/logout` 仅限浏览器 Cookie 调用）。
- **修改用户时的防越权检查**：调用 `PATCH /users/{id}` 修改他人账号（含启停账号）时，若对方现有权限或修改后权限包含当前操作者自身没有的权限，返回 `403`；尝试修改自身权限或停用自己返回 `400`。
- **给用户选配置组**：`PUT /users/{id}/model-group` 的 `modelGroup` 传 `null` 放回默认组，改组即时生效；可选组名取自 `GET /model-providers/groups`。`UserOut.modelGroup` 为 `null` 即默认组。
- **代指定用户操作（`users:act_as`）**：持有 `users:act_as` 权限的 API Key，在调用以下 13 个写接口时传入目标用户名，即可以该用户的身份操作：新建的数据直接记在该用户名下；操作已有对话（发消息、运行控制、改工作区文件）时须填对话属主：
  - `POST /conversations`（`userName`）
  - `POST /tasks`（`userName`）
  - `POST /conversations/{id}/prompts`（`user_name`）
  - 对话运行控制（`user_name`，原本可以不带请求体的照样可以不带）：`POST /conversations/{id}:abort`、`POST /conversations/{id}/prompts/{promptId}:abort`、`POST /conversations/{id}/prompts:steer`、`POST /conversations/{id}/interactions/{interactionId}`、`POST /conversations/{id}/turns/{turnId}:regenerate`
  - `PUT /conversations/{id}/workspace/file`（`userName`）
  - `POST /generations/*`（`user_name` 或 `userName`）
  - `POST /references/videos/{id}/test-generations`（`userName`）
  - `POST /references/audios`（`userName`）
  - `POST /uploads/{uploadId}/confirm`（`userName`）
  - 注意：普通浏览器登录用户调用上述接口时，该字段只能填本人用户名，填他人返回 `422`。

## 3. 数据载荷与格式 (Payload Formatting)

- **字段命名**：常规业务接口统一使用 `camelCase`（小驼峰）。少数历史或透传接口保留 `snake_case`（前端直接按生成类型消费，新增业务接口不再使用 `snake_case`）：SSO 的 `authorization_url`、注册接口的用户状态字段、§5 的 Transcript 协议外层字段、§11 镜像上游的视频生成与查询接口、§19 Agent 的 `config` 配置文档以及 §8 需求单的 `inputs` 内部字段。
- **时间与默认排序**：所有时间均为 ISO 8601 UTC 格式。除非另有说明，列表接口默认按创建时间倒序排列（`createdAt DESC, id DESC`），游标分页（`cursor` / `nextCursor`）也按此顺序续接。
- **客户端幂等 ID**：发消息的 `prompt_id`、新建对话的 `id` 和新建需求单的 `id` 支持客户端生成以实现重试幂等；若传入 ID 与其他用户的记录冲突，服务端统一按资源不可见返回 `404`（见 [CONTEXT.md 不变量 8](../docs/CONTEXT.md#不变量)）。

## 4. 错误处理与响应信封

所有业务错误统一返回 JSON 格式：`{ "detail": "<可直接向用户或开发者展示的中文错误原因>" }`。HTTP 状态码与业务错误的对应关系固定如下：

| 内部错误类型 | HTTP 状态码 | 含义与特殊附加字段 |
|---|---|---|
| `AuthenticationFailed` | `401` | 未登录、会话已过期或 API Key 无效 |
| `PermissionDenied` | `403` | 看得见该资源，但没有操作权限（如治理者尝试修改他人对话、管理员越权修改用户） |
| `NotFound` | `404` | 资源不存在，**或者该资源属于他人、对当前用户不可见**（不对外暴露资源是否存在） |
| `Conflict` | `409` | 与当前状态冲突：如乐观锁版本号过期、状态机不允许当前操作、资源正在被引用无法删除。当对话绑定的 Agent 版本无法装配时，额外附带 `code: "agent_unavailable"`；用户所在的配置组已不在部署配置里时（发消息、媒体生成受理、`final-cut` 翻译等按他定组的接口，见 [CONTEXT.md「配置组」](../docs/CONTEXT.md#配置组model-group)），额外附带 `code: "model_group_unavailable"` |
| `ValidationFailed` | `422` | 请求参数校验不通过（格式为 `<字段路径>: <原因>`，单次返回首个错误）。发布 Agent 编译检查不通过时，额外附带字段级错误列表 `problems: [{ path, message }]` |

- **网关与下游错误**：取消成片导出时若渲染服务不可达，返回 `502`；`final-cut` 文字翻译调用模型失败（含途经的运行时不可达）返回附带 `code` 的 `502`（见[预览域名与工程接口](#final-cut-工程与预览域名)）；其余情况下 Agent 运行时服务不可达或报错时，统一返回 `503`。
- **异步任务失败**：视频、图片等生成接口返回 `202` 仅代表任务已入队；后续生成失败体现在任务记录的 `status: "failed"` 及 `errorCode` / `errorMessage` 字段中。

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

- **UUID 格式与幂等创建**：接口路径、请求体和 WebSocket 帧中的对话 ID 有无连字符（`-`）均可识别，服务端返回时统一使用带连字符的标准格式。`POST /conversations` 支持客户端传入自定义 `id`：如果是自己的已有对话，会幂等返回该对话且状态码为 `200`（首次创建为 `201`）；如果该 ID 属于他人的对话或已删除的对话，则返回 `404`。
- **创建对话时锁定 Agent 版本**：传入的 `agentId` 必须在首页可选列表 `GET /conversations/agents` 中（不存在或未上架返回 `422`，已归档或从未发布过返回 `409`）。对话创建后即固定使用该 Agent 当时的最新版本。
- **侧边栏列表与筛选**：
  - `GET /conversations` 一次性返回用户最近创建的最多 100 个合集（含各合集第一页对话）以及未分组的第一页对话，并附带真实的未分组总数 `ungroupedCount` 和各合集内对话总数 `conversationCount`（查看 100 个之外的更早合集调用 `GET /collections`）。
  - 支持按 `state` 筛选：`all`（全部，默认）、`open`（未标记收尾）、`done`（已标记收尾，即 `completedAt` 非空）、`running`（当前有对话轮次正在运行）。
  - `GET /conversations/by-collection/{id}` 是只看自己对话的工作台接口，对「合集不存在、合集属于他人、合集为空」三种情况统一返回空列表。
- **查询对话下的视频生成进度 `GET /conversations/video-progress`**：返回所有当前仍有视频（出片、局部编辑段、合成视频）排队或生成中的对话状态映射：`{ "conversations": { "<对话ID>": "queued" | "running" } }`。
- **自动生成标题**：后台配置了默认 `llm` 模型（§18）且用户未手动改过标题时，每轮对话开始时服务端在后台自动生成标题，成功后通过 `session.meta.updated` 帧推送。
- **保存工作区文件 `PUT /conversations/{id}/workspace/file`**：
  - 仅对话创建者本人可写入（治理者调用返回 `403`）。请求体须携带读取时的版本号 `expectedVersion`，版本不一致或文件不存在返回 `409`；保存成功后版本号加 1。
  - 保存 `video_shot.json` 校验分镜结构、参考图数量（每组 0～30 张，URL 不重复）及每组提示词长度（≤ 4000 字）；保存 `film.icml` 或 `film.icrun` 校验工程语法；`review.md` 为纯文本复核清单不做格式校验。保存文件时均不检查媒体地址可达性，仅在 Agent 交付分镜表或检查工程时校验（见 [CONTEXT.md「媒体地址」](../docs/CONTEXT.md#媒体地址media-address)）。
- **AI 导演制作页接口 `/conversations/{id}/film`**（业务概念见 [CONTEXT.md「导演工程文件与制作页」](../docs/CONTEXT.md#导演工程文件与制作页film-project--film-page)，背景见 [ADR-0002](../docs/adr/0002-director-project-files.md)）：
  - **读取制作页** `GET .../film`：工作区无 `film.icml` 返回 `404`；返回两文件版本号（`filmVersion` / `runVersion`）、语法问题数 `problems`（大于 0 时 `groups` 为空）、配乐描述 `musicDescription` 及分段列表 `groups[]`。
  - **修改文案与增删参考图** `PATCH .../film/text`：校验 `filmVersion`，支持修改设定描述、镜头正文与台词文字（不可增删台词句数或调换顺序，多组共用设定不可插入图片）。在独占镜头文字中通过 `images` 新插入图片（`@Image(M+1)`）时，写文件前仅校验新增图片的可达性与图片类型，再追加进参考图列表并顺延后续机位图编号；删除某元素图全部引用时自动移除并重排编号。
  - **选用或更换图片** `PUT .../film/image`：校验 `filmVersion` 与 `runVersion`，为指定节点选用图片或取消选用（`url: null`）。选用非空 `url` 前校验地址可达且为图片（不可用返回 `422` 并说明位置与原因，不回显地址）。首次选用或取消选用镜头机位图时，后端自动在 `film.icml` 参考图列表和对应镜头开头同步增删 `参考@ImageN，`。
  - **一键修改全片画幅** `PUT .../film/aspect-ratio`：校验 `filmVersion`，统一修改所有视频节点和机位图画幅（人物/场景设定图比例不变）。
  - **在制作页发起生图或出片** `POST .../film/image-generations` 与 `POST .../film/video-generations`：先校验该节点或视频组参考图列表无缺图（缺图返回 `422` 列出缺失项），再校验本次引用的参考图地址可达且为图片，通过后创建生成任务（返回 `202 { jobId }`，在 `metadata.film_node` 记录节点名）。新生成的图片不会自动替换当前选用图片，需调用 `PUT .../film/image` 写入 `film.icrun`。

### final-cut 工程格式

业务概念见 [CONTEXT.md「final-cut」](../docs/CONTEXT.md#final-cut成片与成片导出)。`final-cut` 工程存放在对话工作区 `final-cut/` 目录下，跨端格式规范由前端与 `render/` 渲染服务共享的 [composition/](../web/src/features/storyboard/final-cut/composition/film.ts) 定义（后端不校验 HTML 结构，仅在发起导出时提取主文件中的素材地址）：

1. **工程目录文件契约**：

| 工程相对路径（`final-cut/` 下） | 职责与跨端读写约束 |
|---|---|
| `index.html` | 唯一主时间线（`404` 代表尚无工程）。`<html>` 根 `data-composition-variables` 声明字幕与随语言文字的字符串变量（默认值为原文）；`<head>` 中 `<!-- final-cut:fonts -->…<!-- /final-cut:fonts -->` 之间为自动重算的字体声明块；`#film`（`data-composition-id="film"`，带 `data-no-timeline`）承载全部时间线片段及 `data-voice-modes` |
| `compositions/captions.html` | 字幕场景文件（`<template>` 包裹 `data-composition-id="captions"` 根 `<div>`，带 `data-no-timeline`）。每句字幕为一个带时间的元素，通过 `data-var-text` 读取主文件根变量；**严禁**在场景内声明 `data-composition-variables` 或在字幕宿主上设置 `data-variable-values`（否则阻断根变量透传，拒绝导出） |
| `compositions/…` | 贴片与场景按组件库目录条目 `files` 清单从 `/hyperframes/<版本>/<路径>` 拷入的专有文本文件（已存在即 `409` 跳过），拷入后归该工程独立持有 |
| `locales/<locale>.json` | 附加语言值表（仅支持 `zh / en / de / es / fr`），内容为 `{ "<变量id>": "<译文>" }` JSON 对象（非 JSON 对象则拒绝打开与导出）；仅记录已翻译项，缺省项回退主文件根变量默认值 |
| `beats/<音频路径>.json` | 配乐节拍缓存文件（路径按 `beatFilePathForSrc` 去除查询参数生成，在引擎节拍格式基础上附加 `downbeats`、`seconds`、`analysis` 算法版本）；仅供编辑器读取，预览与渲染服务忽略 |

2. **时间线元素与关键属性契约**：

| 元素类别 | 关键属性与跨端语义 |
|---|---|
| 通用片段（`#film` 直接子元素） | `data-start`、`data-duration`（秒）、`data-track-index`（所属分区行号）、`data-hidden`（隐藏/静音，预览与导出均不渲染不发声）、行内 `z-index`（画面区叠放顺序）；`data-link` 为编辑器联动标识 |
| 视频 `<video>` / 音频 `<audio>` | `src` 直写素材完整 URL；支持 `data-media-start`、`data-volume`、`data-playback-rate`、`data-fade-in`、`data-fade-out`、音频效果链 `data-fx-chain` 与自动化曲线 `data-automation`（`data-audio-group`、`data-fx-carve` 供编辑器重算智能调音）。视频有声带 `data-has-audio="true"`，静音带 `muted`；分离原声与源视频共享 `data-sync-origin`；音频循环带 `loop` |
| 配音与旁白（`<audio>`） | 携带 `data-dub-of="<字幕id>"` 即为配音片段：带 `data-locale="<locale>"` 为对应外语配音；不带 `data-locale` 为原文旁白（额外带 `data-dub-voice="<参考音频id>"` 记录克隆音色）；生成截尾时带 `data-dub-trimmed` |
| 组件宿主（贴片 / 场景） | 携带 `data-composition-id`、`data-composition-src`、`data-playback-start` 与 `data-variable-values`（JSON 对象，保存原文取值）；行内样式写入尺寸缩放与 `--font-display` / `--font-body`。随语言文字字段由 `data-locale-bindings='{"<字段id>":"<根变量id>"}'` 映射到主文件根变量 |
| 字幕宿主与单句元素 | `#film` 下 `data-track-kind="captions"` 宿主挂载 `compositions/captions.html`（整轨隐藏写宿主 `data-hidden`）。场景内单句元素带 `data-caption-of="<视频片段id>"` 标识识别归属；单句自定义样式写行内 `color`、`font-family`（须在组件库 `fonts` 中声明，否则导出报 `font-missing`）、`font-size` 及配套描边投影 |
| 画布编辑 | 视频片段与单句字幕写入所属文件（位移写 `data-x` / `data-y` 及基线 `data-hf-edit-base-x/y`，缩放写行内宽高，旋转写 `rotate` 或 `transform`）；贴片与场景作为整体编辑，变换仅写入主文件宿主的行内 `translate`（保留居中百分比并叠加像素偏移）、`scale` 与 `rotate`，不写 `data-x` / `data-y` 或宽高，也不修改组件文件 |

3. **多语言文字与人声合并规则（预览与 `render/` 导出共用）**：
   - **人声切换 `data-voice-modes`**：位于 `#film` 上，结构为 `{ "<locale>": { "mode": "dub" | "original", "voice": "<参考音频id>" | null, "lines"?: { "<字幕id>": { "voice": "<参考音频id>" | null } | { "dub": false } } } }`（缺省或格式非法均按 `original`、`voice: null` 处理）。预览与导出统一通过 [voices.ts](../web/src/features/storyboard/final-cut/composition/voices.ts) 的 `localizedVoices` 重写主文件副本：`dub` 模式仅保留当前语言配音，移除分离原声与原文旁白并将视频置为 `muted`；原文及 `original` 模式移除所有外语配音，保留原声与原文旁白。
   - **随语言文字合并**：预览或导出外语版本时，统一通过 [locale-text.ts](../web/src/features/storyboard/final-cut/composition/locale-text.ts) 的 `localizedHostValues` 将校验后的值表（缺失项取根变量默认值）合并进带 `data-locale-bindings` 宿主的 `data-variable-values`，并将值表作为渲染变量传给引擎驱动字幕显示（工作区原文件保持不变）。
4. **工作区文件同步**：新建工程文件调用 `POST .../final-cut/files`（已存在返回 `409`），更新已有文件携带 `expectedVersion` 调用 `PUT .../workspace/file`（冲突返回 `409`）；每次写入均广播 `event.fs.changed`。

### 成片导出

业务规则见 [CONTEXT.md「成片导出」](../docs/CONTEXT.md#final-cut成片与成片导出)。以下三个接口仅限对话创建者本人调用（未配置渲染服务时统一返回 `422`）：
- **发起导出** `POST /conversations/{id}/whole-film/exports`：可选请求体 `{ locale }`（仅支持 `zh / en / de / es / fr`，缺省或 `null` 表示导出原文，其余值返回 `422`）。工作区缺少 `final-cut/index.html` 或目标外语缺少 `final-cut/locales/<locale>.json` 时返回 `422`。受理后创建 `whole_film` 生成任务排入渲染队列，返回 `202 { exportId }`，并在记录中保存 `locale` 及主文件素材血缘：`<video>` 按输出地址匹配生成记录（多条命中取最早创建者，记为 `videos: [{ jobId, url }]`）；`<audio>` 依次匹配本对话（含分叉继承）生成记录、本对话（含分叉继承）上传、参考音频库未移除记录（先命中者为准，记为 `audios: [{ sourceKind: "generation" | "upload" | "reference", sourceId, url }]`），未匹配地址不记录且不阻断导出。队列执行时才读取工作区实时 `final-cut/` 全目录提交渲染服务（此时若主文件已删则记 `FINAL_CUT_EMPTY` 失败；值表缺失、格式非法或变量类型不匹配则由渲染服务拒收并记 `RENDER_REJECTED` 失败）。
- **查询最新导出进度** `GET .../whole-film/exports/latest`：返回最新一次导出状态 `{ export: { id, locale, status, progress, queuePosition, error, downloadUrl } }`（未导出过则 `export` 为 `null`；`status` 取值为 `queued | rendering | uploading | done | failed | cancelled`）。
- **取消导出** `DELETE .../whole-film/exports/{exportId}`：取消排队或渲染中的导出（返回 `204`；正处于向渲染服务提交瞬间返回 `409`；渲染服务不可达返回 `502`）。

### final-cut 工程与预览域名

由于 `final-cut` 工程允许包含不可信脚本，浏览器预览固定在独立的预览子域名（`FINAL_CUT_PREVIEW_ORIGIN`，见 [deploy.md](../docs/deploy.md#本地启动) 与 [ADR-0008](../docs/adr/0008-final-cut-workspace-project.md)）中运行；预览域名无法读取主应用的登录 Cookie，完全凭限时签名令牌拉取工程文件：
- **按主机名严格隔离**：后端在路由前按请求 `Host` 切分域名。`Host` 为预览域名时仅开放下方两个预览读取接口，其余路径（含登录）一律返回 `404` 且拒绝 WebSocket 握手；`Host` 为其他主机或后端未配置预览域名时，预览接口一律返回 `404`。
- **签发与续期预览令牌** `POST /conversations/{id}/final-cut/preview`（应用域名，登录态）：可见范围与读取工作区文件一致（治理者亦可签发，不可见返回 `404`；未配置预览域名或缺少合法 `Origin` 请求头返回 `422`；来源未放行先返回 `403`）。返回 1 小时有效的无状态签名令牌 `{ origin, token, expiresAt }`（签入对话属主、对话 ID、过期时间与请求 `Origin`，到期前不可吊销）。编辑器每 50 分钟续取新令牌更新预览文档的 `<base>`，不重载预览页。
- **预览读取接口**（预览域名，免登录 Cookie，令牌无效或过期返回 `403`）：
  - `GET /final-cut/preview/{token}/host`：返回 `{ appOrigin }`，供预览页核对自身所处域名并校验 `postMessage` 来源。
  - `GET /final-cut/preview/{token}/files/{path}`：校验规范相对路径（含空段、`.`、`..`、首尾 `/`、反斜杠、控制字符或非 NFC 形式均返回 `404`）。`vendor/` 开头返回 `307` 跳转至同主机静态资源 `/hyperframes/vendor/<其余路径>`；其余路径直接读取工作区 `final-cut/<path>`（不存在返回 `404`），`Content-Type` 按扩展名返回 `.html / .css / .js / .mjs / .json / .svg / .txt`（带 `charset=utf-8`）或 `application/octet-stream`，响应固定附带 `Cache-Control: no-store`、`X-Content-Type-Options: nosniff` 与 `Referrer-Policy: no-referrer`。
- **新建工程文件** `POST /conversations/{id}/final-cut/files`（应用域名，登录态）：请求体 `{ path, content }`（路径规则同上，不合规返回 `422`；文件已存在返回 `409`；创建成功返回 `201 { path, version }`）。仅未删除对话的创建者可调用（不可见或本人已删对话返回 `404`，非创建者或治理者访问已删对话返回 `403`）。
- **文字翻译** `POST /conversations/{id}/final-cut/translations`（应用域名，登录态）：权限同「新建工程文件」。将一批原文短句同步翻译为 `targetLocale`（`zh / en / de / es / fr`，单批条数与字数上限见 `openapi.json`，无需声明源语言，已属目标语言的词句原样保留），返回与请求等长同序的 `{ translations: [{ id, text }] }`，不落库、不写工作区、不记生成任务。错误响应均附带 `code`：未启用翻译模型返回 `409`（`model_unavailable`）；上游限流、网络异常、5xx 或输出截断返回 `502`（`model_call_failed`，可重试）；模型拒绝、超时、返回条数/ID 不匹配或译文为空返回 `502`（`model_failed`，禁止用原文顶替）。

### 分叉

`POST /conversations/{id}:fork` 从指定对话的第 `turn` 轮分叉出归属当前调用者的新对话（需 `agent:run` 权限且能看到源对话，**治理者也可从已删除对话分叉**）：
- 请求体为 `{ turn, title?, agentId?, collectionId? }`。源对话仍有运行中、待审批或排队消息时返回 `409`；`turn` 越界或源对话从未运行过返回 `422`。
- **复制与继承的内容**：新对话复制源对话截至第 `turn` 轮的聊天历史与工作区文件（版本号重置为 1），不复制关联的需求单；源对话此前已生成的视频与已挂载的上传按血缘只读继承（`GET /generations?conversationId=新对话ID` 与 `GET /conversations/新对话ID/uploads` 一并列出，不可对继承轮次点重新生成）。

### 做同款

`POST /conversations` 传入 `sameAs`（资料库中关联了对话的素材卡 ID）：
- 只要调用者拥有 `generation:read` 权限，且源对话工作区含 `film.icml` 或 `video_shot.json`（缺失返回 `422`），即使调用者无权访问源对话或源对话已删除，也可创建同款空白新对话。
- 系统将源对话工作区的 `treatment.md`、`film.icrun` 按原名复制，将 `film.icml` 改名为 `old_film.icml`、`video_shot.json` 改名为 `old_video_shot.json` 复制到新对话中（不复制聊天历史，不继承原视频）；数据库 `conversations.same_as` 列记录源对话 ID（接口不返回该列）。

### 两处归属、收尾标记与治理者复盘

- **修改归属与标记收尾**：通过 `PUT .../task` 和 `PUT .../collection` 绑定或解绑（传 `null`）需求单与合集；通过 `PUT .../completion` 传入 `{ completed: true | false }` 手动标记或取消「已收尾」状态（创建者继续发消息或提交视频生成时自动清空）。
- **治理者全局复盘（需 `users:manage` 权限）**：
  - `GET /conversations/audit` 支持按所属用户 `ownerUserId`、需求单 `taskId`、创建时间范围 `since` / `until`（左闭右开）、状态 `state` 及删除状态 `deleted`（`live | deleted | all`）检索全站对话，并返回总数 `total` 与运行中数量 `runningTotal`。
  - 治理者可查看任意对话（含已删除对话）的聊天记录、工作区文件并订阅实时流，不可修改他人对话。

### 附件

- 发消息时 `content` 里的图片和视频附件只接收合法的 `http://` 或 `https://` 链接（本地文件先走 §10 直传获取链接）。
- **外部图片自动转存**：若消息中的图片链接不是本系统 OSS 的纯净链接（如外部链接或带过期签名参数），服务端在接收消息前自动从公网下载该图片（仅限 80/443 端口、最多 3 次重定向、30 秒超时），转存为发送者本人的一条上传台账记录（宽高读取图片头）并替换消息中的链接；下载或校验失败整条消息返回 `422`。视频附件不自动转存。

---

## 7. 合集 (Collections)

- 普通用户只能查看和操作自己的合集（访问他人合集返回 `404`）。
- 持有 `users:manage` 的治理者可通过 `GET /collections?scope=all` 查看全站合集（无权限传 `scope=all` 返回 `403`），并可重命名或删除他人合集，但不会因此获得合集内他人对话的修改权限。

## 8. 创作需求单 (Tasks)

业务概念见 [CONTEXT.md「创作需求单」](../docs/CONTEXT.md#创作需求单task)。需求单无个人私有归属，持有 `tasks:read` 即可查看全部需求单（无权修改返回 `403`）：
- **创建与更新**：`POST /tasks` 支持客户端传入幂等 `id`（重发已有 ID 返回 `200`）和初始状态 `status`（`draft` 或 `published`）。`PUT /tasks/{id}` 为**整单全量覆盖**（更新时不可传 `id` 和 `status`）。请求体 `inputs` 内部字段使用 `snake_case`；商品列表 `inputs.products`（1～20 款，款号不重复）的款号与排列顺序在创建时即锁定，后续不可增删或调换顺序。
- **状态流转与字段冻结规则**：

| 当前状态 | 允许执行的操作 | 所需权限 | 允许修改与冻结的字段 |
|---|---|---|---|
| `draft`（草稿） | `PUT` 修改、`DELETE` 删除、`POST .../publish` 下发（要求至少填一项创作内容或参考素材，且 `deadline` 未过期） | 创建者本人或治理者（`users:manage`） | 除商品款号与排列顺序外，其余商品资料、视频规格和参考素材均可修改 |
| `published`（已下发） | `POST .../confirm` 认领（变为 `confirmed`）、`POST .../withdraw` 撤回（变为 `withdrawn`）、`PUT` 修改 | `tasks:write` | **冻结**商品信息及 `video_spec` 中的 `platform`、`video_type`、`content_type`（改动返回 `409`）；标题、优先级、截止时间、时长/画幅/分辨率、创作要求与参考素材仍可修改 |
| `confirmed`（已认领） | `POST .../confirm` 追加新认领人（保持 `confirmed`）、`POST .../withdraw` 撤回、`PUT` 修改 | `tasks:write` | 同 `published` |
| `withdrawn`（已撤回） | **终态**，禁止任何修改、删除或再次认领（一律返回 `409`） | — | 全部冻结 |

- **关联对话自动认领**：创建对话传入 `taskId` 或调用 `PUT /conversations/{id}/task` 关联处于 `published` / `confirmed` 的需求单时，自动将该对话所属用户加入认领人列表（后续解绑对话不移除认领记录）。

## 9. 爆款视频查询 (Inspirations)

`POST /inspirations/videos/search` 根据商品 **PDM 款号**（`styleNos`）检索高表现参考视频：
- **三级回退寻找替身**：某款无自有爆款视频时，按「同款（`exact`）→ 同品牌同类目（`sameBrandCategory`）→ 同类目（`sameCategory`）→ 无匹配（`none`）」逐级放宽查找，并在 `matches` 中逐款标明匹配层级。
- **过滤条件不影响匹配层级**：指标下限过滤条件（`filters`）仅筛选最终返回列表；若某款自有视频因未达过滤门槛被筛空，匹配层级仍记为 `exact`，不会回退拿替身视频凑数。

## 10. 上传 (Uploads)

客户端文件直传分两步完成（文件大小、格式与图片宽高限制见 [uploads/models.py](../server/src/iclip/domains/uploads/models.py)，概念见 [CONTEXT.md「上传与上传台账」](../docs/CONTEXT.md#上传与上传台账media-upload)）：
1. **获取直传签名 `POST /uploads/sign`**：返回 `uploadId`、限时上传地址 `upload.url` 和必须原样携带的请求头 `upload.headers`（签入 `Content-Type` 与审计元数据 `x-oss-meta-*`，前端 PUT 直传时少传或改传任一 Header 会被 OSS 拒绝并返回 `403`）。
2. **确认上传完成 `POST /uploads/{uploadId}/confirm`**：服务端核对 OSS 对象真实类型与大小（未上传返回 `409`，超限或格式不符返回 `422`），通过后写入上传台账（非生成任务）并返回永久公开记录（重复调用幂等返回首次记录，忽略后续请求体变更）：
   - **元数据记录**：`sizeBytes`、`contentType` 取自 OSS；图片需在确认请求体中同时传入合法的 `width` 与 `height`（越界返回 `422`）；确认阶段不测时长，`durationMs` 固定为空（台账引入前的历史记录 `contentType`、`sizeBytes` 亦为空）。
   - **视频自动去重**：视频按 OSS 对象 MD5 查重；若已有相同文件，直接复用最早那份视频的 `url` 并删除新传重复对象，但仍在当前用户名下新建一条上传记录。
   - **关联对话**：任意类型上传均可在确认时传入本人未删除对话的 `conversationId`（不可见或无权修改返回 `404` / `403`）；挂载在对话上的音频可直接供该对话 `final-cut` 选用。
3. **查询对话上传列表 `GET /conversations/{id}/uploads`**（需 `generation:read`，不可见返回 `404`）：按时间倒序返回挂载在该对话上的上传（自动包含分叉继承的祖先上传），支持按 `kind`（`image | video | audio`）筛选及 `before` 游标分页。

---

## 11. 媒体生成 (Generations)

系统提供 9 个异步生成提交接口（受理成功均返回 `202`，状态变更推送 `event.generation.changed` 帧）。12 种生成记录全景见 [CONTEXT.md「生成任务」](../docs/CONTEXT.md#生成任务generation-job)；参考视频试生成（`video` / `trial`）由 §14 `POST /references/videos/{id}/test-generations` 提交。

| 提交接口 | 记录类型 (`kind` / `operation`) | 核心参数、校验规则与产物说明 |
|---|---|---|
| `POST /generations/video` | `video` / `generate`（出片） | 字段与上游异步接口一致（`snake_case`），支持附加 `conversation_id`、`task_id`、`shot_index`、`metadata`、可选 `reference_ids`（须均为未移除的在库参考资产，否则 `422`；仅落库归因、不发上游），以及二选一的 `prompt` 或结构化 `shot`（服务端拼装为 ≤ 4000 字提示词，参考图/视频/音频各 ≤ 30 个）。`GET /generations/video/{task_id}` 支持按上游格式轮询出片、试生成与编辑段 |
| `POST /generations/video-edits` | `video` / `generate`（局部编辑段） | 基于已完成素材片（`sourceJobId`）替换 `[rangeStartMs, rangeEndMs]` 区间（结束时间允许超出原片最多 50 ms）。不传参考视频为**图生模式**（1 张首帧、2 张首尾帧、≥3 张参考图）；传入 1 条本人视频上传或未移除在库参考视频地址为**视频编辑模式**（按 [clip_models.py](../server/src/iclip/domains/generation/clip_models.py) 拼装模型参数）。不接收分辨率参数，两种模式均沿用最初出片请求的 `resolution`（未传时同样不传） |
| `POST /generations/video-composites` | `video` / `compose`（视频合成） | 传入基底素材片 `baseJobId` 与 1～100 段 `segments: [{ sourceJobId, start, end? }]`（须取自该基底本身或基于该基底完成的编辑段），本地 ffmpeg 对齐画幅帧率重编码拼接，期间通过 `clipStage`（`fetching | processing | uploading`）反馈阶段 |
| `POST /generations/image` | `image` / `generate`（生图 / 帧图编辑） | 模型、画幅、分辨率与可选 `channel` 须在 `GET /generations/image-models` 声明范围内。帧图编辑传入 `sourceUrl` 时，在本对话及继承生成图片中匹配关联 `sourceJobId`，未命中（含上传图片）记为外部底图地址 |
| `POST /generations/subtitles` | `subtitle` / `generate`（字幕识别） | 按需识别指定素材片（`sourceJobId`）口播字幕，结果存于 `sentences: [{ startMs, endMs, text, speaker, words }]`；无音轨或无人说话同样正常完成（`sentences` 为 `[]`） |
| `POST /generations/dubbings` | `dubbing` / `generate`（配音） | 为指定素材片（`sourceJobId`）合成指定外语（`locale`）配音并拼成与原片等长的 m4a 音轨（`outputUrl`），单句处理结果存于 `dubbedLines: [{ index, speed, trimmed }]`（参考源与时长规则见下；未开通语音合成返回 `422`） |
| `POST /generations/speeches` | `speech` / `generate`（合成语音 / 旁白） | 使用参考音频库中未移除的音色（`reference_audio`）朗读单段 `text`（可选指定 `locale` 与时长上限 `maxDurationMs`），产出不补静音的单段 m4a（`outputUrl`、`durationMs` 及单元素 `dubbedLines`；未开通返回 `422`） |
| `POST /generations/music` | `audio` / `generate`（生成背景音乐） | 必传 `conversationId` 与 `prompt`（1～3000 字），调用千问音乐模型后自动切除首尾静音、统一响度并转存 m4a，记录实测 `durationMs` |
| `POST /generations/video-enhancements` | `video` / `enhance`（超分高清版） | 传入 `{ sourceJobId, resolution: "720p" | "1080p", userName }`。不限源视频属主，可对任意素材片或导出成片提升至更高分辨率；同一源视频同一档位已有未失败记录时幂等复用（可通过 `GET /generations/{id}/enhancements` 查询可用档位与状态） |

- **配音与合成语音补充规则**：
  - **参考音频截取（`reference`）**：`dubbings` 支持三选一——`original`（在素材片原声中截取被说话时段 `spans`——缺省取 `lines`——覆盖最长的不超过 10 秒区间，有效说话不足 3 秒则任务失败）、`reference_audio`（在库未移除音色，取前 10 秒）、`upload`（本人音频上传，取前 10 秒）；`speeches` 仅接收 `reference_audio`（不合规均返回 `422`）。任务记录保存实际使用的参考地址与音色台词快照（台词不发给上游合成服务）。
  - **槽位对齐与超长处理**：`dubbings` 中有序不重叠的 `lines` 从各自 `startMs` 起放置，可用槽位至下一句起点或视频结尾（传入 `slotEndMs` 时以之为上限），空余区间补静音；单句合成音频超出槽位（或超出 `speeches` 的 `maxDurationMs`）时，先按不超过 `1.25x` 加速，仍放不下则截尾并做淡出（`trimmed: true`）。
- **通用列表查询 `GET /generations`**：支持按 `kind`、`operation`、`conversationId`（查询分叉副本时自动包含继承记录）、`taskId`、`shotIndex`、`rootJobId`、`sourceJobId` 及 `metadata`（JSONB 包含匹配，如 `{"shot":1,"frame":2}` 或 `{"film_node":"hero"}`）筛选，以末条 `id` 作 `before` 游标翻页。

---

## 12. 审计报表 (Audit)

供治理者查看团队产能、一次通过率、耗时与 Token 消耗的三个只读报表接口（统计口径见 [CONTEXT.md「审计口径」](../docs/CONTEXT.md#审计口径audit-metrics)，**分叉副本、局部编辑段、合成视频一律不计入**）：
- **时间范围与统计锚点**：三个接口均必传起点 `since`，时间窗为左闭右开 `[since, until)`（`since >= until` 返回 `422`）。各项指标按各自事件发生时刻落入窗口（出片数与片长按视频完成时刻，镜数与一次通过按该镜首条视频成功时刻，运行次数按发起时刻，交付周期按末条视频完成时刻，任务执行列表按对话创建时刻）。
- **团队总览 `GET /audit/overview?since&until&timezone`**：
  - 时间跨度 `n`（所选时区本地日历天数，上限 366 天）：`n ≤ 2` 按小时（`hour`）、`n ≤ 120` 按天（`day`）、超过 120 天按周（`week`）聚合，并自动附带往前平移 `n` 天的上一周期环比数据。
  - **移动均线 `ma7` / `ma30`**（按周聚合为 `null`）：件数类仅按天聚合返回，且只对有运行记录的「活跃日」求均值；比率与耗时类若当前窗口样本不足（活跃日 < 3、镜数 < 30、单任务 < 10、视频 < 30、出片 < 10），自动向前补齐样本（最远至 `min(上一期起点, since - 60天)`）并在结果中返回实际使用的 `since`。
- **按人员统计 `GET /audit/people`**：按「出片件数降序 → 运行次数降序 → 用户名升序」排列，附带每人分期趋势 `trend[]`。
- **按任务执行明细 `GET /audit/executions`**：每行对应时间窗内创建、有过运行或带镜号出片的正式对话（支持按 `start | retries | cycle | tokens` 排序，游标与排序绑定），自动标记 `retry`、`stuck`、`spend`、`task_stuck` 四类预警标签。

## 13. 资料库 (Library)

面向全站用户（需 `generation:read`）开放的只读作品与素材库（定义见 [CONTEXT.md「资料库」](../docs/CONTEXT.md#资料库library)）：
- **成片素材 `GET /library/videos` 与详情 `GET /library/videos/{id}`**：
  - 列表按素材卡最新自有素材片完成时间（`face.finishedAt`）倒序分页，支持按 `userName`、`since` / `until`、`orientation`（`portrait | landscape`）与关键词 `q` 筛选。
  - 详情返回按镜头组排列的全部版本 `groups[]`（有镜号升序在前，无镜号在后）及 `canMakeSame`（关联对话且工作区含 `film.icml` 或 `video_shot.json` 时为 `true`）。
- **成片列表 `GET /library/whole-films`**：按对话聚合展示全站已导出的完整成片（不含分叉继承），每张卡直接返回该对话下全部导出版本 `versions[]`。

## 14. 参考资产 (References)

分为参考视频与参考音频两组接口（定义见 [CONTEXT.md「参考资产」](../docs/CONTEXT.md#参考资产reference)）。读取与编删需 `generation:read`，入库需 `uploads:write`，重拆、重打标与试生成需 `generation:submit`；编辑与删除仅限属主或治理者（他人调用返回 `403`）。

### 参考视频 `/references/videos`

- **列表与筛选项**：`GET /references/videos` 支持按 `tags`、`userName`、全文关键词 `q`、创建时间 `[since, until)` 筛选及 `cursor` 分页（仅首页返回 `total`）；`GET /references/videos/filters` 返回各属主及其条数。
- **入库 `POST /references/videos`**：`uploadId`（本人视频上传）与 `sourceJobId`（调用者可见的已完成素材片）二选一必填（来源不可见或类型不符返回 `404`）。新地址返回 `201` 并排入拆解队列；已在库地址幂等返回 `200` 不重复拆解；曾被软删除的地址恢复上架并更新为本次属主与来源。
- **拆解状态与错误码**：`breakdownStatus` 为 `pending | running | completed | failed`；重拆失败保留原 `document` 并返回 `errorCode`：`video_unreadable`（文件损坏或不可读）、`model_call_failed`（限流/网络/5xx/截断，可重试）、`model_failed`（模型拒绝或超时）、`model_unavailable`（后台未启用模型）、`timeout`（超 20 分钟）。
- **编辑、重拆、试生成与移除**：
  - `PATCH /references/videos/{id}`：携带乐观锁 `version` 修改拆解正文（版本冲突或处于排队/拆解中返回 `409`）。
  - `PUT .../tags`（整份替换标签）、`POST .../breakdowns`（重新拆解，成功后覆盖正文并触发 AI 打标）、`POST .../tagging`（按当前正文重新打标）。
  - `POST .../test-generations`：按当前拆解报告生成 wan3 480p 试生成视频（`video` / `trial`，拆解未完成或上次试生成未结束返回 `409`；后续修改正文会使详情 `testVideo.stale` 变为 `true`）。
  - `DELETE /references/videos/{id}`：软删除；后续对话按同地址拆解仍复用其报告，但不恢复上架。

### 参考音频 `/references/audios`

- **列表与筛选项**：`GET /references/audios` 支持按子类 `audioKind`（`voice | bgm | sfx`）、语种 `locale`、`userName`、关键词 `q`、`[since, until)` 筛选及 `cursor` 分页；`GET /references/audios/filters` 返回各子类及属主条数。
- **入库 `POST /references/audios`**：`uploadId`（本人音频上传）与 `sourceJobId`（调用者可见的已完成背景音乐）二选一必填（不符返回 `404`），不做 URL 去重，每次新建返回 `201`。入库时服务端实测时长写入 `durationMs`：无法探测、或音色（`voice`）时长不在 3～30 秒范围内返回 `422`；仅 `voice` 允许填写台词 `transcript`（`locale` 限 `zh / en / de / es / fr`）。
- **修改与移除**：`PATCH /references/audios/{id}` 按需更新元数据（传 `null` 清空可空字段，非 `voice` 保留 `transcript` 返回 `422`）；`DELETE` 软删除不影响已生成的历史配音。

## 15. 资料库标签 (Library Tags)

灵感库（§14）与爆款素材库（§16）共用的分类标签树（定义见 [CONTEXT.md「标签」](../docs/CONTEXT.md#标签library-tag)）：
- **获取标签树与筛选规则**：`GET /library-tags` 返回完整维度与标签树及两库去重条目计数 `counts`。列表 `tags` 筛选遵循**同维度内「或（OR）」（含子孙标签）、跨维度间「且（AND）」**。
- **自动打标状态与错误码**：`tagStatus` 取值为 `null | pending | running | completed | failed`；失败 `tagError` 取值为 `no_source_text`、`model_call_failed`、`model_failed`、`model_unavailable`、`timeout`（超 10 分钟）。排队或打标进行中修改标签或重打标返回 `409`。
- **管理标签树（`POST / PATCH / DELETE /library-tags`）**：顶层为维度（`parentId: null`），其下最多 3 级标签值；维度间及同维度各层级内禁止重名；`autoFill: "ai"` 仅限设置在维度上，且全库开启 `autoFill: "ai"` 的维度下标签值总数合计不超过 500 个（违反返回 `422`）。

## 16. 爆款素材 (Hit Cases)

从「成片素材」中挑选进爆款素材库的单版视频（路径 `/library/hit-cases`）：
- **检查入选资格 `GET /library/hit-cases/{jobId}`**：返回 `eligible` 及不可入选原因 `ineligibleReason`（`not_material | no_conversation | no_treatment`）。
- **入选、改标与移出**：`PUT .../{jobId}` 幂等入选（首次入选保存初始 `tagIds` 并读取所属对话 `treatment.md` 排入 AI 打标队列）；支持 `PUT .../{jobId}/tags`、`POST .../{jobId}/tagging` 与 `DELETE .../{jobId}`。列表按 `addedAt DESC, jobId DESC` 分页。

---

## 17. 技能库 (Skills)

管理后台技能库接口（路径 `/skills`，概念见 [CONTEXT.md「技能库」](../docs/CONTEXT.md#技能库skill-library)）：
- **文件限制与防覆盖乐观锁**：每个技能仅包含根目录 `SKILL.md`（禁止删除或改名）及 `references/` 下的 UTF-8 纯文本文件（单文件 ≤ 1 MB，总计 ≤ 5 MB、最多 200 个文件）。增改（`PUT .../draft/files/{path}`）、删除（`DELETE ...?baseHash=`）和重命名（`POST .../draft/files/rename`）均须携带 `baseHash`（新建传 `null`），哈希不匹配返回 `409`。
- **修改名称与发布版本**：`PATCH /skills/{id}` 修改 `displayName` 或唯一标识 `name`（重名返回 `409`，立即生效不发新版）。`POST /skills/{id}/versions` 校验 `SKILL.md` 头部包含非空 `description`（≤ 1024 字）后发布新版本（草稿与最新版无差异返回 `422`）。
- **Zip 导入与导出**：`POST /skills/import`（≤ 6 MB，支持 `dryRun=true` 预检，正式导入仅写草稿不自动发布）；`GET /skills/{id}/export` 导出时自动将包内顶层目录名与 `SKILL.md` 的 `name` 替换为当前最新标识。

## 18. 模型供应商 (Model Providers)

管理后台模型供应商、密钥与默认模型接口（路径 `/model-providers` 与 `/default-models`，概念见 [CONTEXT.md「供应商」](../docs/CONTEXT.md#供应商model-provider)）：
- **敏感字段打码与按需更新**：声明标记为 `secret` 的字段在所有响应中只返回打码值（`••••` 加末 4 位，不足 8 位仅 `••••`）。`PATCH .../credentials/{id}` 未传字段保留原值（切勿将打码串原样传回）。
- **连通性测试（不落库，失败亦返回 HTTP `200`，通过 `{ ok, elapsedMs, reason }` 判断）**：`POST .../credentials/test` 对该供应商首个已启用 `llm` 模型发最小请求（无启用 `llm` 模型返回 `422`）；`POST .../models/test` 测试指定 `llm` 模型。
- **密钥的配置组**：密钥携带 `modelGroup`（`null` 表示不归组，概念见 [CONTEXT.md「配置组」](../docs/CONTEXT.md#配置组model-group)）。`GET /model-providers/groups` 按部署配置顺序返回可选组名 `{ groups }`。`PATCH .../credentials/{id}` 不传 `modelGroup` 保持不变，传 `null` 清空，传组名改组；组名不在部署配置内或同一供应商下该组已有其他密钥均返回 `422`。
- **删除与停用保护（冲突返回 `409`）**：默认密钥须先切换默认后才能删除；全局默认模型（`PUT /default-models/{type}`）及正被任一 Agent 草稿或当前版本引用的供应商、模型、密钥均禁止停用或删除。

## 19. Agent 配置 (Agents)

管理后台 Agent 配置接口（路径 `/agents`，概念见 [CONTEXT.md「Agent 标识、草稿与版本」](../docs/CONTEXT.md#agent-标识草稿与版本agent-config)）：
- **配置文档格式（`snake_case`）**：草稿、历史版本与 YAML 导出包共用结构：`schema_version: 1`、`instructions`、`model: { provider, name, credential_id?, settings: { thinking? } }`、`tools`（`type: "cap"` 插件或 `type: "mcp"` 远程服务）及 `subagents`；有序技能列表通过同级 `skillIds` 传入。MCP 挂载项 `{ type: "mcp", server, tools, approval_tools? }` 表达工具三态（见 [CONTEXT.md「MCP 服务」](../docs/CONTEXT.md#mcp-服务mcp-server)）：在 `tools` 内为允许，同时在 `approval_tools`（须为 `tools` 子集，为空省略）内为要求审批，不在 `tools` 内为关闭；新挂载写 `tools: []`，历史 `tools: null` 代表包含后续新增工具在内的全部工具。
- **乐观锁与发布编译检查**：保存草稿（`PUT /agents/{id}/draft`）、发布版本（`POST .../versions`）和恢复版本（`POST .../restore`）均须传入 `lockVersion`（不一致返回 `409`）。发布编译不通过返回 `422 { detail, problems: [{ path, message }] }`，无改动返回 `422`。
- **YAML 导出与导入**：`GET /agents/{id}/export` 打包主 Agent 及其当前版本引用的子 Agent（剔除 `credential_id`）；`POST /agents/import` 支持 `dryRun=true` 预检，正式导入在单事务内创建或覆盖草稿，不自动发布。
- **反向引用保护（`usedBy` 与 `409`）**：技能、模型、密钥、MCP 服务和 Agent 详情均附带 `usedBy: [{ agentId, agentName, inDraft, inActiveVersion }]`；`usedBy` 非空时归档、停用或删除均返回 `409`。

### 测试预览

供管理员试聊草稿或指定版本的接口（概念见 [CONTEXT.md「测试预览」](../docs/CONTEXT.md#测试预览agent-preview)）：
- **开启预览** `POST /agents/{id}/previews`：可选传入 `{ versionId }`（缺省为实时预览草稿），返回 `201 { id, agentId, versionId, createdAt }`，同时自动撤回并中断该管理员在该 Agent 下的旧预览（旧 `id` 随即失效返回 `404`）。
- **复用聊天接口与严格私有**：返回的预览 `id` 可直接调用 §5 发消息/读记录/停止/审批/WebSocket 订阅、§6 工作区文件只读接口，以及作为 §22 `GET /mcp-connections` 的 `conversationId`（调用其他正式对话接口返回 `404`）。仅创建者本人（且仍持 `agent:manage`）可访问，其他任何人（含治理者）访问一律返回 `404`。

---

## 20. 运行时服务 (Agent Runtime)

运行时服务接口（`/v1/*`）仅供业务后端在服务端调用，不对浏览器开放。接口定义以运行时项目的 `openapi.json` 为准，鉴权、模型调用、实时流与回调协议见运行时项目的 `docs/protocol.md`。

### 配置组

后端在以下三处向运行时透传按 [CONTEXT.md「配置组」](../docs/CONTEXT.md#配置组model-group) 算出的 `model_group`（默认组传 `null` 或省略；视频插件在运行期内直接读取 `AgentRunDeps.model_group`）：
- **发消息** `POST /v1/sessions/{id}/prompts`：传对话属主（测试预览为预览创建者）的配置组；重新生成不传，由运行时沿用原消息的组。
- **起标题** `POST /v1/titles`：传对话属主的配置组。
- **模型调用** `POST /v1/model-calls/responses`：`final-cut` 翻译传对话属主的组，参考视频拆解传触发人（`reference_videos.requested_by`）的组，资料库打标传条目创建人（`library_entries.created_by`）的组；记录人为空时不传。

### 跨版本兼容

- **读取方忽略未知字段**：解析对方的响应、回调请求体与实时帧时，遇到未知字段直接忽略。
- **接口只增不改**：允许新增字段，禁止删除字段或改变已有字段的类型与语义。
- **新增枚举值、消息块或工具卡类型属于非兼容变更**：旧后端与旧前端无法识别新值。
- **跨端升级顺序**：运行时新增接口时**先升级运行时**（`--runtime-first`）；新增枚举值、消息块或工具卡类型时**先升级应用**（`--app-first`）；视频插件依赖后端新增内部接口（§21）时**先升级后端**（`--app-first`）。括号里是两边一起升级时 [`upgrade.sh all`](../docs/deploy.md#两边一起升级) 的顺序参数。

## 21. 后端给运行时的内部接口

挂载在视频后端 `/internal/runtime/` 下（不进入公开 `openapi.json`，统一校验 `Authorization: Bearer <RUNTIME_INTERNAL_TOKEN>`，不符返回 `401`）：

- **接收运行时的 3 个生命周期回调**：
  - `POST .../hooks/gate`：校验会话所属用户存在（否则 `404`）且未停用（否则 `403`）；测试预览会话额外校验用户仍持有 `agent:manage`（否则 `403`）。
  - `POST .../hooks/run-started`：正式对话更新 `lastRunId`、清空已收尾标记并广播 `event.session.updated`（测试预览跳过）。
  - `POST .../hooks/turn-started`：正式对话尚未改过默认标题时，后台异步调用运行时 `POST /v1/titles` 生成标题。
- **供视频插件调用的内部服务**（结构定义见各插件 `wire.py` 与 [plugin_services.py](../plugins/video/src/iclip_video/plugin_services.py)）：
  - `GET .../plugins/services`：返回已开启的插件支撑服务清单（`shot_video` 与 `video_breakdown`），供运行时启动期核对。
  - `POST .../plugins/generations` 与 `GET .../plugins/generations/{job_id}`：提交与轮询图片生成任务（轮询遇到短暂网络异常或 `502/503/504` 时持续轮询直至总超时）。
  - `POST .../plugins/frame-boards`：视频抽帧合成时间码拼板（失败返回 `422`，附 `code: "shots_out_of_range" | "boards_unreadable" | "boards_not_stored"`）。
  - `POST .../plugins/grid-cuts`：宫格大图切分并存入 OSS（失败返回 `422`，附 `code: "grid_cut_failed"`）。
  - `POST .../plugins/reference-breakdowns`：查询或排队等待参考视频拆解报告。

## 22. MCP 服务 (MCP Servers)

管理后台远程 MCP 工具服务接口（路径 `/mcp-servers`，概念见 [CONTEXT.md「MCP 服务」](../docs/CONTEXT.md#mcp-服务mcp-server)）：
- **唯一性与加密存储**：服务标识 `id`（格式同 Agent ID，不可改）、`name` 和 `url` 全局唯一（冲突返回 `409`）；`transport` 仅支持 `streamable_http` 或 `sse`，`timeoutSeconds` 为 1～300 秒（默认 30 秒）。`url` 与 `headers` 值均经 `CREDENTIAL_ENCRYPTION_KEYS` 加密存储：管理接口返回完整 `url`，`headers` 值一律打码返回（`PATCH` 未传项保留原值）。
- **测试连接与发现工具**：调用 `POST /mcp-servers/{id}/check` 测试已存服务并更新 `lastCheck` 与工具列表 `tools`（修改 `url` 或 `transport` 会清空这两项，须重测通过后方能被 Agent 发布引用），或调用 `POST /mcp-servers/check` 在保存前测试共享连接表单。开启「使用自有账户」（`authMode: "per_user"`）的服务不支持保存前表单测试（返回 `422`），保存后调用 `POST /mcp-servers/{id}/check` 使用当前管理员本人的连接测试（未连接、已失效或续期暂不可用均返回对应 `409` 错误码，不更新检查记录；测试成功同步刷新服务公布的权限范围）。
- **工具命名与前端卡片展示**：暴露给模型的工具名为 `mcp_<服务标识>_<原工具名>`（≤ 64 字符）。前端工具卡片标题（`display.summary`）显示为「MCP 服务名称 · 工具显示名（`title`）」，副标题（`display.detail`）取首个非空字符串参数的首行。
- **使用自有账户配置**：`authMode` 取 `shared`（默认）或 `per_user`。`oauthScopes` 指定请求权限范围（`null` 表示服务公布的全部）；不支持动态客户端注册的服务由管理员填写 `oauthClient: { clientId, clientSecret? }`（密钥打码返回），并在外部授权服务器登记回调地址 `<前端源>/mcp/callback`（可通过 `GET /mcp-servers:callback-url` 查询，未配 SSO 时为 `null`）。`PATCH` 若会断开或作废已有用户连接，未带 `confirmReconnect: true` 时返回 `409 { detail, code: "mcp_connections_affected", affectedUsers }`，经管理员确认后重发生效。

### 用户的连接

路径在 `/mcp-connections` 下（仅需登录，无需 `agent:manage`，始终操作当前登录用户本人）：
- **查询连接状态** `GET /mcp-connections`：返回已启用的 `per_user` 服务及当前用户的连接状态 `state`（`connected | invalid | none`）。不传参数返回全部；传入以下任一参数（互斥，混传返回 `422`）时，仅返回该目标及其子 Agent 当前版本实际向模型暴露了工具的服务（全关或子 Agent 仅含审批工具的不计）：
  - `conversationId`：按已有对话（或本人仍具 `agent:manage` 的测试预览）锁定的版本计算；仅限本人可发消息的未删除对话，他人只读对话亦返回 `404`；版本无法装配返回 `409 agent_unavailable`。
  - `agentId`（可选配 `draft=true`，需 `agent:manage`，否则 `403`）：按该 Agent 当前版本或草稿计算（不存在返回 `404`）。
- **发起与完成授权**：`POST /mcp-connections/{serverId}/authorize` 返回 5 分钟有效的 `{ authorizationUrl }`（回调地址固定由后端按 `SSO_REDIRECT_URL` 源拼出 `/mcp/callback`）；授权服务器回调前端 `/mcp/callback` 后，前端将 `state`、`code`（及可选 `iss`）原样提交 `POST /mcp-connections/complete`，返回 `{ serverId, name, account }` 并覆盖旧连接。
- **断开连接** `DELETE /mcp-connections/{serverId}`：幂等返回 `204`。
- **OAuth 与连接错误码（HTTP `409`，按 `code` 区分）**：

| `code` | 含义 |
|---|---|
| `agent_unavailable` | 按 `conversationId` 查询时，该对话绑定的 Agent 版本无法装配 |
| `mcp_callback_unconfigured` | 后端未配置 SSO，无法拼出回调地址 |
| `mcp_client_required` | 服务不支持动态客户端注册，需管理员先配置客户端 ID |
| `mcp_oauth_unsupported` | 服务未公布 OAuth 授权服务器元数据 |
| `mcp_oauth_unavailable` | 服务或其授权服务器暂时不可达，可重试 |
| `mcp_oauth_rejected` | 授权服务器拒绝了本次请求 |
| `mcp_sign_in_expired` | 本次登录状态不存在、已使用、已过期或期间服务配置已变更，需重新发起 |
| `mcp_sign_in_foreign` | 本次登录并非当前登录用户发起 |
| `mcp_not_connected` / `mcp_reconnect_required` | 管理员测试 `per_user` 服务连接时，本人尚未连接或连接已失效 |
