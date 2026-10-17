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
    MAX_OVERLAYS,
    MAX_VARIABLE_TEXT_CHARS,
    MAX_VARIABLES,
    MAX_VIDEO_CLIPS,
    MIN_CLIP_MS,
    WholeFilmDocument,
)
from tests.helpers.whole_film import butted, component_clip, draft_document, video_clip

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


def overlay(overlay_id: str, start: int, duration: int) -> dict[str, Any]:
    return {
        "id": overlay_id,
        "component": "sticker",
        "start": start,
        "duration": duration,
        "variables": {},
    }


def edit(index: int, text: str = "改过的字") -> dict[str, Any]:
    return {"subtitleJobId": str(SUBTITLE), "sentenceIndex": index, "text": text}


def test_a_full_draft_round_trips_its_wire_shape() -> None:
    """片头、两段视频、片尾、转场、改字、音乐与包装都在：按 camelCase 原样读出来。"""

    document = draft_document(
        layer0=[
            component_clip("intro", "intro", start=0, duration=2000),
            video_clip("a", start=2000, duration=3000, source_job_id=SOURCE, playback_start=500),
            video_clip("b", start=5000, duration=2000, source_job_id=SOURCE, volume=0),
            component_clip("outro", "outro", start=7000, duration=2000),
        ],
        transitions=[
            {"id": "t1", "afterClipId": "a", "component": "fade", "duration": 300, "variables": {}}
        ],
        edits=[edit(0), edit(1)],
        music={"jobId": str(uuid.uuid4()), "offset": 1200, "volume": 0.6},
        overlays=[overlay("o2", 6000, 3000), overlay("o1", 0, 6000)],
    )

    parsed = parse(document)

    assert parsed.model_dump(mode="json", by_alias=True) == document
    assert parsed.total_ms() == 9000
    assert parsed.video_sources() == (SOURCE,)


def test_an_empty_timeline_is_a_valid_draft() -> None:
    parsed = parse(draft_document(layer0=[], transitions=[]))

    assert parsed.total_ms() == 0


def test_unknown_fields_are_rejected() -> None:
    document = draft_document()
    document["layer0"][0]["muted"] = True

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
        pytest.param(_first_clip("volume", 2), True, id="音量 2"),
        pytest.param(_first_clip("volume", 2.01), False, id="音量超过 2"),
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


@pytest.mark.parametrize(
    ("count", "accepted"), [(MAX_VIDEO_CLIPS, True), (MAX_VIDEO_CLIPS + 1, False)]
)
def test_at_most_a_hundred_video_clips(count: int, accepted: bool) -> None:
    layer = butted([(f"c{index}", MIN_CLIP_MS) for index in range(count)], source_job_id=SOURCE)
    document = draft_document(layer0=layer, transitions=[])

    if accepted:
        parse(document)
    else:
        assert f"{MAX_VIDEO_CLIPS} 段视频" in rejected(document)


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
            video_clip("b", start=starts[1], duration=2000, source_job_id=SOURCE),
        ]
    )

    assert "首尾相接" in rejected(document)


def _layer(*roles: str) -> list[dict[str, Any]]:
    """按角色排一条首尾相接的画面轨，``video`` 是视频，其余是片头片尾，每段 1 秒。"""

    layer: list[dict[str, Any]] = []
    for index, role in enumerate(roles):
        start = index * 1000
        if role == "video":
            layer.append(video_clip(f"c{index}", start=start, duration=1000, source_job_id=SOURCE))
        else:
            layer.append(component_clip(f"c{index}", role, start=start, duration=1000))
    return layer


@pytest.mark.parametrize(
    ("roles", "problem"),
    [
        pytest.param(("intro", "video", "outro"), None, id="片头在前片尾在后"),
        pytest.param(("intro",), None, id="只有片头"),
        pytest.param(("outro",), None, id="只有片尾"),
        pytest.param(("video", "intro"), "片头", id="片头不在第一段"),
        pytest.param(("outro", "video"), "片尾", id="片尾不在最后一段"),
        pytest.param(("intro", "intro", "video"), "片头", id="两个片头"),
        pytest.param(("video", "outro", "outro"), "片尾", id="两个片尾"),
    ],
)
def test_intro_only_first_and_outro_only_last(roles: tuple[str, ...], problem: str | None) -> None:
    document = draft_document(layer0=_layer(*roles), transitions=[])

    if problem is None:
        parse(document)
    else:
        assert problem in rejected(document)


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
    layer = _layer("intro", "video")
    layer[0]["component"] = component
    document = draft_document(layer0=layer, transitions=[])

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
    layer = _layer("intro", "video")
    layer[0]["variables"] = variables
    document = draft_document(layer0=layer, transitions=[])

    if accepted:
        parse(document)
    else:
        rejected(document)


def test_clip_ids_are_unique_across_the_document() -> None:
    clash = overlay("a", 0, 1000)

    assert "重复" in rejected(draft_document(source_job_id=SOURCE, overlays=[clash]))


def _transition(after: str, *, transition_id: str = "t1", duration: int = 300) -> dict[str, Any]:
    return {
        "id": transition_id,
        "afterClipId": after,
        "component": "fade",
        "duration": duration,
        "variables": {},
    }


@pytest.mark.parametrize(
    ("transitions", "problem"),
    [
        pytest.param([_transition("a")], None, id="接在第一段后"),
        pytest.param([_transition("a", duration=MIN_CLIP_MS)], None, id="恰好 100 毫秒"),
        pytest.param([_transition("a", duration=MIN_CLIP_MS - 1)], FIELD_BOUND, id="不到 100 毫秒"),
        pytest.param([_transition("b")], "转场", id="接在最后一段后"),
        pytest.param([_transition("nope")], "转场", id="不在画面轨里"),
        pytest.param(
            [_transition("a"), _transition("a", transition_id="t2")], "一个转场", id="一段两个"
        ),
    ],
)
def test_transitions_join_a_clip_to_the_next(
    transitions: list[dict[str, Any]], problem: str | None
) -> None:
    document = draft_document(source_job_id=SOURCE, transitions=transitions)

    if problem is None:
        parse(document)
    else:
        assert problem in rejected(document)


@pytest.mark.parametrize(
    ("overlays", "problem"),
    [
        pytest.param([overlay("o1", 0, 5000)], None, id="铺满整片"),
        pytest.param(
            [overlay("o1", 3000, 2000), overlay("o2", 0, 3000)], None, id="首尾相接不论先后"
        ),
        pytest.param([overlay("o1", 4000, 1001)], "超出", id="超出整片"),
        pytest.param([overlay("o1", 0, 3000), overlay("o2", 2999, 1000)], "重叠", id="重叠"),
        pytest.param([overlay("o1", 0, MIN_CLIP_MS - 1)], FIELD_BOUND, id="不到 100 毫秒"),
        pytest.param([overlay("o1", -1, 1000)], FIELD_BOUND, id="从负数开始"),
        pytest.param(
            [overlay(f"o{index}", index * 100, 100) for index in range(MAX_OVERLAYS + 1)],
            FIELD_BOUND,
            id="超过 50 个",
        ),
    ],
)
def test_overlays_stay_inside_the_film_without_overlapping(
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
        pytest.param({"offset": 90_000, "volume": 2}, True, id="从中间、两倍"),
        pytest.param({"offset": -1, "volume": 1}, False, id="起点为负"),
        pytest.param({"offset": 0, "volume": 2.5}, False, id="音量超过 2"),
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
