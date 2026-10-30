"""Agent 配置端点的请求与响应形状，camelCase 别名；``config`` 是配置文档本身，字段照配置格式（snake_case），
与导出包里的一致。术语见 docs/CONTEXT.md「Agent 标识」等词条。"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

from iclip.common.agent_usage import AgentUsageOut
from iclip.domains.agent_config.config import AgentConfig
from iclip.domains.agent_config.models import AgentStatus


class CamelModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel, populate_by_name=True, extra="forbid", frozen=True
    )


class AgentProblemOut(CamelModel):
    path: str
    """指到配置里的字段，如 ``model.settings.thinking``、``tools[2]``、``subagents[0].agent``、
    ``skills[1]``；报在整体上为空串。"""
    message: str


class ActiveVersionOut(CamelModel):
    """当前版本的摘要。"""

    id: uuid.UUID
    version: int
    published_at: datetime


class AgentOut(CamelModel):
    id: str
    """标识，创建后不能改。"""
    name: str
    description: str
    """被当作子 agent 时给主 agent 看；不进版本，改了立即生效。"""
    status: AgentStatus
    listed: bool
    """在首页 Agent 菜单里列不列出。"""
    sort_order: int
    active_version: ActiveVersionOut | None
    """没发布过为 ``null``。"""
    has_unpublished_changes: bool
    """草稿的配置或技能名单与当前版本不同；没发布过恒为 ``true``。"""
    created_by: uuid.UUID
    created_at: datetime
    updated_at: datetime


class AgentsOut(CamelModel):
    items: list[AgentOut]
    """按 ``sortOrder`` 从小到大，同序按 ``createdAt`` 倒序。"""


class AgentDraftOut(CamelModel):
    config: AgentConfig
    skill_ids: list[uuid.UUID]
    """绑定的技能，按先后排。"""
    base_version_id: uuid.UUID | None
    lock_version: int
    """保存草稿、发布与恢复时带上；与库里对不上是 409。"""
    updated_by: uuid.UUID
    updated_at: datetime


class AgentDetailOut(AgentOut):
    draft: AgentDraftOut
    used_by: list[AgentUsageOut]
    """把这个 agent 当作子 agent 的 agent（草稿或当前版本里），按标识排。"""


class AgentCreateIn(CamelModel):
    id: str
    name: str
    description: str = ""


class AgentUpdateIn(CamelModel):
    """不给或给 ``null`` 的项不动。"""

    name: str | None = None
    description: str | None = None
    listed: bool | None = None


class AgentOrderIn(CamelModel):
    ids: list[str]
    """全部 agent 的标识（含已归档的），按想要的先后排，一个不多一个不少。"""


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
    """版本号从大到小。"""


class AgentVersionDetailOut(AgentVersionOut):
    config: AgentConfig
    skill_ids: list[uuid.UUID]
    """这一版冻结下来的技能，按先后排。"""


class AgentPublishProblemsOut(BaseModel):
    """发布被拦下的 422：``detail`` 是一句话，``problems`` 列出全部问题。"""

    detail: str
    problems: list[AgentProblemOut]


AgentImportAction = Literal["create", "overwrite"]
"""``create`` 新建一个只有草稿的 agent；``overwrite`` 覆盖同标识 agent 的草稿。"""


class AgentImportItemOut(CamelModel):
    agent_id: str
    name: str
    action: AgentImportAction
    problems: list[AgentProblemOut]
    """这个 agent 的问题，``path`` 相对它的配置（技能写成 ``skills[i]``）。"""
    warnings: list[AgentProblemOut]
    """不拦导入、但发布前要处理的：技能已归档或没发布过、供应商或模型已停用。"""


class AgentImportOut(CamelModel):
    """导入检查或导入的结果。只建或覆盖草稿，不发布。"""

    entry: str | None
    """读不出包时为 ``null``。"""
    agents: list[AgentImportItemOut]
    """按包里的先后。"""
    problems: list[AgentProblemOut]
    """整个包的问题（大小、YAML、格式版本、入口），``path`` 相对包本身。"""
    warnings: list[str]
    """只是提醒，不拦导入。"""


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
