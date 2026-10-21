"""参考视频的后台拆解：一次任务接手、拆解、写回，拆成再排一次打标；拆解不碰标签；四种失败各落各的
原因并保留原来的拆解；超时收尾；任务抛出后不重投。拆解走真的适配器，HTTP 与抽帧是替身，打标队列
只记下排了谁。"""

from __future__ import annotations

import uuid

import httpx
import pytest
from procrastinate.testing import InMemoryConnector
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from iclip.domains.identity.models import Principal
from iclip.domains.identity.rbac import ROLE_PERMISSIONS
from iclip.domains.references.infra_sql import SqlReferenceStore
from iclip.domains.references.models import BREAKDOWN_TIMEOUT_SECONDS
from iclip.domains.references.queue import QUEUE, ReferenceQueue
from iclip.domains.references.repository import VideoBreakdowns
from iclip.domains.references.service import ReferenceService
from tests.helpers.references import (
    DOCUMENT,
    FakeArk,
    FakeSampler,
    NoTestVideos,
    ark_pipeline,
    plant_reference,
    plant_user,
    reference_row,
    responses_body,
)
from tests.helpers.tagging import (
    RecordingTaggingQueue,
    entry_of,
    plant_entry,
    tag_id,
    tagging_service,
)

OLD_DOCUMENT = "# 出场元素\n旧的那份"


def make_queue(
    engine: AsyncEngine,
    breakdowns: VideoBreakdowns,
    tagging: RecordingTaggingQueue,
    *,
    connector: InMemoryConnector | None = None,
) -> ReferenceQueue:
    return ReferenceQueue(
        SqlReferenceStore(engine),
        breakdowns=breakdowns,
        tagging=tagging_service(engine, tagging),
        connector=connector or InMemoryConnector(),
    )


def ark_breakdowns(ark: FakeArk, *, sampler: FakeSampler | None = None) -> VideoBreakdowns:
    return ark_pipeline(ark, sampler=sampler)[0]


async def no_uploads(principal: Principal, upload_id: uuid.UUID) -> str | None:
    raise AssertionError("这里不该读上传记录")


async def pending_row(engine: AsyncEngine) -> tuple[uuid.UUID, uuid.UUID, set[uuid.UUID]]:
    """排着队的一行，带着上一次的拆解，条目上有一个人工标签与一个 AI 标签。"""

    owner = await plant_user(engine, "maya")
    reference_id = await plant_reference(
        engine, owner=owner, status="pending", document=OLD_DOCUMENT
    )
    tags = {await tag_id(engine, "平台&渠道", "AMZ"), await tag_id(engine, "品类", "拖鞋")}
    entry_id = await plant_entry(engine, reference_id, status="completed", tags=list(tags))
    return reference_id, entry_id, tags


async def test_a_breakdown_writes_the_document_and_queues_tagging_without_touching_tags(
    engine: AsyncEngine,
) -> None:
    ark = FakeArk()
    tagging = RecordingTaggingQueue()
    reference_id, entry_id, tags = await pending_row(engine)

    await make_queue(engine, ark_breakdowns(ark), tagging).run_breakdown(str(reference_id))

    row = await reference_row(engine, reference_id)
    assert row["breakdown_status"] == "completed"
    assert row["document"] == DOCUMENT
    assert row["error_code"] is None
    assert row["version"] == 2
    assert ark.breakdown_calls == 1
    assert ark.tag_requests == [], "拆解队列自己不打标"
    entry = await entry_of(engine, reference_id)
    assert (entry["tag_status"], entry["tags"]) == ("pending", tags)
    assert tagging.enqueued == [entry_id]


async def test_a_successful_rerun_queues_tagging_again(engine: AsyncEngine) -> None:
    owner = await plant_user(engine, "maya")
    reference_id = await plant_reference(engine, owner=owner)
    entry_id = await plant_entry(engine, reference_id, status="failed", error="model_failed")
    tagging = RecordingTaggingQueue()
    store = SqlReferenceStore(engine)
    queue = make_queue(engine, ark_breakdowns(FakeArk()), tagging)

    references = ReferenceService(
        store,
        own_video_upload=no_uploads,
        queue=queue,
        tagging=tagging_service(engine, tagging),
        uploads_available=False,
        test_videos=NoTestVideos(),
    )
    maya = Principal(
        kind="user", user_id=owner, permissions=ROLE_PERMISSIONS["editor"], audit_label="maya"
    )
    await references.rerun(maya, reference_id)
    assert tagging.enqueued == [], "排上重拆时还不打标"

    await queue.run_breakdown(str(reference_id))

    assert tagging.enqueued == [entry_id]
    assert (await entry_of(engine, reference_id))["tag_status"] == "pending"


async def test_a_breakdown_of_a_row_without_an_entry_creates_one_for_the_owner(
    engine: AsyncEngine,
) -> None:
    owner = await plant_user(engine, "maya")
    reference_id = await plant_reference(engine, owner=owner, status="pending", document=None)
    tagging = RecordingTaggingQueue()

    await make_queue(engine, ark_breakdowns(FakeArk()), tagging).run_breakdown(str(reference_id))

    entry = await entry_of(engine, reference_id)
    assert (entry["tag_status"], entry["created_by"]) == ("pending", owner)
    assert tagging.enqueued == [entry["id"]]


@pytest.mark.parametrize(
    ("ark", "sampler", "error_code"),
    [
        pytest.param(FakeArk(), FakeSampler(broken=True), "video_unreadable", id="video"),
        pytest.param(
            FakeArk(breakdown=httpx.Response(503, text="busy")),
            None,
            "model_call_failed",
            id="5xx",
        ),
        pytest.param(
            FakeArk(breakdown=httpx.Response(429, text="slow down")),
            None,
            "model_call_failed",
            id="429",
        ),
        pytest.param(
            FakeArk(breakdown=httpx.ConnectError("refused")),
            None,
            "model_call_failed",
            id="unreachable",
        ),
        pytest.param(
            FakeArk(breakdown=httpx.Response(200, text="<html>")),
            None,
            "model_call_failed",
            id="not-json",
        ),
        pytest.param(
            FakeArk(
                breakdown=httpx.Response(200, json=responses_body("半截", status="incomplete"))
            ),
            None,
            "model_call_failed",
            id="incomplete",
        ),
        pytest.param(
            FakeArk(breakdown=httpx.Response(200, json=responses_body("  "))),
            None,
            "model_call_failed",
            id="empty",
        ),
        pytest.param(
            FakeArk(breakdown=httpx.Response(400, text="bad video")),
            None,
            "model_failed",
            id="rejected",
        ),
        pytest.param(
            FakeArk(breakdown=httpx.ReadTimeout("too slow")),
            None,
            "model_failed",
            id="timeout",
        ),
    ],
)
async def test_a_failed_breakdown_records_its_reason_and_keeps_the_old_breakdown(
    engine: AsyncEngine, ark: FakeArk, sampler: FakeSampler | None, error_code: str
) -> None:
    reference_id, _, tags = await pending_row(engine)
    tagging = RecordingTaggingQueue()

    await make_queue(engine, ark_breakdowns(ark, sampler=sampler), tagging).run_breakdown(
        str(reference_id)
    )

    row = await reference_row(engine, reference_id)
    assert (row["breakdown_status"], row["error_code"]) == ("failed", error_code)
    assert row["document"] == OLD_DOCUMENT
    assert row["version"] == 1
    assert tagging.enqueued == [], "没拆成就不打标"
    entry = await entry_of(engine, reference_id)
    assert (entry["tag_status"], entry["tags"]) == ("completed", tags)


async def test_a_row_not_waiting_in_line_is_not_broken_down(engine: AsyncEngine) -> None:
    owner = await plant_user(engine, "maya")
    reference_id = await plant_reference(engine, owner=owner, status="completed")
    ark = FakeArk()

    await make_queue(engine, ark_breakdowns(ark), RecordingTaggingQueue()).run_breakdown(
        str(reference_id)
    )

    assert ark.requests == []
    assert (await reference_row(engine, reference_id))["version"] == 1


async def test_running_rows_past_the_limit_time_out_and_keep_their_breakdown(
    engine: AsyncEngine,
) -> None:
    owner = await plant_user(engine, "maya")
    limit_minutes = BREAKDOWN_TIMEOUT_SECONDS / 60
    stalled = await plant_reference(
        engine,
        owner=owner,
        video_url="https://cdn.example.test/a.mp4",
        status="running",
        document=OLD_DOCUMENT,
        started_minutes_ago=limit_minutes + 1,
    )
    fresh = await plant_reference(
        engine,
        owner=owner,
        video_url="https://cdn.example.test/b.mp4",
        status="running",
        started_minutes_ago=limit_minutes - 1,
    )

    queue = make_queue(engine, ark_breakdowns(FakeArk()), RecordingTaggingQueue())
    assert await queue.time_out_stalled() == 1

    timed_out = await reference_row(engine, stalled)
    assert (timed_out["breakdown_status"], timed_out["error_code"]) == ("failed", "timeout")
    assert timed_out["document"] == OLD_DOCUMENT
    assert (await reference_row(engine, fresh))["breakdown_status"] == "running"


async def test_a_late_result_does_not_overwrite_a_row_that_timed_out_and_was_rerun(
    engine: AsyncEngine,
) -> None:
    """超时收尾后又重拆的行，上一次迟到的结果不写进去。"""

    reference_id, _, _ = await pending_row(engine)
    store = SqlReferenceStore(engine)
    first = await store.claim(reference_id)
    assert first is not None
    owner = (await reference_row(engine, reference_id))["owner_user_id"]
    async with engine.begin() as conn:
        await conn.execute(
            text(
                "UPDATE iclip.reference_videos SET breakdown_status = 'failed',"
                " error_code = 'timeout' WHERE id = :id"
            ),
            {"id": reference_id},
        )
    assert await store.requeue(
        reference_id, from_failed_only=False, requested_by=owner, api_key_id=None
    )
    second = await store.claim(reference_id)
    assert second is not None

    assert not await store.finish(first, document="迟到的")

    row = await reference_row(engine, reference_id)
    assert (row["breakdown_status"], row["document"]) == ("running", OLD_DOCUMENT)


async def test_a_task_that_raises_is_not_run_again(engine: AsyncEngine) -> None:
    """崩在半路的任务停在 failed，不重投：再跑一次就是再付一次钱。"""

    reference_id, _, _ = await pending_row(engine)
    connector = InMemoryConnector()
    calls: list[str] = []

    class Crashing:
        async def breakdown(self, video_url: str) -> str:
            calls.append(video_url)
            raise RuntimeError("进程里出了没料到的错")

    queue = make_queue(engine, Crashing(), RecordingTaggingQueue(), connector=connector)
    await queue.app.open_async()
    try:
        await queue.enqueue_breakdown(reference_id)
        await queue.app.run_worker_async(queues=[QUEUE], wait=False, install_signal_handlers=False)
    finally:
        await queue.app.close_async()

    assert len(calls) == 1
    breakdown_jobs = [
        job for job in connector.jobs.values() if job["task_name"] == "references.run_breakdown"
    ]
    assert [job["status"] for job in breakdown_jobs] == ["failed"]
    assert (await reference_row(engine, reference_id))["breakdown_status"] == "running"
