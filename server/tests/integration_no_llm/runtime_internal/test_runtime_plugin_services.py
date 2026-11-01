"""内部接口上的插件服务：请求与答复照 ``iclip_video`` 的 wire 模型走一趟，进程内的端口适配器照常干活，
端口的失败按约定的状态码与 ``code`` 答出，客户端能还原成同一个错误。

只挂内部接口的路由与错误信封；对话服务只在出图入口问一句是不是测试预览，用替身答「不是」。"""

from __future__ import annotations

import subprocess
import uuid
from collections.abc import Sequence
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import cast

import httpx
import pytest
from agent_runtime.errors import AuthenticationFailed
from fastapi import FastAPI
from iclip_video.shot_video.ports import (
    EXTRACTION_VERSION,
    AnchorSheets,
    BoardsNotStored,
    BoardsResult,
    BoardsUnreadable,
    ExtractionLedger,
    FrameBoards,
    FrameBoardsFailed,
    GridCuts,
    ImageGenerations,
    ImageJob,
    ImageRequest,
    InvalidImageRequest,
    LedgerBoard,
    ShotCells,
    ShotsOutOfRange,
)
from iclip_video.shot_video.shots import ShotSpan
from iclip_video.shot_video.wire import FrameBoardsFailure
from iclip_video.video_breakdown.ports import FailedBreakdown, ReferenceBreakdowns
from iclip_video.video_breakdown.wire import ReferenceBreakdownResult
from pydantic import TypeAdapter

from iclip.app.errors import install_error_handlers
from iclip.app.image_generations import GenerationsAdapter
from iclip.app.reference_breakdown import ReferenceBreakdownsAdapter
from iclip.app.runtime_internal import (
    RuntimePluginServices,
    ShotServices,
    TurnNaming,
    create_runtime_internal_router,
)
from iclip.app.shot_media import GridCutsAdapter
from iclip.domains.conversations.service import ConversationService
from iclip.domains.identity.public import Principal
from iclip.domains.references.models import Outcome
from iclip.domains.references.service import ReferenceService
from iclip.platform.media.process import ffmpeg_available
from tests.helpers.fetch_url import as_is
from tests.helpers.generation import InMemoryGenerationRepository, film_image_service
from tests.helpers.identity import FakePrincipals
from tests.helpers.shot_video import FakeCutRecords, FakeObjects

TOKEN = "runtime-internal-test-token-0123456789"
AUTHORIZED = {"Authorization": f"Bearer {TOKEN}"}
OWNER = Principal(
    kind="user",
    user_id=uuid.UUID("11111111-1111-1111-1111-111111111111"),
    permissions=frozenset({"agent:run"}),
    audit_label="logan",
)
LEDGER = ExtractionLedger(
    extraction_version=EXTRACTION_VERSION,
    extraction_key="k",
    boards=[LedgerBoard(board=1, url="https://cdn.test/board-1.jpg")],
)
GRID_URL = "https://cdn.test/grid.png"


class NoPreviews:
    """对话服务的替身：出图入口只问它这个 id 是不是测试预览；这里的都不是（预览见
    ``test_preview_generations.py``）。"""

    async def is_preview(self, session_id: str) -> bool:
        return False


def internal_app(plugins: RuntimePluginServices) -> FastAPI:
    app = FastAPI()
    install_error_handlers(app)
    conversations = cast("ConversationService", NoPreviews())
    app.include_router(
        create_runtime_internal_router(
            token=TOKEN,
            user_principal=FakePrincipals(OWNER),
            conversations=conversations,
            naming=TurnNaming(conversations),
            plugins=plugins,
        )
    )
    return app


UNUSED = object()
"""用例不经过的端口占位。"""


def services(
    *,
    generations: ImageGenerations | None = None,
    boards: FrameBoards | None = None,
    cuts: GridCuts | None = None,
    breakdowns: ReferenceBreakdowns | None = None,
    image_models: frozenset[str] = frozenset(),
) -> RuntimePluginServices:
    """给了出图、取帧或切格任一个就挂上 ``shot_video``，没给的那几个用占位。"""

    shot = (
        ShotServices(
            generations=(
                generations if generations is not None else cast("ImageGenerations", UNUSED)
            ),
            boards=boards if boards is not None else cast("FrameBoards", UNUSED),
            cuts=cuts if cuts is not None else cast("GridCuts", UNUSED),
            image_models=image_models,
        )
        if any(port is not None for port in (generations, boards, cuts))
        else None
    )
    return RuntimePluginServices(shot_video=shot, breakdowns=breakdowns)


def client_for(app: FastAPI) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test", headers=AUTHORIZED
    )


def image_request(**overrides: str) -> ImageRequest:
    base = ImageRequest(
        prompt="雨中中景",
        model="nano_banana_pro",
        aspect_ratio="9:16",
        resolution="4k",
        channel="dev",
        user_name="logan",
        conversation_id=str(uuid.uuid4()),
    )
    return replace(base, **overrides)


def submission(request: ImageRequest, user_id: uuid.UUID = OWNER.user_id) -> dict[str, object]:
    return {
        "user_id": str(user_id),
        "request": TypeAdapter(ImageRequest).dump_python(request, mode="json"),
    }


async def test_an_image_is_submitted_and_read_back_through_the_adapter() -> None:
    repo = InMemoryGenerationRepository()
    request = image_request()
    app = internal_app(
        services(generations=GenerationsAdapter(film_image_service(repo), FakePrincipals(OWNER)))
    )

    async with client_for(app) as client:
        submitted = await client.post(
            "/internal/runtime/plugins/generations", json=submission(request)
        )
        assert submitted.status_code == 200, submitted.text
        job = TypeAdapter(ImageJob).validate_python(submitted.json())
        read = await client.get(
            f"/internal/runtime/plugins/generations/{job.job_id}",
            params={"user_id": str(OWNER.user_id)},
        )

    (row,) = repo.jobs.values()
    assert (job.job_id, job.status, job.channel) == (row.id, "pending", "dev")
    assert row.owner_user_id == OWNER.user_id
    assert row.conversation_id == uuid.UUID(request.conversation_id)
    assert TypeAdapter(ImageJob).validate_python(read.json()) == job


async def test_an_invalid_image_request_is_422_with_the_adapters_own_words() -> None:
    adapter = GenerationsAdapter(
        film_image_service(InMemoryGenerationRepository()), FakePrincipals(OWNER)
    )
    bad = image_request(aspect_ratio="17:9")
    with pytest.raises(InvalidImageRequest) as raised:
        await adapter.submit(OWNER.user_id, bad)

    async with client_for(internal_app(services(generations=adapter))) as client:
        refused = await client.post("/internal/runtime/plugins/generations", json=submission(bad))

    assert refused.status_code == 422
    assert refused.json() == {"detail": str(raised.value)}


async def test_an_owner_who_is_gone_or_deactivated_is_404_or_403() -> None:
    """适配器自己按属主重建主体：停用的 ``AuthenticationFailed`` 在这些路由上答 403，401 只留给令牌。"""

    async def deactivated(_user_id: uuid.UUID) -> Principal:
        raise AuthenticationFailed("账号已停用")

    repo = InMemoryGenerationRepository()
    gone = internal_app(
        services(generations=GenerationsAdapter(film_image_service(repo), FakePrincipals()))
    )
    stopped = internal_app(
        services(generations=GenerationsAdapter(film_image_service(repo), deactivated))
    )

    async with client_for(gone) as client:
        missing = await client.post(
            "/internal/runtime/plugins/generations", json=submission(image_request())
        )
    async with client_for(stopped) as client:
        refused = await client.post(
            "/internal/runtime/plugins/generations", json=submission(image_request())
        )

    assert (missing.status_code, missing.json()) == (404, {"detail": "用户不存在"})
    assert (refused.status_code, refused.json()) == (403, {"detail": "账号已停用"})
    assert repo.jobs == {}


@dataclass
class ScriptedBoards:
    """取帧拼板的替身：记下收到的参数；设了 ``error`` 就抛它，否则原样交回传来的台账。"""

    error: FrameBoardsFailed | None = None
    calls: list[tuple[str, tuple[tuple[ShotSpan, ...], ...], ExtractionLedger | None]] = field(
        default_factory=list[tuple[str, tuple[tuple[ShotSpan, ...], ...], ExtractionLedger | None]]
    )

    async def boards(
        self,
        *,
        video_url: str,
        rows: Sequence[Sequence[ShotSpan]],
        previous: ExtractionLedger | None,
    ) -> BoardsResult:
        self.calls.append((video_url, tuple(tuple(row) for row in rows), previous))
        if self.error is not None:
            raise self.error
        return BoardsResult(ledger=previous or LEDGER, reused=previous is not None)


ROWS = (
    (ShotSpan(shot_id=1, start_ms=0, end_ms=1500), ShotSpan(shot_id=2, start_ms=1500, end_ms=3000)),
)


def boards_body(previous: ExtractionLedger | None) -> dict[str, object]:
    return {
        "video_url": "https://cdn.test/ref.mp4",
        "rows": [
            [{"shot_id": s.shot_id, "start_ms": s.start_ms, "end_ms": s.end_ms} for s in row]
            for row in ROWS
        ],
        "previous": None if previous is None else previous.model_dump(mode="json", by_alias=True),
    }


async def test_frame_boards_pass_the_rows_and_ledger_through_and_answer_the_result() -> None:
    boards = ScriptedBoards()

    async with client_for(internal_app(services(boards=boards))) as client:
        answered = await client.post(
            "/internal/runtime/plugins/frame-boards", json=boards_body(LEDGER)
        )

    assert answered.status_code == 200, answered.text
    assert TypeAdapter(BoardsResult).validate_python(answered.json()) == BoardsResult(
        ledger=LEDGER, reused=True
    )
    assert boards.calls == [("https://cdn.test/ref.mp4", ROWS, LEDGER)]


@pytest.mark.parametrize(
    ("error", "code"),
    [
        (ShotsOutOfRange("镜头时间戳越界（视频时长 3000ms）：镜头 2。"), "shots_out_of_range"),
        (
            BoardsUnreadable("取不到素材（HTTPStatusError）: https://cdn.test/ref.mp4"),
            "boards_unreadable",
        ),
        (BoardsNotStored("图片没存进对象存储：超时。重新调用一次。"), "boards_not_stored"),
    ],
)
async def test_each_boards_failure_is_422_with_its_code_and_the_model_facing_text(
    error: FrameBoardsFailed, code: str
) -> None:
    async with client_for(internal_app(services(boards=ScriptedBoards(error=error)))) as client:
        refused = await client.post(
            "/internal/runtime/plugins/frame-boards", json=boards_body(None)
        )

    assert refused.status_code == 422
    assert refused.json() == {"detail": str(error), "code": code}
    restored = FrameBoardsFailure.model_validate(refused.json()).error()
    assert (type(restored), str(restored)) == (type(error), str(error))


def make_grid_png(path: Path) -> bytes:
    """四个纯色格、白色分隔带的 2×2 宫格。"""

    boxes = [
        (0, 0, 180, 150, "red"),
        (186, 0, 218, 150, "green"),
        (0, 156, 180, 248, "blue"),
        (186, 156, 218, 248, "orange"),
    ]
    filters = ",".join(
        f"drawbox=x={x}:y={y}:w={w}:h={h}:color={color}@1:t=fill" for x, y, w, h, color in boxes
    )
    command = ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=white:s=404x404"]
    result = subprocess.run(
        [*command, "-vf", filters, "-frames:v", "1", str(path)], capture_output=True
    )
    assert result.returncode == 0, result.stderr.decode(errors="replace")
    return path.read_bytes()


def grid_client(grid: bytes) -> httpx.AsyncClient:
    def handler(request: httpx.Request) -> httpx.Response:
        if str(request.url) == GRID_URL:
            return httpx.Response(200, content=grid)
        return httpx.Response(404)

    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def cut_body(
    job_id: uuid.UUID, cells: ShotCells | AnchorSheets, aspect: str | None
) -> dict[str, object]:
    return {
        "user_id": str(OWNER.user_id),
        "job_id": str(job_id),
        "grid_url": GRID_URL,
        "cells": cells.model_dump(mode="json"),
        "aspect": aspect,
    }


@pytest.mark.skipif(not ffmpeg_available(), reason="本机 PATH 上没有 ffmpeg/ffprobe")
@pytest.mark.parametrize(
    ("cells", "keys"),
    [
        (
            ShotCells(cell_ids=("S1-1", "S2-1")),
            [
                "iclip/agent/shot-frames/{job}/out/S1-1.jpg",
                "iclip/agent/shot-frames/{job}/out/S2-1.jpg",
            ],
        ),
        (
            AnchorSheets(indexes=(1, 2, 3)),
            [
                "iclip/agent/anchor-sheets/{job}/1.jpg",
                "iclip/agent/anchor-sheets/{job}/2.jpg",
                "iclip/agent/anchor-sheets/{job}/3.jpg",
            ],
        ),
    ],
    ids=["shot-cells", "anchor-sheets"],
)
async def test_grid_cuts_store_each_cell_under_its_unchanged_key_and_record_the_cuts(
    tmp_path: Path, cells: ShotCells | AnchorSheets, keys: list[str]
) -> None:
    objects = FakeObjects()
    records = FakeCutRecords()
    job_id = uuid.uuid4()
    async with grid_client(make_grid_png(tmp_path / "grid.png")) as fetcher:
        cuts = GridCutsAdapter(fetcher, fetch_url=as_is, objects=objects, records=records)
        async with client_for(internal_app(services(cuts=cuts))) as client:
            answered = await client.post(
                "/internal/runtime/plugins/grid-cuts", json=cut_body(job_id, cells, None)
            )

    expected = [key.format(job=job_id) for key in keys]
    assert answered.status_code == 200, answered.text
    assert answered.json() == {"urls": [objects.public_url(key) for key in expected]}
    assert list(objects.written) == expected
    assert records.cuts == [(job_id, tuple(objects.public_url(key) for key in expected))]


@pytest.mark.skipif(not ffmpeg_available(), reason="本机 PATH 上没有 ffmpeg/ffprobe")
async def test_a_failed_cut_is_422_with_the_reason_and_nothing_recorded(tmp_path: Path) -> None:
    records = FakeCutRecords()
    async with grid_client(make_grid_png(tmp_path / "grid.png")) as fetcher:
        cuts = GridCutsAdapter(fetcher, fetch_url=as_is, objects=FakeObjects(), records=records)
        async with client_for(internal_app(services(cuts=cuts))) as client:
            refused = await client.post(
                "/internal/runtime/plugins/grid-cuts",
                json=cut_body(uuid.uuid4(), ShotCells(cell_ids=("S1-1",)), "9-16"),
            )

    assert refused.status_code == 422
    assert refused.json() == {
        "detail": "画幅要写成 宽:高，比如 9:16；收到的是 '9-16'",
        "code": "grid_cut_failed",
    }
    assert records.cuts == []


@pytest.mark.skipif(not ffmpeg_available(), reason="本机 PATH 上没有 ffmpeg/ffprobe")
async def test_a_cut_that_cannot_be_recorded_is_a_server_error(tmp_path: Path) -> None:
    records = FakeCutRecords(error=ConnectionError("数据库断了"))
    async with grid_client(make_grid_png(tmp_path / "grid.png")) as fetcher:
        cuts = GridCutsAdapter(fetcher, fetch_url=as_is, objects=FakeObjects(), records=records)
        app = internal_app(services(cuts=cuts))
        transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
        async with httpx.AsyncClient(
            transport=transport, base_url="http://test", headers=AUTHORIZED
        ) as client:
            failed = await client.post(
                "/internal/runtime/plugins/grid-cuts",
                json=cut_body(uuid.uuid4(), ShotCells(cell_ids=("S1-1",)), None),
            )

    assert failed.status_code == 500


@dataclass
class ScriptedReferences:
    """参考视频服务的替身：按地址交回预设的结果。"""

    outcomes: dict[str, Outcome]
    asked: list[tuple[uuid.UUID, str]] = field(default_factory=list[tuple[uuid.UUID, str]])

    async def ensure(self, principal: Principal, video_url: str) -> Outcome:
        self.asked.append((principal.user_id, video_url))
        return self.outcomes[video_url]


async def test_a_reference_breakdown_answers_the_document_or_the_failure() -> None:
    references = ScriptedReferences(
        {
            "https://cdn.test/ok.mp4": Outcome(document="## 拆解文档"),
            "https://cdn.test/bad.mp4": Outcome(document=None, error_code="video_unreadable"),
        }
    )
    adapter = ReferenceBreakdownsAdapter(
        cast("ReferenceService", references), FakePrincipals(OWNER)
    )

    async with client_for(internal_app(services(breakdowns=adapter))) as client:
        done, failed = [
            await client.post(
                "/internal/runtime/plugins/reference-breakdowns",
                json={"user_id": str(OWNER.user_id), "video_url": url},
            )
            for url in ("https://cdn.test/ok.mp4", "https://cdn.test/bad.mp4")
        ]

    assert (done.status_code, failed.status_code) == (200, 200)
    assert ReferenceBreakdownResult.model_validate(done.json()).outcome() == "## 拆解文档"
    assert ReferenceBreakdownResult.model_validate(failed.json()).outcome() == FailedBreakdown(
        reason="video_unreadable"
    )
    assert references.asked == [
        (OWNER.user_id, "https://cdn.test/ok.mp4"),
        (OWNER.user_id, "https://cdn.test/bad.mp4"),
    ]


SHOT_ROUTES = ("generations", "frame-boards", "grid-cuts")
BREAKDOWN_ROUTES = ("reference-breakdowns",)


@pytest.mark.parametrize(
    ("plugins", "answer", "mounted"),
    [
        (services(), {"shot_video": None, "video_breakdown": False}, ()),
        (
            services(
                generations=cast("ImageGenerations", UNUSED),
                boards=cast("FrameBoards", UNUSED),
                cuts=cast("GridCuts", UNUSED),
                image_models=frozenset({"nano_banana_pro", "gpt-image-2.5"}),
            ),
            {
                "shot_video": {"image_models": ["gpt-image-2.5", "nano_banana_pro"]},
                "video_breakdown": False,
            },
            SHOT_ROUTES,
        ),
        (
            services(breakdowns=cast("ReferenceBreakdowns", UNUSED)),
            {"shot_video": None, "video_breakdown": True},
            BREAKDOWN_ROUTES,
        ),
    ],
    ids=["none", "shot_video", "video_breakdown"],
)
async def test_the_services_answer_matches_the_mounted_routes(
    plugins: RuntimePluginServices, answer: dict[str, object], mounted: tuple[str, ...]
) -> None:
    """运行时启动时照这份核对：说开了的那组路由挂着（空请求体答 422），没开的答 404。"""

    async with client_for(internal_app(plugins)) as client:
        answered = await client.get("/internal/runtime/plugins/services")
        statuses = {
            name: (await client.post(f"/internal/runtime/plugins/{name}", json={})).status_code
            for name in (*SHOT_ROUTES, *BREAKDOWN_ROUTES)
        }

    assert answered.status_code == 200
    assert answered.json() == answer
    assert statuses == {
        name: 422 if name in mounted else 404 for name in (*SHOT_ROUTES, *BREAKDOWN_ROUTES)
    }
