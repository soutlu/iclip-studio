"""打标请求按给的 AI 维度现拼：字段 ``d1…dn``、取值只能是那一维度里的名字；解析只收清单里的名字，
名字换成 id，选了下级就去掉上级；模型调用失败按能不能再试落两种原因。"""

from __future__ import annotations

import json
import uuid

import httpx
import pytest

from iclip.app.library_tagging import (
    TAG_MAX_OUTPUT_TOKENS,
    TAG_REASONING_EFFORT,
    build_tag_request,
    parse_tag_answer,
)
from iclip.domains.tagging.models import TaggingFailed, TagNode
from tests.helpers.references import FakeArk, ark_pipeline, tag_answer


def node(name: str, *children: TagNode, guide: str | None = None) -> TagNode:
    own = uuid.uuid4()
    adopted = tuple(
        TagNode(
            id=child.id,
            parent_id=own,
            name=child.name,
            auto_fill=None,
            guide=child.guide,
            position=index,
            children=child.children,
        )
        for index, child in enumerate(children)
    )
    return TagNode(
        id=own, parent_id=None, name=name, auto_fill=None, guide=guide, position=0, children=adopted
    )


def dimension(name: str, *values: TagNode, guide: str | None = None) -> TagNode:
    own = node(name, *values, guide=guide)
    return TagNode(
        id=own.id,
        parent_id=None,
        name=own.name,
        auto_fill="ai",
        guide=own.guide,
        position=0,
        children=own.children,
    )


CATEGORY = dimension("品类", node("跑鞋"), node("拖鞋"), guide="看出场的产品")
STRUCTURE = dimension(
    "内容结构",
    node("开箱测评型", node("对比测评", guide="Comparison Battle"), guide="拆包装上手"),
    node("口播讲解型"),
)


def ids_of(dim: TagNode) -> dict[str, uuid.UUID]:
    return {one.name: one.id for one in dim.descendants()}


def test_each_dimension_is_one_field_limited_to_its_own_names() -> None:
    request = build_tag_request([CATEGORY, STRUCTURE])

    fmt = request.text_format
    assert (fmt["type"], fmt["strict"]) == ("json_schema", True)
    schema = fmt["schema"]
    assert schema["required"] == ["d1", "d2"]
    assert schema["additionalProperties"] is False
    assert schema["properties"]["d1"]["items"]["enum"] == ["跑鞋", "拖鞋"]
    assert schema["properties"]["d2"]["items"]["enum"] == ["开箱测评型", "对比测评", "口播讲解型"]
    for name in ("品类", "内容结构", "看出场的产品", "拆包装上手", "Comparison Battle"):
        assert name in request.system_prompt


def test_the_request_follows_the_dimensions_it_is_given() -> None:
    request = build_tag_request([STRUCTURE])

    assert list(request.text_format["schema"]["properties"]) == ["d1"]
    assert "品类" not in request.system_prompt


def test_names_become_ids_and_a_chosen_child_drops_its_parent() -> None:
    request = build_tag_request([CATEGORY, STRUCTURE])
    categories, structure = ids_of(CATEGORY), ids_of(STRUCTURE)
    raw = json.dumps({"d1": ["跑鞋", "跑鞋"], "d2": ["开箱测评型", "对比测评", "口播讲解型"]})

    assert parse_tag_answer(raw, request) == (
        categories["跑鞋"],
        structure["对比测评"],
        structure["口播讲解型"],
    )


def test_a_parent_alone_is_kept_and_empty_arrays_mean_nothing() -> None:
    request = build_tag_request([CATEGORY, STRUCTURE])

    assert parse_tag_answer('{"d1": [], "d2": ["开箱测评型"]}', request) == (
        ids_of(STRUCTURE)["开箱测评型"],
    )
    assert parse_tag_answer('{"d1": [], "d2": []}', request) == ()


@pytest.mark.parametrize(
    "raw",
    [
        pytest.param('{"d1": ["人字拖"], "d2": []}', id="unknown-name"),
        pytest.param('{"d1": ["对比测评"], "d2": []}', id="name-from-another-dimension"),
        pytest.param('{"d1": []}', id="missing-key"),
        pytest.param('{"d1": [], "d2": [], "d3": []}', id="extra-key"),
        pytest.param('{"d1": "跑鞋", "d2": []}', id="not-an-array"),
        pytest.param("```json\n{}\n```", id="not-json"),
        pytest.param("[]", id="not-an-object"),
    ],
)
def test_anything_off_list_or_malformed_fails_as_model_failed(raw: str) -> None:
    with pytest.raises(TaggingFailed) as caught:
        parse_tag_answer(raw, build_tag_request([CATEGORY, STRUCTURE]))
    assert caught.value.code == "model_failed"


def test_a_name_repeated_within_a_dimension_is_a_broken_tree() -> None:
    broken = dimension("场景", node("居家"), node("户外", node("居家")))

    with pytest.raises(RuntimeError, match="居家"):
        build_tag_request([broken])


async def test_the_call_sends_the_text_with_the_request_built_for_these_dimensions() -> None:
    ark = FakeArk(tag=tag_answer({"d1": ["拖鞋"]}))
    _, tagger = ark_pipeline(ark)

    assert await tagger.tag("一段拆解", [CATEGORY]) == (ids_of(CATEGORY)["拖鞋"],)

    (sent,) = ark.tag_requests
    system, user = sent["input"]
    assert system["role"] == "system"
    assert user["content"] == [{"type": "input_text", "text": "一段拆解"}]
    assert sent["text"] == {"format": build_tag_request([CATEGORY]).text_format}
    assert sent["reasoning"] == {"effort": TAG_REASONING_EFFORT}
    assert sent["max_output_tokens"] == TAG_MAX_OUTPUT_TOKENS


@pytest.mark.parametrize(
    ("answer", "code"),
    [
        pytest.param(httpx.Response(503, text="busy"), "model_call_failed", id="5xx"),
        pytest.param(httpx.ConnectError("refused"), "model_call_failed", id="unreachable"),
        pytest.param(httpx.Response(400, text="rejected"), "model_failed", id="rejected"),
    ],
)
async def test_call_failures_split_by_whether_another_try_may_help(
    answer: httpx.Response | Exception, code: str
) -> None:
    _, tagger = ark_pipeline(FakeArk(tag=answer))

    with pytest.raises(TaggingFailed) as caught:
        await tagger.tag("一段拆解", [CATEGORY])
    assert caught.value.code == code
