# 测试规范

> 日常命令与提交前检查见 [AGENTS.md](../AGENTS.md)，前端测试细则见 [前端实现规范](../web/docs/frontend-implementation.md#测试)。

## 1. 按行为选择测试层

编写测试的核心原则是**验证外部可观察的结果与稳定契约**（例如 HTTP 状态码与返回体、WebSocket 事件序列、数据库落盘记录、生成的文件产物），而不是验证内部实现细节。每一项业务行为只选择一个最合适的测试层，不在多层重复写相同的断言。

### 各模块的核心验证责任

| 模块 | 主要测试责任 |
|---|---|
| `runtime/` | 通用 Agent 运行调度、崩溃恢复、数据库持久化与运行时接口协议（不涉及具体业务用户与视频逻辑） |
| `plugins/video/` | 视频工具的参数校验与执行行为、分镜与工程文件格式校验、插件与后端通信的端口协议 |
| `server/` | 用户身份与权限控制、各业务域规则与数据库读写、跨服务装配与音视频处理适配 |
| `web/` | 页面交互行为、实时流协议消费与编辑器纯算法（具体分层见[前端实现规范](../web/docs/frontend-implementation.md#测试)） |
| `render/` | 渲染请求校验、内存队列调度與真实 MP4 成片渲染产物 |

### `server/tests/` 目录分层

| 目录 | 测试范围与环境要求 |
|---|---|
| `unit/` | 纯函数逻辑、配置解析与对象装配检查；可使用临时文件和内存替身（Fake），不连接真实数据库或外部服务 |
| `integration_no_llm/` | 连接真实 PostgreSQL 数据库，测试完整的应用装配、HTTP/WebSocket 接口与数据库读写；大模型、OSS 与上游供应商使用替身 |
| `integration_llm/` | 连接真实大模型服务，验证模型调用协议与返回结构 |
| `e2e_full/` | 连接真实外部服务的全链路端到端测试 |
| `helpers/` | 共用测试工具与夹具（不放具体测试用例） |

**关键测试机制说明：**
- **后端与运行时联合测试夹具（[runtime_backed.py](../server/tests/helpers/runtime_backed.py)）**：后端集成测试会将「视频后端」与「运行时服务」一起启动并连接同一个测试数据库，两者之间通过内存 ASGI 传输层直接互相调用。需要替换默认插件时，可在测试中覆写 `runtime_plugins` 夹具。
- **Transcript 金样对齐测试（Golden Test）**：后端的[场景测试](../server/tests/integration_no_llm/agents/test_transcript_scenarios.py)使用假模型跑完真实运行流程，验证「实时流拼出的结果」与「从数据库历史重建的结果」完全一致，并将结果保存为 `contract/transcript/` 下的金样文件（设置 `UPDATE_GOLDEN=1` 可更新金样）；前端的 [golden.test.ts](../web/src/shared/transcript/golden.test.ts) 则直接读取同一份金样文件做解析测试，确保前后端协议绝对对齐。
- **自动标记与目录规范**：Pytest marker 由 [tests/conftest.py](../server/tests/conftest.py) 按所在目录自动注入；测试目录结构与禁止导入私有符号的规则由[集合契约测试](../server/tests/unit/architecture/test_collection_contract.py)自动检查。

---

## 2. 断言与替身（Fake）编写原则

- **按行为组织用例**：测试函数名应清晰表达「在什么条件下、执行什么操作、得到什么结果」；权限拒绝、并发冲突与幂等重试用例紧挨着对应的正常流程放置。
- **善用参数化测试**：针对同一规则的不同输入分支，优先使用带可读 ID 的 `@pytest.mark.parametrize`，避免复制粘贴大段相似代码。
- **只测结果、不绑架实现**：只对最终返回值或状态做断言，不要用 Mock 记录并断言内部私有函数的调用顺序，也严禁导入或 monkeypatch 以 `_` 开头的私有函数/属性。
- **不对自然语言文案做快照**：不要对提示词（Prompt）全文或普通报错措辞做字符串快照测试，只验证关键结构与错误码。
- **保持替身（Fake）极简**：测试替身只实现当前测试必需的最小状态，不在替身里把生产业务逻辑重写一遍；删除测试用例时，同步清理不再使用的专属夹具。

---

## 3. Postgres 测试环境

[integration_no_llm/conftest.py](../server/tests/integration_no_llm/conftest.py) 按以下优先级连接测试数据库：

1. 如果设置了环境变量 `TEST_DATABASE_URL`，则直接连接该测试库（**严禁指向真实业务数据库**，测试夹具会自动执行迁移并清空表数据）。
2. 如果未设置，则通过 `Testcontainers` 自动拉起一个临时的 PostgreSQL 容器并在整个测试会话内复用。
3. 如果本机既未设置 `TEST_DATABASE_URL`、也没有运行 Docker，本地数据库测试会自动跳过（汇报验证结果时必须明确说明跳过了数据库测试）。

> **迁移对账要求**：每当在 `iclip` 或 `agent_runtime` schema 中新增数据表时，必须将该模块的 SQLAlchemy 元数据加入[迁移对账测试](../server/tests/integration_no_llm/bootstrap/test_migrations.py)的 `_MODULE_METADATA` 中。由于该测试只自动比对表名和列名，字段类型、非空约束、索引以及 procrastinate 调度表的迁移仍需人工核对。

---

## 4. 自动化测试的边界

以下场景无法仅靠进程内自动化测试完全覆盖，需要在真实环境中验证：
- **企业 SSO / PMS 登录**：自动化测试使用协议替身；修改登录接入代码后，必须在本地走通一次真实的 SSO 登录回调（见 [AGENTS.md](../AGENTS.md)）。
- **大模型输出质量**：自动化测试只验证接口协议与结构，生成内容的质量需单独评估。
- **生产网关与网络断连**：Cookie 的 `Secure` 属性、Nginx 反向代理的 WebSocket Upgrade，以及客户端中途断网后的连接清理，需要在真实网络传输层验收（不能仅靠 `httpx.ASGITransport` 内存缓冲模拟）。
