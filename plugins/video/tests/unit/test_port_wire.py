"""端口走 HTTP 时的请求与答复：经 JSON 走一趟回来与原值相等，失败还原成端口声明的同一个错误。"""

from __future__ import annotations

import uuid

import pytest
from pydantic import TypeAdapter, ValidationError

from iclip_video.shot_video.ports import (
    EXTRACTION_VERSION,
    AnchorSheets,
    BoardsNotStored,
    BoardsResult,
    BoardsUnreadable,
    ExtractionLedger,
    FrameBoardsFailed,
    ImageJob,
    ImageRequest,
    LedgerBoard,
    ShotCells,
    ShotsOutOfRange,
)
from iclip_video.shot_video.shots import ShotSpan
from iclip_video.shot_video.wire import (
    FrameBoardsCall,
    FrameBoardsFailure,
    GridCutCall,
    ImageSubmission,
)
from iclip_video.video_breakdown.ports import FailedBreakdown
from iclip_video.video_breakdown.wire import ReferenceBreakdownResult

LEDGER = ExtractionLedger(
    extraction_version=EXTRACTION_VERSION,
    extraction_key="k",
    boards=[LedgerBoard(board=1, url="https://cdn.test/b1.jpg")],
)


def test_the_port_values_survive_a_json_round_trip() -> None:
    submission = ImageSubmission(
        user_id=uuid.uuid4(),
        request=ImageRequest(
            prompt="雨中中景",
            model="nano_banana_pro",
            aspect_ratio="9:16",
            resolution="4k",
            channel="dev",
            user_name="logan",
            reference_image_urls=("https://cdn.test/a.jpg",),
            conversation_id=str(uuid.uuid4()),
        ),
    )
    boards = FrameBoardsCall(
        video_url="https://cdn.test/v.mp4",
        rows=((ShotSpan(shot_id=1, start_ms=0, end_ms=1500),),),
        previous=LEDGER,
    )
    job = ImageJob(job_id=uuid.uuid4(), status="completed", channel="pro", output_url="https://x")
    result = BoardsResult(ledger=LEDGER, reused=True)

    assert ImageSubmission.model_validate_json(submission.model_dump_json()) == submission
    assert FrameBoardsCall.model_validate_json(boards.model_dump_json(by_alias=True)) == boards
    jobs = TypeAdapter(ImageJob)
    results = TypeAdapter(BoardsResult)
    assert jobs.validate_json(jobs.dump_json(job)) == job
    # 宿主（FastAPI）按别名写答复，台账字段是 camelCase。
    dumped = results.dump_json(result, by_alias=True)
    assert b'"extractionKey"' in dumped
    assert results.validate_json(dumped) == result


@pytest.mark.parametrize(
    ("cells", "wire"),
    [
        (
            ShotCells(cell_ids=("S1-1", "S2-1")),
            {"kind": "shot_cells", "cell_ids": ["S1-1", "S2-1"]},
        ),
        (AnchorSheets(indexes=(1, 2)), {"kind": "anchor_sheets", "indexes": [1, 2]}),
    ],
)
def test_a_cut_names_its_cells_by_kind(cells: ShotCells | AnchorSheets, wire: object) -> None:
    call = GridCutCall(
        user_id=uuid.uuid4(), job_id=uuid.uuid4(), grid_url="https://g", cells=cells, aspect=None
    )

    assert call.model_dump(mode="json")["cells"] == wire
    assert GridCutCall.model_validate_json(call.model_dump_json()).cells == cells


@pytest.mark.parametrize(
    "cells",
    [{"kind": "shot_cells", "cell_ids": []}, {"kind": "anchor_sheets", "indexes": [0]}],
    ids=["no-cells", "index-from-one"],
)
def test_a_cut_without_cells_or_with_a_zero_index_is_refused(cells: object) -> None:
    with pytest.raises(ValidationError):
        GridCutCall.model_validate(
            {
                "user_id": str(uuid.uuid4()),
                "job_id": str(uuid.uuid4()),
                "grid_url": "g",
                "cells": cells,
            }
        )


@pytest.mark.parametrize(
    ("error", "code"),
    [
        (ShotsOutOfRange("镜头时间戳越界"), "shots_out_of_range"),
        (BoardsUnreadable("取不到素材"), "boards_unreadable"),
        (BoardsNotStored("图片没存进对象存储"), "boards_not_stored"),
    ],
)
def test_a_boards_failure_comes_back_as_the_same_subtype_and_text(
    error: FrameBoardsFailed, code: str
) -> None:
    failure = FrameBoardsFailure.model_validate_json(FrameBoardsFailure.of(error).model_dump_json())

    assert failure.code == code
    restored = failure.error()
    assert (type(restored), str(restored)) == (type(error), str(error))


def test_only_the_declared_subtypes_have_a_code() -> None:
    with pytest.raises(TypeError):
        FrameBoardsFailure.of(FrameBoardsFailed("基类"))


@pytest.mark.parametrize("outcome", ["## 拆解文档", FailedBreakdown(reason="timeout")])
def test_a_breakdown_result_carries_the_document_or_the_failure(
    outcome: str | FailedBreakdown,
) -> None:
    wire = ReferenceBreakdownResult.of(outcome).model_dump_json()

    assert ReferenceBreakdownResult.model_validate_json(wire).outcome() == outcome


@pytest.mark.parametrize("body", [{}, {"document": "d", "failed": {"reason": "timeout"}}])
def test_a_breakdown_result_has_exactly_one_of_the_two(body: dict[str, object]) -> None:
    with pytest.raises(ValidationError):
        ReferenceBreakdownResult.model_validate(body)
