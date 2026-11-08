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
    cleaned = name.strip()
    if not cleaned:
        raise ValidationFailed("请填写名称")
    if len(cleaned) > MAX_TAG_NAME_CHARS:
        raise ValidationFailed(f"名称最多 {MAX_TAG_NAME_CHARS} 个字")
    return cleaned


def clean_guide(guide: str | None) -> str | None:
    if guide is None:
        return None
    cleaned = guide.strip()
    if len(cleaned) > MAX_TAG_GUIDE_CHARS:
        raise ValidationFailed(f"判断说明最多 {MAX_TAG_GUIDE_CHARS} 个字")
    return cleaned or None


def ai_value_count(tree: Sequence[TagNode]) -> int:
    return sum(
        len(dimension.descendants()) for dimension in tree if dimension.auto_fill == AUTO_FILL_AI
    )


def _check_unique(
    tree: Sequence[TagNode], dimension: TagNode | None, name: str, *, self_id: uuid.UUID | None
) -> None:
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
