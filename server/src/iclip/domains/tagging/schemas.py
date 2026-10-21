"""资料库标签端点的响应形状，camelCase 别名。术语见 docs/CONTEXT.md「标签」。"""

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
    """灵感库里没移除的参考视频。"""
    hit_cases: int
    """爆款素材库里的素材片。"""


class LibraryTagOut(CamelModel):
    """标签树的一个节点：顶层是维度，下面是取值，取值下面还可以有一层。"""

    id: uuid.UUID
    name: str
    auto_fill: AutoFill | None
    """只有维度有值：``ai`` 是 AI 打这个维度，``null`` 只靠人填。取值恒为 ``null``。"""
    guide: str | None
    """怎么判断，打标提示词里也写这一句。"""
    position: int
    """同级里的先后，小的在前；``children`` 已按它排好。"""
    counts: TagCountsOut
    children: list[LibraryTagOut]


class LibraryTagsOut(CamelModel):
    dimensions: list[LibraryTagOut]
    """全部维度，按 ``position`` 排。"""


__all__ = ["LibraryTagOut", "LibraryTagsOut", "TagCountsOut"]
