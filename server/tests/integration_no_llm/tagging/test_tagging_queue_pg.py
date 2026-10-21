"""后台打标：一次任务接手、取文字、按当前 AI 维度打标、一次写回；AI 维度整组重写，人工维度不动；
失败与超时只清 AI 维度；按开始时刻核对，迟到的结果不写；打标中被删的标签跳过。打标走真的适配器，
HTTP 是替身。"""

from __future__ import annotations

import uuid
from collections.abc import Sequence

import httpx
import pytest
from procrastinate.testing import InMemoryConnector
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from iclip.app.library_tagging import HitCaseTreatments, LibrarySourceText
from iclip.domains.library.reports_pg import PgLibraryReports
from iclip.domains.references.infra_sql import SqlReferenceStore
from iclip.domains.tagging.infra_sql import SqlTagStore
from iclip.domains.tagging.models import TAGGING_TIMEOUT_SECONDS, EntryKey, TagNode
from iclip.domains.tagging.queue import TaggingQueue
from iclip.domains.tagging.repository import Tagger
from iclip.domains.tagging.service import TaggingService
from iclip.platform.file_store.pg import PgFileStore
from tests.helpers.hit_cases import (
    TREATMENT,
    hit_case_rows,
    plant_conversation,
    plant_hit_case,
    plant_job,
    plant_material,
    plant_treatment,
)
from tests.helpers.references import (
    DOCUMENT,
    FakeArk,
    ark_pipeline,
    plant_reference,
    plant_user,
    tag_answer,
)
from tests.helpers.tagging import add_tag, delete_tag, entry_of, plant_entry, tag_id


def make_queue(engine: AsyncEngine, tagger: Tagger) -> TaggingQueue:
    return TaggingQueue(
        SqlTagStore(engine),
        source_text=LibrarySourceText(
            SqlReferenceStore(engine),
            library=PgLibraryReports(engine),
            treatments=HitCaseTreatments(PgFileStore(engine)),
        ),
        tagger=tagger,
        connector=InMemoryConnector(),
    )


def ark_tagger(ark: FakeArk) -> Tagger:
    return ark_pipeline(ark)[1]


async def pending_entry(
    engine: AsyncEngine, *, document: str | None = DOCUMENT
) -> tuple[uuid.UUID, uuid.UUID, dict[str, uuid.UUID]]:
    """排着队的一条：带一个人工维度的标签（AMZ）与上一次 AI 打的标签（拖鞋、口播讲解型）。"""

    owner = await plant_user(engine, "maya")
    reference_id = await plant_reference(engine, owner=owner, document=document)
    tags = {
        "amz": await tag_id(engine, "平台&渠道", "AMZ"),
        "slipper": await tag_id(engine, "品类", "拖鞋"),
        "talk": await tag_id(engine, "内容结构", "口播讲解型"),
    }
    entry_id = await plant_entry(engine, reference_id, status="pending", tags=list(tags.values()))
    return reference_id, entry_id, tags


async def test_ai_dimensions_are_rewritten_and_manual_ones_kept(engine: AsyncEngine) -> None:
    ark = FakeArk(tag=tag_answer({"d1": ["跑鞋"], "d2": [], "d3": ["开箱测评型", "对比测评"]}))
    reference_id, entry_id, tags = await pending_entry(engine)

    await make_queue(engine, ark_tagger(ark)).run_tagging(str(entry_id))

    entry = await entry_of(engine, reference_id)
    assert (entry["tag_status"], entry["tag_error"]) == ("completed", None)
    assert entry["tag_started_at"] is not None
    assert entry["tags"] == {
        tags["amz"],
        await tag_id(engine, "品类", "跑鞋"),
        await tag_id(engine, "内容结构", "开箱测评型", "对比测评"),
    }, "选了小类就不留大类；旧的 AI 标签换掉，人工的留着"


async def test_the_request_only_offers_the_ai_dimensions_of_the_current_tree(
    engine: AsyncEngine,
) -> None:
    ark = FakeArk()
    _, entry_id, _ = await pending_entry(engine)

    await make_queue(engine, ark_tagger(ark)).run_tagging(str(entry_id))

    (sent,) = ark.tag_requests
    assert sent["input"][1]["content"] == [{"type": "input_text", "text": DOCUMENT}]
    properties = sent["text"]["format"]["schema"]["properties"]
    assert list(properties) == ["d1", "d2", "d3"]
    assert "跑鞋" in properties["d1"]["items"]["enum"]
    assert properties["d2"]["items"]["enum"] == [
        "居家/日常放松",
        "户外/公园散步",
        "通勤/长时间站立",
    ]
    assert {"开箱测评型", "对比测评"} <= set(properties["d3"]["items"]["enum"])
    offered = {value for one in properties.values() for value in one["items"]["enum"]}
    assert "AMZ" not in offered, "人工维度不给模型选"


@pytest.mark.parametrize(
    ("answer", "code"),
    [
        pytest.param(httpx.Response(500, text="boom"), "model_call_failed", id="call-failed"),
        pytest.param(httpx.Response(400, text="rejected"), "model_failed", id="rejected"),
        pytest.param(tag_answer({"d1": ["人字拖"], "d2": [], "d3": []}), "model_failed", id="bad"),
    ],
)
async def test_a_failure_records_its_reason_and_clears_only_ai_dimensions(
    engine: AsyncEngine, answer: httpx.Response, code: str
) -> None:
    reference_id, entry_id, tags = await pending_entry(engine)

    await make_queue(engine, ark_tagger(FakeArk(tag=answer))).run_tagging(str(entry_id))

    entry = await entry_of(engine, reference_id)
    assert (entry["tag_status"], entry["tag_error"]) == ("failed", code)
    assert entry["tags"] == {tags["amz"]}


async def test_no_text_to_read_fails_without_calling_the_model(engine: AsyncEngine) -> None:
    ark = FakeArk()
    reference_id, entry_id, tags = await pending_entry(engine, document=None)

    await make_queue(engine, ark_tagger(ark)).run_tagging(str(entry_id))

    entry = await entry_of(engine, reference_id)
    assert (entry["tag_status"], entry["tag_error"]) == ("failed", "no_source_text")
    assert entry["tags"] == {tags["amz"]}
    assert ark.requests == []


async def test_a_hit_case_is_tagged_from_its_conversations_treatment(
    engine: AsyncEngine,
) -> None:
    ark = FakeArk()
    owner = await plant_user(engine, "nora")
    _, job_id = await plant_material(engine, owner)
    amz = await tag_id(engine, "平台&渠道", "AMZ")
    entry_id = await plant_hit_case(engine, job_id, tags=[amz], status="pending")

    await make_queue(engine, ark_tagger(ark)).run_tagging(str(entry_id))

    (sent,) = ark.tag_requests
    assert sent["input"][1]["content"] == [{"type": "input_text", "text": TREATMENT}]
    assert await hit_case_rows(engine, job_id) == (1, 3), "AMZ 留着，另打上跑鞋与对比测评"


async def test_a_hit_case_without_treatment_text_has_nothing_to_tag(engine: AsyncEngine) -> None:
    """没有新片执行方案、只有空白、不挂对话、记录不存在，都取不到文字；打标记 ``no_source_text``。"""

    owner = await plant_user(engine, "nora")
    blank_conversation = await plant_conversation(engine, owner)
    await plant_treatment(engine, owner, blank_conversation, " \n")
    blank = await plant_job(engine, owner, blank_conversation)
    missing = await plant_job(engine, owner, await plant_conversation(engine, owner))
    detached = await plant_job(engine, owner, None)
    source = LibrarySourceText(
        SqlReferenceStore(engine),
        library=PgLibraryReports(engine),
        treatments=HitCaseTreatments(PgFileStore(engine)),
    )

    for job_id in (blank, missing, detached, uuid.uuid4()):
        assert await source.text(EntryKey(kind="hit_case", subject_id=job_id)) is None

    ark = FakeArk()
    entry_id = await plant_hit_case(engine, missing, status="pending")
    await make_queue(engine, ark_tagger(ark)).run_tagging(str(entry_id))
    async with engine.connect() as conn:
        row = (
            await conn.execute(
                text("SELECT tag_status, tag_error FROM iclip.library_entries WHERE id = :id"),
                {"id": entry_id},
            )
        ).one()
    assert tuple(row) == ("failed", "no_source_text")
    assert ark.requests == []


async def test_an_entry_not_waiting_in_line_is_not_tagged(engine: AsyncEngine) -> None:
    owner = await plant_user(engine, "maya")
    reference_id = await plant_reference(engine, owner=owner)
    entry_id = await plant_entry(engine, reference_id, status="completed")
    ark = FakeArk()

    await make_queue(engine, ark_tagger(ark)).run_tagging(str(entry_id))

    assert ark.requests == []
    assert (await entry_of(engine, reference_id))["tag_status"] == "completed"


class DeletingTagger:
    """选中一个标签，交回之前它已被治理者删掉。"""

    def __init__(self, engine: AsyncEngine, doomed: uuid.UUID, kept: uuid.UUID) -> None:
        self._engine = engine
        self._doomed = doomed
        self._kept = kept

    async def tag(self, text: str, dimensions: Sequence[TagNode]) -> tuple[uuid.UUID, ...]:
        await delete_tag(self._engine, self._doomed)
        return (self._doomed, self._kept)


async def test_a_tag_deleted_while_tagging_is_skipped(engine: AsyncEngine) -> None:
    reference_id, entry_id, tags = await pending_entry(engine)
    doomed = await add_tag(engine, await tag_id(engine, "场景"), "海边")
    runner = await tag_id(engine, "品类", "跑鞋")

    await make_queue(engine, DeletingTagger(engine, doomed, runner)).run_tagging(str(entry_id))

    entry = await entry_of(engine, reference_id)
    assert entry["tag_status"] == "completed"
    assert entry["tags"] == {tags["amz"], runner}


async def test_a_late_result_does_not_overwrite_an_entry_that_timed_out_and_was_requeued(
    engine: AsyncEngine,
) -> None:
    reference_id, entry_id, tags = await pending_entry(engine)
    store = SqlTagStore(engine)
    first = await store.claim(entry_id)
    assert first is not None
    async with engine.begin() as conn:
        await conn.execute(
            text(
                "UPDATE iclip.library_entries SET tag_status = 'failed', tag_error = 'timeout'"
                " WHERE id = :id"
            ),
            {"id": entry_id},
        )
    key = EntryKey(kind="reference", subject_id=reference_id)
    assert await store.request(key) == entry_id
    second = await store.claim(entry_id)
    assert second is not None

    assert not await store.finish(first, [await tag_id(engine, "品类", "跑鞋")])
    assert not await store.fail(first, error_code="model_failed")

    entry = await entry_of(engine, reference_id)
    assert (entry["tag_status"], entry["tags"]) == ("running", set(tags.values()))


async def test_running_entries_past_the_limit_time_out_and_lose_only_ai_tags(
    engine: AsyncEngine,
) -> None:
    owner = await plant_user(engine, "maya")
    amz = await tag_id(engine, "平台&渠道", "AMZ")
    slipper = await tag_id(engine, "品类", "拖鞋")
    limit_minutes = TAGGING_TIMEOUT_SECONDS / 60
    stalled = await plant_reference(engine, owner=owner, video_url="https://cdn.example.test/a.mp4")
    fresh = await plant_reference(engine, owner=owner, video_url="https://cdn.example.test/b.mp4")
    await plant_entry(
        engine,
        stalled,
        status="running",
        tags=[amz, slipper],
        started_minutes_ago=limit_minutes + 1,
    )
    await plant_entry(
        engine, fresh, status="running", tags=[slipper], started_minutes_ago=limit_minutes - 1
    )

    assert await make_queue(engine, ark_tagger(FakeArk())).time_out_stalled() == 1

    timed_out = await entry_of(engine, stalled)
    assert (timed_out["tag_status"], timed_out["tag_error"]) == ("failed", "timeout")
    assert timed_out["tags"] == {amz}
    still = await entry_of(engine, fresh)
    assert (still["tag_status"], still["tags"]) == ("running", {slipper})


class BrokenTaggingQueue:
    async def enqueue_tagging(self, entry_id: uuid.UUID) -> None:
        raise ConnectionError("队列连不上")


async def test_an_entry_that_cannot_be_queued_fails_instead_of_staying_pending(
    engine: AsyncEngine,
) -> None:
    reference_id, _, tags = await pending_entry(engine)
    tagging = TaggingService(SqlTagStore(engine), queue=BrokenTaggingQueue())

    with pytest.raises(ConnectionError):
        await tagging.enqueue(EntryKey(kind="reference", subject_id=reference_id), created_by=None)

    entry = await entry_of(engine, reference_id)
    assert (entry["tag_status"], entry["tag_error"]) == ("failed", "model_call_failed")
    assert entry["tags"] == {tags["amz"]}
