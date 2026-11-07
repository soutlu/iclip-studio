# 系统架构

> 本文说明 Agent 运行时服务、视频插件包、视频业务后端与成片渲染服务的职责分工、代码分层与核心运行机制。
> - 业务概念与不变量见 [CONTEXT.md](CONTEXT.md)
> - 接口与跨端协议见 [contract/conventions.md](../contract/conventions.md)
> - 新业务系统接入运行时见[新应用接入运行时](runtime-apps.md)
> - 开发命令与门禁见 [AGENTS.md](../AGENTS.md)

## 1. 两个服务

系统由四个运行时组件构成，核心是**视频后端**与**Agent 运行时服务**的分离：

| 组件 | 所在目录与包名 | 核心职责与数据归属 |
|---|---|---|
| **运行时服务**（端口 `7790`） | [runtime/](../runtime/pyproject.toml)（`agent_runtime`） | 负责所有跟 Agent 相关的事：管理配置（技能库、模型供应商、MCP 服务、Agent 版本）、维护会话与消息队列、驱动大模型运行、推送聊天流（Transcript）、读写工作区文件、统计 Token 用量。数据存于 `agent_runtime` schema |
| **视频插件包**（装入运行时镜像） | [plugins/video/](../plugins/video/pyproject.toml)（`iclip_video`） | 为 Agent 提供视频领域的专属工具集（如视频理解、视频拆解、生成分镜图、校验工程文件）。需要调用视频后端能力时，通过 HTTP 调用后端的内部接口 |
| **视频后端**（端口 `7788`） | [server/](../server/pyproject.toml)（`iclip`） | 浏览器唯一访问的入口（BFF）：负责用户登录与权限校验、管理业务侧的对话列表、处理视频生成/参考视频拆解/资料库/成片草稿等业务逻辑。数据存于 `iclip` schema |
| **成片渲染服务**（内网 `8080`） | [render/](../render/package.json)（Node.js） | 接收成片草稿，在无头浏览器中通过 HyperFrames 合成视频、特效、音乐与字幕，渲染成 MP4 并上传到对象存储 |

**依赖方向与隔离原则：**
- **单向代码依赖**：`视频后端` 依赖 `视频插件包` 和 `运行时`（主要是复用类型定义与客户端库）；`视频插件包` 只依赖 `运行时`；`运行时` 不依赖任何业务包。
- **同库不同 Schema**：后端和运行时连接同一个 PostgreSQL 数据库，但严格按 Schema 隔离（后端用 `iclip`，运行时用 `agent_runtime`）。两个 Schema 之间不建数据库外键，代码里也绝不跨 Schema 读写对方的表（由两边的架构测试强制检查）。所有数据库表结构的变更统一由后端的 Alembic 迁移脚本管理（见[后端的持久化与迁移](#后端的持久化与迁移)）。
- **单进程运行限制**：目前后端和运行时都采用单进程（单 Worker）模式部署，因为实时消息流投影、事件广播和 WebSocket 连接池都维护在进程内存中。若未来扩展为多实例部署，需先引入跨实例连接路由。

**视频后端与运行时之间的 4 条通信通道：**
1. **应用接口 `/v1`**：视频后端作为应用 `video`，通过 Python [客户端库](#客户端库)调用运行时，完成创建会话、发消息、读聊天记录、读写工作区文件、拉取首页可用 Agent 列表、自动起标题和拉取统计数据（详见[运行时的接口](#运行时的接口)与[调运行时](#调运行时)）。
2. **管理接口 `/v1/admin`**：对应管理后台的「技能库、模型供应商、MCP 服务、Agent 配置」四组接口，由视频后端先做权限校验和参数检查，再原样转发给运行时处理。
3. **生命周期回调与内部接口 `/internal/runtime/`**：运行时在「开跑前检查、运行开始、对话轮次开始」三个时机回调视频后端；同时视频插件在执行抽帧、生图、拆解时也会调用后端的这套内部接口（统一使用环境变量 `RUNTIME_INTERNAL_TOKEN` 鉴权，详见[内部接口与视频插件包](#内部接口与视频插件包)）。
4. **两条 WebSocket 实时流**：运行时提供「应用事件流 `/v1/events`」（推送所有会话的忙闲变化）和「对话内容流 `/v1/ws`」（推送某段对话的打字机输出与文件变更），视频后端接收后转发给前端浏览器的 `/ws` 连接（详见[浏览器连接与事件流](#浏览器连接与事件流)）。

---

## 2. 运行时服务

### 运行时的模块

Agent 引擎基于 PydanticAI 与 Pydantic AI Harness 构建。以下目录均位于 `runtime/src/agent_runtime/` 下（模块间的导入边界由 [runtime/tach.toml](../runtime/tach.toml) 和[架构测试](../runtime/tests/unit/architecture/test_architecture.py)检查）：

| 目录 / 文件 | 职责说明 |
|---|---|
| `harness/` | 底层引擎：负责通用 Agent 装配、消息队列调度、运行历史持久化、上下文压缩和 Transcript 转换，完全不感知业务层的用户与权限规则 |
| `transcript/` | 定义前端渲染聊天记录所需的树状结构（Turn / Step / Block）、工具卡片展示格式和 WebSocket 帧结构 |
| `plugins/` | 定义插件接入接口（`PluginFactory`）、插件注册表类型，以及内置的 `workspace`（工作区文件读写）插件 |
| `config/` | 管理后台四大配置模块（技能库、模型供应商、MCP 服务、Agent 配置）的业务逻辑与数据库读写 |
| `assembly/` | 装配层：把数据库里的配置转化成可运行的 Agent 实例、构建大模型连接、执行连通性测试 |
| `service/` | 面向接入应用的服务层：封装创建会话、对话分叉、跨会话复制文件等高层操作 |
| `http/` | FastAPI 路由与 WebSocket 入口（Web 框架代码只出现在这一层） |
| `live/` 与 `hooks.py` | 定义实时推送帧、按应用分发事件的集线器（`AppEventHub`），以及回调业务后端的 HTTP 客户端 |
| `client/` | 提供给业务后端直接调用的 Python 客户端库（见[客户端库](#客户端库)） |
| `file_store/` | 工作区文件的数据库存储实现 |
| `outbound/` | 运行时自己的出网层（[outbound/](../runtime/src/agent_runtime/outbound/__init__.py)），基于 `httpx-secure` 提供只连公网的 HTTP 客户端与地址探测：只连公网地址的 80 / 443 端口，跳转后的新连接同样检查，不带用户名密码、不走代理；地址里带用户名密码、或端口不是 80 / 443 时在发请求前就拒绝，不去连接。插件在提交点做的地址检查（[harness/media_check.py](../runtime/src/agent_runtime/harness/media_check.py)）通过它发起 |
| `secrets.py` 与 `run_deps.py` | 敏感字段（API Key、MCP 请求头等）的 MultiFernet 加密与打码工具、运行上下文 `AgentRunDeps` |

**启动与插件加载流程：**
- 启动命令为 `python -m agent_runtime.main --config <yaml>`。生产环境的 Docker 镜像（[runtime/Dockerfile](../runtime/Dockerfile)）安装的是组合包 [deploy/runtime-video](../deploy/runtime-video/pyproject.toml)，它把 `runtime` 和 `plugins/video` 打包在了一起。
- 启动配置文件（[settings.py](../runtime/src/agent_runtime/settings.py)）声明了允许接入的应用列表（`apps`）以及要加载的插件包入口（`plugins.factory`）。
- 服务启动（[http/asgi.py](../runtime/src/agent_runtime/http/asgi.py)）时，会先初始化插件包（建立与后端的客户端连接并做启动前自检），然后再用插件包返回的注册表构建完整的运行时应用（[http/app.py](../runtime/src/agent_runtime/http/app.py)）。仅 `import` 模块时不会连接数据库，方便直接导出 OpenAPI 合同。

### 运行时的接口

运行时所有 HTTP 接口都在 `/v1` 路径下，完整定义见 [contract/runtime-openapi.json](../contract/runtime-openapi.json)，跨服务调用协议见 [conventions §20](../contract/conventions.md#20-运行时服务-agent-runtime)：

- **会话与聊天接口**（`/v1/sessions…`、`/v1/agents`、`/v1/titles`）：供业务后端创建或分叉会话、发送消息、中止运行、插队、重新生成、提交审批、拉取聊天记录（Transcript）、读写工作区文件、获取首页 Agent 列表以及生成对话标题。
- **后台管理接口**（`/v1/admin`）：供业务后端转发技能库、模型供应商、MCP 服务与 Agent 配置的增删改查请求。
- **统计数据接口**（`/v1/stats`）：只读接口，按调用方应用过滤并返回会话、运行和 Token 消耗的原始记录行，由业务后端自行做报表聚合。
- **固定模型代理接口**（`/v1/model-calls/responses`，[http/model_calls.py](../runtime/src/agent_runtime/http/model_calls.py)）：供业务后端调用代码中固定指定的模型（如火山方舟拆解与打标模型）。运行时根据传入的供应商声明名和模型名，在数据库里找出已启用且配好默认密钥的供应商，自动带上 API Key 转发给上游的 `/responses` 接口并原样返回结果（超时上限 900 秒，密钥始终保留在运行时内部，且日志自动脱敏）。

### 实时通道与回调

运行时通过两条 WebSocket 流和三个 HTTP 回调与业务后端保持实时同步（协议见 [conventions §20](../contract/conventions.md#20-运行时服务-agent-runtime)）：

- **应用事件流 `/v1/events`**：当任何会话的运行状态发生变化（如开始运行、进入等待审批、运行结束）时，任务队列会在数据库事务提交后通知 `AppEventHub`（[live/hub.py](../runtime/src/agent_runtime/live/hub.py)）。集线器查出该会话归属哪个业务应用，按顺序推送给该应用的事件流连接。
- **对话内容流 `/v1/ws`**：业务后端按会话订阅后，实时推送大模型的流式输出（Transcript 操作帧）以及工作区文件变更通知（由 [file_store/announcing.py](../runtime/src/agent_runtime/file_store/announcing.py) 在文件写入成功后触发推送）。
- **三个生命周期回调**（[hooks.py](../runtime/src/agent_runtime/hooks.py)）：
  1. **开跑前检查（`gate`）**：在每次调用大模型前触发。如果业务后端一时连不上或返回 `502/503/504`，运行时会在约 30 秒窗口内自动退避重试（期间照常维持任务心跳锁）；如果后端明确返回非 2xx 拒绝（如用户已被停用），则直接将该轮消息标为失败。
  2. **运行开始（`run_started`）**：在拿到运行锁后、发出第一条消息事件前同步调用，用于通知业务后端更新对话状态。
  3. **轮次开始（`turn_started`）**：在新一轮用户消息首次开跑时在后台异步调用（不阻塞模型执行），业务后端收到后会为新对话触发自动生成标题。

### 客户端库

Python 业务后端统一使用运行时提供的客户端库 [agent_runtime/client/](../runtime/src/agent_runtime/client/__init__.py)（`RuntimeClient`）与运行时通信：
- **自动还原业务异常**：针对 `/v1` 下的会话接口，客户端提供了带类型注解的方法，并会自动把运行时返回的 `404 / 409 / 422` 状态码还原成对应的领域异常（例如将 `409 agent_unavailable` 还原为 `AgentUnavailable` 异常）；如果遇到网络断开、超时或 5xx 错误，则统一抛出 `RuntimeUnavailable`，由业务后端向前端返回 `503` 服务不可用。
- **管理接口透传（`admin_request`）**：将管理后台请求原样转发到 `/v1/admin/…` 并原样返回响应。
- **WebSocket 自动心跳与前向兼容**：封装了 `connect_transcript` 和 `connect_events`，内部自动回复服务端心跳；对于未识别的新帧类型或新增字段直接原样透传，保证运行时先行升级时不会导致后端断连。

### 对话固定版本与每次运行装配

所有的模型、技能、MCP 和 Agent 配置都存储在数据库中，运行时不会在启动时预先加载，而是在每次对话运行时按需动态装配：

1. **会话锁定 Agent 版本**：创建对话时，`SessionService`（[service/sessions.py](../runtime/src/agent_runtime/service/sessions.py)）检查所选 Agent 是否在首页公开、启用且已发布，并将该 Agent 当时的最新版本 ID 记录在 `agent_runtime.sessions` 表中。后续该会话的所有运行都固定使用这个版本。
2. **运行前动态编译与 LRU 缓存（[assembly/agents.py](../runtime/src/agent_runtime/assembly/agents.py)）**：
   - 用户发消息时以及后台准备开跑前，系统都会调用 `AgentRuntime` 读取会话锁定的版本并执行检查（`compile_agent`）。如果该版本依赖的模型已被停用、密钥已被删或插件已不存在，直接抛出 `AgentUnavailable`（发消息阶段直接返回 `409` 报错；若排队期间配置失效则在开跑时将消息标为失败）。
   - **进程内缓存**：为了避免每条消息都重复构建对象，装配好的 Agent 实例会缓存在进程的 LRU 缓存中（大小由 `agent_runs.assembly_cache_size` 控制）。缓存 Key 包含了「Agent 版本 ID + 供应商与密钥更新时间 + 模型参数 + 思考档位 + MCP 服务更新时间与工具列表 + 各绑定技能最新版的 `name:content_hash` + 各子 Agent 的版本与描述」。一旦管理员在后台更新了密钥、发布了新技能或修改了子 Agent 描述，缓存 Key 就会自然变化，下一次运行立即用上最新配置，无需手动清理缓存或重启服务。
3. **测试预览的装配**：测试预览会话在创建时不限制 Agent 是否已上架或已发布。如果预览的是草稿（未传 `version_id`），每次发消息都会按草稿当前的 `lock_version` 实时装配，改完草稿保存后下一条消息立刻生效。
4. **技能文件本地落盘缓存**：由于底层引擎需要从磁盘路径读取技能文件，系统会将每个技能最新版本的文件写入本地缓存目录 `<skill_cache_dir>/<sha256(内容哈希+当前标识)>/<当前标识>/`（写入时自动将 `SKILL.md` 里的 `name` 替换为当前技能标识，并通过临时目录原子改名防止并发冲突）。

### 工具、插件与 MCP 服务

Agent 可用的工具来自两部分：**代码内置插件**和**管理员登记的远程 MCP 服务**。所有插件、MCP 工具和技能都必须按 Agent 显式挂载，子 Agent 不会自动继承主 Agent 的挂载（工具编写规范见 [tool-design.md](tool-design.md)）。

- **代码插件机制（[plugins/base.py](../runtime/src/agent_runtime/plugins/base.py)）**：每个插件都是一个继承自 PydanticAI `Capability` 的类。服务启动时，组合根通过 `PluginCls.bind(...)` 将插件需要用到的外部客户端绑定到动态生成的子类属性上（这样既不用放进序列化配置，也不用塞进运行上下文 `deps`）。需要把多个能力打包成一个插件（例如 `video_breakdown` 同时包含拆解工具和后台异步执行能力 `BackgroundTools`）时，使用 `CombinedCapability`。
- **MCP 服务接入（`config/mcp_servers/`，[conventions §22](../contract/conventions.md#22-mcp-服务-mcp-servers)）**：由 [assembly/mcp.py](../runtime/src/agent_runtime/assembly/mcp.py) 调用底层 [harness/mcp.py](../runtime/src/agent_runtime/harness/mcp.py) 的 `MCPToolset`，支持通过 Streamable HTTP 或 SSE 直连远程 MCP 服务，并为暴露给模型的工具自动加上 `mcp_<服务标识>_` 前缀。同时进程内维护了一份内存名册（`McpServerIndex`），供前端工具卡片展示对应的服务名称与工具中文名。
- **通用校验下沉**：凡是与具体 Agent 无关的安全校验（如媒体地址的形状检查与提交点的「链接能打开、类型对」检查 [harness/materials.py](../runtime/src/agent_runtime/harness/materials.py) 与 [harness/media_check.py](../runtime/src/agent_runtime/harness/media_check.py)，后者每次检查自己建一个只连公网的客户端、用完即关；工作区文件大小与配额限制 [harness/files.py](../runtime/src/agent_runtime/harness/files.py)），统一写在底层 `harness/` 中，避免在各个插件里重复编写。地址来自参数的工具（如 `write_video_shots`、`generate_shot_frames`、`breakdown_video`）在 `args_validator` 里检查；地址来自工程文件的 `check_film`、`generate_images` 在工具主体里检查，`check_film` 把不能用的地址列进问题清单。

### 模型供应商与 agent 配置

- **模型供应商与并发锁（`config/model_providers/`）**：
  - 服务启动时加载并校验 `declarations/*.yaml` 中的供应商声明。
  - 在修改某个供应商的密钥、切换默认密钥、启停模型、设置全局默认模型或删除供应商时，都会在同一个数据库事务里先对该供应商行加悲观锁（`SELECT ... FOR UPDATE`），确保并发操作下绝不会破坏「默认密钥不能删」「默认模型必须处于启用状态」等约束。
  - **连通性测试（[harness/probe.py](../runtime/src/agent_runtime/harness/probe.py)）**：向目标模型发送一条最多生成 16 个 Token、15 秒超时且不重试的极简请求；如果报错，会自动把错误信息中可能包含的 API Key 明文抹除后再返回给前端。
  - **密钥加密（[secrets.py](../runtime/src/agent_runtime/secrets.py)）**：采用 `CREDENTIAL_ENCRYPTION_KEYS`（MultiFernet，支持配置多把密钥实现不停机轮换，见 [deploy.md#换密钥加密钥匙](deploy.md#换密钥加密钥匙)）统一加密模型密钥和 MCP 服务的地址与请求头。
- **Agent 配置与反向引用检查（`config/agent_config/`）**：
  - 发布检查函数 `compile_agent` 通过四个领域端口（`ModelDirectory`、`PluginDirectory`、`McpDirectory`、`SkillDirectory`）核对所有引用的资源是否有效。
  - 反过来，当管理员试图归档技能、停用/删除模型或密钥、停用/删除 MCP 服务或归档某个 Agent 时，各自模块会通过 `AgentReferences` 扫描所有 Agent 的草稿与当前发布版本；一旦发现正在被引用，立即拒绝操作并返回具体的引用方列表（`usedBy`）。

### 运行时的持久化

运行时所有数据表均位于 `agent_runtime` schema 下（代码路径相对 `runtime/src/agent_runtime/`）：

| 数据模块 | 代码位置与核心存储机制 |
|---|---|
| **运行历史与消息快照** | `harness/step_store_pg.py`：实现 `StepStore` 协议。单条消息按内容的 sha256 哈希在 `snapshot_messages` 表中去重存储，快照行只保存消息哈希引用，大幅节省存储空间 |
| **消息队列、运行锁与审批** | `harness/jobs.py`：基于 PostgreSQL 实现消息排队、同一对话运行互斥锁、租约心跳续期以及崩溃任务自动清扫 |
| **会话与 Token 用量** | `harness/sessions.py`（记录会话归属应用、锁定的 Agent 版本与预览标记）、`harness/usage_ledger_pg.py`（每次模型回复后按「对话 + 模型」累加 Token 消耗） |
| **工作区文件** | `file_store/pg.py` |
| **四大后台配置表** | `config/{skills,model_providers,mcp_servers,agent_config}/infra_sql.py`：修改同一个技能或同一个 Agent 时先加行锁再递增版本号；表中的操作人字段（`created_by` 等）直接保存业务后端传来的用户 ID 字符串 |

**对话分叉（`fork`）的执行顺序设计：**
由于分叉涉及多张表的写入且不跨事务锁全表，系统严格按照以下顺序分步提交：「1. 检查源会话当前空闲且轮次合法 → 2. 规划要截取的历史消息快照（若规划完发现源会话轮次变了则报错中止）→ 3. 创建新会话行 → 4. 复制工作区文件 → 5. 写入新会话的初始快照」。这样即使中途出错，最多只会在库里留下一条前端根本访问不到的孤立数据，绝不会污染源对话。

### 运行与订阅

- **后台运行与前端连接解耦**：Agent 运行由后台 `ConversationRunner`（[harness/transcript/runner.py](../runtime/src/agent_runtime/harness/transcript/runner.py)）独立驱动，用户关掉网页或断开 WebSocket 只会取消实时订阅，不会打断后台运行。当工具触发人工审批时，当前运行（Run）正常结束落库；等用户提交审批结果后，系统会启动一个新的 Run 接着跑（在界面上仍然归属于同一个对话轮次 Turn）。
- **实时流与历史回放完全一致**：无论是刚打开页面从数据库历史消息还原（`from_messages`），还是在线接收实时流事件（`projector`），两边都共用同一套工具卡片注册表，保证生成的结构与编号分毫不差。每条实时流都带有一个唯一生命周期标识 `stream_epoch`，防止服务重启后旧连接把新序号误接在旧内容后面。
- **上下文压缩保持技能可用**：当对话过长插入压缩摘要（`CompactionPart`）时，摘要器会自动把压缩边界之前加载过的技能重新补记在边界之后，确保压缩后模型依然记得已加载的技能。
- **子 Agent 独立流**：主 Agent 每次通过 `delegate_task` 委派任务给子 Agent，都会产生一条独立的子运行（子 Agent 的 `agent_id` 即其 `run_id`）。前端只需在查询或订阅时传入该 `agent_id`，就能用完全相同的协议查看子 Agent 内部的执行过程。

---

## 3. 视频后端

### 后端的模块

视频后端是一个基于 FastAPI 的模块化单体应用，`app/` 目录是唯一的装配中心（组合根）。以下路径均相对 `server/src/iclip/`（模块边界由 [server/tach.toml](../server/tach.toml) 和[架构测试](../server/tests/unit/architecture/test_architecture.py)守护）：

| 目录 | 职责说明 |
|---|---|
| `domains/` | 各业务模块（用户权限、对话、生成任务、参考视频、资料库、标签、需求单、上传、审计等）的业务逻辑、接口路由与数据库操作（`infra_sql.py`） |
| `platform/` | 通用技术底座：数据库连接池、OSS 对象存储、ffmpeg 音视频处理与硬件加速探测（`platform/media/`）、视频抽帧拼板与九宫格切图（`platform/shot_media/`）、视频拆解抽帧与火山方舟调用适配（`platform/video_breakdown/`）、后端自己的出网层（[platform/outbound/](../server/src/iclip/platform/outbound/__init__.py)，基于 `httpx-secure` 提供只连公网的客户端、下载器与制作页用的媒体地址检查；后端只引用运行时的类型定义、错误与客户端库，不引用运行时的出网层）、统一错误映射与管理接口转发（`platform/runtime_admin.py`） |
| `common/` | 跨层共用的基础枚举与纯函数规则（如生成任务类型、状态枚举） |
| `config/` | 配置文件模型（[config/models.py](../server/src/iclip/config/models.py)）、环境变量解析与功能开启条件检查 |
| `app/` | 组合根（[app/bootstrap.py](../server/src/iclip/app/bootstrap.py)）以及连接不同业务模块或跨服务调用的适配器 |

### 后端的配置与装配

- 服务启动时通过 `--config`（或环境变量 `CONFIG_FILE`）读取 `config.yaml`，并结合环境变量由 `resolve_settings()` 一次性完成校验；业务模块内部不再直接读取环境变量。
- **启动期自动探测硬件编码器（[platform/media/codec.py](../server/src/iclip/platform/media/codec.py)）**：只要开启了需要本地處理视频的功能（抽帧出图、视频剪辑合成、参考视频拆解），后端在启动时会自动按 `Apple VideoToolbox → NVIDIA NVENC → 软件 libx264` 的顺序实际试编一小段视频，选出可用的最快编码器注入各模块；如果未手动指定队列并发数，硬件加速时默认并发为 4，纯软件编码时默认为 2。

### 调运行时

后端在组合根中维护一个全局的 `RuntimeClient`（通过环境变量 `RUNTIME_URL` 和 `RUNTIME_APP_KEY` 向运行时证明自己是应用 `video`）：
- **转发管理后台接口**：技能库、模型供应商、MCP 服务与 Agent 配置四组路由在验完权限后，由 `platform/runtime_admin.py` 转发给运行时的 `/v1/admin`。由于运行时只存用户 ID、不存用户名，对于返回结果中包含 `createdBy` / `updatedBy` 的接口，后端会批量查询一次用户表，把创建人/修改人的显示名称补齐后再返回给前端。
- **对话与工作区操作**：通过 `app/runtime_ports.py` 和 `app/runtime_workspace.py` 调用运行时的会话与文件接口，并在请求头 `X-End-User` 中传入该对话的所属用户 ID。新建对话时严格遵守**「先在运行时开好会话，再在后端落对话记录」**的顺序，防止出现没有底层会话的空壳对话。
- **管理测试预览**：后端在 `iclip.agent_previews` 表中记录每个管理员在每个 Agent 下当前的预览会话 ID，并在 `ConversationService` 中集中检查权限（必须是创建者本人且当前仍拥有 `agent:manage` 权限）。在测试预览中调用工具生成的图片，视频插件会自动清空其业务对话归属，避免污染正式对话列表。
- **运行时不可用兜底**：当运行时服务连不上、超时或报错时，后端统一向前端返回 `503` 错误信封，并将具体原因写入服务端日志。

### 浏览器连接与事件流

前端浏览器只与视频后端建立一条 `/ws` WebSocket 连接，由后端在背后代理运行时的实时流：
- **按对话鉴权并透传内容流**：每当浏览器连上 `/ws`，后端就同步与运行时建立一条 `/v1/ws` 连接。前端发来 `subscribe_v2` 订阅某段对话时，后端先检查该用户有没有权限看这段对话；无权查看的直接原地返回 `not_found`，有权查看的则转发给运行时，并将运行时后续发来的聊天流（`transcript.reset` / `ops`）和文件变更帧原样透传给浏览器。任何一端断开，后端都会以 `1001` 状态码关闭浏览器连接，让前端触发重连。
- **消费全局事件流（[app/runtime_events.py](../server/src/iclip/app/runtime_events.py)）**：后端启动一个常驻后台任务连接运行时的 `/v1/events`，收到会话忙闲变化（`event.session.work_changed`，排除测试预览）后，自动推送给该对话的创建者以及在线的治理者。**断线防漂移机制**：一旦后端与运行时的事件流断开或重连成功，后端会主动以 `1001` 踢掉当时所有的浏览器 WebSocket 连接，强制前端重连并重新拉取对话列表，避免断线期间漏掉状态变化。

### 内部接口与视频插件包

后端在 `/internal/runtime/` 下提供了一组仅供运行时和视频插件调用的内部接口（通过 `RUNTIME_INTERNAL_TOKEN` 鉴权，协议见 [conventions §21](../contract/conventions.md#21-后端给运行时的内部接口)）。

内置的 6 个插件职责与后端配合方式如下：

| 插件名称 | 启用方式 | 依赖插件 | 功能说明与后端配合方式 |
|---|---|---|---|
| `workspace` | 始终启用（内置于运行时） | 无 | 提供工作区文件的查看、创建与修改工具 |
| `video` | 始终启用（无需配置） | `workspace` | 提供 `video_parser` 工具：直接通过运行时托管的火山方舟连接进行视频内容理解，不经过视频后端 |
| `video_shots` | 始终启用 | `workspace` | 提供 `write_video_shots` 工具：校验并生成标准分镜表 `video_shot.json`，交付前检查每张镜头帧的地址 |
| `iclip_studio` | 始终启用 | `workspace` | 提供 `check_film` 工具：校验 AI 导演编写的工程文件 `film.icml` 与运行文件 `film.icrun` |
| `shot_video` | 在 `runtime.yaml` 配置 `shot_video` 段 | `workspace`, `video` | 提供视频抽帧与分镜生图工具：由于插件内不做重度媒体处理，它会通过内部接口调用后端的 `app/shot_media.py`（抽帧拼板、宫格切图）与 `app/image_generations.py`（按渠道顺序调用图片模型） |
| `video_breakdown` | 在 `runtime.yaml` 配置 `video_breakdown` 段 | `workspace` | 提供 `breakdown_video` 工具：作为**后台异步工具（`BackgroundTools`）**运行，通过内部接口调用后端的 `app/reference_breakdown.py` 查询或触发参考视频拆解队列 |

- **启动期双向检查**：如果运行时配置启用了 `shot_video` 或 `video_breakdown`，在启动时会自动请求后端的 `/internal/runtime/plugins/services` 接口，确认后端已经配好对应的图片模型、OSS、ffmpeg 和拆解服务；如果后端没配齐，运行时会直接报错拒绝启动，避免运行期才发现工具不可用。
- **后台异步工具机制（`BackgroundTools`）**：模型调用 `breakdown_video` 后会立刻收到一条「已启动拆解」的回执并可以继续和用户聊别的事；等后端拆解完成后，结果会作为一条新消息自动发给模型。如果拆解还没跑完这段对话就被用户中止或异常结束，下次发消息开跑前，系统会自动把当初那条回执替换成「已中断（`interrupted`）」标记，保证历史记录和界面上的任务卡片都能正确收尾。

### 身份与模块协作

- **统一鉴权与代指定用户操作（`ActAs`）**：所有 HTTP 和 WebSocket 请求由 `PrincipalMiddleware` 统一解析登录 Cookie 或 API Key（`/internal/runtime/` 内部接口除外），接口所需权限通过 FastAPI `Security` 直接声明在路由上。对于支持 `users:act_as` 的 6 个写接口（建对话、建需求单、发消息、提交生成、参考视频试生成、确认上传），在拿到请求体后会调用 [identity/acting.py](../server/src/iclip/domains/identity/acting.py) 的 `ActAs` 完成归属用户切换。
- **模块间解耦**：`domains/` 下的各个业务模块互不直接导入对方的内部实现，需要跨模块协作时（例如发消息时自动把外部图片附件转存为上传记录、查询分叉对话的祖先出片记录、做同款时复制制作文件），一律由模块声明接口协议（Protocol），再由 `app/` 组合根注入适配器将两边接起来。
- **出网下载与地址检查**：组合根建好只连公网的出网下载器与客户端（lifespan 结束时关闭）。发消息时转存外部图片附件，以及制作页在插入、选用图片与按文件生图、出片时检查图片地址（[app/conversation_film.py](../server/src/iclip/app/conversation_film.py)），都经出网下载器发起。取帧拼板（[app/shot_media.py](../server/src/iclip/app/shot_media.py)）与参考视频拆解要下载的视频地址可能是模型给的：本系统 OSS 桶里的对象换成内网地址、经普通的共用 HTTP 客户端下载，其他地址经只连公网的客户端原样下载。拆解遇到这类外部地址时先下载到本地、再在本地文件上探时长，不把远程地址交给 ffprobe（它会自己跟随跳转）。

### 成片渲染服务

- **后端排队与调度（[generation/render.py](../server/src/iclip/domains/generation/render.py)）**：用户在前端点击导出成片后，对话模块会将当时的成片草稿、用到的视频与音乐地址以及最新字幕打包存为一条 `whole_film` 生成任务，放入异步队列的专属通道（lane）。队列任务通过内网 HTTP（`WHOLE_FILM_RENDER_URL`）将渲染任务和预签名的 OSS 上传地址发给渲染服务，并轮询进度（总超时与上传签名有效期均为 6 小时）。
- **独立 Node 渲染服务（[render/](../render/package.json)）**：运行在内网（无鉴权），构建时直接把前端的成片合成代码（`web/src/features/storyboard/whole-film/composition/`）打包进来，并挂载与前端相同的成片组件库目录（`RENDER_REGISTRY_ROOT`）。收到任务后在内存队列中按先进先出顺序单任务执行：先把素材下载到本地临时目录 → 启动无头浏览器用 HyperFrames 按 30 fps 渲染出 MP4（期间拦截除素材白名单域名以外的一切外网请求）→ 通过预签名地址上传到 OSS。如果渲染服务重启，内存中正在进行的任务会丢失，后端轮询发现后会将其标记为 `RENDER_LOST` 失败，提示用户重新导出。

### 后端的持久化与迁移

业务表位于 `iclip` schema，异步队列调度表（procrastinate）位于 `public` schema，所有表结构演进均通过 [server/migrations/versions/](../server/migrations/versions/) 下的 Alembic 脚本管理：

| 模块 / 报表视图 | 存储与查询机制 |
|---|---|
| **常规业务模块** | 各业务模块在自己的 `domains/*/infra_sql.py` 中维护自有数据表；外部 PDM 商品款目录通过 `domains/products/catalog_pg.py` 的独立只读连接池查询 |
| **资料库标签（`domains/tagging/`）** | 独立维护标签树、被打标条目与关联关系三张表（见 [ADR-0006](adr/0006-library-tags-as-data.md)、[ADR-0007](adr/0007-library-tag-value-depth.md)）。管理员修改标签树结构时，会先获取数据库事务级咨询锁（Advisory Lock），再校验全树是否重名或超出层级/数量上限 |
| **资料库聚合查询（`domains/library/reports_pg.py`）** | 不单独建冗余表，而是跨「生成记录、对话、用户」三张表实时聚合计算素材卡封面与分叉继承关系；爆款素材库直接关联标签域的条目表与生成记录表 |
| **审计统计报表（`domains/audit/reports_pg.py`）** | 不建持久表。每个审计请求先用短查询拿到需要的对话 ID，再在不占用数据库连接的情况下通过 `runtime_facts.py` 调用运行时的 `/v1/stats/*` 接口拉取会话、运行耗时与 Token 消耗记录，最后在一个事务里把这些记录与 `iclip` 的生成记录写入事务级临时表，该请求的全部指标 SQL 都在这个事务里读这些临时表 |

### 生成、拆解与打标队列

后端的三个异步任务队列（媒体生成、参考视频拆解、资料库打标）共用同一个 procrastinate 数据库连接器，随后端服务一同启停，且**所有队列任务均不开启自动重试**：

1. **媒体生成队列（`domains/generation/`）**：
   - **宫格切图与文件上传**：同步处理完直接写入数据库（状态即 `completed`），不进异步队列。
   - **视频生成（出片、局部编辑段、超分高清版）**：异步提交给上游视频网关并轮询结果；不同视频模型族的参数拼装规则集中在 [clip_models.py](../server/src/iclip/domains/generation/clip_models.py)。
   - **视频剪辑合成（`compose`）**：在本地调用 ffmpeg 将多段视频裁剪、重编码拼接后上传 OSS。
   - **字幕识别（`subtitle`）与背景音乐生成（`audio`）**：各自拥有独立的队列通道。当一条素材片生成完成时，会自动触发回调排入一条字幕识别任务（抽取音频调用千问 ASR `qwen-audio-3.1-asr-flash`）；背景音乐则调用千问 TTS `qwen-audio-3.1-tts-next`，下载音频后用 ffmpeg 切除首尾静音、统一响度并转存为 m4a。
   - **成片导出（`whole_film`）**：独立通道，转发给成片渲染服务处理（见[成片渲染服务](#成片渲染服务)）。
2. **参考视频拆解队列（`domains/references/`，队列名 `references`）**：
   - 调用 `BreakdownRunner`（60 秒以内的视频在本地按每秒 10 帧抽帧并提取音轨，超过 60 秒的视频直接传 URL 让上游抽帧），然后通过运行时的 `/v1/model-calls/responses` 接口调用火山方舟模型生成拆解报告。
   - **错误分类映射**：
     - `model_unavailable`：运行时返回 `409 model_unavailable`（后台未配置或未启用拆解模型）。
     - `model_call_failed`（可重试错误）：火山方舟返回 429 限流或 5xx 错误、网络连不上、或返回的内容不是完整合法的 JSON。
     - `model_failed`（不可重试错误）：其余 4xx 报错、调用超时或应用凭证被拒。
     - `timeout`：后台定时任务每分钟扫描一次，将处于「拆解中」超过 20 分钟的任务强制收尾为超时。
   - 拆解报告成功写回数据库后，会自动排入一次 AI 打标任务。
3. **资料库 AI 打标队列（`domains/tagging/`，队列名 `tagging`）**：
   - 读取参考视频的拆解报告（或爆款素材所属对话工作区里的 `treatment.md`），把当前标签树中所有开启了 `auto_fill=ai` 的维度动态拼装成 JSON Schema，通过运行时调用火山方舟模型打标。
   - 拿到结果后，在单个事务内清空该条目原有的 AI 维度标签并写入新选中的标签（人工维度的标签保持不动）。后台定时任务每分钟将超过 10 分钟仍未结束的打标任务收尾为 `timeout`。

---

## 4. 日志

视频后端（[app/logging.py](../server/src/iclip/app/logging.py)）与运行时服务（[agent_runtime/http/logging.py](../runtime/src/agent_runtime/http/logging.py)）采用完全一致的 `structlog` 日志配置：
- 本地开发（Console 格式）打印本地时间并标明服务名（「后端」或「运行时」）；线上环境（JSON 格式）输出 ISO UTC 时间戳。
- 自动屏蔽正常的 `/healthz` 健康检查请求日志和 WebSocket 重复连接日志，并通过 `QUIET_LOGGERS` 压低第三方库的无关日志噪音。
- 每个请求的 `request_id` 和当前登录身份 `principal` 通过 `contextvars` 自动绑定到上下文中，业务代码打日志只需写固定中文短句和关键变量（见 [AGENTS.md](../AGENTS.md)）。
