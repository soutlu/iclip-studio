"""四个端口的 HTTP 客户端：请求的路径与请求体照 conventions §21，答复读回端口的值；422 还原成端口声明的
错误、原话不变；连不上、超时、其他状态码与形状不对的答复都抛 ``InternalApiError``，其中后端暂时不可达是
``InternalApiUnavailable``，查出图任务时还原成 ``ImageJobUnavailable``。"""

from __future__ import annotations

import json
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

import httpx
import pytest
from pydantic import TypeAdapter

from iclip_video.internal_api import (
    HttpFrameBoards,
    HttpGridCuts,
    HttpImageGenerations,
    HttpReferenceBreakdowns,
    InternalApi,
    InternalApiError,
    InternalApiUnavailable,
    plugin_services,
)
from iclip_video.plugin_services import PluginServices, ShotVideoServices
from iclip_video.shot_video.ports import (
    EXTRACTION_VERSION,
    AnchorSheets,
    BoardsNotStored,
    BoardsResult,
    BoardsUnreadable,
    ExtractionLedger,
    FrameBoardsFailed,
    GridCutFailed,
    ImageJob,
    ImageJobUnavailable,
    ImageRequest,
    InvalidImageRequest,
    LedgerBoard,
    ShotCells,
    ShotsOutOfRange,
)
from iclip_video.shot_video.shots import ShotSpan
from iclip_video.video_breakdown.ports import FailedBreakdown

USER = uuid.UUID("11111111-1111-1111-1111-111111111111")
JOB = uuid.UUID("22222222-2222-2222-2222-222222222222")
LEDGER = ExtractionLedger(
    extraction_version=EXTRACTION_VERSION,
    extraction_key="k",
    boards=[LedgerBoard(board=1, url="https://cdn.test/board-1.jpg")],
)
ROWS = ((ShotSpan(shot_id=1, start_ms=0, end_ms=1500),),)
GRID_URL = "https://cdn.test/grid.png"
REQUEST = ImageRequest(
    prompt="雨中中景",
    model="nano_banana_pro",
    aspect_ratio="9:16",
    resolution="4k",
    channel="dev",
    user_name="logan",
    reference_image_urls=("https://cdn.test/a.jpg",),
    conversation_id="33333333-3333-3333-3333-333333333333",
)
JOB_BODY: dict[str, Any] = {
    "job_id": str(JOB),
    "status": "completed",
    "channel": "dev",
    "output_url": "https://cdn.test/grid.png",
    "error_code": None,
    "error_message": None,
}


@dataclass
class Backend:
    """后端的替身：每个请求都记下来，答 ``status`` 与 ``body``；``raises`` 给了就在传输层抛它。"""

    status: int = 200
    body: Any = None
    raises: httpx.HTTPError | None = None
    seen: list[httpx.Request] = field(default_factory=list[httpx.Request])

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.seen.append(request)
        if self.raises is not None:
            raise self.raises
        return httpx.Response(self.status, json=self.body)

    @property
    def sent(self) -> Any:
        (request,) = self.seen
        return json.loads(request.content)

    def api(self) -> InternalApi:
        return InternalApi(
            httpx.AsyncClient(transport=httpx.MockTransport(self), base_url="http://server.test")
        )


async def test_an_image_is_submitted_with_the_owner_and_the_request() -> None:
    backend = Backend(body=JOB_BODY)

    job = await HttpImageGenerations(backend.api()).submit(USER, REQUEST)

    (request,) = backend.seen
    assert (request.method, request.url.path) == ("POST", "/internal/runtime/plugins/generations")
    assert backend.sent == {
        "user_id": str(USER),
        "request": TypeAdapter(ImageRequest).dump_python(REQUEST, mode="json"),
    }
    assert job == ImageJob(
        job_id=JOB, status="completed", channel="dev", output_url="https://cdn.test/grid.png"
    )


async def test_an_image_job_is_read_back_for_its_owner() -> None:
    backend = Backend(body={**JOB_BODY, "status": "pending", "output_url": None})

    job = await HttpImageGenerations(backend.api()).get(USER, JOB)

    (request,) = backend.seen
    assert (request.method, request.url.path) == (
        "GET",
        f"/internal/runtime/plugins/generations/{JOB}",
    )
    assert request.url.params["user_id"] == str(USER)
    assert job == ImageJob(job_id=JOB, status="pending", channel="dev")
    assert request.extensions["timeout"]["read"] == 30.0, "查一次任务用短上限，不用客户端的整段上限"


async def test_a_refused_image_request_is_an_invalid_image_request_in_the_same_words() -> None:
    backend = Backend(status=422, body={"detail": "nano_banana_pro 不支持分辨率 8k"})

    with pytest.raises(InvalidImageRequest) as raised:
        await HttpImageGenerations(backend.api()).submit(USER, REQUEST)

    assert str(raised.value) == "nano_banana_pro 不支持分辨率 8k"


async def test_frame_boards_send_the_rows_and_the_ledger_by_its_alias_and_read_the_result() -> None:
    backend = Backend(
        body={"ledger": LEDGER.model_dump(mode="json", by_alias=True), "reused": True}
    )

    result = await HttpFrameBoards(backend.api()).boards(
        video_url="https://cdn.test/ref.mp4", rows=ROWS, previous=LEDGER
    )

    (request,) = backend.seen
    assert request.url.path == "/internal/runtime/plugins/frame-boards"
    assert backend.sent == {
        "video_url": "https://cdn.test/ref.mp4",
        "rows": [[{"shot_id": 1, "start_ms": 0, "end_ms": 1500}]],
        "previous": {
            "extractionVersion": EXTRACTION_VERSION,
            "extractionKey": "k",
            "boards": [{"board": 1, "url": "https://cdn.test/board-1.jpg"}],
        },
    }
    assert result == BoardsResult(ledger=LEDGER, reused=True)


@pytest.mark.parametrize(
    ("code", "kind"),
    [
        ("shots_out_of_range", ShotsOutOfRange),
        ("boards_unreadable", BoardsUnreadable),
        ("boards_not_stored", BoardsNotStored),
    ],
)
async def test_each_boards_failure_comes_back_as_its_own_subtype_in_the_same_words(
    code: str, kind: type[FrameBoardsFailed]
) -> None:
    detail = "镜头时间戳越界（视频时长 3000ms）：镜头 2。"
    backend = Backend(status=422, body={"detail": detail, "code": code})

    with pytest.raises(FrameBoardsFailed) as raised:
        await HttpFrameBoards(backend.api()).boards(
            video_url="https://cdn.test/ref.mp4", rows=ROWS, previous=None
        )

    assert (type(raised.value), str(raised.value)) == (kind, detail)


async def test_grid_cuts_send_the_cells_and_read_the_urls() -> None:
    urls = ["https://cdn.test/1.jpg", "https://cdn.test/2.jpg"]
    backend = Backend(body={"urls": urls})

    got = await HttpGridCuts(backend.api()).cut(
        USER, JOB, grid_url=GRID_URL, cells=AnchorSheets(indexes=(1, 2)), aspect="9:16"
    )

    (request,) = backend.seen
    assert request.url.path == "/internal/runtime/plugins/grid-cuts"
    assert backend.sent == {
        "user_id": str(USER),
        "job_id": str(JOB),
        "grid_url": "https://cdn.test/grid.png",
        "cells": {"kind": "anchor_sheets", "indexes": [1, 2]},
        "aspect": "9:16",
    }
    assert got == tuple(urls)


async def test_a_failed_cut_is_a_grid_cut_failed_with_the_same_reason() -> None:
    reason = "画幅要写成 宽:高，比如 9:16；收到的是 '9-16'"
    backend = Backend(status=422, body={"detail": reason, "code": "grid_cut_failed"})

    with pytest.raises(GridCutFailed) as raised:
        await HttpGridCuts(backend.api()).cut(
            USER, JOB, grid_url=GRID_URL, cells=ShotCells(cell_ids=("S1-1",)), aspect=None
        )

    assert str(raised.value) == reason


async def call_boards(api: InternalApi) -> object:
    return await HttpFrameBoards(api).boards(
        video_url="https://cdn.test/ref.mp4", rows=ROWS, previous=None
    )


async def call_cut(api: InternalApi) -> object:
    return await HttpGridCuts(api).cut(
        USER, JOB, grid_url=GRID_URL, cells=ShotCells(cell_ids=("S1-1",)), aspect=None
    )


@pytest.mark.parametrize("call", [call_boards, call_cut], ids=["frame-boards", "grid-cuts"])
async def test_a_422_without_a_code_is_not_taken_for_a_port_failure(
    call: Callable[[InternalApi], Awaitable[object]],
) -> None:
    """请求结构校验失败的 422 只有 ``detail``：那是客户端发错了，不当成端口的失败让工具重试。"""

    backend = Backend(status=422, body={"detail": "rows[0][0].shot_id: Field required"})

    with pytest.raises(InternalApiError, match="422"):
        await call(backend.api())


async def test_a_reference_breakdown_comes_back_as_the_document_or_the_failure() -> None:
    done = Backend(body={"document": "## 拆解文档", "failed": None})
    failed = Backend(body={"document": None, "failed": {"reason": "video_unreadable"}})

    document = await HttpReferenceBreakdowns(done.api()).ensure(USER, "https://cdn.test/ok.mp4")
    failure = await HttpReferenceBreakdowns(failed.api()).ensure(USER, "https://cdn.test/bad.mp4")

    (request,) = done.seen
    assert request.url.path == "/internal/runtime/plugins/reference-breakdowns"
    assert done.sent == {"user_id": str(USER), "video_url": "https://cdn.test/ok.mp4"}
    assert document == "## 拆解文档"
    assert failure == FailedBreakdown(reason="video_unreadable")


async def test_plugin_services_are_read_back() -> None:
    backend = Backend(
        body={"shot_video": {"image_models": ["gpt-image-2.5"]}, "video_breakdown": False}
    )

    services = await plugin_services(backend.api())

    (request,) = backend.seen
    assert (request.method, request.url.path) == ("GET", "/internal/runtime/plugins/services")
    assert services == PluginServices(
        shot_video=ShotVideoServices(image_models=("gpt-image-2.5",)), video_breakdown=False
    )


async def submit(api: InternalApi) -> object:
    return await HttpImageGenerations(api).submit(USER, REQUEST)


async def get_job(api: InternalApi) -> object:
    return await HttpImageGenerations(api).get(USER, JOB)


async def ensure(api: InternalApi) -> object:
    return await HttpReferenceBreakdowns(api).ensure(USER, "https://cdn.test/ok.mp4")


async def list_services(api: InternalApi) -> object:
    return await plugin_services(api)


CALLS = [submit, get_job, call_boards, call_cut, ensure, list_services]
CALL_IDS = ["submit", "get", "frame-boards", "grid-cuts", "breakdowns", "services"]


@pytest.mark.parametrize(
    ("status", "body"),
    [
        (401, {"detail": "运行时内部接口的令牌不对"}),
        (403, {"detail": "账号已停用"}),
        (404, {"detail": "Not Found"}),
        (500, {"detail": "Internal Server Error"}),
    ],
)
@pytest.mark.parametrize("call", [submit, get_job], ids=["submit", "get"])
async def test_any_other_status_is_an_internal_api_error_naming_it(
    call: Callable[[InternalApi], Awaitable[object]], status: int, body: dict[str, str]
) -> None:
    """确定性的失败不当成暂时不可达：查任务时也照样报，不让轮询接着等。"""

    backend = Backend(status=status, body=body)

    with pytest.raises(InternalApiError) as raised:
        await call(backend.api())

    assert not isinstance(raised.value, InternalApiUnavailable)
    assert f"答 {status}" in str(raised.value)
    assert body["detail"] in str(raised.value)


UNAVAILABLE: list[Callable[[], Backend]] = [
    lambda: Backend(raises=httpx.ConnectError("connection refused")),
    lambda: Backend(raises=httpx.ReadTimeout("timed out")),
    lambda: Backend(status=502, body={"detail": "Bad Gateway"}),
    lambda: Backend(status=503, body={"detail": "Service Unavailable"}),
    lambda: Backend(status=504, body={"detail": "Gateway Timeout"}),
]
UNAVAILABLE_IDS = ["connect", "timeout", "502", "503", "504"]


@pytest.mark.parametrize("backend", UNAVAILABLE, ids=UNAVAILABLE_IDS)
async def test_an_unreachable_backend_is_unavailable_and_the_submission_fails(
    backend: Callable[[], Backend],
) -> None:
    """提交不是幂等的：后端暂时不可达也照样失败即报，不在端口上翻成可以接着等的错误。"""

    with pytest.raises(InternalApiUnavailable):
        await submit(backend().api())


@pytest.mark.parametrize("backend", UNAVAILABLE, ids=UNAVAILABLE_IDS)
async def test_an_unreachable_backend_while_polling_is_an_image_job_unavailable(
    backend: Callable[[], Backend],
) -> None:
    with pytest.raises(ImageJobUnavailable):
        await get_job(backend().api())


async def test_a_transport_failure_names_its_cause() -> None:
    error = httpx.ConnectError("connection refused")
    backend = Backend(raises=error)

    with pytest.raises(InternalApiError, match="连不上（ConnectError）") as raised:
        await HttpImageGenerations(backend.api()).submit(USER, REQUEST)

    assert raised.value.__cause__ is error


@pytest.mark.parametrize("call", CALLS, ids=CALL_IDS)
async def test_a_success_in_the_wrong_shape_is_an_internal_api_error(
    call: Callable[[InternalApi], Awaitable[object]],
) -> None:
    backend = Backend(body={"unexpected": True})

    with pytest.raises(InternalApiError, match="形状不对"):
        await call(backend.api())
