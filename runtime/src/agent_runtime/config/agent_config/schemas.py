from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

from agent_runtime.agent_usage import AgentUsageOut
from agent_runtime.config.agent_config.config import AgentConfig
from agent_runtime.config.agent_config.models import AgentStatus


class CamelModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel, populate_by_name=True, extra="forbid", frozen=True
    )


class AgentProblemOut(CamelModel):
    path: str
    message: str


class ActiveVersionOut(CamelModel):
    """当前版本的摘要。"""

    id: uuid.UUID
    version: int
    published_at: datetime


class AgentOut(CamelModel):
    id: str
    name: str
    description: str
    status: AgentStatus
    listed: bool
    sort_order: int
    active_version: ActiveVersionOut | None
    has_unpublished_changes: bool
    has_subagents: bool
    is_subagent: bool
    created_by: uuid.UUID
    created_at: datetime
    updated_at: datetime


class AgentsOut(CamelModel):
    items: list[AgentOut]


class AgentPluginOut(CamelModel):
    name: str
    label: str
    description: str
    requires: list[str]
    parameters: dict[str, Any]


class AgentPluginsOut(CamelModel):
    items: list[AgentPluginOut]


class AgentDraftOut(CamelModel):
    config: AgentConfig
    skill_ids: list[uuid.UUID]
    base_version_id: uuid.UUID | None
    lock_version: int
    updated_by: uuid.UUID
    updated_at: datetime


class AgentDetailOut(AgentOut):
    draft: AgentDraftOut
    used_by: list[AgentUsageOut]


class AgentCreateIn(CamelModel):
    id: str
    name: str
    description: str = ""
    listed: bool = False


class AgentUpdateIn(CamelModel):
    """不给或给 ``null`` 的项不动。"""

    name: str | None = None
    description: str | None = None
    listed: bool | None = None


class AgentOrderIn(CamelModel):
    ids: list[str]


class AgentDraftIn(CamelModel):
    config: AgentConfig
    skill_ids: list[uuid.UUID]
    lock_version: int


class AgentPublishIn(CamelModel):
    note: str | None = None
    lock_version: int


class AgentRestoreIn(CamelModel):
    lock_version: int


class AgentVersionOut(CamelModel):
    id: uuid.UUID
    version: int
    note: str | None
    created_by: uuid.UUID
    created_at: datetime


class AgentVersionsOut(CamelModel):
    items: list[AgentVersionOut]


class AgentVersionDetailOut(AgentVersionOut):
    config: AgentConfig
    skill_ids: list[uuid.UUID]


class AgentPublishProblemsOut(BaseModel):
    """发布被拦下的 422：``detail`` 是一句话，``problems`` 列出全部问题。"""

    detail: str
    problems: list[AgentProblemOut]


AgentImportAction = Literal["create", "overwrite"]


class AgentImportItemOut(CamelModel):
    agent_id: str
    name: str
    action: AgentImportAction
    problems: list[AgentProblemOut]
    warnings: list[AgentProblemOut]


class AgentImportOut(CamelModel):
    """导入检查或导入的结果。只建或覆盖草稿，不发布。"""

    entry: str | None
    agents: list[AgentImportItemOut]
    problems: list[AgentProblemOut]
    warnings: list[str]


__all__ = [
    "ActiveVersionOut",
    "AgentCreateIn",
    "AgentDetailOut",
    "AgentDraftIn",
    "AgentDraftOut",
    "AgentImportAction",
    "AgentImportItemOut",
    "AgentImportOut",
    "AgentOrderIn",
    "AgentOut",
    "AgentProblemOut",
    "AgentPublishIn",
    "AgentPublishProblemsOut",
    "AgentRestoreIn",
    "AgentUpdateIn",
    "AgentVersionDetailOut",
    "AgentVersionOut",
    "AgentVersionsOut",
    "AgentsOut",
]
