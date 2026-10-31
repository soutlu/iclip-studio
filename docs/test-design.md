# 测试规范

> 命令入口与交付检查见 [AGENTS.md](../AGENTS.md)，前端测试见 [实现规范](../web/docs/frontend-implementation.md#测试)。

## 1. 按行为选择测试层

优先验证用户可观察的结果或稳定契约：HTTP 状态与 payload、事件序列、持久化结果、文件产物。每个行为选一个主要测试层；同一断言在两层重复时保留靠近可观察边界的一份。unit 用于纯逻辑、进程内契约，或集成层无法经济触达的分支。

先确定被测责任，再选测试层和运行环境：

| 模块 | 主要验证责任 |
|---|---|
| `runtime/` | 通用运行规则、恢复、持久化与运行时协议；不解释应用身份与视频业务 |
| `plugins/video/` | 工具行为、视频文件与产物规则、插件端口协议 |
| `server/` | 应用身份与权限、业务规则和存储、跨服务装配与媒体适配 |
| `web/` | 界面行为、客户端协议消费与编辑算法；具体归层见前端实现规范 |
| `render/` | 渲染请求与队列、传输和实际成片产物 |

跨模块贯通测试验证接线与组合结果，各模块保留自身独有的失败与边界分支，不在每层重放完整业务矩阵。部分运行时 HTTP / PG 测试仍借用 `server/tests/` 的迁移和夹具；测试所在目录不改变被测责任。

| `server/tests/` 下的目录 | 验证范围 |
|---|---|
| `unit/` | 纯逻辑、配置与引擎装配等进程内契约；可用临时文件和模型替身，不连接真实数据库或外部服务 |
| `integration_no_llm/` | 真实 Postgres、应用装配、HTTP/WS 与存储往返；LLM、OSS、provider 使用替身 |
| `integration_llm/` | 真实模型的协议与结构 |
| `e2e_full/` | 依赖真实外部服务的全链路 |
| `helpers/` | 共用测试基建，不放测试用例 |

后端集成层的 app 由 [runtime_backed.py](../server/tests/helpers/runtime_backed.py) 连同运行时服务一起装：两边接同一个测试库，后端的运行时客户端与运行时的回调各经 ASGI 传输层直达对方；运行时的插件登记表默认是视频插件包始终登记的三个，要替身插件的用例覆写 `runtime_plugins` 夹具。不跑 lifespan 时消息照样跑完，两条 WebSocket 只在 `TestClient` 跑着组合 lifespan（先运行时、后后端）时才通。

marker 由 [tests/conftest.py](../server/tests/conftest.py) 按目录注入；测试树和私有符号导入由 [集合契约测试](../server/tests/unit/architecture/test_collection_contract.py) 检查。新增顶层测试层时同时更新这些入口和 [pyproject.toml](../server/pyproject.toml)，普通子目录不需要修改分层契约。

transcript 按场景测：[场景测试](../server/tests/integration_no_llm/agents/test_transcript_scenarios.py)用假模型跑真实运行，断言实时重放出的页与冷启动重建的页逐字相等，并把三个场景存成 `contract/transcript/` 下的金样（`UPDATE_GOLDEN=1` 重生成），前端 [golden 测试](../web/src/shared/transcript/golden.test.ts)用 vendored schema 解析同一份。只有历史才会遇到的规则留在 [历史重建单测](../runtime/tests/unit/harness/test_transcript_from_messages.py)，手工事件或官方模型解析协议流才能造出的形状留在 [投影器单测](../runtime/tests/unit/harness/test_transcript_projector.py)；新场景先进场景文件，不另开对照测试。

模块责任、测试层与执行分组分别判断。[CI](../.github/workflows/ci.yml) 的 `sessions` / `application` 是平衡耗时的执行分组，不代表模块归属；前端 Node / jsdom 是执行环境。具体文件选择以配置为准，分组调整须核对收集结果没有重复或遗漏。

## 2. 断言与替身

- 用例名称说明被测行为与预期结果，准备、操作、断言按阅读顺序组织；同一文件内按行为分组，权限、冲突与重试紧邻对应操作。
- 同一规则的分支用有可读标识的参数化表达；公共传输规则选代表入口，各入口独有的业务规则分别保留，避免把无关维度相乘。只有前提相同、不会互相改变状态的同一行为才共用一次装配，不为减少用例数合并独立流程。
- 断言结果，不记录并断言内部调用过程；不 import 或 monkeypatch 生产代码的下划线私有符号。
- 不对框架 kwargs 做快照。调用形状本身是稳定契约时，可以用一个集中的契约测试覆盖。
- 不对 prompt 或自然语言措辞做快照；只验证所需结构与行为。
- fake 只实现测试所需的最小状态，不复制生产业务逻辑。删除用例后同步删除其专用准备、分支与记录器；共用夹具只收场景确实共用的准备，不发展成另一套业务实现。
- 调整不合层的测试时，将有效行为覆盖迁移到合适层，再删除重复或依赖实现细节的断言。

## 3. Postgres 测试环境

[integration_no_llm/conftest.py](../server/tests/integration_no_llm/conftest.py) 按以下顺序提供数据库：

1. `TEST_DATABASE_URL` 非空时使用指定测试库。
2. 否则由 Testcontainers 启动一次性 Postgres，测试会话内复用。
3. 两者都不可用时，本地数据库测试跳过；报告结果时必须说明跳过范围。

`TEST_DATABASE_URL` 的约束见 [AGENTS.md](../AGENTS.md#1-命令与验证)；夹具会执行迁移并清空测试表。

CI 使用明确配置的 Postgres service container；连接失败应报错，不能依赖本地跳过路径。真实外部服务测试缺凭证时可以跳过；凭证齐备后的连接、协议或业务失败不得伪装成缺凭证。

新增 `iclip` 或 `agent_runtime` 的表时，把模块元数据纳入 [迁移对账测试](../server/tests/integration_no_llm/bootstrap/test_migrations.py) 的 `_MODULE_METADATA`。该测试只比较两个 schema 的表名与列名集合；列类型、可空性、索引、约束，以及 procrastinate 表的迁移需另行核对。

## 4. 验证边界

- SSO/PMS 自动化使用协议替身；接入变更还需按 [AGENTS.md](../AGENTS.md) 完成真实登录回调验收。
- LLM 自动化验证协议与结构，输出语义质量单独评估。
- cookie `Secure`、反向代理 WebSocket upgrade 等属性在实际部署链路验收。
- 连接断开后的行为需要真实传输边界验证；不能把 `httpx.ASGITransport` 的完整缓冲响应当作中途断连测试。
