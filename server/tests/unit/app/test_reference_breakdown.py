"""参考视频打标的请求形状与解析：提示词由两份清单生成，用户消息只放拆解全文，输出格式取
``TAG_FORMAT``；解析只收清单里的值，坏的一律算打标失败。另验证 AI 导演那一侧的适配：参考视频的
结果换成导演端口的文档或失败原因。"""

from __future__ import annotations

import json
from typing import cast

import pytest

from iclip.app.reference_breakdown import (
    TAG_FORMAT,
    TAG_MAX_OUTPUT_TOKENS,
    TAG_REASONING_EFFORT,
    ReferenceBreakdownsAdapter,
    parse_tags,
)
from iclip.capabilities.iclip_studio.ports import FailedBreakdown
from iclip.domains.identity.public import Principal
from iclip.domains.references.models import (
    CATEGORIES,
    VIDEO_TYPES,
    Outcome,
    TaggingFailed,
    Tags,
)
from iclip.domains.references.service import ReferenceService
from tests.helpers.references import DOCUMENT, VIDEO, FakeArk, ark_pipeline


async def test_tagging_sends_the_document_alone_with_a_prompt_built_from_both_lists() -> None:
    ark = FakeArk()
    _, tagger = ark_pipeline(ark)

    assert await tagger.tag(DOCUMENT) == Tags(video_types=("review",), categories=("跑鞋",))

    (request,) = ark.tag_requests
    system, user = request["input"]
    assert user["content"] == [{"type": "input_text", "text": DOCUMENT}]
    (system_part,) = system["content"]
    prompt = system_part["text"]
    for one in VIDEO_TYPES:
        assert f"- {one.value} {one.label}：{one.rule}" in prompt
    assert "、".join(CATEGORIES) in prompt
    assert request["text"] == {"format": TAG_FORMAT}
    assert request["reasoning"] == {"effort": TAG_REASONING_EFFORT}
    assert request["max_output_tokens"] == TAG_MAX_OUTPUT_TOKENS


def test_the_output_format_only_allows_listed_values() -> None:
    properties = TAG_FORMAT["schema"]["properties"]
    assert properties["videoTypes"]["items"]["enum"] == [one.value for one in VIDEO_TYPES]
    assert properties["categories"]["items"]["enum"] == list(CATEGORIES)
    assert (TAG_FORMAT["type"], TAG_FORMAT["strict"]) == ("json_schema", True)


def test_the_category_list_holds_the_56_names() -> None:
    assert len(CATEGORIES) == 56
    assert len(set(CATEGORIES)) == 56
    assert len(VIDEO_TYPES) == 8


def test_parsing_deduplicates_and_keeps_order() -> None:
    raw = json.dumps(
        {"videoTypes": ["try_on", "review", "try_on"], "categories": ["袜子", "跑鞋", "袜子"]}
    )

    assert parse_tags(raw) == Tags(video_types=("try_on", "review"), categories=("袜子", "跑鞋"))


def test_empty_arrays_mean_untagged() -> None:
    assert parse_tags('{"videoTypes": [], "categories": []}') == Tags()


class FixedReferences:
    """参考视频服务的替身：``ensure`` 交回给定的结果。"""

    def __init__(self, outcome: Outcome) -> None:
        self._outcome = outcome

    async def ensure(self, principal: Principal, video_url: str) -> Outcome:
        return self._outcome


def director_adapter(outcome: Outcome) -> ReferenceBreakdownsAdapter:
    return ReferenceBreakdownsAdapter(cast("ReferenceService", FixedReferences(outcome)))


PRINCIPAL = cast("Principal", object())


async def test_the_director_gets_the_document_of_the_reference_video() -> None:
    adapter = director_adapter(Outcome(document=DOCUMENT))

    assert await adapter.ensure(PRINCIPAL, VIDEO) == DOCUMENT


async def test_the_director_gets_the_reason_a_breakdown_failed() -> None:
    adapter = director_adapter(Outcome(document=None, error_code="video_unreadable"))

    assert await adapter.ensure(PRINCIPAL, VIDEO) == FailedBreakdown(reason="video_unreadable")


async def test_an_outcome_with_neither_document_nor_reason_is_a_bug() -> None:
    with pytest.raises(RuntimeError, match="既没有文档也没有失败原因"):
        await director_adapter(Outcome(document=None)).ensure(PRINCIPAL, VIDEO)


@pytest.mark.parametrize(
    "raw",
    [
        pytest.param('{"videoTypes": ["review"], "categories": ["人字拖"]}', id="unknown-category"),
        pytest.param('{"videoTypes": ["vlog"], "categories": []}', id="unknown-type"),
        pytest.param('{"videoTypes": ["review"]}', id="missing-key"),
        pytest.param('{"videoTypes": [], "categories": [], "brand": "x"}', id="extra-key"),
        pytest.param('{"videoTypes": "review", "categories": []}', id="not-an-array"),
        pytest.param("```json\n{}\n```", id="not-json"),
        pytest.param("[]", id="not-an-object"),
    ],
)
def test_anything_off_list_or_malformed_fails_tagging(raw: str) -> None:
    with pytest.raises(TaggingFailed):
        parse_tags(raw)
