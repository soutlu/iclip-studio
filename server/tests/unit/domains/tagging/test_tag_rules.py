"""改标签树的规则：名称与判断说明的整理，维度下最多三级取值，维度之间与同一维度里不论哪一层都不重名，
只有维度能设 AI 打标，AI 维度的取值合计不过上限；同级按给的位置重新排，超出范围夹到首尾。"""

from __future__ import annotations

import uuid

import pytest

from iclip.common.errors import NotFound, ValidationFailed
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
    reorder,
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


@pytest.mark.parametrize(
    ("name", "message"),
    [("", "请填写名称"), ("   ", "请填写名称"), ("字" * (MAX_TAG_NAME_CHARS + 1), "最多 50 个字")],
)
def test_blank_or_long_names_are_rejected(name: str, message: str) -> None:
    with pytest.raises(ValidationFailed, match=message):
        clean_name(name)


def test_guides_are_trimmed_and_blank_means_none() -> None:
    assert clean_guide(None) is None
    assert clean_guide("   ") is None
    assert clean_guide(" 看出场的产品 ") == "看出场的产品"
    assert clean_guide("字" * MAX_TAG_GUIDE_CHARS) == "字" * MAX_TAG_GUIDE_CHARS
    with pytest.raises(ValidationFailed, match="最多 1000 个字"):
        clean_guide("字" * (MAX_TAG_GUIDE_CHARS + 1))


def test_a_new_dimension_goes_among_the_dimensions() -> None:
    assert check_new(TREE, parent_id=None, name="品牌", auto_fill="ai") == TREE


def test_values_allow_three_levels_below_a_dimension_but_no_deeper() -> None:
    assert check_new(TREE, parent_id=STRUCTURE_ID, name="新大类", auto_fill=None) == (REVIEW, TALK)
    assert check_new(TREE, parent_id=REVIEW_ID, name="新小类", auto_fill=None) == (COMPARE,)
    assert check_new(TREE, parent_id=COMPARE.id, name="具体场景", auto_fill=None) == ()
    last = node("末级")
    deep = node("场景", children=(node("大类", children=(node("中类", children=(last,)),)),))
    with pytest.raises(ValidationFailed, match="标签最多三级"):
        check_new((deep,), parent_id=last.id, name="第四级", auto_fill=None)


def test_a_missing_parent_is_rejected() -> None:
    with pytest.raises(ValidationFailed, match="上级标签不存在"):
        check_new(TREE, parent_id=uuid.uuid4(), name="新取值", auto_fill=None)


@pytest.mark.parametrize(
    ("parent_id", "name", "message"),
    [
        (None, "内容结构", "已有名为「内容结构」的维度"),
        (STRUCTURE_ID, "对比测评", "「内容结构」中已有「对比测评」"),
        (REVIEW_ID, "口播讲解型", "「内容结构」中已有「口播讲解型」"),
    ],
)
def test_names_are_unique_among_dimensions_and_across_levels_of_one_dimension(
    parent_id: uuid.UUID | None, name: str, message: str
) -> None:
    with pytest.raises(ValidationFailed, match=message):
        check_new(TREE, parent_id=parent_id, name=name, auto_fill=None)


def test_the_same_name_may_appear_in_another_dimension() -> None:
    check_new(TREE, parent_id=CHANNEL_ID, name="对比测评", auto_fill=None)


def test_auto_fill_is_only_for_dimensions() -> None:
    with pytest.raises(ValidationFailed, match="只有维度可设为 AI 打标"):
        check_new(TREE, parent_id=STRUCTURE_ID, name="新大类", auto_fill="ai")
    with pytest.raises(ValidationFailed, match="只有维度可设为 AI 打标"):
        check_change(TREE, TALK.id, name=None, auto_fill="ai", sets_auto_fill=True)
    check_change(TREE, TALK.id, name=None, auto_fill=None, sets_auto_fill=True)


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


def test_changing_a_missing_tag_is_not_found() -> None:
    with pytest.raises(NotFound):
        check_change(TREE, uuid.uuid4(), name="随便", auto_fill=None, sets_auto_fill=False)


A, B, C, D = (uuid.uuid4() for _ in range(4))


@pytest.mark.parametrize(
    ("moving", "index", "expected"),
    [
        (C, 0, [C, A, B, D]),
        (A, 2, [B, C, A, D]),
        (B, 3, [A, C, D, B]),
        (B, 99, [A, C, D, B]),
        (C, -5, [C, A, B, D]),
    ],
)
def test_reorder_moves_within_siblings_and_clamps(
    moving: uuid.UUID, index: int, expected: list[uuid.UUID]
) -> None:
    assert reorder([A, B, C, D], moving, index) == expected


def test_reorder_inserts_a_newcomer() -> None:
    new = uuid.uuid4()
    assert reorder([A, B], new, 1) == [A, new, B]
    assert reorder([A, B], new, 2) == [A, B, new]
