from __future__ import annotations

from iclip.platform.runtime_admin import AdminOut, CreatedByName, UpdatedByName
from iclip.platform.runtime_api.agent_usage import AgentUsageOut
from iclip.platform.runtime_api.config.agent_config.schemas import (
    AgentDraftOut as RuntimeAgentDraftOut,
)
from iclip.platform.runtime_api.config.agent_config.schemas import AgentOut as RuntimeAgentOut
from iclip.platform.runtime_api.config.agent_config.schemas import (
    AgentVersionDetailOut as RuntimeAgentVersionDetailOut,
)
from iclip.platform.runtime_api.config.agent_config.schemas import (
    AgentVersionOut as RuntimeAgentVersionOut,
)


class AgentOut(RuntimeAgentOut, CreatedByName):
    pass


class AgentsOut(AdminOut):
    items: list[AgentOut]


class AgentDraftOut(RuntimeAgentDraftOut, UpdatedByName):
    pass


class AgentDetailOut(AgentOut):
    draft: AgentDraftOut
    used_by: list[AgentUsageOut]


class AgentVersionOut(RuntimeAgentVersionOut, CreatedByName):
    pass


class AgentVersionsOut(AdminOut):
    items: list[AgentVersionOut]


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
