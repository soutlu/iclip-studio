from __future__ import annotations

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

from iclip.platform.runtime_api.agent_usage import AgentUsageOut
from iclip.platform.runtime_api.config.skills.models import SkillStatus


class CamelModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel, populate_by_name=True, extra="forbid", frozen=True
    )


class SkillFileOut(CamelModel):
    """清单里的一个文件。"""

    path: str
    size: int
    hash: str


class DraftFileInfoOut(SkillFileOut):
    updated_at: datetime


class SkillOut(CamelModel):
    id: uuid.UUID
    name: str
    display_name: str
    description: str
    status: SkillStatus
    latest_version_id: uuid.UUID | None
    latest_version: int | None
    has_unpublished_changes: bool
    created_by: uuid.UUID
    created_at: datetime
    updated_at: datetime


class SkillDetailOut(SkillOut):
    draft_files: list[DraftFileInfoOut]
    used_by: list[AgentUsageOut]


class SkillCreateIn(CamelModel):
    """新建一个技能，同时生成一份带 frontmatter 的 ``SKILL.md`` 草稿。"""

    name: str
    display_name: str
    description: str


class SkillUpdateIn(CamelModel):
    """改显示名或标识，不给的项不动，至少给一项；都不进版本，保存即生效。"""

    display_name: str | None = None
    name: str | None = None


class DraftFileOut(CamelModel):
    path: str
    content: str
    size: int
    hash: str
    updated_at: datetime


class DraftFileWriteIn(CamelModel):
    content: str
    base_hash: str | None


class DraftFileRenameIn(CamelModel):
    """把草稿里的一个文件改到新路径，内容不变。"""

    source: str = Field(alias="from")
    target: str = Field(alias="to")
    base_hash: str


class SkillPublishIn(CamelModel):
    note: str | None = None


class SkillVersionOut(CamelModel):
    id: uuid.UUID
    version: int
    note: str | None
    content_hash: str
    created_by: uuid.UUID
    created_at: datetime


class SkillVersionDetailOut(SkillVersionOut):
    files: list[SkillFileOut]


class SkillVersionFileOut(SkillFileOut):
    content: str


SkillImportAction = Literal["create", "overwrite"]


class SkillImportOut(CamelModel):
    """导入检查或导入的结果。只建或覆盖草稿，不发布。"""

    action: SkillImportAction | None
    skill_id: uuid.UUID | None
    name: str | None
    display_name: str | None
    description: str | None
    files: list[SkillFileOut]
    problems: list[str]


__all__ = [
    "DraftFileInfoOut",
    "DraftFileOut",
    "DraftFileRenameIn",
    "DraftFileWriteIn",
    "SkillCreateIn",
    "SkillDetailOut",
    "SkillFileOut",
    "SkillImportAction",
    "SkillImportOut",
    "SkillOut",
    "SkillPublishIn",
    "SkillUpdateIn",
    "SkillVersionDetailOut",
    "SkillVersionFileOut",
    "SkillVersionOut",
]
