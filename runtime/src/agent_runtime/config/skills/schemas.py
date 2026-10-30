"""技能库端点的请求与响应形状，camelCase 别名。术语见 docs/CONTEXT.md「技能库」。"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

from agent_runtime.agent_usage import AgentUsageOut
from agent_runtime.config.skills.models import SkillStatus


class CamelModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel, populate_by_name=True, extra="forbid", frozen=True
    )


class SkillFileOut(CamelModel):
    """清单里的一个文件。"""

    path: str
    size: int
    """按 UTF-8 编码后的字节数。"""
    hash: str
    """内容按 UTF-8 编码后的 sha256，十六进制。"""


class DraftFileInfoOut(SkillFileOut):
    updated_at: datetime


class SkillOut(CamelModel):
    id: uuid.UUID
    name: str
    """标识，创建后不能改。"""
    display_name: str
    description: str
    """发布时取这一版 ``SKILL.md`` 的 ``description``；还没发布过时取草稿里的。"""
    status: SkillStatus
    latest_version_id: uuid.UUID | None
    """没发布过为 ``null``。"""
    latest_version: int | None
    """最新版的版本号，从 1 起；没发布过为 ``null``。"""
    has_unpublished_changes: bool
    """草稿与最新版的内容不同；没发布过恒为 ``true``。"""
    created_by: uuid.UUID
    created_at: datetime
    updated_at: datetime


class SkillsOut(CamelModel):
    items: list[SkillOut]
    """按 ``createdAt`` 倒序。"""


class SkillDetailOut(SkillOut):
    draft_files: list[DraftFileInfoOut]
    """草稿的全部文件，按 ``path`` 排。"""
    used_by: list[AgentUsageOut]
    """草稿或当前版本绑定了这个技能的 agent，按 agent 标识排；它们还在用时不能归档。"""


class SkillCreateIn(CamelModel):
    """新建一个技能，同时生成一份带 frontmatter 的 ``SKILL.md`` 草稿。"""

    name: str
    display_name: str
    description: str


class SkillUpdateIn(CamelModel):
    display_name: str


class DraftFileOut(CamelModel):
    path: str
    content: str
    size: int
    hash: str
    updated_at: datetime


class DraftFileWriteIn(CamelModel):
    content: str
    base_hash: str | None
    """写之前读到的 ``hash``；新建文件给 ``null``。与库里对不上是 409。"""


class SkillPublishIn(CamelModel):
    note: str | None = None


class SkillVersionOut(CamelModel):
    id: uuid.UUID
    version: int
    note: str | None
    content_hash: str
    """清单的 sha256：内容相同的两版这个值相同。"""
    created_by: uuid.UUID
    created_at: datetime


class SkillVersionsOut(CamelModel):
    items: list[SkillVersionOut]
    """版本号从大到小。"""


class SkillVersionDetailOut(SkillVersionOut):
    files: list[SkillFileOut]
    """这一版的清单，按 ``path`` 排。"""


class SkillVersionFileOut(SkillFileOut):
    content: str


SkillImportAction = Literal["create", "overwrite"]
"""``create`` 新建一个技能；``overwrite`` 覆盖同名技能的草稿。"""


class SkillImportOut(CamelModel):
    """导入检查或导入的结果。只建或覆盖草稿，不发布。"""

    action: SkillImportAction | None
    """读不出合格的 ``name`` 时为 ``null``。"""
    skill_id: uuid.UUID | None
    """覆盖时是那个技能；新建的检查时为 ``null``，导入后是新技能。"""
    name: str | None
    display_name: str | None
    """``SKILL.md`` 第一个 ``# `` 标题，没有就用 ``name``。"""
    description: str | None
    files: list[SkillFileOut]
    """读出来的合格文件，按 ``path`` 排。"""
    problems: list[str]
    """全部问题，每条写明哪个文件、为什么不行；不为空时正式导入是 422。"""


__all__ = [
    "DraftFileInfoOut",
    "DraftFileOut",
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
    "SkillVersionsOut",
    "SkillsOut",
]
