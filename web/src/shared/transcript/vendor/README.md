# vendor：Transcript 协议数据层

本目录代码移植自 `@moonshot-ai/transcript`（仓库为 [MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code) 的 `packages/transcript`），基准对齐到上游提交 `c9f01f0`（2026-10-10），并已核对至 `a2afdbc`（2026-10-30）。开源许可证见 [LICENSE](LICENSE)。

本项目在此基础上做了定制扩展与裁剪，因此不是上游代码的原样拷贝。

## 本项目的定制改动

1. **工具卡片增加 `metadata` 字段**：用于承载展示给前端用户的结构化工具结果。类型定义在 [model/frame.ts](model/frame.ts)，Zod 校验在 [contract/schema.ts](contract/schema.ts)，相等性比较在 [ops/apply.ts](ops/apply.ts) 的 `frameEquals`，修改时需三处同步。
2. **用户消息统一用 `content` 数组保存原始消息块**：在轮次头部（Turn）和用户文本块中使用 `content` 替代了上游的 `prompt` 与 `attachmentIds`；保留了上游的 `triggerPromptId`（定义在 [model/turn.ts](model/turn.ts)），供前端乐观发送的气泡认领服务端返回的消息。
3. **裁剪不需要的模块**：未引入上游的 `history/` 目录（本项目的历史记录由运行时项目的 `src/agent_runtime/harness/transcript/from_messages.py` 负责生成），也未引入上游的 `origin` 与 `clientMetadata` 字段。
4. **测试覆盖**：[__tests__/](__tests__/) 验证本目录的 `content`、`metadata` 扩展与 Schema 边界；跨端协议对齐由外层的[金样测试（`golden.test.ts`）](../golden.test.ts)保障。

## 维护与升级边界

- 日常业务逻辑、WebSocket 连接管理与前端状态管理统一放在[上级目录（`src/shared/transcript/`）](../)，不在本 `vendor/` 目录内修改。
- 后续同步上游改动或调整跨端协议时，请逐项对比并保留上述定制扩展，切勿直接用上游目录整体覆盖；同时需同步核对运行时项目的协议定义 `src/agent_runtime/transcript/wire.py` 并更新金样测试。
