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
    """标签树的一个节点：顶层是维度，维度下最多三级取值。"""

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


class LibraryTagCreateIn(CamelModel):
    """加一个维度或取值。名称、层级、重名与 AI 取值上限的规则见合同「标签」一节。"""

    parent_id: uuid.UUID | None = None
    """上级；不给或 ``null`` 是加一个维度。"""
    name: str
    guide: str | None = None
    auto_fill: AutoFill | None = None
    """只有维度能给。"""
    position: int | None = None
    """排到同级里的第几个（0 起），超出范围夹到首尾；不给排在最后。"""


class LibraryTagUpdateIn(CamelModel):
    """改一个标签，不给的项不动；上级改不了。"""

    name: str | None = None
    """不给或 ``null`` 不改。"""
    guide: str | None = None
    """给了 ``null`` 或空串就清掉。"""
    auto_fill: AutoFill | None = None
    """只有维度能设 ``ai``；给了 ``null`` 是改回只靠人填。"""
    position: int | None = None
    """移到同级里的第几个（0 起），超出范围夹到首尾；不给或 ``null`` 不动。"""


__all__ = [
    "LibraryTagCreateIn",
    "LibraryTagOut",
    "LibraryTagUpdateIn",
    "LibraryTagsOut",
    "TagCountsOut",
]
