"""agents 域对外暴露的类型。"""

from __future__ import annotations

import uuid
from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class AgentRunDeps:
    """运行属主与对话上下文，通过 ctx.deps 继承至下属运行。

    下属运行的 ctx.conversation_id 可能重新生成，工作区隔离必须使用这里继承的对话 id。
    user_id 是消息记录的属主，可信，由服务端按消息行给出；需要授权的工具每次调用时按它重建主体。
    conversation_id 仅作属主之下的隔离维度，不能单独决定访问范围。
    user_name 是这次运行替谁跑的归属标签，工具把它发给上游落表；它不是身份，不参与授权。
    preview 来自会话创建时固定的类型；预览产物不挂到业务对话，工作区仍按 conversation_id 隔离。"""

    user_id: uuid.UUID
    conversation_id: str
    user_name: str
    preview: bool = False


def conversation_of(deps: object) -> str | None:
    """用量台账的 ``conversation_of``：按运行依赖认出这次模型调用属于哪段对话，deps 不是
    ``AgentRunDeps`` 时为 None（台账记一条 warning、不记账）。"""

    return deps.conversation_id if isinstance(deps, AgentRunDeps) else None


__all__ = ["AgentRunDeps", "conversation_of"]
