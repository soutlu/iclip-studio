# 后端架构

> 本文说明模块职责、装配与运行机制。业务术语和不变量见 [CONTEXT.md](CONTEXT.md)，接口约定见 [contract/conventions.md](../contract/conventions.md)，开发流程见 [AGENTS.md](../AGENTS.md)。

## 1. 模块职责

后端是 FastAPI 模块化单体，Agent 引擎使用 PydanticAI 与 Pydantic AI Harness。`app/` 是唯一组合根：读取配置、创建连接池、装配模块、连接模块间的协议并管理生命周期。

以下路径均相对 `server/src/iclip/`。

| 位置 | 职责 |
|---|---|
| `domains/` | 业务用例、领域模型、HTTP 入口及存储适配；不依赖 Agent 引擎 |
| `harness/` | 通用 Agent 装配、运行驱动、消息持久化、上下文压缩与 transcript 投影；不解释业务身份和业务规则 |
| `capabilities/` | 面向模型的类型化工具，连接 Agent 引擎与业务能力 |
| `platform/` | 共用技术协议及适配器：数据库与行归属、对象存储、工作区文件存储、素材台账、ffmpeg 媒体处理、HTTP 错误映射、翻页、transcript 类型 |
| `common/` | 跨层共用的纯规则：领域错误分类、工具入参的 JSON 文本归一化、地址形状判定、镜头组规则（时间线连续、`@ImageN` 引用、参考图上限）、出片正文的拼装与反拆，以及生成记录的种类、状态词表 |
| `config/` | 配置声明、环境变量定义与启动期解析 |
| `app/` | 组合根及跨模块适配 |
| `main.py` / `asgi.py` | CLI / ASGI 入口 |

依赖图与框架引用边界以 [tach.toml](../server/tach.toml) 和 [架构测试](../server/tests/unit/architecture/test_architecture.py) 为准。业务模块按职责拆文件，不要求每个模块凑齐固定文件模板。

能力包之间不互相 import。确需共享的技术协议下沉到 `platform/`，由组合根注入同一个实例；共用的产物形状与校验规则会用到 `pydantic_ai`（框架围栏只放 `harness/` 与 `capabilities/`），放在 `capabilities/` 下不带工具的模块里。协议随实际调用需求定义，不提前建立抽象层。

存储适配跟随使用其协议的模块：业务自有表放对应模块的 `infra_sql.py`，外部只读库用独立适配器；官方 StepPersistence 的 Postgres 实现在 `harness/step_store_pg.py`。数据库 engine 只由组合根创建。

显式组合根、Principal 解析器与 `api_keys` 表、StepPersistence 的 Postgres 后端是刻意自研的，不以「不重复造轮子」为由换成 DI 容器或第三方库。引擎依赖的精确版本由 [uv.lock](../server/uv.lock) 固定，CI 使用 `uv sync --locked`；升级时同步 [pyproject.toml](../server/pyproject.toml) 与 lockfile，并验证装配、持久化与 transcript 契约。

## 2. 配置与装配

| 权威入口 | 内容 |
|---|---|
| `server/configs/config.yaml`（不进仓库） | 运行参数、模型命名表与模型端点 |
| [config/models.py](../server/src/iclip/config/models.py) | 配置字段、默认值、环境变量名、功能开关与依赖校验 |
| `server/agents/agents.yaml`（不进仓库） | Agent ID、显示名、spec、模型引用、skill、capability 与子代理声明 |
| [config/agents.py](../server/src/iclip/config/agents.py) | 声明与资产路径解析 |
| [app/bootstrap.py](../server/src/iclip/app/bootstrap.py) | 资源创建、模块装配、路由挂载与生命周期 |
| [app/agent_layer.py](../server/src/iclip/app/agent_layer.py) | 模型表与 agent 注册表的装配、热重载与拒绝规则 |

运行配置与 Agent 声明在启动期加载、校验并装配。配置文件路径分别由 `CONFIG_FILE`、`AGENTS_FILE` 指定；CLI 的 `--config`、`--agents` 设置这两个入口。`models` 段、`conversations.title_model` 与 `agents/` 目录构成可热换的一层（[app/agent_layer.py](../server/src/iclip/app/agent_layer.py)）：后端监听两个目录，文件一变即重读、完整装配、整体替换，非热字段有变或装配出错即整体拒绝、沿用旧层，不做部分生效；`SIGHUP` 触发同一次重载，结果报告在 `/healthz` 的 `config` 段；其余配置段与环境变量改了要重启。两个目录只存在于服务器与开发机，接口合同导出用 [scripts/contract/](../server/scripts/contract/config.yaml) 下的占位配置。依赖服务的连接信息与凭证由环境变量提供；模型凭证由 `models.*.api_key_env` 指向环境变量。可选功能的启用条件与缺失依赖处理集中在 `resolve_settings()`，不在业务模块中重新读取配置。

Agent 声明文件必须存在；不启用 Agent 时写 `agent: {}`。`spec` 必须指向现存文件，文件内容可以为空；同目录的 `instructions.md` 自动加载。主 Agent ID 来自声明键，`name` 是首页 Agent 菜单显示的名字，不写就显示 ID；子 Agent 名称来自 spec 所在目录名；声明的名称、模型覆盖 spec 对应字段，关闭磁盘自动扫描。

skill 与 capability 都按 Agent 显式挂载，子代理不继承主代理的挂载。skill 正文由 Harness 按需加载，reference 由随库挂载的 `get_skill_reference` 读取。capability 的实例和挂载依赖集中在 [app/capability_table.py](../server/src/iclip/app/capability_table.py)，工具声明规则见 [tool-design.md](tool-design.md)。

`video` 提供参考视频拆解（`video_parser`）与镜头组 prompt 表交付（`write_video_shots`），依赖 `workspace`；由 `video` 配置段与 `VIDEO_UNDERSTANDING_*` 环境变量启用，不需要媒体生成、对象存储和 ffmpeg。`shot_video` 提供取帧与出图，依赖 `workspace` 与 `video`；由 `shot_video` 配置段启用，另需媒体生成、对象存储和 ffmpeg，三者是否齐由 `ResolvedSettings.shot_tools_enabled` 一处判定，能力表只在它成立时收到 `shot_video`。`iclip_studio` 是导演流程的工具集，依赖 `workspace`。`breakdown_video` 把一条视频的拆解文档写进工作区，工作区里已有那份就直接用：工具自己不调模型，经组合根的适配器（[app/reference_breakdown.py](../server/src/iclip/app/reference_breakdown.py)）交给下面的参考视频，与资料库读写同一行、同一份拆解。那一行有拆解就直接用；没有、或上次没拆成，就排一次后台拆解，每 3 秒查一次，最多等 20 分钟。没拆成时按失败原因回模型：视频打不开让用户换一条；模型调用失败且还有重试次数就让模型再调一次，再调会把这一行重新排队；其余让用户稍后再试。拆解本身怎么做见下面参考视频那段：不超过 60 秒的自己抽帧（每秒 10 帧）连同音轨发给模型，更长的把地址交给对方取帧。它由 `iclip_studio` 配置段与 `VIDEO_UNDERSTANDING_*` 环境变量启用，另需 ffmpeg；配了 `iclip_studio` 却没把参考视频服务交给能力表在装配期报错。启动期的 ffmpeg 检查另按 `ResolvedSettings.ffmpeg_required` 执行：取帧与出图要用它，媒体生成带的视频编辑（编辑段受理时探时长与合成）要用它，`iclip_studio` 读时长与抽帧也要用它，三者任一启用就必须有。要用 ffmpeg 时，组合根在装配期探测一次本地视频加工用哪套编解码（[platform/media/codec.py](../server/src/iclip/platform/media/codec.py)）：硬件优先，依次试 VideoToolbox、NVENC，真编一小段、再解一遍，都成功就选中，都不行用软件 libx264 并记 warning；选中的那套注入合成、参考视频的拆解抽帧与分镜取帧三处。合成与拆解两个队列的并发（`media_generation.compose_concurrency`、`iclip_studio.breakdown_concurrency`）不写时按选中的那套取：硬件 4，软件 2。另两件工具管工程文件：`check_film` 检查工作区里的 `film.icml` 与 `film.icrun`；`generate_images` 给用户指定的生图节点出图，实现保留，组合根现在不登记，图由人在制作页上生成。工程文件不导出成分镜，出片也在制作页上。生图经组合根的适配器走生成域：出图时给记录标上节点名，生成结果不算在用，检查与出片只认运行文件里选用的图；用的图片模型钉在包声明里。读文件、读剧本、检查与拼提示词都在 [iclip_studio/film/](../server/src/iclip/capabilities/iclip_studio/film/) 这个不带工具的子包里，标签和属性以其中的包声明为准；生图与视频提示词的模板包 `@iclip/film-kits` 也在这里，模板之外各段怎么排按模板写在拼提示词的代码里，图号由 AI 导演写在文件里，拼的时候原样发送。制作页（[conventions §6](../contract/conventions.md#6-对话-conversations)）走对话域的端点：对话域只管权限，组合根的 [conversation_film.py](../server/src/iclip/app/conversation_film.py) 读写工作区里的两个文件、认图片地址，分组、改字与换图的规则在同一个子包的 `studio.py`；视图的形状在 [common/film_view.py](../server/src/iclip/common/film_view.py)，对话域与子包共用。`video_shot.json` 的形状与前端约定见 [contract/conventions.md](../contract/conventions.md#6-对话-conversations)。

[shot_document.py](../server/src/iclip/capabilities/shot_document.py) 持有镜头组表的结构与校验措辞，供 `video` 的交付工具、制作页拼出片请求与对话域的文件写回共用；工程文件与运行文件的写回校验用 `iclip_studio/film/` 的同一套检查，只看被写的那一个文件；[video_understanding.py](../server/src/iclip/capabilities/video_understanding.py) 持有视频拆解协议与方舟适配器；[video_document.py](../server/src/iclip/capabilities/video_document.py) 回答拆解文档在工作区的路径与镜头时间码的写法，`shot_video` 靠它定位 `video` 写下的文档，拆解提示词与取帧解析器的报错引同一个写法。划分标准：模型看得见的东西（工具名、docstring、参数 schema、验证器措辞、display 表、指令）留在各自包内，换 agent 就可以不同；模型看不见、换 agent 也不允许有差异的机制下沉到 `harness/`、`common/` 或这类共用模块，不在包之间复制：素材台账校验在 [harness/materials.py](../server/src/iclip/harness/materials.py)，工作区写入与配额、版本错误的翻译在 [harness/files.py](../server/src/iclip/harness/files.py)，镜头组的时间线连续、`@ImageN` 引用与参考图上限在 [common/shot_rules.py](../server/src/iclip/common/shot_rules.py)，与生成域的出片请求共用。

模型适配集中在 [harness/models.py](../server/src/iclip/harness/models.py)，同名模型复用实例。provider 选择交给官方 `infer_model`；`api: responses` 使用本仓的 Responses 子类。模型参数转换不进入业务模块或工具。

lifespan 启动运行驱动、已启用的生成队列与参考视频的拆解队列；关停时先停止后台任务并等待运行终态落库，再关闭 HTTP 客户端和本应用持有的连接池。启动不建表，迁移单独执行。

## 3. 身份与模块协作

HTTP 与 WebSocket 由 `PrincipalMiddleware` 统一解析身份。中间件只解析，端点级权限在路由上以 `Security` 声明并随合同导出，行级归属与条件性判断在业务用例执行；WebSocket 入口另行校验 Origin，订阅时校验对话可见性。钥匙替人办事不在中间件里：建对话、建需求单、发消息、提交生成、参考视频试生成、确认上传六个写入口拿到请求体后各调一次 [identity/acting.py](../server/src/iclip/domains/identity/acting.py) 的 `ActAs`，持 `users:act_as` 的 key 带 `user_name` 时就在这一步把主体换成那个人，下游照常只消费主体。帧的投递范围见 [conventions §5](../contract/conventions.md#5-agent-对话-transcript)。SSO callback 完成验证、账号关联与本地 cookie 签发；配置 PMS 时同步用户资料，失败即终止登录。后续普通请求不再调用 SSO/PMS。

运行通过 `AgentRunDeps` 向工具传递可信主体与对话 ID，业务含义和权限约束见 [CONTEXT.md](CONTEXT.md)。harness 只传递 deps，不解包业务字段；工具所需服务由组合根闭包注入，不放进 deps。客户端 state 不作为运行身份或服务来源。

跨模块协作在组合根适配。例如：合集元信息接入对话侧栏，工作区文件和素材台账接入对话的派生数据端口，生成任务仓库包一层状态广播把每次状态跳转发成 WebSocket 全局帧；上传确认经 uploads 声明的两个端口，由组合根接到生成域：一个查这次上传记过没有，一个落一条上传记录并交回最终地址；这一步只要生成仓储，媒体生成没开也照落。需求单直接持有调用方确认的创作输入，创建时不依赖产品目录装配。模块只使用自身声明的协议，不自行创建其他模块的客户端或仓库。

## 4. 持久化与迁移

| 数据 | 实现位置 |
|---|---|
| `iclip` 业务表 | 各领域模块的 `infra_sql.py` |
| `agent_runtime` 运行历史与快照 | `harness/step_store_pg.py`，实现官方 StepStore 协议 |
| `agent_runtime` prompt 队列、运行关联与审批记录 | `harness/jobs.py` |
| `agent_runtime` 工作区与对话素材台账 | `platform/file_store/pg.py`、`platform/material_ledger/pg.py` |
| `agent_runtime` 对话用量台账 | `harness/usage_ledger_pg.py`；`harness/usage_ledger.py` 的 capability 挂在每个 Agent 上，模型每答一次按（对话，模型）累加 token |
| `public` 生成任务调度表 | procrastinate；DDL 随 Alembic 迁移维护；版本在 pyproject 精确 pin，升级时把它新增的迁移脚本抄成一个新 revision |
| `iclip` 爆款视频 | `domains/inspirations/infra_sql.py`；数据由部署方自行导入，运行时只读不刷新 |
| `iclip` 埋点事件 | `domains/tracking/infra_sql.py`；只追加，主语资格按表名读生成记录，审计按表名读下载事件 |
| PDM 款目录外部库 | `domains/products/catalog_pg.py`，独立连接池设置会话级只读 |
| 审计报表（跨 `iclip` 与 `agent_runtime` 九张表的只读聚合，含运行事件 `events` 与运行关联 `agent_job_runs`） | `domains/audit/reports_pg.py`；不建表、不写入，列、状态词或运行事件名被改动时由它的集成测试先红；总览与按人的时间窗、粒度、分期与均线补窗是 `domains/audit/overview.py` 里的纯函数，任务执行的异常门槛与翻页游标在 `domains/audit/executions.py` |
| `iclip` 参考视频 | `domains/references/infra_sql.py`；一条视频一行，拆解、标签与状态都在行上，状态跳转都是带条件的更新 |
| 资料库（跨生成记录、对话、用户三张表的只读聚合） | `domains/library/reports_pg.py`；同上，每次请求现算卡面与副本的血缘装填，数据到十万级再换成随出片完成更新的读表 |

对话分叉横跨上表前四行：对话领域服务的分叉用例按顺序调两个端口写工作区与素材、种子快照，最后自己落对话行；端口由 [app/conversation_fork.py](../server/src/iclip/app/conversation_fork.py) 接到文件存储与 agent 引擎上，只回报事实，冲突与否由用例判。四处写入各开各的事务，没有统一回滚，靠这个顺序保证中途失败只留下寻址不到的孤儿数据。出片记录不拷，副本按血缘继承：生成域按对话读记录时经同一文件里的适配器问对话域要祖先与边界、主体读不读得到这段对话，递归查询只在对话的 Postgres 仓储上，不进对话仓储协议。做同款走建对话用例里的另一个端口，同样先拷后落行：[app/conversation_same_style.py](../server/src/iclip/app/conversation_same_style.py) 只拷固定几份制作文件（两份改名）与素材台账，同一份文件表也给资料库判断一段对话做不做得了同款。

表结构只经 [Alembic 迁移](../server/migrations/versions/) 演进，命令见 [AGENTS.md](../AGENTS.md)。新增表与迁移的对账范围、人工核对要求见 [测试规范](test-design.md#3-postgres-测试环境)。

## 5. 运行、记录与订阅

Agent 运行由 [ConversationRunner](../server/src/iclip/harness/transcript/runner.py) 驱动，与发起请求的连接生命周期分离。持久化机制：

- prompt 先进入 Postgres 队列；数据库约束保证同一对话的运行互斥，租约、心跳与清扫处理认领和中断恢复。
- StepPersistence 保存消息历史与可续跑快照；恢复读取持久记录。停止运行使用框架取消入口，等待终态落库。
- 审批结束当前 run，决定持久化后以新 run 续跑，仍属于同一轮；审批工具只挂顶层 Agent。
- 生成任务另由 procrastinate 的提交、轮询队列驱动，业务状态写回生成任务表；切图与上传创建即完成，直接落库，不进队列。视频的提交与任务查询对外是上游异步接口的镜像，请求原样转发、结果地址直接存。合成（video / compose）是同一套队列里的一家本地 provider，用 ffmpeg 在服务端拼接；编辑段与出片一样走视频 provider、原样转发，参考片段由前端切好上传，服务端只在受理时用 ffprobe 探片段与基底的时长做核对。

参考视频在 `domains/references/`：用例、自有表与它自己的 procrastinate App（队列 `references`）。拆解、打标、读上传记录与试生成都是领域声明的端口，领域不 import 能力包与生成域：组合根在 [app/reference_breakdown.py](../server/src/iclip/app/reference_breakdown.py) 用 `iclip_studio` 配置建 `VideoBreakdown` 与方舟适配器，把 ffmpeg 与模型的失败换成落到行上的失败原因（视频打不开、模型调用失败、模型失败；超时由下面的周期任务记），打标的输出格式与解析也只在这个文件里；上传记录经组合根的闭包按主体读生成域的那一行；试生成由 [app/reference_test_video.py](../server/src/iclip/app/reference_test_video.py) 记成属主名下的一条视频生成，读最新一次按 `metadata.referenceId` 查生成记录。一次后台任务先接手（排队改成拆解中，记开始时刻），再拆解、打标，最后按开始时刻核对后一次写回，打标失败只留空标签；任务不挂自动重试，崩在半路的行由每分钟一次的周期任务在拆解中满 20 分钟时按超时收尾。生成队列与拆解队列共用组合根建的一个连接器：媒体生成或拆解任一配好就建它，lifespan 里打开一次、两个 worker 都停了再关；拆解队列的 worker 只看 `iclip_studio` 配没配，不以媒体生成为前提，每个进程的并发取 `iclip_studio.breakdown_concurrency`，不写时按启动时选中的编解码取（见[配置与装配](#2-配置与装配)）。它与对话运行在同一个进程、同一个 lifespan 里起停，AI 导演的工具才等得到结果。

transcript 是运行记录的投影。历史由 `from_messages` 从持久消息生成，实时由 `projector` 从引擎事件生成；两条路径必须得到相同的编号和结构，共用工具 display 注册表。上下文压缩在完整历史中插入 `CompactionPart`，发送模型时从最后一条边界计算窗口，不删除原始消息。

子代理各自一条 transcript 流，agent_id 即其 run id，一次 `delegate_task` 就是它的第一轮；父工具调用与子运行的关联记在官方 tool_effect 账本，实时与历史都据此重建。子代理任务的终态取自子运行的结束事件；父工具返回缺失时（父运行被停或崩溃）也按同一口径。读子代理流走同一组接口带 `agent_id`，归属由子运行记录的 `parent_run_id` 回溯到会话。

实时投影与连接注册表在每个 worker 的内存中，快照持久化后才移交该轮实时状态。每条实时流建出时带一个 epoch，续订水位按 epoch 与批次号一起核对。连接注册表同时持有会话事件时钟（[session_events.py](../server/src/iclip/platform/transcript/session_events.py)），全局帧与文件变更帧在写入提交之后从它取号；对话域经组合根注入的端口取水位、广播整行与删除，不依赖 WebSocket 实现。当前没有跨 worker 广播：订阅落到其他 worker 时无法收到该运行的实时事件。多 worker 部署必须把这一限制纳入连接路由设计。

WebSocket 订阅、活动状态和文件变更帧的对外约定见 [contract/conventions.md](../contract/conventions.md)，本文不维护第二份帧与端点清单。

## 6. 日志

[app/logging.py](../server/src/iclip/app/logging.py) 统一配置 structlog 与标准库日志的渲染链。请求和 WebSocket 连接的 `request_id`、`principal` 通过 contextvars 传递；级别、格式由运行配置决定。业务日志写法和第三方噪音处理见 [AGENTS.md](../AGENTS.md)。
