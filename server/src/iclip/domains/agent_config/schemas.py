"""Agent 配置端点的答复：运行时的答复模型加上操作人的显示名（见 ``iclip.platform.runtime_admin``）。
运行时只记操作人 id，名字由后端转发时补上；其余字段与运行时的同名模型一致。

带操作人的模型直接继承运行时的；装着它们的外层（列表、详情的草稿）换了字段类型，按同样的字段另写一份。"""

from __future__ import annotations

from agent_runtime.agent_usage import AgentUsageOut
from agent_runtime.config.agent_config.schemas import AgentDraftOut as RuntimeAgentDraftOut
from agent_runtime.config.agent_config.schemas import AgentOut as RuntimeAgentOut
from agent_runtime.config.agent_config.schemas import (
    AgentVersionDetailOut as RuntimeAgentVersionDetailOut,
)
from agent_runtime.config.agent_config.schemas import AgentVersionOut as RuntimeAgentVersionOut

from iclip.platform.runtime_admin import AdminOut, CreatedByName, UpdatedByName


class AgentOut(RuntimeAgentOut, CreatedByName):
    pass


class AgentsOut(AdminOut):
    items: list[AgentOut]
    """按 ``sortOrder`` 从小到大，同序按 ``createdAt`` 倒序。"""


class AgentDraftOut(RuntimeAgentDraftOut, UpdatedByName):
    pass


class AgentDetailOut(AgentOut):
    draft: AgentDraftOut
    used_by: list[AgentUsageOut]
    """把这个 agent 当作子 agent 的 agent（草稿或当前版本里），按标识排。"""


class AgentVersionOut(RuntimeAgentVersionOut, CreatedByName):
    pass


class AgentVersionsOut(AdminOut):
    items: list[AgentVersionOut]
    """版本号从大到小。"""


class AgentVersionDetailOut(RuntimeAgentVersionDetailOut, CreatedByName):
    pass


__all__ = [
    "AgentDetailOut",
    "AgentDraftOut",
    "AgentOut",
    "AgentVersionDetailOut",
    "AgentVersionOut",
    "AgentVersionsOut",
    "AgentsOut",
]
