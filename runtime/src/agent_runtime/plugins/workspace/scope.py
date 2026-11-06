from __future__ import annotations

from typing import Any

from pydantic_ai.tools import RunContext

from agent_runtime.file_store.namespace import namespace_for
from agent_runtime.run_deps import AgentRunDeps


def workspace_namespace(ctx: RunContext[Any]) -> str:
    deps = ctx.deps
    if not isinstance(deps, AgentRunDeps):
        raise RuntimeError(
            f"工作区算不出命名空间：这次运行的 deps 是 {type(deps).__name__}，"
            "不是 AgentRunDeps——运行身份没有注入进来。"
        )
    return namespace_for(deps.user_id, deps.conversation_id)


__all__ = ["workspace_namespace"]
