"""``shot_video`` 的两个媒体端口适配器：台账复用的判定、下载走换算后的地址、下载失败的端口错误，
以及切图记录按运行属主落到宫格名下。抽帧、拼板与切格的像素结果由集成测试覆盖。"""

from __future__ import annotations

import uuid
from typing import cast

import httpx
import pytest
from agent_runtime.errors import NotFound
from iclip_video.shot_video.ports import (
    EXTRACTION_VERSION,
    AnchorSheets,
    BoardsUnreadable,
    ExtractionLedger,
    GridCutFailed,
    LedgerBoard,
    ShotCells,
)
from iclip_video.shot_video.shots import parse_shot_rows
from structlog.testing import capture_logs

from iclip.app.shot_media import (
    CutRecordsAdapter,
    FrameBoardsAdapter,
    GridCutsAdapter,
    cut_object_keys,
    reusable,
)
from iclip.domains.generation.models import STATUS_COMPLETED, GenerationOutput
from iclip.domains.generation.service import SettledRecords
from iclip.domains.identity.public import Principal
from iclip.platform.media.codec import SOFTWARE
from iclip.platform.object_store.layout import MEDIA_PATHS
from tests.helpers.fetch_url import rewriting
from tests.helpers.generation import (
    InMemoryGenerationRepository,
    image_request,
    make_job,
)
from tests.helpers.identity import FakePrincipals
from tests.helpers.shot_video import FakeCutRecords, FakeObjects

KEY = "k"
VIDEO = "https://cdn.test/ref.mp4"
INTERNAL = "https://iclip.oss-cn-shenzhen-internal.aliyuncs.com"
DOCUMENT = "**[00:00.000-00:02.000]** 中景"


def board_url(*, key: str = KEY, index: int = 1) -> str:
    """替身对象存储为这次取帧的这块板发布的地址。"""

    return FakeObjects().public_url(MEDIA_PATHS.shot_board(extraction_key=key, index=index))


def ledger(url: str | None = None, *, key: str = KEY) -> ExtractionLedger:
    return ExtractionLedger(
        extraction_version=EXTRACTION_VERSION,
        extraction_key=key,
        boards=[LedgerBoard(board=1, url=url or board_url(key=key))],
    )


def test_a_ledger_of_another_version_is_not_reusable() -> None:
    stale = ledger().model_copy(update={"extraction_version": EXTRACTION_VERSION + 1})

    assert not reusable(stale, key=KEY, public_url=FakeObjects().public_url)


FORGED_BOARD_URLS = {
    "external": "https://evil.test/board.jpg",
    "our-key-on-a-foreign-host": f"https://evil.test/{MEDIA_PATHS.shot_board(extraction_key=KEY, index=1)}",
    "another-extraction": board_url(key="other"),
    "another-board": board_url(index=2),
    "extra-query": f"{board_url()}?v=1",
}
"""key 保留、板地址被改：外部地址，本系统的对象路径挂到别的域名，别的视频或拆解文档（也就是
别的对话才会产出）的板，同一次取帧的另一块板，真地址后面缀参数。"""


@pytest.mark.parametrize("url", list(FORGED_BOARD_URLS.values()), ids=list(FORGED_BOARD_URLS))
def test_a_reused_ledger_only_vouches_for_the_boards_this_extraction_published(url: str) -> None:
    """台账在模型可写的工作区里；板地址按 key 与板号重算后整串比对，对不上就不复用，
    复用分支拿不到它，也就登记不了它。"""

    with capture_logs() as logs:
        assert not reusable(ledger(url), key=KEY, public_url=FakeObjects().public_url)

    assert [log["boards"] for log in logs] == [[1]]
    assert url not in repr(logs)


def refusing_client(asked: list[str]) -> httpx.AsyncClient:
    """下载一律 404 并记下请求地址。"""

    def handler(request: httpx.Request) -> httpx.Response:
        asked.append(str(request.url))
        return httpx.Response(404)

    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


async def test_frame_boards_download_the_reference_video_from_the_rewritten_address() -> None:
    """取不到视频：端口错误的原文就是下载失败的原文，模型照它看到的一样。"""

    asked: list[str] = []
    adapter = FrameBoardsAdapter(
        refusing_client(asked),
        fetch_url=rewriting("https://cdn.test", INTERNAL),
        objects=FakeObjects(),
        codec=SOFTWARE,
    )

    with pytest.raises(BoardsUnreadable) as raised:
        await adapter.boards(video_url=VIDEO, rows=parse_shot_rows(DOCUMENT), previous=None)

    assert asked == [f"{INTERNAL}/ref.mp4"]
    assert raised.value.__cause__ is not None
    assert str(raised.value) == str(raised.value.__cause__)


def test_cut_cells_keep_the_object_keys_the_plugin_used_to_compute() -> None:
    """每格的对象 key 由后端按帧号与序号算；桶里已有的产物都是这个布局，逐字钉住。"""

    job_id = uuid.UUID("55555555-5555-5555-5555-555555555555")

    assert cut_object_keys(job_id, ShotCells(cell_ids=("S1-1", "S12-3"))) == [
        "iclip/agent/shot-frames/55555555-5555-5555-5555-555555555555/out/S1-1.jpg",
        "iclip/agent/shot-frames/55555555-5555-5555-5555-555555555555/out/S12-3.jpg",
    ]
    assert cut_object_keys(job_id, AnchorSheets(indexes=(1, 2))) == [
        "iclip/agent/anchor-sheets/55555555-5555-5555-5555-555555555555/1.jpg",
        "iclip/agent/anchor-sheets/55555555-5555-5555-5555-555555555555/2.jpg",
    ]


async def test_cutting_a_grid_downloads_it_from_the_rewritten_address() -> None:
    asked: list[str] = []
    records = FakeCutRecords()
    adapter = GridCutsAdapter(
        refusing_client(asked),
        fetch_url=rewriting("https://cdn.test", INTERNAL),
        objects=FakeObjects(),
        records=records,
    )

    with pytest.raises(GridCutFailed) as raised:
        await adapter.cut(
            uuid.uuid4(),
            uuid.uuid4(),
            grid_url="https://cdn.test/iclip/agent/generated-images/grid.png",
            cells=ShotCells(cell_ids=("S1-1",)),
            aspect=None,
        )

    assert asked == [f"{INTERNAL}/iclip/agent/generated-images/grid.png"]
    assert raised.value.__cause__ is not None
    assert str(raised.value) == str(raised.value.__cause__)
    assert records.cuts == []


def cutter(user_id: uuid.UUID) -> Principal:
    return Principal(
        kind="user",
        user_id=user_id,
        permissions=frozenset({"agent:run"}),
        audit_label="logan",
    )


async def test_cut_cells_are_recorded_against_their_grid_under_the_run_owner() -> None:
    """切出来的每一格各落一条切图：来源是宫格，对话与需求单抄宫格，属主是运行属主，与地址同序。"""

    owner = uuid.uuid4()
    grid = make_job(
        image_request(),
        status=STATUS_COMPLETED,
        owner_user_id=owner,
        conversation_id=uuid.uuid4(),
        task_id=uuid.uuid4(),
        output=GenerationOutput(url="https://cdn.test/grid.png"),
    )
    repo = InMemoryGenerationRepository([grid])
    principals = FakePrincipals(cutter(owner))
    adapter = CutRecordsAdapter(SettledRecords(repo), principals)
    urls = ["https://cdn.test/cells/S1-1.jpg", "https://cdn.test/cells/S2-1.jpg"]

    await adapter.record_cuts(owner, grid.id, urls)

    assert principals.asked == [owner], "端口只收属主 id，每次调用都按它重建一次主体"
    cells = [job for job in repo.jobs.values() if job.operation == "cut"]
    assert [job.output.url for job in cells] == urls
    assert {
        (
            job.kind,
            job.source_job_id,
            job.conversation_id,
            job.task_id,
            job.owner_user_id,
            job.status,
            job.request,
        )
        for job in cells
    } == {("image", grid.id, grid.conversation_id, grid.task_id, owner, STATUS_COMPLETED, None)}


async def test_cut_records_let_a_resolver_failure_through() -> None:
    """属主账号不在了：重建主体的错误原样抛出，生成域一次都不调。"""

    adapter = CutRecordsAdapter(cast("SettledRecords", object()), FakePrincipals())

    with pytest.raises(NotFound, match="用户不存在"):
        await adapter.record_cuts(uuid.uuid4(), uuid.uuid4(), ["https://cdn.test/cells/S1-1.jpg"])


@pytest.mark.parametrize("grid_state", ["还没完成", "是视频"])
async def test_cutting_from_anything_but_a_finished_image_is_a_bug(grid_state: str) -> None:
    """工具刚等到宫格完成才切；对不上是装配或状态坏了，不当成模型能改的输入。"""

    owner = uuid.uuid4()
    grid = (
        make_job(image_request(), owner_user_id=owner)
        if grid_state == "还没完成"
        else make_job(
            status=STATUS_COMPLETED,
            owner_user_id=owner,
            output=GenerationOutput(url="https://cdn.test/take.mp4"),
        )
    )
    repo = InMemoryGenerationRepository([grid])
    adapter = CutRecordsAdapter(SettledRecords(repo), FakePrincipals(cutter(owner)))

    with pytest.raises(RuntimeError, match="宫格"):
        await adapter.record_cuts(owner, grid.id, ["https://cdn.test/cells/S1-1.jpg"])
    assert list(repo.jobs) == [grid.id]
