# 新应用接入运行时

本文讲一个新业务（下称应用）怎样把 agent 对话接到运行时服务上。运行时的机制见[架构 §2](architecture.md#2-运行时服务)，接口形状以 [runtime-openapi.json](../contract/runtime-openapi.json) 为准，鉴权、会话归属、两条 WebSocket 与回调的约定见 [conventions §20](../contract/conventions.md#20-运行时服务-agent-runtime)。视频后端（应用 `video`）是现成的接法，下文各步都指到它的对应代码。

## 分工

| 运行时管 | 应用管 |
|---|---|
| agent 配置、会话、消息队列与运行、transcript、工作区文件与素材台账、用量与统计 | 用户身份与登录、谁能看谁能写、自己的产品记录（如对话列表、标题、归属）、给浏览器的接口 |

运行时信任应用：它只认应用的密钥，应用交来的用户 id 原样记下，不核对用户存不存在、有没有权限。浏览器不直连运行时，应用的服务端是唯一的调用方。

## 1. 登记应用

在运行时配置（部署目录的 `configs/runtime.yaml`，形状见 [settings.py](../runtime/src/agent_runtime/settings.py) 与 [样例](../deploy/runtime.example.yaml)）的 `apps` 下加一项，改完重启运行时服务：

```yaml
apps:
  video: {...}            # 已有的视频后端，不动
  crm:                    # 应用标识：小写字母开头，只含小写字母、数字、- 与 _
    key_env: CRM_APP_KEY  # 放这个应用密钥的环境变量
    admin: false          # 要不要用 /v1/admin 管理接口
    hooks:                # 三个键都要写，null 是不要这个回调
      token_env: CRM_HOOK_TOKEN
      gate: https://crm.internal/runtime/hooks/gate
      run_started: null
      turn_started: https://crm.internal/runtime/hooks/turn-started
      timeout_seconds: 10
```

- 密钥与回调令牌都不少于 32 个字符，放在运行时服务的环境变量里；每个应用各用一把密钥，与别的应用相同就起不来。单机部署时 [compose.yaml](../deploy/compose.yaml) 只把列出的变量交给 `runtime` 容器，新加的变量要加进它的 `environment`。
- 三个回调都不要时 `token_env` 可以不写；有一个地址就必须写。
- 运行时在 compose 网络里监听 7790、不对外开端口：应用要放进同一个网络或另开端口才连得上，回调地址也要从 `runtime` 容器里连得到。
- 会话 id 由应用铸（UUID）；撞上别的应用已有的 id 开会话答 `409`。

## 2. 回调

运行时按会话归属的应用找回调地址，`POST` JSON，带 `Authorization: Bearer <回调令牌>`。请求体、重试与时机见 [conventions §20「回调」](../contract/conventions.md#回调)，模型在 [hooks.py](../runtime/src/agent_runtime/hooks.py)。

| 回调 | 应用要答什么 | 视频后端的做法 |
|---|---|---|
| `gate` | 放行答 2xx；不放行答别的非 2xx（如 `403`），这次运行失败、消息记 `failed`。答 `502`/`503`/`504` 或没答复会被重试约 30 秒，所以暂时答不了时用它们 | 重建属主主体，账号不在或已停用就拦下 |
| `run_started` | 答 2xx；失败只记日志。它卡着运行，要快答 | 记下对话的最近一次运行、刷新行并广播 |
| `turn_started` | 答 2xx；失败只记日志。在后台调，不卡运行 | 对话还是默认标题时调 `POST /v1/titles` 起名 |

三个请求体都带 `preview`，为真的是测试预览会话（见第 6 步）。视频后端的实现在 [app/runtime_internal.py](../server/src/iclip/app/runtime_internal.py)，约定见 [conventions §21](../contract/conventions.md#21-后端给运行时的内部接口)。

## 3. 开会话、发消息、读记录

Python 应用用客户端库 [agent_runtime/client/](../runtime/src/agent_runtime/client/__init__.py) 的 `RuntimeClient`（每个接口一个带类型的方法，报错规则见[架构「客户端库」](architecture.md#客户端库)）。客户端库在 `agent_runtime` 包里，没有单独的客户端包，Python 应用按路径依赖 [runtime/](../runtime/pyproject.toml)，同视频后端的 [pyproject.toml](../server/pyproject.toml)；别的语言照 `runtime-openapi.json` 与 conventions §20 直接调。顺序：

1. `GET /v1/agents` 取能选的 agent（上菜单、在用、发布过）。
2. `POST /v1/sessions` 体 `{id, agent_id}` 开会话，固定这个 agent 此刻的当前版本。
3. `POST /v1/sessions/{id}/prompts` 发消息，体 `{prompt_id, content, user_name, agent_id}`，`X-End-User` 是会话的属主。`prompt_id` 是幂等键，`user_name` 是这条消息替谁发的标签，按应用自己的规则填。
4. 跟进：连对话内容流 `/v1/ws` 订这段会话（`subscribe_v2`）收 transcript 帧；连应用事件流 `/v1/events` 收本应用全部会话的忙闲。断线后用 `POST /v1/sessions:activities` 重新对齐忙闲。
5. 读回：`GET /v1/sessions/{id}/transcript?session_agent=<agent>` 读一页，`…/transcript/ops` 按水位补批，`…/status` 读运行状态。

停、插队、重新生成、审批、分叉、拷文件、工作区文件与素材台账都在同一组 `/v1/sessions/{id}/…` 路由下，见 `runtime-openapi.json`。

可以运行的样例：[test_second_app.py](../server/tests/integration_no_llm/runtime_service/test_second_app.py) 里的应用 `crm` 不配插件包，按上面的顺序跑通一段会话，并核对它与 `video` 互相寻址不到对方的会话。

## 4. 用户与可见性

- `X-End-User` 是会话的属主，不是正在看的人：工作区与素材台账按它分命名空间，新消息的属主记它。治理者替别人看对话时，应用照样填对话的属主。
- 运行时只认会话归不归调用方应用；别的应用的会话一律 `404`。同一个应用里谁能看哪段会话、能不能写，应用在转发之前自己判。视频后端在对话域判完再转，入口在 [transcript_api.py](../server/src/iclip/domains/agents/transcript_api.py) 与 [app/runtime_ports.py](../server/src/iclip/app/runtime_ports.py)。
- 运行时答 401、403 只说应用的密钥或权限不对，应用按运行时不可用处理，不当成用户没登录或无权限。

## 5. 转给浏览器

应用给浏览器的实时连接照视频后端的做法（[架构「浏览器连接与事件流」](architecture.md#浏览器连接与事件流)）：

- 每条浏览器连接对应一条 `/v1/ws`。浏览器的 `subscribe_v2` 先由应用核可见性，看不见的就地回 `not_found`，看得见的原样转过去；回执由运行时给，帧不解析、原文转给浏览器，运行时新加的帧与字段因此自动带到。
- `/v1/events` 每个进程连一条，按帧里的 `owner_user_id` 找该通知的浏览器连接，`preview` 为真的按应用自己的规则筛。
- 任一条上游断了，就关掉受影响的浏览器连接让它重连、重拉，断线期间的帧不补发。

## 6. 测试预览

`POST /v1/sessions` 体 `{id, preview: {agent_id, version_id}}` 开一段预览：`version_id` 为空试 agent 当下的草稿，每次运行重读；给了就试那一版。预览会话不能分叉、不能当拷文件的源或目标，不进 `/v1/stats`；事件流帧与回调请求体里 `preview` 为真。谁能开、谁能看由应用定，视频后端的规则见 [conventions §19「测试预览」](../contract/conventions.md#测试预览)。

## 7. 管理接口

`admin: true` 的应用能用 `/v1/admin`：技能库、模型供应商与默认模型、MCP 服务、agent 配置，子路径同视频后端的那几组端点。写操作在 `X-End-User` 给操作人 id，答复里只有 id，显示名由应用自己补。客户端库用 `admin_request` 原样转发；视频后端的转发在 [platform/runtime_admin.py](../server/src/iclip/platform/runtime_admin.py)。管理权限是整组的，不分哪一块。

## 8. 插件包（可选）

应用要给 agent 加自己的工具时写一个插件包：入口是 `PluginFactory`（[plugins/base.py](../runtime/src/agent_runtime/plugins/base.py)），运行时配置的 `plugins.factory` 指向它，`plugins.config` 原样交给它；插件约定见[架构「工具、插件与 MCP 服务」](architecture.md#工具插件与-mcp-服务)。插件要应用自己的服务时，照视频插件包的做法经 HTTP 调应用的内部接口：令牌从环境变量读，启动时核对应用开了哪些服务，见[架构「内部接口与视频插件包」](architecture.md#内部接口与视频插件包)。只用工具、不要应用服务的，可以改用管理员登记的 MCP 服务，不必写插件包。

## 现有限制

- agent 配置（agent、技能库、模型供应商、默认模型、MCP 服务）所有应用共用一份，`/v1/agents` 与 `/v1/titles` 也不分应用：每个应用看到同一份首页名册。
- 一份运行时配置只接一个插件包，插件登记表所有应用共用；现在的运行时镜像装的是 [deploy/runtime-video](../deploy/runtime-video/pyproject.toml)（运行时加视频插件包），新应用的插件包要进这个部署包或另建一个。
- `agent_runtime` 的表结构由视频后端的 Alembic 迁移维护（[server/migrations/](../server/migrations/versions/)），部署运行时就要跑这套迁移。
- 运行时只跑一个进程，见[架构 §1](architecture.md#1-两个服务)。
