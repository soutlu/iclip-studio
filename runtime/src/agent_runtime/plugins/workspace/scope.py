"""工作区插件的命名空间：从可信运行依赖取属主与对话 id。

主 Agent 与下属通过 AgentRunDeps 继承同一对话，不能使用下属新生成的 ctx.conversation_id。
命名空间的构造规则在 ``agent_runtime.file_store.namespace``。"""

from __future__ import annotations

from typing import Any

from pydantic_ai.tools import RunContext

from agent_runtime.file_store.namespace import namespace_for
from agent_runtime.run_deps import AgentRunDeps


def workspace_namespace(ctx: RunContext[Any]) -> str:
    """从可信运行依赖解析命名空间；依赖缺失或类型错误时直接失败，禁止退回公共空间。"""

    deps = ctx.deps
    if not isinstance(deps, AgentRunDeps):
        raise RuntimeError(
            f"工作区算不出命名空间：这次运行的 deps 是 {type(deps).__name__}，"
            "不是 AgentRunDeps——运行身份没有注入进来。"
        )
    return namespace_for(deps.user_id, deps.conversation_id)


__all__ = ["workspace_namespace"]
