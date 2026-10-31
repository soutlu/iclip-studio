"""成片草稿的时间线、跨轨标识与字幕唯一性；字段声明由生成合同表达。"""

from __future__ import annotations

import uuid
from typing import Any

import pytest
from pydantic import ValidationError

from iclip.domains.conversations.whole_film_schemas import (
    MAX_CAPTION_EDITS,
    MAX_CAPTION_TEXT_CHARS,
    MAX_FILM_MS,
    MAX_LAYER0_CLIPS,
    MAX_OVERLAYS,
    MIN_CLIP_MS,
    WholeFilmDocument,
)
from tests.helpers.whole_film import butted, component_clip, draft_document, overlay, video_clip

SOURCE = uuid.uuid4()
SUBTITLE = uuid.uuid4()

Document = dict[str, Any]

FIELD_BOUND = ""
"""字段自身的边界（长度、范围、类型）由 pydantic 报，只断言被拒，不看措辞。"""


def parse(document: Document) -> WholeFilmDocument:
    return WholeFilmDocument.model_validate(document)


def rejected(document: Document) -> str:
    """不合规矩的文档报的那一句；只取第一条，与 HTTP 422 的 ``detail`` 同一来源。"""

    with pytest.raises(ValidationError) as caught:
        parse(document)
    return str(caught.value.errors()[0]["msg"])


def edit(index: int, text: str = "改过的字") -> dict[str, Any]:
    return {"subtitleJobId": str(SUBTITLE), "sentenceIndex": index, "text": text}


def test_a_full_draft_round_trips_its_wire_shape() -> None:
    """组件段夹在两段视频之间、改字、关掉并挪过、缩放旋转过的字幕、音乐与不同行上相互重叠、挪过位置
    又缩放旋转过的特效块都在：按 camelCase 原样读出来。"""

    document = draft_document(
        layer0=[
            component_clip("c1", start=0, duration=2000),
            video_clip("a", start=2000, duration=3000, source_job_id=SOURCE, playback_start=500),
            component_clip("c2", start=5000, duration=1000, playback_start=400),
            video_clip("b", start=6000, duration=2000, source_job_id=SOURCE, volume=0),
        ],
        edits=[edit(0), edit(1)],
        captions_variables={"font": "Sample Sans"},
        captions_hidden=True,
        captions_at=(0, -240),
        captions_scale=0.8,
        captions_rotation=-12.5,
        captions_pivot=(540, 1500),
        music={"jobId": str(uuid.uuid4()), "offset": 1200, "volume": 0.6},
        overlays=[
            overlay(
                "o2",
                start=6000,
                duration=3000,
                track=1,
                z_index=2,
                x=-36,
                y=410,
                scale=1.5,
                rotation=180,
                pivot=(-20, 4096),
            ),
            overlay("o1", start=0, duration=7000, track=0, z_index=1, playback_start=250),
        ],
    )

    parsed = parse(document)

    assert parsed.model_dump(mode="json", by_alias=True) == document
    # 画面轨 8 秒，o2 到 9 秒结束：成片到所有轨上内容的最远结束
    assert parsed.total_ms() == 9000
    assert parsed.video_sources() == (SOURCE,)


def test_total_is_the_farthest_end_on_any_track() -> None:
    layer = butted([("a", 3000)], source_job_id=SOURCE)

    assert parse(draft_document(layer0=layer)).total_ms() == 3000
    inside = [overlay("o", start=0, duration=1000)]
    assert parse(draft_document(layer0=layer, overlays=inside)).total_ms() == 3000
    beyond = [overlay("o", start=2000, duration=4500)]
    assert parse(draft_document(layer0=layer, overlays=beyond)).total_ms() == 6500
    assert parse(draft_document(layer0=[], overlays=beyond)).total_ms() == 6500


def test_an_empty_timeline_is_a_valid_draft() -> None:
    parsed = parse(draft_document(layer0=[]))

    assert parsed.total_ms() == 0


def test_a_film_of_component_clips_only_is_valid() -> None:
    parsed = parse(
        draft_document(
            layer0=[
                component_clip("c1", start=0, duration=2000),
                component_clip("c2", start=2000, duration=3000),
            ]
        )
    )

    assert (parsed.total_ms(), parsed.video_sources()) == (5000, ())


@pytest.mark.parametrize(
    ("durations", "accepted"),
    [
        pytest.param([MIN_CLIP_MS, 1000], True, id="恰好 100 毫秒"),
        pytest.param([MIN_CLIP_MS - 1, 1000], False, id="不到 100 毫秒"),
        pytest.param([MAX_FILM_MS - 1000, 1000], True, id="恰好两分钟"),
        pytest.param([MAX_FILM_MS - 1000, 1001], False, id="超过两分钟"),
    ],
)
def test_clip_and_film_durations(durations: list[int], accepted: bool) -> None:
    document = draft_document(
        layer0=butted([("a", durations[0]), ("b", durations[1])], source_job_id=SOURCE)
    )

    if accepted:
        parse(document)
    else:
        message = rejected(document)
        if sum(durations) > MAX_FILM_MS:
            assert "上限" in message


def test_layer0_holds_any_number_of_clips_up_to_two_minutes() -> None:
    """视频段不设段数上限：两分钟按最短时长排满可以，再多一段就超出（防大包的上限也在这里）。"""

    full = butted(
        [(f"c{index}", MIN_CLIP_MS) for index in range(MAX_LAYER0_CLIPS)], source_job_id=SOURCE
    )
    parse(draft_document(layer0=full))

    over = butted(
        [(f"c{index}", MIN_CLIP_MS) for index in range(MAX_LAYER0_CLIPS + 1)],
        source_job_id=SOURCE,
    )
    rejected(draft_document(layer0=over))


@pytest.mark.parametrize(
    "starts",
    [
        pytest.param([100, 3100], id="不从 0 起"),
        pytest.param([0, 3100], id="中间有空档"),
        pytest.param([0, 2900], id="两段重叠"),
    ],
)
def test_layer0_starts_at_zero_and_is_butt_joined(starts: list[int]) -> None:
    document = draft_document(
        layer0=[
            video_clip("a", start=starts[0], duration=3000, source_job_id=SOURCE),
            component_clip("b", start=starts[1], duration=2000),
        ]
    )

    assert "首尾相接" in rejected(document)


def test_clip_ids_are_unique_across_the_document() -> None:
    clash = overlay("a", start=0, duration=1000)

    assert "重复" in rejected(draft_document(source_job_id=SOURCE, overlays=[clash]))


@pytest.mark.parametrize(
    ("overlays", "problem"),
    [
        pytest.param([overlay("o1", start=0, duration=5000)], None, id="从头铺到尾"),
        pytest.param(
            [
                overlay("o1", start=0, duration=3000, track=0),
                overlay("o2", start=1000, duration=3000, track=1),
            ],
            None,
            id="不同行可以重叠",
        ),
        pytest.param(
            [
                overlay("o1", start=0, duration=3000, track=1),
                overlay("o2", start=2999, duration=1000, track=1),
            ],
            "（第 2 行）上重叠",
            id="同一行重叠",
        ),
        pytest.param(
            [
                overlay("o1", start=3000, duration=1000, track=1),
                overlay("o2", start=0, duration=3000, track=1),
            ],
            None,
            id="同一行首尾相接，先后不按开始时间",
        ),
        pytest.param(
            [
                overlay("o1", start=0, duration=3000, track=0, z_index=1),
                overlay("o2", start=0, duration=3000, track=1, z_index=9),
            ],
            None,
            id="zIndex 与行的先后不必一致",
        ),
        pytest.param(
            [overlay("o1", start=4000, duration=MAX_FILM_MS - 4000)], None, id="超出画面轨到两分钟"
        ),
        pytest.param(
            [overlay("o1", start=4000, duration=MAX_FILM_MS - 3999)], "上限", id="两分钟之后结束"
        ),
        pytest.param([overlay("o1", start=0, duration=MIN_CLIP_MS - 1)], FIELD_BOUND, id="太短"),
        pytest.param([overlay("o1", start=-1, duration=1000)], FIELD_BOUND, id="从负数开始"),
        pytest.param(
            [
                overlay(f"o{index}", start=0, duration=100, track=index)
                for index in range(MAX_OVERLAYS + 1)
            ],
            FIELD_BOUND,
            id="太多",
        ),
    ],
)
def test_overlays_do_not_overlap_on_a_row_and_end_by_two_minutes(
    overlays: list[dict[str, Any]], problem: str | None
) -> None:
    document = draft_document(source_job_id=SOURCE, overlays=overlays)

    if problem is None:
        parse(document)
    else:
        assert problem in rejected(document)


@pytest.mark.parametrize(
    ("edits", "problem"),
    [
        pytest.param([edit(0), edit(1, "字" * MAX_CAPTION_TEXT_CHARS)], None, id="两句"),
        pytest.param([edit(0, "字" * (MAX_CAPTION_TEXT_CHARS + 1))], FIELD_BOUND, id="太长"),
        pytest.param([edit(0, " ")], FIELD_BOUND, id="空白"),
        pytest.param([edit(-1)], FIELD_BOUND, id="句号为负"),
        pytest.param([edit(0), edit(0, "又改")], "两次", id="同一句改两次"),
        pytest.param(
            [edit(index) for index in range(MAX_CAPTION_EDITS + 1)], FIELD_BOUND, id="太多"
        ),
    ],
)
def test_caption_edits(edits: list[dict[str, Any]], problem: str | None) -> None:
    document = draft_document(source_job_id=SOURCE, edits=edits)

    if problem is None:
        parse(document)
    else:
        assert problem in rejected(document)
