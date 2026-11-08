from __future__ import annotations

import uuid

import pytest

from iclip.common.errors import ValidationFailed
from iclip.domains.generation.schemas import (
    KIND_IMAGE,
    KIND_VIDEO,
    OPERATION_COMPOSE,
    OPERATION_GENERATE,
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
    payload = request_to_payload(edit_request())

    with pytest.raises(ValidationFailed, match="形状不合法"):
        request_from_payload(KIND_VIDEO, OPERATION_GENERATE, payload, has_source=False)


def test_a_composite_stored_before_user_names_reads_back_without_one() -> None:
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


def test_a_stored_prompt_assembled_by_an_older_rule_reads_back_as_stored() -> None:
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
