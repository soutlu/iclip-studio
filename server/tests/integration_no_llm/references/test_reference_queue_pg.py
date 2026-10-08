"""参考视频的后台拆解：一次任务接手、拆解、打标、一次写回；四种失败各落各的原因并保留原来的拆解；
超时收尾；任务抛出后不重投。拆解与打标走真的适配器，HTTP 与抽帧是替身。"""

from __future__ import annotations

import uuid

import httpx
import pytest
from procrastinate.testing import InMemoryConnector
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from iclip.domains.references.infra_sql import SqlReferenceStore
from iclip.domains.references.models import BREAKDOWN_TIMEOUT_SECONDS, Tags
from iclip.domains.references.queue import QUEUE, ReferenceQueue
from tests.helpers.references import (
    DOCUMENT,
    FakeArk,
    FakeSampler,
    ark_pipeline,
    plant_reference,
    plant_user,
    reference_row,
    responses_body,
    tag_answer,
)

OLD_DOCUMENT = "# 出场元素\n旧的那份"


def make_queue(
    engine: AsyncEngine,
    ark: FakeArk,
    *,
    sampler: FakeSampler | None = None,
    connector: InMemoryConnector | None = None,
) -> ReferenceQueue:
    breakdowns, tagger = ark_pipeline(ark, sampler=sampler)
    return ReferenceQueue(
        SqlReferenceStore(engine),
        breakdowns=breakdowns,
        tagger=tagger,
        connector=connector or InMemoryConnector(),
    )


async def pending_row(engine: AsyncEngine) -> uuid.UUID:
    """排着队的一行，带着上一次的拆解与标签。"""

    owner = await plant_user(engine, "maya")
    return await plant_reference(
        engine,
        owner=owner,
        status="pending",
        document=OLD_DOCUMENT,
        video_types=("drama",),
        categories=("拖鞋",),
    )


async def test_a_breakdown_writes_back_the_document_and_deduplicated_tags(
    engine: AsyncEngine,
) -> None:
    ark = FakeArk(tag=tag_answer(("review", "try_on", "review"), ("跑鞋", "袜子", "跑鞋")))
    reference_id = await pending_row(engine)

    await make_queue(engine, ark).run_breakdown(str(reference_id))

    row = await reference_row(engine, reference_id)
    assert row["breakdown_status"] == "completed"
    assert row["document"] == DOCUMENT
    assert (row["video_types"], row["categories"]) == (["review", "try_on"], ["跑鞋", "袜子"])
    assert row["error_code"] is None
    assert row["version"] == 2
    assert row["started_at"] is not None
    assert ark.breakdown_calls == 1


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
    reference_id = await pending_row(engine)

    await make_queue(engine, ark, sampler=sampler).run_breakdown(str(reference_id))

    row = await reference_row(engine, reference_id)
    assert (row["breakdown_status"], row["error_code"]) == ("failed", error_code)
    assert row["document"] == OLD_DOCUMENT
    assert (row["video_types"], row["categories"]) == (["drama"], ["拖鞋"])
    assert row["version"] == 1
    assert ark.tag_requests == [], "没拆成就不打标"


@pytest.mark.parametrize(
    "tag",
    [
        pytest.param(tag_answer(("review",), ("拖鞋", "人字拖")), id="unknown-category"),
        pytest.param(tag_answer(("vlog",), ()), id="unknown-type"),
        pytest.param(httpx.Response(200, json=responses_body("{videoTypes: [")), id="bad-json"),
        pytest.param(httpx.Response(500, text="boom"), id="call-failed"),
        pytest.param(httpx.ConnectError("refused"), id="unreachable"),
    ],
)
async def test_failed_tagging_leaves_tags_empty_and_still_completes(
    engine: AsyncEngine, tag: httpx.Response | Exception
) -> None:
    reference_id = await pending_row(engine)

    await make_queue(engine, FakeArk(tag=tag)).run_breakdown(str(reference_id))

    row = await reference_row(engine, reference_id)
    assert row["breakdown_status"] == "completed"
    assert row["document"] == DOCUMENT
    assert (row["video_types"], row["categories"]) == ([], [])


async def test_a_row_not_waiting_in_line_is_not_broken_down(engine: AsyncEngine) -> None:
    owner = await plant_user(engine, "maya")
    reference_id = await plant_reference(engine, owner=owner, status="completed")
    ark = FakeArk()

    await make_queue(engine, ark).run_breakdown(str(reference_id))

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
        categories=("拖鞋",),
        started_minutes_ago=limit_minutes + 1,
    )
    fresh = await plant_reference(
        engine,
        owner=owner,
        video_url="https://cdn.example.test/b.mp4",
        status="running",
        started_minutes_ago=limit_minutes - 1,
    )

    assert await make_queue(engine, FakeArk()).time_out_stalled() == 1

    timed_out = await reference_row(engine, stalled)
    assert (timed_out["breakdown_status"], timed_out["error_code"]) == ("failed", "timeout")
    assert (timed_out["document"], timed_out["categories"]) == (OLD_DOCUMENT, ["拖鞋"])
    assert (await reference_row(engine, fresh))["breakdown_status"] == "running"


async def test_a_late_result_does_not_overwrite_a_row_that_timed_out_and_was_rerun(
    engine: AsyncEngine,
) -> None:
    """超时收尾后又重拆的行，上一次迟到的结果不写进去。"""

    reference_id = await pending_row(engine)
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

    assert not await store.finish(first, document="迟到的", tags=Tags())

    row = await reference_row(engine, reference_id)
    assert (row["breakdown_status"], row["document"]) == ("running", OLD_DOCUMENT)


async def test_a_task_that_raises_is_not_run_again(engine: AsyncEngine) -> None:
    """崩在半路的任务停在 failed，不重投：再跑一次就是再付一次钱。"""

    reference_id = await pending_row(engine)
    connector = InMemoryConnector()
    calls: list[str] = []

    class Crashing:
        async def breakdown(self, video_url: str) -> str:
            calls.append(video_url)
            raise RuntimeError("进程里出了没料到的错")

    _, tagger = ark_pipeline(FakeArk())
    queue = ReferenceQueue(
        SqlReferenceStore(engine), breakdowns=Crashing(), tagger=tagger, connector=connector
    )
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
