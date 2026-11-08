from __future__ import annotations

import uuid

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

from iclip.domains.tagging.models import AutoFill


class CamelModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel, populate_by_name=True, extra="forbid", frozen=True
    )


class TagCountsOut(CamelModel):
    """带这个标签或它任一下级的条目数。"""

    references: int
    hit_cases: int


class LibraryTagOut(CamelModel):
    """标签树的一个节点：顶层是维度，维度下最多三级取值。"""

    id: uuid.UUID
    name: str
    auto_fill: AutoFill | None
    guide: str | None
    position: int
    counts: TagCountsOut
    children: list[LibraryTagOut]


class LibraryTagsOut(CamelModel):
    dimensions: list[LibraryTagOut]


class LibraryTagCreateIn(CamelModel):
    """加一个维度或取值。名称、层级、重名与 AI 取值上限的规则见合同「标签」一节。"""

    parent_id: uuid.UUID | None = None
    name: str
    guide: str | None = None
    auto_fill: AutoFill | None = None
    position: int | None = None


class LibraryTagUpdateIn(CamelModel):
    """改一个标签，不给的项不动；上级改不了。"""

    name: str | None = None
    guide: str | None = None
    auto_fill: AutoFill | None = None
    position: int | None = None


__all__ = [
    "LibraryTagCreateIn",
    "LibraryTagOut",
    "LibraryTagUpdateIn",
    "LibraryTagsOut",
    "TagCountsOut",
]
