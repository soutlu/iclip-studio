# 新应用接入运行时指南

本文说明一个新的业务系统（下称「应用」）如何接入 Agent 运行时服务，快速获得 Agent 对话与工具运行能力。
- 运行时内部机制见 [架构 §2](architecture.md#2-运行时服务)
- 接口定义以 [runtime-openapi.json](../contract/runtime-openapi.json) 为准，通信协议细节见 [conventions §20](../contract/conventions.md#20-运行时服务-agent-runtime)
- 完整接入示例可参考现有的视频后端（应用 `video`）或最小接入集成测试 [test_second_app.py](../server/tests/integration_no_llm/runtime_service/test_second_app.py)

## 职责分工

| Agent 运行时负责 | 接入的业务应用负责 |
|---|---|
| 管理 Agent 配置（模型、技能库、MCP 服务、Agent 版本）、维护会话与消息队列、驱动大模型运行、输出聊天记录（Transcript）、管理工作区文件、统计 Token 消耗 | 用户登录与权限校验、管理业务侧的对话列表（标题、文件夹归属等）、向前端浏览器提供接口（BFF） |

**核心信任边界**：前端浏览器绝不直接连接运行时，所有请求都由业务应用的服务端携带「应用密钥」发起。业务应用在请求头 `X-End-User` 中传入的用户 ID，运行时会直接信任并原样记录，不会去检查该用户是否存在或是否有权限。

---

## 接入五步流程

### 第一步：在运行时配置文件中登记应用

在运行时的配置文件 `configs/runtime.yaml`（参考 [settings.py](../runtime/src/agent_runtime/settings.py) 与 [样例](../deploy/runtime.example.yaml)）的 `apps` 下新增一项，修改后重启运行时服务：

```yaml
apps:
  video: {...}            # 已有的视频后端，保持不变
  crm:                    # 新应用标识：小写字母开头，仅含小写字母、数字、- 和 _
    key_env: CRM_APP_KEY  # 存放该应用密钥的环境变量名（长度 ≥ 32 字符，不同应用不可共用）
    admin: false          # 是否允许该应用调用 /v1/admin 管理后台接口
    hooks:                # 三个生命周期回调都必须声明，不需要的填 null
      token_env: CRM_HOOK_TOKEN
      gate: https://crm.internal/runtime/hooks/gate
      run_started: null
      turn_started: https://crm.internal/runtime/hooks/turn-started
      timeout_seconds: 10
```

- 如果采用单机 Docker Compose 部署，记得在 [compose.yaml](../deploy/compose.yaml) 的 `runtime.environment` 中把新增的环境变量（如 `CRM_APP_KEY`、`CRM_HOOK_TOKEN`）传给 `runtime` 容器，并确保容器之间网络互通。

### 第二步：实现生命周期回调接口（可选）

运行时会在三个时机向 `hooks` 配置的地址发送 `POST` 请求（请求头带 `Authorization: Bearer <回调令牌>`，协议见 [conventions §20「回调」](../contract/conventions.md#回调)，数据结构见 [hooks.py](../runtime/src/agent_runtime/hooks.py)，视频后端的参考实现见 [app/runtime_internal.py](../server/src/iclip/app/runtime_internal.py)）：

| 回调名称 | 触发时机 | 业务应用应该怎么响应 | 视频后端的实际做法 |
|---|---|---|---|
| `gate`（开跑前检查） | 每次调用大模型前（同步阻塞） | 允许运行返回 `2xx`；如果应用暂时繁忙返回 `502/503/504` 或超时，运行时会自动重试约 30 秒；返回其他非 `2xx`（如 `403`）则直接终止运行并将消息标为失败 | 检查对话所属用户是否存在且未被停用（如果是测试预览，还需检查用户当前是否仍持有 `agent:manage` 权限） |
| `run_started`（运行开始） | 拿到运行锁后（同步阻塞，需快速响应） | 返回 `2xx`（失败仅记日志，不中断运行） | 更新对话表里的最近运行记录、清空已收尾标记，并向前端广播对话更新 |
| `turn_started`（轮次开始） | 每轮用户消息首次开跑时（后台异步调用） | 返回 `2xx`（失败仅记日志） | 如果对话还是默认标题，在后台调用运行时的 `POST /v1/titles` 自动生成标题 |

### 第三步：调用会话与发消息接口

如果业务应用使用 Python 开发，可以直接依赖 `runtime/` 并使用内置的 `RuntimeClient`（见 [agent_runtime/client/](../runtime/src/agent_runtime/client/__init__.py)，错误处理见[架构「客户端库」](architecture.md#客户端库)）；其他语言可直接按 `runtime-openapi.json` 调用 HTTP 接口：

1. **获取可用 Agent 列表**：调用 `GET /v1/agents`，拿到当前在首页上架、启用且已发布的 Agent。
2. **创建会话**：调用 `POST /v1/sessions`（传入应用自己生成的 UUID `id` 和所选的 `agent_id`），会话创建后即自动锁定该 Agent 当时的最新版本。
3. **发送消息**：调用 `POST /v1/sessions/{id}/prompts`（传入幂等键 `prompt_id`、消息内容 `content`、对账标签 `user_name` 和 `agent_id`，请求头 `X-End-User` 填**会话所属用户的 ID**）。
4. **读取聊天记录与状态**：调用 `GET /v1/sessions/{id}/transcript?session_agent=<agent>` 读取一页历史记录，调用 `…/status` 查询运行状态。
5. **其他控制操作**：停止运行、消息插队、重新生成、提交人工审批、对话分叉、复制工作区文件以及读写文件，均在同一组 `/v1/sessions/{id}/…` 路径下。

### 第四步：做好权限隔离并转发 WebSocket 实时流

- **先验权、再转发**：运行时只检查会话是否属于当前调用的应用（访问其他应用的会话统一返回 `404`），不检查具体用户权限。因此业务应用在把请求转发给运行时之前，必须先判断当前登录用户有没有权限查看或操作这段对话（参考 [transcript_api.py](../server/src/iclip/domains/agents/transcript_api.py)）。**注意**：请求头里的 `X-End-User` 必须始终传**这段对话的所属用户 ID**（因为工作区文件是按所属用户隔离命名空间的），哪怕是管理员在查看别人的对话，也要传原对话所属用户的 ID。
- **转发两条 WebSocket 流**（参考[架构「浏览器连接与事件流」](architecture.md#浏览器连接与事件流)）：
  - **对话内容流 `/v1/ws`**：前端每建立一条 WebSocket 连接，应用后端就对应连一条 `/v1/ws`。前端发来 `subscribe_v2` 时，应用后端先检查该用户能否查看这段对话：不能看的直接原地回 `not_found`；能看的原样转发给运行时，并将运行时后续推过来的聊天增量帧和文件变更帧原样透传给浏览器。
  - **应用事件流 `/v1/events`**：应用后端建立一条长连接接收所有会话的忙闲状态变化，根据帧里的 `owner_user_id` 推送给对应用户的浏览器连接。
  - **断线重对齐**：只要任意一条上游连接断开，应用后端就主动断开对应的浏览器连接，让前端重连并调用 `POST /v1/sessions:activities` 重新对齐状态。

### 第五步：按需接入高阶能力（可选）

- **测试预览**：调用 `POST /v1/sessions` 时传入 `{ id, preview: { agent_id, version_id } }`（`version_id` 传空则每次运行实时读取最新草稿），详见 [conventions §19「测试预览」](../contract/conventions.md#测试预览)。
- **转发管理后台接口**：将应用配置为 `admin: true` 后，即可通过 `RuntimeClient.admin_request` 把 `/v1/admin` 下的管理请求转发给运行时（写操作在 `X-End-User` 中传入当前管理员的用户 ID，参考 [platform/runtime_admin.py](../server/src/iclip/platform/runtime_admin.py)）。
- **借用运行时调用固定模型**：如果应用自己的后台任务需要调用某个固定大模型、又不想单独管理 API Key，可以调用 `POST /v1/model-calls/responses`，直接复用运行时配置页里托管的供应商密钥（详见 [conventions §20「模型调用」](../contract/conventions.md#模型调用)）。
- **为 Agent 扩展专属工具**：如果只需要接入外部通用工具，直接在管理后台登记 **MCP 服务**即可（见[架构「工具、插件与 MCP 服务」](architecture.md#工具插件与-mcp-服务)）；如果需要深度调用应用自身的内部接口，可以编写 `PluginFactory` 插件包并在运行时配置中挂载（见[架构「内部接口与视频插件包」](architecture.md#内部接口与视频插件包)）。

---

## 现有限制

1. **后台配置与 Agent 名册全局共享**：目前技能库、模型供应商、默认模型、MCP 服务、Agent 配置以及 `GET /v1/agents` 返回的首页列表在同一个运行时实例内由所有接入应用共享，暂不支持按应用隔离配置。
2. **单个运行时实例只挂载一个插件部署包**：当前的生产镜像打包的是 [deploy/runtime-video](../deploy/runtime-video/pyproject.toml)（运行时 + 视频插件包）；如果新应用需要编写自己的代码插件包，需要合并进该部署包或单独构建镜像。
3. **单进程限制**：运行时服务必须以单进程（单 Worker）模式运行（见[架构 §1](architecture.md#1-两个服务)）。
