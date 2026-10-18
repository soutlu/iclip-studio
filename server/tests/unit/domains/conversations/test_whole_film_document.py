"""整片草稿文档的形状与时间线规则：每条规则一个合规矩、一个不合规矩的例子。"""

from __future__ import annotations

import uuid
from collections.abc import Callable
from typing import Any

import pytest
from pydantic import ValidationError

from iclip.domains.conversations.whole_film_schemas import (
    MAX_CAPTION_EDITS,
    MAX_CAPTION_TEXT_CHARS,
    MAX_COMPONENT_CHARS,
    MAX_FILM_MS,
    MAX_LAYER0_CLIPS,
    MAX_OVERLAYS,
    MAX_VARIABLE_TEXT_CHARS,
    MAX_VARIABLES,
    MAX_VOLUME,
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
    """组件段夹在两段视频之间、改字、音乐与不同行上相互重叠的特效块都在：按 camelCase 原样读出来。"""

    document = draft_document(
        layer0=[
            component_clip("c1", start=0, duration=2000),
            video_clip("a", start=2000, duration=3000, source_job_id=SOURCE, playback_start=500),
            component_clip("c2", start=5000, duration=1000, playback_start=400),
            video_clip("b", start=6000, duration=2000, source_job_id=SOURCE, volume=0),
        ],
        edits=[edit(0), edit(1)],
        music={"jobId": str(uuid.uuid4()), "offset": 1200, "volume": 0.6},
        overlays=[
            overlay("o2", start=6000, duration=3000, track=1, z_index=2),
            overlay("o1", start=0, duration=7000, track=0, z_index=1, playback_start=250),
        ],
    )

    parsed = parse(document)

    assert parsed.model_dump(mode="json", by_alias=True) == document
    # 画面轨 8 秒，o2 到 9 秒结束：整片到所有轨上内容的最远结束
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


def test_unknown_fields_are_rejected() -> None:
    document = draft_document()
    document["layer0"][0]["muted"] = True

    rejected(document)


@pytest.mark.parametrize(
    ("where", "field", "value"),
    [
        pytest.param("component", "role", "intro", id="组件段带 role"),
        pytest.param("document", "transitions", [], id="带 transitions"),
        pytest.param("component", "playbackStart", None, id="组件段缺 playbackStart"),
        pytest.param("overlay", "playbackStart", None, id="特效块缺 playbackStart"),
        pytest.param("component", "playbackStart", -1, id="组件段入点为负"),
        pytest.param("overlay", "playbackStart", -1, id="特效块入点为负"),
        pytest.param("overlay", "track", None, id="特效块缺 track"),
        pytest.param("overlay", "zIndex", None, id="特效块缺 zIndex"),
        pytest.param("overlay", "track", -1, id="特效块行为负"),
        pytest.param("overlay", "zIndex", -1, id="特效块 zIndex 为负"),
    ],
)
def test_component_clips_have_no_role_and_carry_a_playback_start(
    where: str, field: str, value: object
) -> None:
    """``value`` 为 None 时去掉这个字段。"""

    document = draft_document(
        layer0=[component_clip("c", start=0, duration=1000)],
        overlays=[overlay("o", start=0, duration=1000)],
    )
    parse(document)
    target = {
        "document": document,
        "component": document["layer0"][0],
        "overlay": document["overlays"][0],
    }[where]
    if value is None:
        del target[field]
    else:
        target[field] = value

    rejected(document)


Change = Callable[[Document], None]


def _first_clip(field: str, value: object) -> Change:
    def change(document: Document) -> None:
        document["layer0"][0][field] = value

    return change


@pytest.mark.parametrize(
    ("change", "accepted"),
    [
        pytest.param(_first_clip("playbackStart", 0), True, id="入点 0"),
        pytest.param(_first_clip("playbackStart", -1), False, id="入点为负"),
        pytest.param(_first_clip("volume", MAX_VOLUME), True, id="音量 +12 dB"),
        pytest.param(_first_clip("volume", 3.99), False, id="音量超过 +12 dB"),
        pytest.param(_first_clip("volume", -0.1), False, id="音量为负"),
        pytest.param(_first_clip("volume", float("nan")), False, id="音量 NaN"),
        pytest.param(_first_clip("id", " "), False, id="空白 id"),
        pytest.param(_first_clip("id", "x" * 65), False, id="id 太长"),
        pytest.param(_first_clip("sourceJobId", "not-a-uuid"), False, id="出处不是 uuid"),
    ],
)
def test_video_clip_fields(change: Change, accepted: bool) -> None:
    document = draft_document(source_job_id=SOURCE)
    change(document)

    if accepted:
        parse(document)
    else:
        rejected(document)


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


@pytest.mark.parametrize(
    "kinds",
    [
        pytest.param(("component", "video"), id="组件段在最前"),
        pytest.param(("video", "component"), id="组件段在最后"),
        pytest.param(("video", "component", "video"), id="组件段在中间"),
        pytest.param(("component", "component", "video", "component"), id="几个组件段"),
    ],
)
def test_component_clips_sit_anywhere_on_layer0(kinds: tuple[str, ...]) -> None:
    layer: list[dict[str, Any]] = []
    for index, kind in enumerate(kinds):
        start = index * 1000
        layer.append(
            video_clip(f"c{index}", start=start, duration=1000, source_job_id=SOURCE)
            if kind == "video"
            else component_clip(f"c{index}", start=start, duration=1000)
        )

    parse(draft_document(layer0=layer))


@pytest.mark.parametrize(
    ("component", "accepted"),
    [
        ("x" * MAX_COMPONENT_CHARS, True),
        ("x" * (MAX_COMPONENT_CHARS + 1), False),
        ("", False),
        ("  ", False),
    ],
    ids=["上限", "太长", "空", "空白"],
)
def test_component_names_are_non_blank_and_bounded(component: str, accepted: bool) -> None:
    clip = component_clip("c", start=0, duration=1000)
    clip["component"] = component
    document = draft_document(layer0=[clip])

    if accepted:
        parse(document)
    else:
        rejected(document)


@pytest.mark.parametrize(
    ("variables", "accepted"),
    [
        pytest.param({f"k{index}": index for index in range(MAX_VARIABLES)}, True, id="50 项"),
        pytest.param({f"k{index}": index for index in range(MAX_VARIABLES + 1)}, False, id="51 项"),
        pytest.param({"text": "字" * MAX_VARIABLE_TEXT_CHARS}, True, id="500 字"),
        pytest.param({"text": "字" * (MAX_VARIABLE_TEXT_CHARS + 1)}, False, id="501 字"),
        pytest.param({"on": False, "n": 3, "x": 0.5, "s": ""}, True, id="四种值"),
        pytest.param({"nested": {"a": 1}}, False, id="对象值"),
        pytest.param({"list": [1]}, False, id="数组值"),
        pytest.param({"empty": None}, False, id="空值"),
        pytest.param({" ": 1}, False, id="空白名字"),
    ],
)
def test_variables_are_flat_and_bounded(variables: dict[str, Any], accepted: bool) -> None:
    clip = component_clip("c", start=0, duration=1000)
    clip["variables"] = variables
    document = draft_document(layer0=[clip])

    if accepted:
        parse(document)
    else:
        rejected(document)


def test_clip_ids_are_unique_across_the_document() -> None:
    clash = overlay("a", start=0, duration=1000)

    assert "重复" in rejected(draft_document(source_job_id=SOURCE, overlays=[clash]))


@pytest.mark.parametrize(
    ("overlays", "problem"),
    [
        pytest.param([overlay("o1", start=0, duration=5000)], None, id="铺满整片"),
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


@pytest.mark.parametrize(
    ("music", "accepted"),
    [
        pytest.param({"offset": 0, "volume": 0}, True, id="从头、静音"),
        pytest.param({"offset": 90_000, "volume": MAX_VOLUME}, True, id="从中间、+12 dB"),
        pytest.param({"offset": -1, "volume": 1}, False, id="起点为负"),
        pytest.param({"offset": 0, "volume": 3.99}, False, id="音量超过 +12 dB"),
    ],
)
def test_music_offset_and_volume(music: dict[str, Any], accepted: bool) -> None:
    document = draft_document(source_job_id=SOURCE, music={"jobId": str(uuid.uuid4()), **music})

    if accepted:
        parse(document)
    else:
        rejected(document)


@pytest.mark.parametrize(
    ("canvas", "accepted"),
    [
        ({"width": 1920, "height": 1080}, True),
        (None, True),
        ({"width": 0, "height": 1080}, False),
        ({"width": 1080}, False),
    ],
    ids=["横屏", "未定", "宽为 0", "缺高"],
)
def test_canvas(canvas: dict[str, Any] | None, accepted: bool) -> None:
    document = draft_document(source_job_id=SOURCE)
    document["canvas"] = canvas

    if accepted:
        parse(document)
    else:
        rejected(document)
