"""持久化请求的种类分派、损坏数据拒绝与历史读取；正常往返由真实仓储测试覆盖。"""

from __future__ import annotations

import uuid

import pytest
from agent_runtime.errors import ValidationFailed

from iclip.domains.generation.schemas import (
    IMAGE_MAX_REFERENCES,
    KIND_IMAGE,
    KIND_VIDEO,
    OPERATION_COMPOSE,
    OPERATION_CUT,
    OPERATION_GENERATE,
    OPERATION_UPLOAD,
    VideoComposeRequest,
    VideoGenerationIn,
    request_to_payload,
)
from iclip.domains.generation.stored_requests import request_from_payload
from tests.helpers.generation import (
    LEGACY_SHOT_PROMPT,
    SHOT_IMAGE_URLS,
    compose_request,
    edit_request,
    image_request,
    video_request,
    video_shot,
)


def test_an_edit_snapshot_without_its_range_fails_loudly() -> None:
    payload = request_to_payload(edit_request())
    del payload["range_end_ms"]

    with pytest.raises(ValidationFailed, match="形状不合法"):
        request_from_payload(KIND_VIDEO, OPERATION_GENERATE, payload, has_source=True)


def test_a_take_snapshot_with_a_range_fails_loudly() -> None:
    """没有来源的视频 generate 是出片，请求里不该有区间。"""

    payload = request_to_payload(edit_request())

    with pytest.raises(ValidationFailed, match="形状不合法"):
        request_from_payload(KIND_VIDEO, OPERATION_GENERATE, payload, has_source=False)


def test_a_composite_stored_before_user_names_reads_back_without_one() -> None:
    """0017 之前拼好的合成没有对账名，读回 ``user_name`` 为空；各段的出处由 0022 补齐。"""

    base, edit = uuid.uuid4(), uuid.uuid4()
    stored = {
        "segments": [
            {"sourceJobId": str(base), "url": "https://example.com/base.mp4", "start": 0, "end": 4},
            {
                "sourceJobId": str(edit),
                "url": "https://example.com/edited.mp4",
                "start": 0,
                "end": 4.3,
            },
        ]
    }

    restored = request_from_payload(KIND_VIDEO, OPERATION_COMPOSE, stored, has_source=True)

    assert isinstance(restored, VideoComposeRequest)
    assert [segment.source_job_id for segment in restored.segments] == [base, edit]
    assert restored.user_name is None


def test_the_stored_shape_is_chosen_by_kind_operation_and_source() -> None:
    """同是 video，调模型的读成上游请求（有来源的是编辑段），本地拼接的读成合成；对不上的组合直接拒。"""

    video = request_to_payload(video_request())
    restored = request_from_payload(KIND_VIDEO, OPERATION_GENERATE, video, has_source=False)
    assert type(restored) is VideoGenerationIn
    with pytest.raises(ValidationFailed, match="形状不合法"):
        request_from_payload(KIND_VIDEO, OPERATION_COMPOSE, video, has_source=True)
    with pytest.raises(ValidationFailed, match="未知的生成类型"):
        request_from_payload(
            KIND_IMAGE, OPERATION_COMPOSE, request_to_payload(image_request()), has_source=True
        )
    with pytest.raises(ValidationFailed, match="未知的生成类型"):
        request_from_payload(
            "clip", OPERATION_COMPOSE, request_to_payload(compose_request()), has_source=True
        )


def test_shot_index_counts_from_one() -> None:
    """0 与负数都不是镜头号，收下只会落一条读不出镜头组的记录。"""

    for invalid in (0, -1):
        with pytest.raises(ValueError, match="shot_index"):
            video_request(shot_index=invalid)


@pytest.mark.parametrize(
    ("kind", "operation"),
    [(KIND_IMAGE, OPERATION_CUT), (KIND_IMAGE, OPERATION_UPLOAD), (KIND_VIDEO, OPERATION_UPLOAD)],
)
def test_cuts_and_uploads_have_no_request(kind: str, operation: str) -> None:
    """切图与上传创建即完成，没有发给执行方的输入：读回 None，存着一份请求就是持久化坏了。"""

    assert request_to_payload(None) is None
    assert request_from_payload(kind, operation, None, has_source=False) is None
    with pytest.raises(ValidationFailed):
        request_from_payload(kind, operation, {"prompt": "x"}, has_source=False)


def test_a_video_cut_is_not_a_record_we_know() -> None:
    with pytest.raises(ValidationFailed, match="未知的生成类型"):
        request_from_payload(KIND_VIDEO, OPERATION_CUT, None, has_source=True)


@pytest.mark.parametrize(
    ("kind", "operation"),
    [
        (KIND_VIDEO, OPERATION_GENERATE),
        (KIND_IMAGE, OPERATION_GENERATE),
        (KIND_VIDEO, OPERATION_COMPOSE),
    ],
)
def test_records_that_call_an_executor_must_have_a_request(kind: str, operation: str) -> None:
    with pytest.raises(ValidationFailed):
        request_from_payload(kind, operation, None, has_source=False)


# --- 结构化镜头组 shot ------------------------------------------------------------


def test_a_stored_prompt_assembled_by_an_older_rule_reads_back_as_stored() -> None:
    """拼法改过之后，旧记录里的 prompt 与按现行拼法重拼的对不上；读回以存下的为准。"""

    payload = request_to_payload(
        video_request(prompt=None, shot=video_shot(), reference_image_urls=SHOT_IMAGE_URLS)
    )
    payload["prompt"] = LEGACY_SHOT_PROMPT

    restored = request_from_payload(KIND_VIDEO, OPERATION_GENERATE, payload, has_source=False)

    assert isinstance(restored, VideoGenerationIn)
    assert restored.prompt == LEGACY_SHOT_PROMPT
    assert restored.shot is not None
    assert restored.shot.global_settings == video_shot()["global_settings"]


def test_a_stored_shot_without_its_prompt_fails_loudly() -> None:
    payload = request_to_payload(
        video_request(prompt=None, shot=video_shot(), reference_image_urls=SHOT_IMAGE_URLS)
    )
    payload["prompt"] = None

    with pytest.raises(ValidationFailed, match="没有 prompt"):
        request_from_payload(KIND_VIDEO, OPERATION_GENERATE, payload, has_source=False)


@pytest.mark.parametrize(
    "overrides",
    [
        {"seconds": -2},
        {"prompt": ""},
        {"model": ""},
        {"user_name": "   "},
        {"reference_image_urls": ["file:///etc/passwd"]},
        {"image_urls": ["https://example.test/a.png"]},
        {"session_id": "s-1"},
    ],
)
def test_video_request_rejects_what_we_can_judge_ourselves(overrides: dict[str, object]) -> None:
    """上游的废弃别名与它会丢弃的字段，在我们这里是未知字段，直接拒。"""

    with pytest.raises(ValueError):
        video_request(**overrides)


def test_video_request_strips_the_user_name() -> None:
    assert video_request(user_name=" logan ").user_name == "logan"
    assert video_request(user_name=None).user_name is None, "HTTP 边界会填，模型本身允许空"


def test_image_request_caps_reference_count() -> None:

    urls = [f"https://example.test/{i}.png" for i in range(IMAGE_MAX_REFERENCES + 1)]
    with pytest.raises(ValueError):
        image_request(reference_image_urls=urls)


@pytest.mark.parametrize("url", ["file:///etc/passwd", "http://"])
def test_non_http_reference_url_is_rejected(url: str) -> None:
    """参考 URL 由供应商下载，只接受带主机名的 HTTP(S)，避免 file:// 等协议访问本地文件。"""

    with pytest.raises(ValueError):
        VideoGenerationIn(
            model="vendor-a-seedance-2-5",
            prompt="猫",
            reference_video_urls=[url],
        )


@pytest.mark.parametrize(
    "damaged",
    [
        {"prompt": "猫"},
        {"model": "m", "seconds": 5},
        {"model": "m", "prompt": "猫", "seconds": "五秒"},
        {"model": "m", "prompt": "猫", "aspectRatio": "16:9"},
    ],
)
def test_damaged_persisted_shape_fails_loudly(damaged: dict[str, object]) -> None:

    with pytest.raises(ValidationFailed, match="形状不合法"):
        request_from_payload(KIND_VIDEO, OPERATION_GENERATE, damaged, has_source=False)
