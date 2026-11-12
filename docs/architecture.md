# 系统架构

> 本文说明 Agent 运行时服务、视频插件包、视频业务后端与成片渲染服务的职责分工、代码分层与核心运行机制。
> - 业务概念与不变量见 [CONTEXT.md](CONTEXT.md)
> - 接口与跨端协议见 [contract/conventions.md](../contract/conventions.md)
> - 运行时自身的设计、接口与新应用接入见运行时项目的 `docs/` 目录
> - 开发命令与门禁见 [AGENTS.md](../AGENTS.md)

## 1. 两个服务

系统由四个运行时组件构成，核心是**视频后端**与**Agent 运行时服务**的分离：

| 组件 | 所在目录与包名 | 核心职责与数据归属 |
|---|---|---|
| **运行时服务**（端口 `7790`） | 运行时项目 Cue，按 `runtime.ref` 检出到 `runtime/`（`agent_runtime`） | 负责所有跟 Agent 相关的事：管理配置（技能库、模型供应商、MCP 服务、Agent 版本）、维护会话与消息队列、驱动大模型运行、推送聊天流（Transcript）、读写工作区文件、统计 Token 用量。数据存于 `agent_runtime` schema |
| **视频插件包**（装入运行时镜像） | [plugins/video/](../plugins/video/pyproject.toml)（`iclip_video`） | 为 Agent 提供视频领域的专属工具集（如视频理解、视频拆解、生成分镜图、校验工程文件）。需要调用视频后端能力时，通过 HTTP 调用后端的内部接口 |
| **视频后端**（端口 `7788`） | [server/](../server/pyproject.toml)（`iclip`） | 浏览器唯一访问的入口（BFF）：负责用户登录与权限校验、管理业务侧的对话列表、处理视频生成/参考视频拆解/资料库/成片草稿等业务逻辑。数据存于 `iclip` schema |
| **成片渲染服务**（内网 `8080`） | [render/](../render/package.json)（Node.js） | 保存成片草稿时按写法检查并重写成片文件；导出时接收成片文件，在无头浏览器中渲染成 MP4 并上传到对象存储 |

**依赖方向与隔离原则：**
- **单向代码依赖**：`视频插件包` 的插件依赖 `运行时`（装插件包的可选依赖 `runtime`）；`运行时` 不依赖任何业务包。`视频后端` 只用 `视频插件包` 里的视频格式代码，不装可选依赖 `runtime`，生产环境不安装运行时：调运行时的客户端与接口形状由后端自己留一份（见[客户端库](#客户端库)），两边只通过 HTTP 通信。
- **同库不同 Schema**：后端和运行时连接同一个 PostgreSQL 数据库，但严格按 Schema 隔离（后端用 `iclip`，运行时用 `agent_runtime`）。两个 Schema 之间不建数据库外键，代码里也绝不跨 Schema 读写对方的表（由两边的架构测试强制检查）。表结构的变更各管各的：后端的 Alembic 迁移管 `iclip` 与 `public`（见[后端的持久化与迁移](#后端的持久化与迁移)），运行时自己的 Alembic 迁移管 `agent_runtime`（见运行时项目 Cue 的 `docs/architecture.md`），版本表也各放在自己的 Schema 里。
- **单进程运行限制**：目前后端和运行时都采用单进程（单 Worker）模式部署，因为实时消息流投影、事件广播和 WebSocket 连接池都维护在进程内存中。若未来扩展为多实例部署，需先引入跨实例连接路由。

**视频后端与运行时之间的 4 条通信通道：**
1. **应用接口 `/v1`**：视频后端作为应用 `video`，通过自己那份 Python [客户端](#客户端库)调用运行时，完成创建会话、发消息、读聊天记录、读写工作区文件、拉取首页可用 Agent 列表、自动起标题和拉取统计数据（接口见运行时项目的 `docs/protocol.md`，后端的做法见[调运行时](#调运行时)）。
2. **管理接口 `/v1/admin`**：对应管理后台的「技能库、模型供应商、MCP 服务、Agent 配置」四组接口，由视频后端先做权限校验和参数检查，再原样转发给运行时处理。
3. **生命周期回调与内部接口 `/internal/runtime/`**：运行时在「开跑前检查、运行开始、对话轮次开始」三个时机回调视频后端；同时视频插件在执行抽帧、生图、拆解时也会调用后端的这套内部接口（统一使用环境变量 `RUNTIME_INTERNAL_TOKEN` 鉴权，详见[内部接口与视频插件包](#内部接口与视频插件包)）。
4. **两条 WebSocket 实时流**：运行时提供「应用事件流 `/v1/events`」（推送所有会话的忙闲变化）和「对话内容流 `/v1/ws`」（推送某段对话的打字机输出与文件变更），视频后端接收后转发给前端浏览器的 `/ws` 连接（详见[浏览器连接与事件流](#浏览器连接与事件流)）。

---

## 2. 运行时服务

运行时单独部署，只部署一份，视频后端与其他应用都经 HTTP 调它。运行时的模块、接口与运行机制见运行时项目的 `docs/architecture.md` 与 `docs/protocol.md`，新应用接入见运行时项目的 `docs/apps.md`。视频后端怎么调运行时见[客户端库](#客户端库)与[调运行时](#调运行时)。

---

## 3. 视频后端

### 后端的模块

视频后端是一个基于 FastAPI 的模块化单体应用，`app/` 目录是唯一的装配中心（组合根）。以下路径均相对 `server/src/iclip/`（模块边界由 [server/tach.toml](../server/tach.toml) 和[架构测试](../server/tests/unit/architecture/test_architecture.py)守护）：

| 目录 | 职责说明 |
|---|---|
| `domains/` | 各业务模块（用户权限、对话、生成任务、参考视频、资料库、标签、需求单、上传、审计等）的业务逻辑、接口路由与数据库操作（`infra_sql.py`） |
| `platform/` | 通用技术底座：数据库连接池、OSS 对象存储、ffmpeg 音视频处理与硬件加速探测（`platform/media/`）、视频抽帧拼板与九宫格切图（`platform/shot_media/`）、视频拆解抽帧与火山方舟调用适配（`platform/video_breakdown/`）、后端自己的出网层（[platform/outbound/](../server/src/iclip/platform/outbound/__init__.py)，基于 `httpx-secure` 提供只连公网的客户端、下载器与制作页用的媒体地址检查）、调运行时的客户端与接口形状（`platform/runtime_api/`，见[客户端库](#客户端库)）、统一错误映射与管理接口转发（`platform/runtime_admin.py`） |
| `common/` | 跨层共用的基础枚举与纯函数规则（如生成任务类型、状态枚举、领域错误类、地址判定） |
| `config/` | 配置文件模型（[config/models.py](../server/src/iclip/config/models.py)）、环境变量解析与功能开启条件检查 |
| `app/` | 组合根（[app/bootstrap.py](../server/src/iclip/app/bootstrap.py)）以及连接不同业务模块或跨服务调用的适配器 |

### 后端的配置与装配

- 服务启动时通过 `--config`（或环境变量 `CONFIG_FILE`）读取 `config.yaml`，并结合环境变量由 `resolve_settings()` 一次性完成校验；业务模块内部不再直接读取环境变量。
- **启动期自动探测硬件编码器（[platform/media/codec.py](../server/src/iclip/platform/media/codec.py)）**：只要开启了需要本地處理视频的功能（抽帧出图、视频剪辑合成、参考视频拆解），后端在启动时会自动按 `Apple VideoToolbox → NVIDIA NVENC → 软件 libx264` 的顺序实际试编一小段视频，选出可用的最快编码器注入各模块；如果未手动指定队列并发数，硬件加速时默认并发为 4，纯软件编码时默认为 2。

### 客户端库

运行时只部署一份，各应用都经 HTTP 调它。视频后端不安装运行时，调运行时的代码是自己的一份 [platform/runtime_api/](../server/src/iclip/platform/runtime_api/__init__.py)：客户端 `RuntimeClient` 加上后端用到的请求体、答复体、实时帧与回调请求体。
- **手工同步**：`platform/runtime_api/<路径>` 从运行时项目的 `src/agent_runtime/<路径>` 复制而来，只留后端用到的定义，定义本身原样不改；错误类与地址判定归后端自己（`iclip/common/`）。后端要用运行时新增的接口或字段时，按同名文件对比后手工同步；读取方忽略不认识的字段，运行时可以先于后端升级（见 [conventions §20「跨版本兼容」](../contract/conventions.md#跨版本兼容)）。
- **参考客户端**：运行时自己的 `agent_runtime/client/` 是运行时自测用的参考客户端，也是后端那份的来源；客户端的行为（异常还原、管理接口透传、WebSocket 心跳与前向兼容）见运行时项目 Cue 的 `docs/architecture.md`「客户端库」。

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

- **运行时镜像**：生产环境的运行时镜像（[deploy/runtime-video/Dockerfile](../deploy/runtime-video/Dockerfile)）安装的是组合包 [deploy/runtime-video](../deploy/runtime-video/pyproject.toml)，它把 `runtime` 和 `plugins/video` 打包在了一起；运行时启动时按配置的 `plugins.factory` 加载视频插件包。
- **启动期双向检查**：如果运行时配置启用了 `shot_video` 或 `video_breakdown`，在启动时会自动请求后端的 `/internal/runtime/plugins/services` 接口，确认后端已经配好对应的图片模型、OSS、ffmpeg 和拆解服务；如果后端没配齐，运行时会直接报错拒绝启动，避免运行期才发现工具不可用。
- **后台异步工具机制（`BackgroundTools`）**：模型调用 `breakdown_video` 后会立刻收到一条「已启动拆解」的回执并可以继续和用户聊别的事；等后端拆解完成后，结果会作为一条新消息自动发给模型。如果拆解还没跑完这段对话就被用户中止或异常结束，下次发消息开跑前，系统会自动把当初那条回执替换成「已中断（`interrupted`）」标记，保证历史记录和界面上的任务卡片都能正确收尾。

### 身份与模块协作

- **统一鉴权与代指定用户操作（`ActAs`）**：所有 HTTP 和 WebSocket 请求由 `PrincipalMiddleware` 统一解析登录 Cookie 或 API Key（`/internal/runtime/` 内部接口除外），接口所需权限通过 FastAPI `Security` 直接声明在路由上。对于支持 `users:act_as` 的 6 个写接口（建对话、建需求单、发消息、提交生成、参考视频试生成、确认上传），在拿到请求体后会调用 [identity/acting.py](../server/src/iclip/domains/identity/acting.py) 的 `ActAs` 完成归属用户切换。
- **模块间解耦**：`domains/` 下的各个业务模块互不直接导入对方的内部实现，需要跨模块协作时（例如发消息时自动把外部图片附件转存为上传记录、查询分叉对话的祖先出片记录、做同款时复制制作文件），一律由模块声明接口协议（Protocol），再由 `app/` 组合根注入适配器将两边接起来。
- **出网下载与地址检查**：组合根建好只连公网的出网下载器与客户端（lifespan 结束时关闭）。发消息时转存外部图片附件，以及制作页在插入、选用图片与按文件生图、出片时检查图片地址（[app/conversation_film.py](../server/src/iclip/app/conversation_film.py)），都经出网下载器发起。取帧拼板（[app/shot_media.py](../server/src/iclip/app/shot_media.py)）与参考视频拆解要下载的视频地址可能是模型给的：本系统 OSS 桶里的对象换成内网地址、经普通的共用 HTTP 客户端下载，其他地址经只连公网的客户端原样下载。拆解遇到这类外部地址时先下载到本地、再在本地文件上探时长，不把远程地址交给 ffprobe（它会自己跟随跳转）。

### 成片渲染服务

- **保存时的检查（[app/whole_film_files.py](../server/src/iclip/app/whole_film_files.py)）**：成片文件的写法只有渲染服务读得懂。保存草稿与发起导出时，后端把文件交给渲染服务的 `POST /films/check`，拿回按写法重写后的文件、总时长和用到的素材（记录 id 与文件里写的地址），再自己核对这些素材是这段对话的素材片、地址和记录上的一致。文件会在打开它的人的页面里运行，所以这一步也是挡住脚本的安全边界。
- **后端排队与调度（[generation/render.py](../server/src/iclip/domains/generation/render.py)）**：用户在前端点击导出成片后，对话模块把草稿的版本号和用到的素材存为一条 `whole_film` 生成任务，放入异步队列的专属通道（lane）。队列任务按版本号取草稿里的成片文件，通过内网 HTTP（`WHOLE_FILM_RENDER_URL`）把它连同「文件里的素材地址 → 下载地址」的对应表和预签名的 OSS 上传地址发给渲染服务，并轮询进度（总超时与上传签名有效期均为 6 小时）。
- **独立 Node 渲染服务（[render/](../render/package.json)）**：运行在内网（无鉴权），构建时直接把前端的成片文件写法（`web/src/features/storyboard/whole-film/composition/`）打包进来，并挂载与前端相同的成片组件库目录（`RENDER_REGISTRY_ROOT`）。收到导出任务先再检查一遍文件，然后在内存队列中按先进先出顺序单任务执行：先把素材下载到本地临时目录、把文件里的素材地址换成本地路径 → 启动无头浏览器按 30 fps 渲染出 MP4（期间拦截除素材白名单域名以外的一切外网请求）→ 通过预签名地址上传到 OSS。如果渲染服务重启，内存中正在进行的任务会丢失，后端轮询发现后会将其标记为 `RENDER_LOST` 失败，提示用户重新导出。

### 后端的持久化与迁移

业务表位于 `iclip` schema，异步队列调度表（procrastinate）位于 `public` schema，这两个 Schema 的表结构演进均通过 [server/migrations/versions/](../server/migrations/versions/) 下的 Alembic 脚本管理，`agent_runtime` 不归后端的迁移管：

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

视频后端（[app/logging.py](../server/src/iclip/app/logging.py)）与运行时服务（运行时项目的 `src/agent_runtime/http/logging.py`）采用完全一致的 `structlog` 日志配置：
- 本地开发（Console 格式）打印本地时间并标明服务名（「后端」或「运行时」）；线上环境（JSON 格式）输出 ISO UTC 时间戳。
- 自动屏蔽正常的 `/healthz` 健康检查请求日志和 WebSocket 重复连接日志，并通过 `QUIET_LOGGERS` 压低第三方库的无关日志噪音。
- 每个请求的 `request_id` 和当前登录身份 `principal` 通过 `contextvars` 自动绑定到上下文中，业务代码打日志只需写固定中文短句和关键变量（见 [AGENTS.md](../AGENTS.md)）。
