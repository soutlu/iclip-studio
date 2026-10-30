"""参考视频用例与仓储：建行幂等与建条目、属主检查、版本冲突、拆解中不许改与重拆、改标签与重新打标、
移除后列表不见但按地址仍能用、AI 导演的 ``ensure``、按标签筛选。用例接真的 Postgres 仓储，排队与
上传记录是替身。"""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import Mapping
from typing import Any

import pytest
from agent_runtime.errors import Conflict, NotFound, PermissionDenied, ValidationFailed
from sqlalchemy.ext.asyncio import AsyncEngine

from iclip.domains.identity.models import Principal
from iclip.domains.identity.rbac import ROLE_PERMISSIONS
from iclip.domains.references.infra_sql import SqlReferenceStore
from iclip.domains.references.models import ReferenceVideo
from iclip.domains.references.repository import OwnVideoUpload
from iclip.domains.references.schemas import ReferenceTagsIn, ReferenceUpdateIn
from iclip.domains.references.service import ReferenceService
from tests.helpers.references import (
    DOCUMENT,
    VIDEO,
    NoTestVideos,
    plant_reference,
    plant_user,
    reference_row,
)
from tests.helpers.tagging import (
    RecordingTaggingQueue,
    entry_of,
    plant_entry,
    tag_id,
    tagging_service,
)


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
            await self._store.finish(claim, document=self._finish_with)


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
    tagging: RecordingTaggingQueue | None = None,
) -> ReferenceService:
    return ReferenceService(
        SqlReferenceStore(engine),
        own_video_upload=uploads_of(owned or {}),
        queue=queue,
        tagging=tagging_service(engine, tagging or RecordingTaggingQueue()),
        uploads_available=True,
        test_videos=NoTestVideos(),
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
    # 还在资料库里的那一行，别人再传只是打开它，属主不变。
    assert (created.user_name, again.user_name, again.can_edit) == ("maya", "maya", False)
    assert queue.enqueued == [created.id]
    listed = await references.list(principal(maya))
    assert [item.id for item in listed.items] == [created.id]
    entry = await entry_of(engine, created.id)
    assert (entry["tag_status"], entry["created_by"], entry["tags"]) == (None, maya, set())
    assert (created.tag_ids, created.tag_status, created.tag_error) == ([], None, None)


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
    body = ReferenceUpdateIn(version=1, document="改过")
    runner = await tag_id(engine, "品类", "跑鞋")

    seen = await references.get(principal(sara), reference_id)
    assert seen.can_edit is False
    with pytest.raises(PermissionDenied):
        await references.update(principal(sara), reference_id, body)
    with pytest.raises(PermissionDenied):
        await references.replace_tags(
            principal(sara), reference_id, ReferenceTagsIn(tag_ids=[runner])
        )
    with pytest.raises(PermissionDenied):
        await references.retag(principal(sara), reference_id)
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
        principal(maya), reference_id, ReferenceUpdateIn(version=1, document="改过的拆解")
    )
    assert (edited.version, edited.document) == (2, "改过的拆解")

    with pytest.raises(Conflict):
        await references.update(
            principal(maya), reference_id, ReferenceUpdateIn(version=1, document="又改")
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
            ReferenceUpdateIn(version=1, document="改"),
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
    outcome = await references.ensure(principal(maya), VIDEO)
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


async def test_someone_else_uploading_a_removed_video_takes_it_over(engine: AsyncEngine) -> None:
    maya, sara = await plant_user(engine, "maya"), await plant_user(engine, "sara")
    upload = uuid.uuid4()
    reference_id = await plant_reference(engine, owner=maya)
    queue = RecordingQueue(SqlReferenceStore(engine))
    references = service(engine, queue, owned={(sara, upload): VIDEO})
    await references.remove(principal(maya), reference_id)

    back, created = await references.create(principal(sara), upload)

    assert (back.id, created, back.document) == (reference_id, False, DOCUMENT)
    assert (back.user_name, back.can_edit) == ("sara", True)
    assert (await references.get(principal(maya), reference_id)).can_edit is False
    assert queue.enqueued == []


async def test_ensure_uses_an_existing_breakdown_even_while_it_is_rerun(
    engine: AsyncEngine,
) -> None:
    maya, sara = await plant_user(engine, "maya"), await plant_user(engine, "sara")
    await plant_reference(engine, owner=maya, status="running")
    queue = RecordingQueue(SqlReferenceStore(engine))

    outcome = await service(engine, queue).ensure(principal(sara), VIDEO)

    assert outcome.document == DOCUMENT
    assert queue.enqueued == []


async def test_two_ensures_of_a_new_video_break_it_down_once(engine: AsyncEngine) -> None:
    maya, sara = await plant_user(engine, "maya"), await plant_user(engine, "sara")
    queue = RecordingQueue(SqlReferenceStore(engine), finish_with="新拆的")
    references = service(engine, queue)

    first, second = await asyncio.gather(
        references.ensure(principal(maya), VIDEO),
        references.ensure(principal(sara), VIDEO),
    )

    assert (first.document, second.document) == ("新拆的", "新拆的")
    assert len(queue.enqueued) == 1
    (item,) = (await references.list(principal(maya))).items
    assert item.user_name in {"maya", "sara"}
    entry = await entry_of(engine, item.id)
    assert entry["tag_status"] is None, "对话里拆的视频也有条目"
    assert entry["created_by"] in {maya, sara}


async def test_ensure_puts_a_failed_video_back_in_line_and_waits_for_the_new_result(
    engine: AsyncEngine,
) -> None:
    maya = await plant_user(engine, "maya")
    reference_id = await plant_reference(
        engine, owner=maya, status="failed", document=None, error_code="model_call_failed"
    )
    queue = RecordingQueue(SqlReferenceStore(engine), finish_with="重拆的")

    outcome = await service(engine, queue).ensure(principal(maya), VIDEO)

    assert outcome.document == "重拆的"
    assert queue.enqueued == [reference_id]


class LockstepStore(SqlReferenceStore):
    """两次 ``ensure_row`` 都读完才放行，让两次 ``ensure`` 都看到那一行还是已失败。"""

    def __init__(self, engine: AsyncEngine) -> None:
        super().__init__(engine)
        self._both_read = asyncio.Barrier(2)

    async def ensure_row(
        self,
        video_url: str,
        *,
        owner: uuid.UUID,
        requested_by: uuid.UUID,
        api_key_id: uuid.UUID | None,
    ) -> tuple[ReferenceVideo, bool]:
        found = await super().ensure_row(
            video_url, owner=owner, requested_by=requested_by, api_key_id=api_key_id
        )
        await self._both_read.wait()
        return found


async def test_two_ensures_of_a_failed_video_put_it_back_in_line_once(engine: AsyncEngine) -> None:
    maya, sara = await plant_user(engine, "maya"), await plant_user(engine, "sara")
    reference_id = await plant_reference(
        engine, owner=maya, status="failed", document=None, error_code="model_call_failed"
    )
    queue = RecordingQueue(SqlReferenceStore(engine), finish_with="重拆的")
    references = ReferenceService(
        LockstepStore(engine),
        own_video_upload=uploads_of({}),
        queue=queue,
        tagging=tagging_service(engine, RecordingTaggingQueue()),
        uploads_available=True,
        test_videos=NoTestVideos(),
        poll_seconds=0.01,
        wait_seconds=5,
    )

    first, second = await asyncio.gather(
        references.ensure(principal(maya), VIDEO),
        references.ensure(principal(sara), VIDEO),
    )

    assert (first.document, second.document) == ("重拆的", "重拆的")
    assert queue.enqueued == [reference_id]


async def test_tag_filters_and_across_dimensions_or_within_and_parents_include_children(
    engine: AsyncEngine,
) -> None:
    maya = await plant_user(engine, "maya")
    sandal_tag = await tag_id(engine, "品类", "凉拖鞋")
    runner_tag = await tag_id(engine, "品类", "跑鞋")
    sock_tag = await tag_id(engine, "品类", "袜子")
    review = await tag_id(engine, "内容结构", "开箱测评型")
    compare = await tag_id(engine, "内容结构", "开箱测评型", "对比测评")
    drama = await tag_id(engine, "内容结构", "剧情叙事型")
    sandal = await plant_reference(
        engine,
        owner=maya,
        video_url="https://cdn.example.test/1.mp4",
        document="# 出场元素\n凉拖鞋 100%纯棉",
        created_minutes_ago=4,
    )
    await plant_entry(engine, sandal, tags=[sandal_tag, review])
    runner = await plant_reference(
        engine,
        owner=maya,
        video_url="https://cdn.example.test/2.mp4",
        document="# 出场元素\n跑鞋",
        created_minutes_ago=3,
    )
    await plant_entry(engine, runner, tags=[runner_tag, sock_tag, compare])
    gone = await plant_reference(
        engine,
        owner=maya,
        video_url="https://cdn.example.test/4.mp4",
        created_minutes_ago=2,
    )
    await plant_entry(engine, gone, tags=[runner_tag, drama])
    untagged = await plant_reference(
        engine,
        owner=maya,
        video_url="https://cdn.example.test/3.mp4",
        document="# 出场元素\n100纯棉",
        created_minutes_ago=1,
    )
    references = service(engine, RecordingQueue(SqlReferenceStore(engine)))
    await references.remove(principal(maya), gone)
    reader = principal(maya, "viewer")

    async def ids(**filters: Any) -> list[uuid.UUID]:
        page = await references.list(reader, **filters)
        assert page.total == len(page.items)
        return [item.id for item in page.items]

    assert await ids() == [untagged, runner, sandal]
    assert await ids(tags=[sock_tag]) == [runner]
    assert await ids(tags=[sandal_tag, runner_tag]) == [runner, sandal], "同一维度命中任一"
    assert await ids(tags=[runner_tag, review]) == [runner], "维度之间都要命中；大类含小类"
    assert await ids(tags=[compare]) == [runner], "小类不含大类本身"
    assert await ids(tags=[sandal_tag, drama]) == []
    assert await ids(tags=[drama]) == [], "移除的不在列表里"
    assert await ids(q="跑鞋") == [runner]
    assert await ids(q="100%") == [sandal], "% 按字面匹配，不是通配符"
    assert await ids(user_name="nobody") == []
    with pytest.raises(ValidationFailed):
        await ids(tags=[uuid.uuid4()])

    (listed,) = [item for item in (await references.list(reader)).items if item.id == runner]
    assert set(listed.tag_ids) == {runner_tag, sock_tag, compare}


async def test_replacing_tags_overwrites_every_dimension(engine: AsyncEngine) -> None:
    maya = await plant_user(engine, "maya")
    reference_id = await plant_reference(engine, owner=maya)
    amz = await tag_id(engine, "平台&渠道", "AMZ")
    await plant_entry(
        engine, reference_id, status="completed", tags=[amz, await tag_id(engine, "品类", "拖鞋")]
    )
    dtc = await tag_id(engine, "平台&渠道", "DTC")
    runner = await tag_id(engine, "品类", "跑鞋")
    references = service(engine, RecordingQueue(SqlReferenceStore(engine)))

    replaced = await references.replace_tags(
        principal(maya), reference_id, ReferenceTagsIn(tag_ids=[dtc, runner, runner])
    )

    assert set(replaced.tag_ids) == {dtc, runner}
    assert (await entry_of(engine, reference_id))["tags"] == {dtc, runner}


async def test_replacing_tags_creates_the_entry_when_missing(engine: AsyncEngine) -> None:
    maya = await plant_user(engine, "maya")
    reference_id = await plant_reference(engine, owner=maya)
    amz = await tag_id(engine, "平台&渠道", "AMZ")
    references = service(engine, RecordingQueue(SqlReferenceStore(engine)))

    await references.replace_tags(principal(maya), reference_id, ReferenceTagsIn(tag_ids=[amz]))

    entry = await entry_of(engine, reference_id)
    assert (entry["tags"], entry["created_by"]) == ({amz}, maya)


@pytest.mark.parametrize("status", ["pending", "running"])
async def test_tags_cannot_change_while_tagging(engine: AsyncEngine, status: str) -> None:
    maya = await plant_user(engine, "maya")
    reference_id = await plant_reference(engine, owner=maya)
    slipper = await tag_id(engine, "品类", "拖鞋")
    await plant_entry(engine, reference_id, status=status, tags=[slipper])
    tagging = RecordingTaggingQueue()
    references = service(engine, RecordingQueue(SqlReferenceStore(engine)), tagging=tagging)

    with pytest.raises(Conflict):
        await references.replace_tags(
            principal(maya),
            reference_id,
            ReferenceTagsIn(tag_ids=[await tag_id(engine, "品类", "跑鞋")]),
        )
    with pytest.raises(Conflict):
        await references.retag(principal(maya), reference_id)
    assert (await entry_of(engine, reference_id))["tags"] == {slipper}
    assert tagging.enqueued == []


async def test_unknown_tags_and_dimensions_are_rejected(engine: AsyncEngine) -> None:
    maya = await plant_user(engine, "maya")
    reference_id = await plant_reference(engine, owner=maya)
    slipper = await tag_id(engine, "品类", "拖鞋")
    await plant_entry(engine, reference_id, tags=[slipper])
    references = service(engine, RecordingQueue(SqlReferenceStore(engine)))

    for wrong in (uuid.uuid4(), await tag_id(engine, "品类")):
        with pytest.raises(ValidationFailed):
            await references.replace_tags(
                principal(maya), reference_id, ReferenceTagsIn(tag_ids=[wrong])
            )
    assert (await entry_of(engine, reference_id))["tags"] == {slipper}


async def test_retagging_needs_a_finished_breakdown_and_queues_the_entry(
    engine: AsyncEngine,
) -> None:
    maya = await plant_user(engine, "maya")
    done = await plant_reference(engine, owner=maya, video_url="https://cdn.example.test/d.mp4")
    entry_id = await plant_entry(engine, done, status="failed", error="model_failed")
    never = await plant_reference(
        engine,
        owner=maya,
        video_url="https://cdn.example.test/n.mp4",
        status="failed",
        document=None,
        error_code="video_unreadable",
    )
    breaking = await plant_reference(
        engine, owner=maya, video_url="https://cdn.example.test/b.mp4", status="running"
    )
    tagging = RecordingTaggingQueue()
    references = service(engine, RecordingQueue(SqlReferenceStore(engine)), tagging=tagging)

    for not_ready in (never, breaking):
        with pytest.raises(Conflict):
            await references.retag(principal(maya), not_ready)
    retagged = await references.retag(principal(maya), done)

    assert (retagged.tag_status, retagged.tag_error) == ("pending", "model_failed")
    assert tagging.enqueued == [entry_id]


async def test_filters_list_owners_by_count_and_skip_removed_rows(engine: AsyncEngine) -> None:
    maya = await plant_user(engine, "maya")
    sara = await plant_user(engine, "sara")
    nora = await plant_user(engine, "nora")
    for index in range(2):
        await plant_reference(
            engine, owner=maya, video_url=f"https://cdn.example.test/m{index}.mp4"
        )
    await plant_reference(engine, owner=sara, video_url="https://cdn.example.test/s.mp4")
    await plant_reference(engine, owner=nora, video_url="https://cdn.example.test/n.mp4")
    removed = await plant_reference(engine, owner=nora, video_url="https://cdn.example.test/n2.mp4")
    gone = await plant_reference(engine, owner=nora, video_url="https://cdn.example.test/n3.mp4")
    references = service(engine, RecordingQueue(SqlReferenceStore(engine)))
    await references.remove(principal(nora), removed)
    await references.remove(principal(nora), gone)

    owners = (await references.filters()).owners

    # 条数多的在前，同数按用户名；移除的不算。
    assert [(one.user_name, one.count) for one in owners] == [
        ("maya", 2),
        ("nora", 1),
        ("sara", 1),
    ]


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
