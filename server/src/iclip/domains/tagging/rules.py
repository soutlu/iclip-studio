"""改标签树的规则：整理名称与判断说明，查层级、重名与 AI 打标的取值上限，排同级的先后。

都是纯函数，按调用方给的那一刻的树判断；服务在拿到写锁、读到当下的树之后调用，判断与写入在同一个
事务里。不合格是 ``ValidationFailed``，消息直接给人看。"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from dataclasses import dataclass

from iclip.common.errors import NotFound, ValidationFailed
from iclip.domains.tagging.models import (
    AI_VALUE_LIMIT,
    AUTO_FILL_AI,
    MAX_TAG_GUIDE_CHARS,
    MAX_TAG_NAME_CHARS,
    AutoFill,
    TagNode,
)

MAX_DEPTH = 3
"""维度是 0，取值最多三级，深度依次是 1、2、3。"""


@dataclass(frozen=True, slots=True)
class _Place:
    node: TagNode
    dimension: TagNode
    depth: int


def _places(tree: Sequence[TagNode]) -> dict[uuid.UUID, _Place]:
    found: dict[uuid.UUID, _Place] = {}

    def visit(node: TagNode, dimension: TagNode, depth: int) -> None:
        found[node.id] = _Place(node=node, dimension=dimension, depth=depth)
        for child in node.children:
            visit(child, dimension, depth + 1)

    for dimension in tree:
        visit(dimension, dimension, 0)
    return found


def clean_name(name: str) -> str:
    """去掉首尾空白；空的、超长的不收。"""

    cleaned = name.strip()
    if not cleaned:
        raise ValidationFailed("请填写名称")
    if len(cleaned) > MAX_TAG_NAME_CHARS:
        raise ValidationFailed(f"名称最多 {MAX_TAG_NAME_CHARS} 个字")
    return cleaned


def clean_guide(guide: str | None) -> str | None:
    """去掉首尾空白，空的当作没有；超长的不收。"""

    if guide is None:
        return None
    cleaned = guide.strip()
    if len(cleaned) > MAX_TAG_GUIDE_CHARS:
        raise ValidationFailed(f"判断说明最多 {MAX_TAG_GUIDE_CHARS} 个字")
    return cleaned or None


def ai_value_count(tree: Sequence[TagNode]) -> int:
    """``auto_fill = ai`` 的全部维度下的取值数，含小类。"""

    return sum(
        len(dimension.descendants()) for dimension in tree if dimension.auto_fill == AUTO_FILL_AI
    )


def _check_unique(
    tree: Sequence[TagNode], dimension: TagNode | None, name: str, *, self_id: uuid.UUID | None
) -> None:
    """维度之间不重名；同一维度里的取值不论哪一层都不重名。``self_id`` 是正在改名的那一个。"""

    if dimension is None:
        if any(one.name == name and one.id != self_id for one in tree):
            raise ValidationFailed(f"已有名为「{name}」的维度")
        return
    if any(one.name == name and one.id != self_id for one in dimension.descendants()):
        raise ValidationFailed(f"「{dimension.name}」中已有「{name}」")


def check_new(
    tree: Sequence[TagNode],
    *,
    parent_id: uuid.UUID | None,
    name: str,
    auto_fill: AutoFill | None,
) -> tuple[TagNode, ...]:
    """在 ``parent_id`` 下（``None`` 即新维度）加一个叫 ``name`` 的标签合不合规矩；交回它将来的同级，
    按现在的先后。``name`` 已整理过。"""

    if parent_id is None:
        _check_unique(tree, None, name, self_id=None)
        return tuple(tree)
    place = _places(tree).get(parent_id)
    if place is None:
        raise ValidationFailed("上级标签不存在")
    if place.depth >= MAX_DEPTH:
        raise ValidationFailed("标签最多三级，无法再添加下级")
    if auto_fill is not None:
        raise ValidationFailed("只有维度可设为 AI 打标")
    _check_unique(tree, place.dimension, name, self_id=None)
    if place.dimension.auto_fill == AUTO_FILL_AI:
        count = ai_value_count(tree)
        if count + 1 > AI_VALUE_LIMIT:
            raise ValidationFailed(f"AI 打标的取值最多 {AI_VALUE_LIMIT} 个，当前已有 {count} 个")
    return place.node.children


def check_change(
    tree: Sequence[TagNode],
    tag_id: uuid.UUID,
    *,
    name: str | None,
    auto_fill: AutoFill | None,
    sets_auto_fill: bool,
) -> tuple[TagNode, tuple[TagNode, ...]]:
    """改名（``name`` 不是 ``None`` 时，已整理过）或改 ``auto_fill``（``sets_auto_fill`` 为真时）合不合
    规矩；交回这个标签与它的同级（含自己，按现在的先后）。没有这个标签是 ``NotFound``。"""

    places = _places(tree)
    place = places.get(tag_id)
    if place is None:
        raise NotFound("标签不存在")
    node = place.node
    is_dimension = node.parent_id is None
    if name is not None and name != node.name:
        _check_unique(tree, None if is_dimension else place.dimension, name, self_id=node.id)
    if sets_auto_fill and auto_fill is not None:
        if not is_dimension:
            raise ValidationFailed("只有维度可设为 AI 打标")
        if node.auto_fill != AUTO_FILL_AI:
            total = ai_value_count(tree) + len(node.descendants())
            if total > AI_VALUE_LIMIT:
                raise ValidationFailed(
                    f"开启后 AI 打标的取值将有 {total} 个，超过上限 {AI_VALUE_LIMIT} 个"
                )
    if node.parent_id is None:
        return node, tuple(tree)
    return node, places[node.parent_id].node.children


def reorder(ids: Sequence[uuid.UUID], moving: uuid.UUID, index: int) -> list[uuid.UUID]:
    """把 ``moving`` 放到第 ``index`` 个（0 起），其余照原来的先后；超出范围夹到首尾。``moving`` 不在
    ``ids`` 里就是新来的，同样插进去。"""

    rest = [one for one in ids if one != moving]
    at = min(max(index, 0), len(rest))
    return [*rest[:at], moving, *rest[at:]]


__all__ = [
    "MAX_DEPTH",
    "ai_value_count",
    "check_change",
    "check_new",
    "clean_guide",
    "clean_name",
    "reorder",
]
