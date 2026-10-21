"""列表筛选选中的标签按维度分组：组按维度在树里的先后，上级连同全部下级，选维度即这一维度的全部
取值；不认识的 id 拒绝。"""

from __future__ import annotations

import uuid

import pytest

from iclip.common.errors import ValidationFailed
from iclip.domains.tagging.models import TagNode
from iclip.domains.tagging.service import expand_filter


def leaf(parent: uuid.UUID, name: str, position: int) -> TagNode:
    return TagNode(
        id=uuid.uuid4(), parent_id=parent, name=name, auto_fill=None, guide=None, position=position
    )


SCENE_ID, STRUCTURE_ID, REVIEW_ID = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
HOME, OUTDOOR = leaf(SCENE_ID, "居家", 0), leaf(SCENE_ID, "户外", 1)
UNBOX, COMPARE = leaf(REVIEW_ID, "标准开箱", 0), leaf(REVIEW_ID, "对比测评", 1)
REVIEW = TagNode(
    id=REVIEW_ID,
    parent_id=STRUCTURE_ID,
    name="开箱测评型",
    auto_fill=None,
    guide=None,
    position=0,
    children=(UNBOX, COMPARE),
)
TALK = leaf(STRUCTURE_ID, "口播讲解型", 1)
SCENE = TagNode(
    id=SCENE_ID,
    parent_id=None,
    name="场景",
    auto_fill="ai",
    guide=None,
    position=0,
    children=(HOME, OUTDOOR),
)
STRUCTURE = TagNode(
    id=STRUCTURE_ID,
    parent_id=None,
    name="内容结构",
    auto_fill="ai",
    guide=None,
    position=1,
    children=(REVIEW, TALK),
)
TREE = (SCENE, STRUCTURE)


def test_tags_group_by_dimension_in_tree_order() -> None:
    groups = expand_filter(TREE, [TALK.id, OUTDOOR.id, HOME.id])

    assert groups == ((OUTDOOR.id, HOME.id), (TALK.id,))


def test_a_parent_brings_all_its_children() -> None:
    assert expand_filter(TREE, [REVIEW.id]) == ((REVIEW.id, UNBOX.id, COMPARE.id),)


def test_a_child_alone_stays_alone() -> None:
    assert expand_filter(TREE, [COMPARE.id]) == ((COMPARE.id,),)


def test_a_dimension_means_any_of_its_values() -> None:
    assert expand_filter(TREE, [STRUCTURE.id]) == ((REVIEW.id, UNBOX.id, COMPARE.id, TALK.id),)


def test_an_unknown_tag_is_rejected() -> None:
    with pytest.raises(ValidationFailed):
        expand_filter(TREE, [uuid.uuid4()])
