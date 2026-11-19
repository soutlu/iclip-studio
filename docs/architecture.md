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
| **视频后端**（端口 `7788`） | [server/](../server/pyproject.toml)（`iclip`） | 浏览器唯一访问的入口（BFF）：负责用户登录与权限校验、管理业务侧的对话列表、处理视频生成/参考视频拆解/资料库/成片导出等业务逻辑。数据存于 `iclip` schema |
| **成片渲染服务**（内网 `8080`） | [render/](../render/package.json)（Node.js） | 导出时接收 `final-cut` 工程文件，在离线沙箱化的无头浏览器中渲染为 MP4 并上传对象存储 |

**依赖方向与隔离原则：**
- **单向代码依赖**：`视频插件包` 的插件依赖 `运行时`（装插件包的可选依赖 `runtime`）；`运行时` 不依赖任何业务包。`视频后端` 只用 `视频插件包` 里的视频格式代码，不装可选依赖 `runtime`，生产环境不安装运行时：调运行时的客户端与接口形状由后端自己留一份（见[客户端库](#客户端库)），两边只通过 HTTP 通信。
- **同库不同 Schema**：后端和运行时连接同一个 PostgreSQL 数据库，但严格按 Schema 隔离（后端用 `iclip`，运行时用 `agent_runtime`）。两个 Schema 之间不建数据库外键，代码里也绝不跨 Schema 读写对方的表（由两边的架构测试强制检查）。表结构变更各管各的：后端 Alembic 迁移管 `iclip` 与 `public`（见[后端的持久化与迁移](#后端的持久化与迁移)），运行时 Alembic 迁移管 `agent_runtime`（见运行时项目 Cue 的 `docs/architecture.md`），版本表各自存放在所属 Schema 内。
- **单进程运行限制**：目前后端和运行时均采用单进程（单 Worker）模式部署，因为实时消息流投影、事件广播和 WebSocket 连接池维护在进程内存中。若未来扩展为多实例部署，需先引入跨实例连接路由。

**视频后端与运行时之间的 4 条通信通道：**
1. **应用接口 `/v1`**：视频后端作为应用 `video`，通过自有的 Python [客户端](#客户端库)调用运行时，完成创建会话、发消息、读聊天记录、读写工作区文件、拉取首页可用 Agent 列表、自动起标题、模型代理调用和统计拉取（接口见运行时项目的 `docs/protocol.md`，后端封装见[调运行时](#调运行时)）。
2. **管理接口 `/v1/admin`**：对应管理后台的「技能库、模型供应商、MCP 服务、Agent 配置」四组接口，由视频后端先做权限校验和参数检查，再转发给运行时处理。
3. **生命周期回调与内部接口 `/internal/runtime/`**：运行时在「开跑前检查、运行开始、对话轮次开始」三个时机回调视频后端；视频插件执行抽帧、生图、拆解时同样调用这套内部接口（统一使用环境变量 `RUNTIME_INTERNAL_TOKEN` 鉴权，详见[内部接口与视频插件包](#内部接口与视频插件包)）。
4. **两条 WebSocket 实时流**：运行时提供「应用事件流 `/v1/events`」（推送所有会话的忙闲变化）和「对话内容流 `/v1/ws`」（推送某段对话的流式输出与文件变更），视频后端接收后代理转发给前端浏览器的 `/ws` 连接（详见[浏览器连接与事件流](#浏览器连接与事件流)）。

---

## 2. 运行时服务

运行时单独部署一份，视频后端与其他应用均经 HTTP 调用。运行时的模块、接口与运行机制见运行时项目的 `docs/architecture.md` 与 `docs/protocol.md`，新应用接入见 `docs/apps.md`。

---

## 3. 视频后端

### 后端的模块

视频后端是基于 FastAPI 的模块化单体应用，`app/` 目录是唯一的装配中心（组合根）。以下路径均相对 `server/src/iclip/`（模块边界由 [server/tach.toml](../server/tach.toml) 和[架构测试](../server/tests/unit/architecture/test_architecture.py)守护）：

| 目录 | 职责说明 |
|---|---|
| `domains/` | 各业务模块（用户权限、对话、生成任务、参考资产、资料库、标签、需求单、上传、审计等）的业务逻辑、接口路由与数据库操作（`infra_sql.py`） |
| `platform/` | 通用技术底座：数据库连接池、OSS 对象存储、ffmpeg 音视频处理与硬件加速探测（`platform/media/`）、视频抽帧拼板与九宫格切图（`platform/shot_media/`）、视频拆解抽帧与火山方舟调用适配（`platform/video_breakdown/`）、基于 `httpx-secure` 的公网出网客户端与下载器（[platform/outbound/](../server/src/iclip/platform/outbound/__init__.py)）、运行时客户端与接口形状（`platform/runtime_api/`）、统一错误映射与管理接口转发（`platform/runtime_admin.py`） |
| `common/` | 跨层共用的基础枚举与纯函数规则（如生成任务类型、状态枚举、领域错误类、地址判定） |
| `config/` | 配置文件模型（[config/models.py](../server/src/iclip/config/models.py)）、环境变量解析与功能开启条件检查 |
| `app/` | 组合根（[app/bootstrap.py](../server/src/iclip/app/bootstrap.py)）以及连接不同业务模块或跨服务调用的适配器 |

### 后端的配置与装配

- 服务启动时通过 `--config`（或环境变量 `CONFIG_FILE`）读取 `config.yaml`，结合环境变量由 `resolve_settings()` 一次性完成校验；业务模块内部不再直接读取环境变量。
- **启动期自动探测硬件编码器（[platform/media/codec.py](../server/src/iclip/platform/media/codec.py)）**：只要开启了需要本地处理视频的功能（抽帧出图、视频剪辑合成、参考视频拆解），后端在启动时自动按 `Apple VideoToolbox → NVIDIA NVENC → 软件 libx264` 顺序实际试编一小段视频，选出可用的最快编码器注入各模块；未手动指定并发数时，硬件加速默认并发为 4，纯软件编码默认为 2。

### 客户端库

视频后端不安装运行时包，调用运行时的代码维护在自有的 [platform/runtime_api/](../server/src/iclip/platform/runtime_api/__init__.py) 中（包含 `RuntimeClient` 及后端实际用到的请求/响应模型、实时帧与回调结构）：
- **手工按需同步**：`platform/runtime_api/<路径>` 从运行时项目 `src/agent_runtime/<路径>` 按同名文件复制裁剪，定义保持原样（错误类与地址判定归后端 `iclip/common/`）。需要使用运行时新增接口或字段时手工对比同步；读取方忽略未知字段，支持运行时先于后端升级（见 [conventions §20「跨版本兼容」](../contract/conventions.md#跨版本兼容)）。
- **参考客户端**：运行时自测用的 `agent_runtime/client/` 是后端客户端的蓝本（异常还原、管理接口透传与 WebSocket 心跳细节见运行时项目的 `docs/architecture.md`）。

### 调运行时

后端在组合根维护全局 `RuntimeClient`（凭 `RUNTIME_URL` 和 `RUNTIME_APP_KEY` 标识为应用 `video`）：
- **转发管理后台接口**：技能库、模型供应商、MCP 服务与 Agent 配置四组路由验权后，由 `platform/runtime_admin.py` 转发至运行时 `/v1/admin`；对含 `createdBy` / `updatedBy` 的响应，后端批量查询用户表补齐显示名后返回前端。
- **对话与工作区操作**：通过 `app/runtime_ports.py` 和 `app/runtime_workspace.py` 调用会话与文件接口，请求头 `X-End-User` 传对话所属用户 ID。新建对话严格遵守**「先在运行时建好会话，再在后端落对话记录」**的顺序，防止产生无底层会话的空壳对话。
- **管理测试预览**：后端在 `iclip.agent_previews` 表记录每位管理员在各 Agent 下的当前预览会话 ID，并在 `ConversationService` 集中验权（限创建者本人且仍持 `agent:manage`）。预览中调用工具生成的图片自动清空业务对话归属，不污染正式列表。
- **运行时不可用兜底**：运行时连接失败、超时或报错时，后端统一向前端返回 `503` 错误信封（`final-cut` 翻译除外，返回带错误码的 `502`）并记录服务端日志。

### 浏览器连接与事件流

前端浏览器只与视频后端建立一条 `/ws` WebSocket 连接，由后端代理运行时的实时流：
- **按对话鉴权并透传内容流**：浏览器连上 `/ws` 时，后端同步与运行时建立一条 `/v1/ws` 连接。收到 `subscribe_v2` 时先校验对话查看权限，无权查看直接在 `ack.payload.not_found` 回报，有权查看则转发至运行时并原样透传后续 `transcript.reset` / `ops` 与文件变更帧；任一端断开均以 `1001` 关闭浏览器连接触发重连。
- **消费全局事件流（[app/runtime_events.py](../server/src/iclip/app/runtime_events.py)）**：常驻后台任务连接运行时的 `/v1/events`，收到正式会话忙闲变化（`event.session.work_changed`）后推送给对话创建者及在线治理者。**断线防漂移机制**：后端与运行时的事件流一旦断开或重连成功，主动以 `1001` 踢掉所有浏览器 WebSocket 连接，强制前端重连并重拉对话列表。

### 内部接口与视频插件包

后端在 `/internal/runtime/` 下提供仅供运行时与视频插件调用的内部接口（凭 `RUNTIME_INTERNAL_TOKEN` 鉴权，协议见 [conventions §21](../contract/conventions.md#21-后端给运行时的内部接口)）。6 个内置插件分工如下：

| 插件名称 | 启用方式 | 依赖插件 | 功能说明与后端配合方式 |
|---|---|---|---|
| `workspace` | 始终启用（内置于运行时） | 无 | 提供工作区文件的查看、创建与修改工具 |
| `video` | 始终启用（无需配置） | `workspace` | 提供 `video_parser` 工具：直接通过运行时托管的火山方舟连接理解视频，不经过视频后端 |
| `video_shots` | 始终启用 | `workspace` | 提供 `write_video_shots` 工具：校验并生成标准分镜表 `video_shot.json`，交付前校验镜头帧地址 |
| `iclip_studio` | 始终启用 | `workspace` | 提供 `check_film` 工具：校验导演工程文件 `film.icml` 与运行文件 `film.icrun` |
| `shot_video` | 在 `runtime.yaml` 配置 `shot_video` 段 | `workspace`, `video` | 提供视频抽帧与分镜生图工具：通过内部接口调用后端 `app/shot_media.py`（抽帧拼板、宫格切图）与 `app/image_generations.py`（按渠道顺序调用图片模型） |
| `video_breakdown` | 在 `runtime.yaml` 配置 `video_breakdown` 段 | `workspace` | 提供 `breakdown_video` **后台异步工具（`BackgroundTools`）**：通过内部接口调用后端 `app/reference_breakdown.py` 查询或触发参考视频拆解队列 |

- **运行时镜像与启动期双向检查**：生产运行时镜像安装组合包 [deploy/runtime-video](../deploy/runtime-video/pyproject.toml)（打包 `runtime` 与 `plugins/video`）。启用 `shot_video` 或 `video_breakdown` 时，运行时启动阶段自动请求后端 `/internal/runtime/plugins/services` 核对图片模型、OSS、ffmpeg 与拆解服务是否就绪，未配齐则拒绝启动。
- **后台异步工具收尾（`BackgroundTools`）**：`breakdown_video` 调用后立即返回「已启动」回执，拆解完成后将结果作为新消息送回模型；若拆解未完对话即中止或异常结束，下次开跑前自动将原回执替换为 `interrupted` 标记。

### 身份与模块协作

- **中间件洋葱圈顺序**：最外层 [app/preview_host.py](../server/src/iclip/app/preview_host.py) 按请求 `Host` 隔离应用域名与 `final-cut` 预览域名（见 [conventions「预览域名」](../contract/conventions.md#final-cut-工程与预览域名)）→ 紧内层 `WriteOriginCheck` 在路由与鉴权前校验写请求 `Origin`（见 [conventions §2](../contract/conventions.md#2-双主体认证-dual-principals)）→ CORS → `PrincipalMiddleware` 统一解析登录 Cookie 或 API Key（`/internal/runtime/` 与 `/final-cut/preview/` 除外）。支持 `users:act_as` 的 8 个写接口在解析请求体后调用 [identity/acting.py](../server/src/iclip/domains/identity/acting.py) 的 `ActAs` 切换数据归属。
- **模块间协议解耦**：`domains/` 下各业务模块互不直接导入内部实现，跨模块协作（如附件自动转存上传、查询分叉祖先记录、做同款复制文件、生成任务校验参考资产）一律由模块声明 `Protocol`，在 `app/` 组合根注入适配器连接。
- **出网下载与地址校验**：组合根维护只连公网的出网下载器与客户端。外部图片附件转存及制作页图片地址校验（[app/conversation_film.py](../server/src/iclip/app/conversation_film.py)）均经出网下载器发起；抽帧拼板（[app/shot_media.py](../server/src/iclip/app/shot_media.py)）与参考视频拆解拉取视频时，本系统 OSS 对象走内网地址与普通客户端，其余外部地址走公网隔离客户端先下载到本地再交由 `ffprobe` 探测（避免 `ffprobe` 自行跟随重定向）。

### 成片渲染服务

- **工程透传与沙箱边界**：编辑器直接读写工作区 `final-cut/` 目录，后端不解析或清洗工程脚本，仅按签名令牌向预览域名提供文件，并在导出时将工程原样交给渲染服务（[ADR-0008](adr/0008-final-cut-workspace-project.md)）。
- **后端排队与调度（[app/whole_film_exports.py](../server/src/iclip/app/whole_film_exports.py)、[generation/render.py](../server/src/iclip/domains/generation/render.py)）**：发起导出时，后端提取主文件素材地址匹配血缘来源（`<video>` 匹配生成记录；`<audio>` 依次匹配本对话含分叉继承的生成记录、本对话含继承的上传、参考音频库未移除记录）创建 `whole_film` 生成任务入队。队列执行时才通过组合根回调读取实时 `final-cut/` 全目录，连同素材下载地址映射与预签名 OSS 上传地址经内网 HTTP（`FINAL_CUT_RENDER_URL`）提交渲染服务并轮询进度（总超时与签名有效期均为 6 小时）。
- **独立 Node 渲染服务（[render/](../render/package.json)）**：运行于内网（无鉴权），只读挂载共享组件库目录（`RENDER_REGISTRY_ROOT`）：
  1. **入队前校验**：`POST /exports` 仅接收 `Content-Type: application/json`（其余返回 `415` 触发浏览器跨源预检拦截，防止渲染页内脚本访问回环端口伪造导出请求）；校验工程路径规范、主文件存在性、多语言值表合法性（复用前端 [composition/](../web/src/features/storyboard/final-cut/composition/film.ts) 的 `localizedHostValues` 与 `localizedVoices` 生成目标语言主文件）及素材域名白名单（`RENDER_ALLOWED_MEDIA_HOSTS`），不合规返回 `400`。
  2. **单任务渲染流水线**：内存队列先进先出执行——写出临时工程并拷入 `vendor/` 公共目录 → 扫描未声明 `@font-face` 的字体族（复用 [font-families.ts](../web/src/features/storyboard/final-cut/composition/font-families.ts)，缺失即报 `font-missing` 列出字体名，防止渲染器外联拉取或静默替换字体）→ 调用 `@hyperframes/core/lint` 的 `lintProject`（`studio` 规则）检查工程（有 error 报 `lint-failed`，仅 warning 记日志放行）→ 下载目标语言实际引用的素材并替换为本地路径 → 启动无头 Chrome 按 30 fps 渲染 MP4 并上传 OSS，完成后清理临时目录。
  3. **浏览器离线沙箱与重启兜底**：渲染浏览器经启动脚本将一切非回环请求导向本地拒绝代理并禁用 WebRTC 直连，彻底阻断外网与链路本地访问（被拦请求记 warn 日志，页面内按加载失败处理）。若渲染服务重启丢失内存任务，后端轮询自动将其标记为 `RENDER_LOST` 失败。

### 后端的持久化与迁移

业务表位于 `iclip` schema，异步队列调度表（procrastinate）位于 `public` schema，均通过 [server/migrations/versions/](../server/migrations/versions/) 的 Alembic 脚本管理（`agent_runtime` 归运行时自身迁移管理）：

| 模块 / 报表视图 | 存储与查询机制 |
|---|---|
| **常规业务模块** | 各模块在自有的 `domains/*/infra_sql.py` 中维护数据表；外部 PDM 款目录通过 `domains/products/catalog_pg.py` 的独立只读连接池查询 |
| **上传台账（`domains/uploads/`）** | 独立维护 `iclip.media_uploads` 表（与 `generation_jobs` 分离），记录前端直传与消息外部图片转存；表级不设外键与 CHECK 约束，枚举在应用层校验（[uploads/models.py](../server/src/iclip/domains/uploads/models.py)），视频确认时按 OSS 对象 MD5 去重；生成、参考资产与成片导出均经 `app/` 组合根解耦调用 |
| **参考资产（`domains/references/`）** | 采用 `iclip.references` 主表 + `reference_videos` / `reference_audios` 一对一子表（无表级外键与 CHECK 约束，同事务读写，视频子表改动同步刷新主表 `updated_at`）。参考视频新增与恢复通过 `pg_advisory_xact_lock` 按 URL 串行去重；参考音频不去重，入库时在组合根用 `ffprobe` 实测时长；资料库标签关联主表（仅视频打标），试生成任务 ID 写回 `test_job_id` |
| **资料库标签（`domains/tagging/`）** | 独立维护标签树、被打标条目与关联关系三张表（见 [ADR-0006](adr/0006-library-tags-as-data.md)、[ADR-0007](adr/0007-library-tag-value-depth.md)）；修改标签树结构时先获取事务级咨询锁再校验重名与层级/数量上限 |
| **资料库聚合查询（`domains/library/reports_pg.py`）** | 不建冗余表，跨「生成记录、对话、用户」三表实时聚合素材卡封面与分叉继承关系；爆款素材库直接关联标签域条目表与生成记录表 |
| **审计统计报表（`domains/audit/reports_pg.py`）** | 不建持久表。先短查询获取对话 ID，释放连接后经 `runtime_facts.py` 调运行时 `/v1/stats/*` 拉取会话耗时与 Token 记录，再于单事务内写入事务级临时表供全部指标 SQL 汇总 |

**迁移默认只增不删**：因为升级时先执行数据库迁移再切换容器，且[回滚](deploy.md#回滚)只切回旧镜像、不回退迁移，所以新版本的迁移执行后，上一版代码仍须能正常工作：
- 新增表、新增可空列等向后兼容变更直接执行。
- 删表、删列、重命名或修改列类型等破坏性变更应拆到后续版本，待依赖旧结构的代码全部下线后再执行。
- 确需单版完成非兼容迁移时，须在 PR 说明中写明；此类版本回滚镜像前需先手工处理数据库。

### 生成、拆解与打标队列

后端三个异步任务队列共用同一个 procrastinate 连接器，随服务一同启停，且**所有队列任务均不开启自动重试**：

1. **媒体生成队列（`domains/generation/`）**：`iclip.generation_jobs` 仅记录生成与加工任务，不记上传（见[后端的持久化与迁移](#后端的持久化与迁移)）。
   - **宫格切图**：同步切分完成后直接落库为 `completed`，不进异步队列。
   - **视频生成（出片、参考视频试生成、局部编辑段、超分高清版）**：异步提交上游视频网关并轮询结果（试生成与出片共用通道与配置组规则，记为 `operation=trial`）；各模型族参数拼装集中在 [clip_models.py](../server/src/iclip/domains/generation/clip_models.py)。
   - **视频剪辑合成（`compose`）**：本地调用 ffmpeg 裁剪、重编码拼接后上传 OSS。
   - **字幕识别（`subtitle`）与背景音乐生成（`audio`）**：各自独立通道。字幕识别仅在调用 `POST /generations/subtitles` 时入队（抽取音频调千问 ASR `qwen-audio-3.1-asr-flash`）；背景音乐调千问 TTS `qwen-audio-3.1-tts-next`，经 ffmpeg 切除首尾静音、统一响度后转存 m4a。
   - **配音（`dubbing`）与合成语音（`speech`）**：共用独立通道与 `SpeechSynthesizer` 协议（[generation/dubbing.py](../server/src/iclip/domains/generation/dubbing.py)、[generation/speech.py](../server/src/iclip/domains/generation/speech.py)）。参考音频截取、逐句变速/截尾与等长音轨拼接均在本地由 ffmpeg 完成；逐句语音合成调用千问 TTS `qwen-audio-3.1-tts-next`（参考音频以 data URI 传入并在提示词中以 `@voice1` 引用，音色台词仅落库不发上游；未配置 `media_generation.speech` 或 `QWEN_SPEECH_API_KEY` 时提交接口返回 `422`）。
   - **成片导出（`whole_film`）**：独立通道，转发给[成片渲染服务](#成片渲染服务)处理。
2. **参考视频拆解队列（`domains/references/`，队列名 `references`）**：
   - 调用 `BreakdownRunner`（≤ 60 秒视频本地按 10 fps 抽帧并提音轨，> 60 秒直接传 URL），经运行时 `/v1/model-calls/responses` 调用火山方舟模型生成拆解报告，成功后自动排入 AI 打标任务。
   - **错误分类与超时**：后台未启用模型映射为 `model_unavailable`；429 / 5xx / 网络异常 / JSON 截断映射为可重试的 `model_call_failed`；其余 4xx / 超时 / 凭证被拒映射为 `model_failed`；定时任务每分钟扫描并将运行超 20 分钟的任务强制收尾为 `timeout`。
3. **资料库 AI 打标队列（`domains/tagging/`，队列名 `tagging`）**：
   - 读取拆解报告或 `treatment.md`，将开启 `auto_fill=ai` 的维度动态拼装为 JSON Schema 经运行时调用火山方舟模型打标，在单事务内整组替换 AI 维度标签（人工维度不变）；定时任务每分钟将超 10 分钟未完的任务收尾为 `timeout`。

---

## 4. 日志

视频后端（[app/logging.py](../server/src/iclip/app/logging.py)）与运行时服务（运行时项目的 `src/agent_runtime/http/logging.py`）采用一致的 `structlog` 配置：
- 本地开发（Console 格式）打印本地时间并标明服务名（「后端」或「运行时」），仅输出写请求与 `4xx` / `5xx` 访问日志（运行时仅输出 `5xx`），并省略 uvicorn 启停例行提示（仅保留 `Application startup complete` 供热重载确认）；线上环境（JSON 格式）输出 ISO UTC 时间戳与完整访问日志。
- 两种格式均屏蔽正常的 `/healthz` 健康检查日志和 WebSocket 重复连接日志，将后端访问日志中 `final-cut` 预览路径的签名令牌脱敏为 `***`，并通过 `QUIET_LOGGERS` 压低第三方库噪音。
- 后端每个请求的 `request_id` 和当前登录身份 `principal` 通过 `contextvars` 自动绑定，业务代码打日志只需写固定中文短句和关键变量（见 [AGENTS.md](../AGENTS.md)）。
