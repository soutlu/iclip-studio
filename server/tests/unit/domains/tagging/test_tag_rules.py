"""标签纯规则的边界：长度上限、跨维度同名、AI 取值计数与改名时排除自身。"""

from __future__ import annotations

import uuid

import pytest
from agent_runtime.errors import ValidationFailed

from iclip.domains.tagging.models import (
    AI_VALUE_LIMIT,
    MAX_TAG_GUIDE_CHARS,
    MAX_TAG_NAME_CHARS,
    AutoFill,
    TagNode,
)
from iclip.domains.tagging.rules import (
    ai_value_count,
    check_change,
    check_new,
    clean_guide,
    clean_name,
)


def node(
    name: str,
    *,
    parent: uuid.UUID | None = None,
    auto_fill: AutoFill | None = None,
    children: tuple[TagNode, ...] = (),
    node_id: uuid.UUID | None = None,
) -> TagNode:
    return TagNode(
        id=node_id or uuid.uuid4(),
        parent_id=parent,
        name=name,
        auto_fill=auto_fill,
        guide=None,
        position=0,
        children=children,
    )


def leaves(parent: uuid.UUID, count: int, prefix: str = "取值") -> tuple[TagNode, ...]:
    return tuple(node(f"{prefix}{index}", parent=parent) for index in range(count))


CHANNEL_ID, STRUCTURE_ID, REVIEW_ID = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
AMZ = node("AMZ", parent=CHANNEL_ID)
COMPARE = node("对比测评", parent=REVIEW_ID)
REVIEW = node("开箱测评型", parent=STRUCTURE_ID, children=(COMPARE,), node_id=REVIEW_ID)
TALK = node("口播讲解型", parent=STRUCTURE_ID)
CHANNEL = node("平台&渠道", children=(AMZ,), node_id=CHANNEL_ID)
STRUCTURE = node("内容结构", auto_fill="ai", children=(REVIEW, TALK), node_id=STRUCTURE_ID)
TREE = (CHANNEL, STRUCTURE)


def test_names_are_trimmed() -> None:
    assert clean_name("  新取值 \n") == "新取值"
    assert clean_name("字" * MAX_TAG_NAME_CHARS) == "字" * MAX_TAG_NAME_CHARS


def test_guides_are_trimmed_and_blank_means_none() -> None:
    assert clean_guide(None) is None
    assert clean_guide("   ") is None
    assert clean_guide(" 看出场的产品 ") == "看出场的产品"
    assert clean_guide("字" * MAX_TAG_GUIDE_CHARS) == "字" * MAX_TAG_GUIDE_CHARS
    with pytest.raises(ValidationFailed, match="最多 1000 个字"):
        clean_guide("字" * (MAX_TAG_GUIDE_CHARS + 1))


def test_the_same_name_may_appear_in_another_dimension() -> None:
    check_new(TREE, parent_id=CHANNEL_ID, name="对比测评", auto_fill=None)


def test_ai_values_count_every_level_of_ai_dimensions_only() -> None:
    assert ai_value_count(TREE) == 3


def ai_tree(ai_values: int, manual_values: int) -> tuple[TagNode, ...]:
    ai_id, manual_id = uuid.uuid4(), uuid.uuid4()
    return (
        node("AI", auto_fill="ai", children=leaves(ai_id, ai_values), node_id=ai_id),
        node("人工", children=leaves(manual_id, manual_values), node_id=manual_id),
    )


def test_adding_to_an_ai_dimension_stops_at_the_limit() -> None:
    below = ai_tree(AI_VALUE_LIMIT - 1, 0)
    check_new(below, parent_id=below[0].id, name="最后一个", auto_fill=None)

    full = ai_tree(AI_VALUE_LIMIT, 0)
    with pytest.raises(ValidationFailed, match=f"最多 {AI_VALUE_LIMIT} 个，当前已有 500 个"):
        check_new(full, parent_id=full[0].id, name="多一个", auto_fill=None)
    check_new(full, parent_id=full[1].id, name="人工维度不受限", auto_fill=None)


def test_switching_a_dimension_to_ai_counts_its_values_against_the_limit() -> None:
    fits = ai_tree(AI_VALUE_LIMIT - 10, 10)
    check_change(fits, fits[1].id, name=None, auto_fill="ai", sets_auto_fill=True)

    over = ai_tree(AI_VALUE_LIMIT - 10, 11)
    with pytest.raises(ValidationFailed, match="将有 501 个，超过上限 500 个"):
        check_change(over, over[1].id, name=None, auto_fill="ai", sets_auto_fill=True)
    # 已经是 AI 的维度再设一次不重算。
    full = ai_tree(AI_VALUE_LIMIT, 0)
    check_change(full, full[0].id, name=None, auto_fill="ai", sets_auto_fill=True)


def test_renaming_checks_names_but_not_against_itself() -> None:
    assert check_change(TREE, TALK.id, name="口播讲解型", auto_fill=None, sets_auto_fill=False) == (
        TALK,
        (REVIEW, TALK),
    )
    assert check_change(TREE, CHANNEL_ID, name="渠道", auto_fill=None, sets_auto_fill=False) == (
        CHANNEL,
        TREE,
    )
    with pytest.raises(ValidationFailed, match="「内容结构」中已有「开箱测评型」"):
        check_change(TREE, COMPARE.id, name="开箱测评型", auto_fill=None, sets_auto_fill=False)
    with pytest.raises(ValidationFailed, match="已有名为「平台&渠道」的维度"):
        check_change(TREE, STRUCTURE_ID, name="平台&渠道", auto_fill=None, sets_auto_fill=False)
