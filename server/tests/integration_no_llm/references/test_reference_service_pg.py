"""参考视频用例与仓储：建行幂等、属主检查、版本冲突、拆解中不许改与重拆、移除后列表不见但按地址
仍能用、AI 导演的 ``ensure``、筛选。用例接真的 Postgres 仓储，排队与上传记录是替身。"""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import Mapping
from typing import Any

import pytest
from sqlalchemy.ext.asyncio import AsyncEngine

from iclip.common.errors import Conflict, NotFound, PermissionDenied
from iclip.domains.identity.models import Principal
from iclip.domains.identity.rbac import ROLE_PERMISSIONS
from iclip.domains.references.infra_sql import SqlReferenceStore
from iclip.domains.references.models import Tags
from iclip.domains.references.repository import OwnVideoUpload
from iclip.domains.references.schemas import ReferenceUpdateIn
from iclip.domains.references.service import ReferenceService
from tests.helpers.references import DOCUMENT, VIDEO, plant_reference, plant_user, reference_row


def principal(user_id: uuid.UUID, role: str = "editor") -> Principal:
    return Principal(
        kind="user",
        user_id=user_id,
        permissions=ROLE_PERMISSIONS[role],
        audit_label=str(user_id),
    )


class RecordingQueue:
    """记下排了哪些行；``finish_with`` 给了就像后台那样立刻把这一行拆完。"""

    def __init__(self, store: SqlReferenceStore, *, finish_with: str | None = None) -> None:
        self._store = store
        self._finish_with = finish_with
        self.enqueued: list[uuid.UUID] = []

    async def enqueue_breakdown(self, reference_id: uuid.UUID) -> None:
        self.enqueued.append(reference_id)
        if self._finish_with is not None:
            claim = await self._store.claim(reference_id)
            assert claim is not None
            await self._store.finish(claim, document=self._finish_with, tags=Tags())


class BrokenQueue:
    async def enqueue_breakdown(self, reference_id: uuid.UUID) -> None:
        raise ConnectionError("队列连不上")


def uploads_of(owned: Mapping[tuple[uuid.UUID, uuid.UUID], str]) -> OwnVideoUpload:
    """（属主，uploadId）对得上才交回地址。"""

    async def own_video_upload(who: Principal, upload_id: uuid.UUID) -> str | None:
        return owned.get((who.user_id, upload_id))

    return own_video_upload


def service(
    engine: AsyncEngine,
    queue: RecordingQueue | BrokenQueue,
    *,
    owned: Mapping[tuple[uuid.UUID, uuid.UUID], str] | None = None,
) -> ReferenceService:
    return ReferenceService(
        SqlReferenceStore(engine),
        own_video_upload=uploads_of(owned or {}),
        queue=queue,
        poll_seconds=0.01,
        wait_seconds=5,
    )


async def test_creating_twice_from_the_same_video_makes_one_row_and_one_breakdown(
    engine: AsyncEngine,
) -> None:
    maya, sara = await plant_user(engine, "maya"), await plant_user(engine, "sara")
    first_upload, second_upload = uuid.uuid4(), uuid.uuid4()
    queue = RecordingQueue(SqlReferenceStore(engine))
    references = service(
        engine, queue, owned={(maya, first_upload): VIDEO, (sara, second_upload): VIDEO}
    )

    created, was_new = await references.create(principal(maya), first_upload)
    again, again_new = await references.create(principal(sara), second_upload)

    assert (was_new, again_new) == (True, False)
    assert again.id == created.id
    assert created.breakdown_status == "pending"
    assert created.user_name == "maya"
    assert queue.enqueued == [created.id]
    listed = await references.list(principal(maya))
    assert [item.id for item in listed.items] == [created.id]


async def test_someone_elses_upload_is_not_found(engine: AsyncEngine) -> None:
    maya, sara = await plant_user(engine, "maya"), await plant_user(engine, "sara")
    upload = uuid.uuid4()
    queue = RecordingQueue(SqlReferenceStore(engine))
    references = service(engine, queue, owned={(maya, upload): VIDEO})

    with pytest.raises(NotFound):
        await references.create(principal(sara), upload)
    assert queue.enqueued == []


async def test_a_queue_that_cannot_take_it_leaves_the_row_failed_not_stuck(
    engine: AsyncEngine,
) -> None:
    maya = await plant_user(engine, "maya")
    upload = uuid.uuid4()
    references = service(engine, BrokenQueue(), owned={(maya, upload): VIDEO})

    with pytest.raises(ConnectionError):
        await references.create(principal(maya), upload)

    (item,) = (await references.list(principal(maya))).items
    assert (item.breakdown_status, item.error_code) == ("failed", "model_call_failed")


async def test_only_the_owner_edits_reruns_and_removes(engine: AsyncEngine) -> None:
    maya, sara = await plant_user(engine, "maya"), await plant_user(engine, "sara")
    reference_id = await plant_reference(engine, owner=maya)
    references = service(engine, RecordingQueue(SqlReferenceStore(engine)))
    body = ReferenceUpdateIn(version=1, document="改过", video_types=[], categories=[])

    seen = await references.get(principal(sara), reference_id)
    assert seen.can_edit is False
    with pytest.raises(PermissionDenied):
        await references.update(principal(sara), reference_id, body)
    with pytest.raises(PermissionDenied):
        await references.rerun(principal(sara), reference_id)
    with pytest.raises(PermissionDenied):
        await references.remove(principal(sara), reference_id)
    assert (await reference_row(engine, reference_id))["document"] == DOCUMENT


async def test_an_edit_with_a_stale_version_conflicts(engine: AsyncEngine) -> None:
    maya = await plant_user(engine, "maya")
    reference_id = await plant_reference(engine, owner=maya)
    references = service(engine, RecordingQueue(SqlReferenceStore(engine)))

    edited = await references.update(
        principal(maya),
        reference_id,
        ReferenceUpdateIn(
            version=1,
            document="改过的拆解",
            video_types=["review", "review"],
            categories=["跑鞋"],
        ),
    )
    assert (edited.version, edited.document) == (2, "改过的拆解")
    assert (edited.video_types, edited.categories) == (["review"], ["跑鞋"])

    with pytest.raises(Conflict):
        await references.update(
            principal(maya),
            reference_id,
            ReferenceUpdateIn(version=1, document="又改", video_types=[], categories=[]),
        )
    assert (await reference_row(engine, reference_id))["document"] == "改过的拆解"


@pytest.mark.parametrize("status", ["pending", "running"])
async def test_edits_and_reruns_conflict_while_breaking_down(
    engine: AsyncEngine, status: str
) -> None:
    maya = await plant_user(engine, "maya")
    reference_id = await plant_reference(engine, owner=maya, status=status)
    queue = RecordingQueue(SqlReferenceStore(engine))
    references = service(engine, queue)

    with pytest.raises(Conflict):
        await references.update(
            principal(maya),
            reference_id,
            ReferenceUpdateIn(version=1, document="改", video_types=[], categories=[]),
        )
    with pytest.raises(Conflict):
        await references.rerun(principal(maya), reference_id)
    assert queue.enqueued == []


async def test_a_rerun_puts_the_row_back_in_line(engine: AsyncEngine) -> None:
    maya = await plant_user(engine, "maya")
    reference_id = await plant_reference(
        engine, owner=maya, status="failed", error_code="model_failed"
    )
    queue = RecordingQueue(SqlReferenceStore(engine))

    rerun = await service(engine, queue).rerun(principal(maya), reference_id)

    assert rerun.breakdown_status == "pending"
    assert rerun.document == DOCUMENT
    assert queue.enqueued == [reference_id]


async def test_a_removed_video_leaves_the_list_but_its_breakdown_is_still_used(
    engine: AsyncEngine,
) -> None:
    maya = await plant_user(engine, "maya")
    reference_id = await plant_reference(engine, owner=maya)
    queue = RecordingQueue(SqlReferenceStore(engine))
    references = service(engine, queue)

    await references.remove(principal(maya), reference_id)

    assert (await references.list(principal(maya))).items == []
    with pytest.raises(NotFound):
        await references.get(principal(maya), reference_id)
    outcome = await references.ensure(principal(maya), VIDEO, retry=True)
    assert outcome.document == DOCUMENT
    assert queue.enqueued == []


async def test_uploading_a_removed_video_again_brings_it_back(engine: AsyncEngine) -> None:
    maya = await plant_user(engine, "maya")
    upload = uuid.uuid4()
    reference_id = await plant_reference(engine, owner=maya)
    queue = RecordingQueue(SqlReferenceStore(engine))
    references = service(engine, queue, owned={(maya, upload): VIDEO})
    await references.remove(principal(maya), reference_id)

    back, created = await references.create(principal(maya), upload)

    assert (back.id, created, back.document) == (reference_id, False, DOCUMENT)
    assert [item.id for item in (await references.list(principal(maya))).items] == [reference_id]
    assert queue.enqueued == []


async def test_ensure_uses_an_existing_breakdown_even_while_it_is_rerun(
    engine: AsyncEngine,
) -> None:
    maya, sara = await plant_user(engine, "maya"), await plant_user(engine, "sara")
    await plant_reference(engine, owner=maya, status="running")
    queue = RecordingQueue(SqlReferenceStore(engine))

    outcome = await service(engine, queue).ensure(principal(sara), VIDEO, retry=True)

    assert outcome.document == DOCUMENT
    assert queue.enqueued == []


async def test_two_ensures_of_a_new_video_break_it_down_once(engine: AsyncEngine) -> None:
    maya, sara = await plant_user(engine, "maya"), await plant_user(engine, "sara")
    queue = RecordingQueue(SqlReferenceStore(engine), finish_with="新拆的")
    references = service(engine, queue)

    first, second = await asyncio.gather(
        references.ensure(principal(maya), VIDEO, retry=True),
        references.ensure(principal(sara), VIDEO, retry=True),
    )

    assert (first.document, second.document) == ("新拆的", "新拆的")
    assert len(queue.enqueued) == 1
    (item,) = (await references.list(principal(maya))).items
    assert item.user_name in {"maya", "sara"}


async def test_ensure_without_retry_reports_a_failure_at_once(engine: AsyncEngine) -> None:
    maya = await plant_user(engine, "maya")
    await plant_reference(
        engine, owner=maya, status="failed", document=None, error_code="video_unreadable"
    )
    queue = RecordingQueue(SqlReferenceStore(engine))
    references = ReferenceService(
        SqlReferenceStore(engine),
        own_video_upload=uploads_of({}),
        queue=queue,
        poll_seconds=60,
        wait_seconds=60,
    )

    outcome = await asyncio.wait_for(references.ensure(principal(maya), VIDEO, retry=False), 5)

    assert (outcome.document, outcome.error_code) == (None, "video_unreadable")
    assert queue.enqueued == []


async def test_ensure_with_retry_puts_a_failed_video_back_in_line(engine: AsyncEngine) -> None:
    maya = await plant_user(engine, "maya")
    reference_id = await plant_reference(
        engine, owner=maya, status="failed", document=None, error_code="model_call_failed"
    )
    queue = RecordingQueue(SqlReferenceStore(engine), finish_with="重拆的")

    outcome = await service(engine, queue).ensure(principal(maya), VIDEO, retry=True)

    assert outcome.document == "重拆的"
    assert queue.enqueued == [reference_id]


async def test_filters_match_any_tag_in_a_group_and_q_searches_the_breakdown(
    engine: AsyncEngine,
) -> None:
    maya = await plant_user(engine, "maya")
    sandal = await plant_reference(
        engine,
        owner=maya,
        video_url="https://cdn.example.test/1.mp4",
        document="# 出场元素\n凉拖鞋 100%纯棉",
        video_types=("review",),
        categories=("凉拖鞋",),
        created_minutes_ago=3,
    )
    runner = await plant_reference(
        engine,
        owner=maya,
        video_url="https://cdn.example.test/2.mp4",
        document="# 出场元素\n跑鞋",
        video_types=("try_on", "drama"),
        categories=("跑鞋", "袜子"),
        created_minutes_ago=2,
    )
    untagged = await plant_reference(
        engine,
        owner=maya,
        video_url="https://cdn.example.test/3.mp4",
        document="# 出场元素\n100纯棉",
        created_minutes_ago=1,
    )
    references = service(engine, RecordingQueue(SqlReferenceStore(engine)))
    reader = principal(maya, "viewer")

    async def ids(**filters: Any) -> list[uuid.UUID]:
        return [item.id for item in (await references.list(reader, **filters)).items]

    assert await ids() == [untagged, runner, sandal]
    assert await ids(video_types=["review", "drama"]) == [runner, sandal]
    assert await ids(categories=["袜子"]) == [runner]
    assert await ids(categories=["凉拖鞋", "跑鞋"], video_types=["review"]) == [sandal]
    assert await ids(q="跑鞋") == [runner]
    assert await ids(q="100%") == [sandal], "% 按字面匹配，不是通配符"
    assert await ids(user_name="nobody") == []

    filters = await references.filters()
    counts = {one.value: one.count for one in filters.video_types}
    assert (counts["review"], counts["try_on"], counts["live_clip"]) == (1, 1, 0)
    assert len(filters.video_types) == 8
    assert {one.name: one.count for one in filters.categories} == {
        "凉拖鞋": 1,
        "跑鞋": 1,
        "袜子": 1,
    }


async def test_the_list_pages_with_a_cursor_and_gives_the_total_on_the_first_page(
    engine: AsyncEngine,
) -> None:
    maya = await plant_user(engine, "maya")
    planted = [
        await plant_reference(
            engine,
            owner=maya,
            video_url=f"https://cdn.example.test/{index}.mp4",
            created_minutes_ago=10 - index,
        )
        for index in range(3)
    ]
    references = service(engine, RecordingQueue(SqlReferenceStore(engine)))

    first = await references.list(principal(maya), limit=2)
    rest = await references.list(principal(maya), limit=2, cursor=first.next_cursor)

    assert [item.id for item in first.items] == [planted[2], planted[1]]
    assert first.total == 3
    assert ([item.id for item in rest.items], rest.total, rest.next_cursor) == (
        [planted[0]],
        None,
        None,
    )
