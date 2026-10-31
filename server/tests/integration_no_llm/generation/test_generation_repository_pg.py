"""验证生成仓储的数据库时钟、JSON 往返、外键、条件更新原子性与分叉继承的读范围。

列表筛选经 HTTP 入口走真实 SQL，同时核对参数解析、包含匹配与分页。
"""

from __future__ import annotations

import json
import uuid
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import pytest
from agent_runtime.errors import NotFound, ValidationFailed
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from iclip.domains.conversations.infra_sql import SqlConversationRepository
from iclip.domains.generation.api import create_generations_router
from iclip.domains.generation.infra_sql import SqlGenerationRepository
from iclip.domains.generation.models import (
    STATUS_COMPLETED,
    STATUS_FAILED,
    STATUS_PENDING,
    STATUS_SUBMITTED,
    STATUS_SUBMITTING,
    GenerationJob,
    GenerationKind,
    GenerationOperation,
    GenerationOutput,
)
from iclip.domains.generation.schemas import SubtitleSentence
from iclip.domains.generation.stored_requests import GenerationRequest
from iclip.domains.identity.acting import ActAs
from iclip.domains.identity.public import Principal
from tests.helpers.app import app_with_principal, make_client
from tests.helpers.fork_lineage import (
    complete,
    finished,
    make_user,
    open_conversation,
    three_level_fork,
)
from tests.helpers.generation import (
    compose_request,
    edit_range,
    edit_request,
    film_image_service,
    image_request,
    make_composite,
    make_cut,
    make_edit,
    make_job,
    make_subtitle,
    make_upload,
    video_request,
)
from tests.helpers.identity import InMemoryUserRepository


def query_client(repo: SqlGenerationRepository, owner: uuid.UUID) -> httpx.AsyncClient:
    """列表经真实路由、服务与 SQL 仓储；只注入主体，不启服务后台或外部模型。"""

    app = app_with_principal(
        Principal(
            kind="user",
            user_id=owner,
            permissions=frozenset({"generation:read"}),
            audit_label="reader",
        )
    )
    app.include_router(
        create_generations_router(film_image_service(repo), act_as=ActAs(InMemoryUserRepository()))
    )
    return make_client(app)


async def insert_job(
    repo: SqlGenerationRepository,
    owner: uuid.UUID,
    request: GenerationRequest | None = None,
) -> GenerationJob:
    return await repo.create(make_job(request or video_request(), owner_user_id=owner))


async def test_timestamps_come_from_the_database_clock(engine: AsyncEngine) -> None:

    repo = SqlGenerationRepository(engine)
    owner = await make_user(engine)
    stale = datetime.now(UTC) - timedelta(days=365)

    job = await repo.create(make_job(video_request(), owner_user_id=owner, created_at=stale))

    assert job.status == STATUS_PENDING
    assert job.created_at.tzinfo is not None
    assert job.created_at > stale + timedelta(days=1), "应用传进来的时刻被数据库改写了"
    assert job.submitted_at is None and job.finished_at is None


async def test_state_transitions_round_trip_through_the_table(engine: AsyncEngine) -> None:

    repo = SqlGenerationRepository(engine)
    owner = await make_user(engine)
    request = video_request(reference_image_urls=["https://example.test/first.png"])
    job = await insert_job(repo, owner, request)

    submitting = await repo.mark_submitting(job.id)
    assert submitting is not None and submitting.status == STATUS_SUBMITTING
    assert await repo.mark_submitting(job.id) is None, "只有还在排队的才改成提交中"
    submitted = await repo.mark_submitted(job.id, provider_task_id="t-1", provider_status="queued")
    assert submitted.status == STATUS_SUBMITTED
    assert submitted.submitted_at is not None

    running = await repo.record_progress(job.id, provider_status="running")
    assert running is not None
    assert running.provider_status == "running"
    assert running.status == STATUS_SUBMITTED, "还在跑不改状态"

    completed = await repo.mark_completed(
        job.id,
        output=GenerationOutput(
            url="https://cdn.test/v.mp4", watermark_url="https://cdn.test/v-wm.mp4"
        ),
        provider_status="succeeded",
    )
    assert completed is not None
    assert completed.finished_at is not None
    assert completed.output.watermark_url == "https://cdn.test/v-wm.mp4"
    assert completed.submitted_at == submitted.submitted_at, "别把发出去的时刻改成拿到结果的时刻"
    assert completed.request == request, "请求体读回来必须还是原来那个"


async def test_sync_result_backfills_the_submitted_moment(engine: AsyncEngine) -> None:

    repo = SqlGenerationRepository(engine)
    owner = await make_user(engine)
    job = await insert_job(repo, owner, image_request())

    await repo.mark_submitting(job.id)
    completed = await repo.mark_completed(
        job.id,
        output=GenerationOutput(url="https://cdn.test/out.png"),
        provider_status="succeeded",
        provider_task_id="img-1",
    )
    assert completed is not None
    assert completed.provider_task_id == "img-1", "对账 id 错过这一步就永远没人写它"
    assert completed.submitted_at is not None


async def test_status_guard_never_overwrites_a_real_result(engine: AsyncEngine) -> None:
    """WHERE 状态守卫须阻止延迟的中断清理覆盖已成功的生成结果。"""

    repo = SqlGenerationRepository(engine)
    owner = await make_user(engine)
    job = await insert_job(repo, owner, image_request())

    await repo.mark_submitting(job.id)
    await repo.mark_completed(
        job.id, output=GenerationOutput(url="https://cdn.test/out.png"), provider_status="succeeded"
    )

    missed = await repo.mark_failed(
        job.id,
        error_code="SUBMIT_INTERRUPTED",
        error_message="不知道发出去没有",
        only_if_status=STATUS_SUBMITTING,
    )
    assert missed is None, "状态已经不是 submitting，这次写入必须一行都不动"

    stored = await repo.get(job.id, owner=owner)
    assert stored.status == STATUS_COMPLETED
    assert stored.output.url == "https://cdn.test/out.png"
    assert stored.error_code is None


async def test_a_late_result_cannot_revive_a_job_that_was_already_failed(
    engine: AsyncEngine,
) -> None:
    """反向也要守住：heal 按心跳判失联不等于原来那次真死了，它回来时不能把失败改回成功。"""

    repo = SqlGenerationRepository(engine)
    owner = await make_user(engine)
    job = await insert_job(repo, owner, image_request())

    await repo.mark_submitting(job.id)
    await repo.mark_failed(
        job.id, error_code="SUBMIT_INTERRUPTED", error_message="不知道发出去没有"
    )

    missed = await repo.mark_completed(
        job.id,
        output=GenerationOutput(url="https://cdn.test/late.png"),
        provider_status="succeeded",
        only_if_status=STATUS_SUBMITTING,
    )
    assert missed is None, "状态已经不是 submitting，这次写入必须一行都不动"

    stored = await repo.get(job.id, owner=owner)
    assert stored.status == STATUS_FAILED
    assert stored.output == GenerationOutput()


async def test_stage_reports_stop_at_a_conclusion(engine: AsyncEngine) -> None:
    """阶段上报只写 provider_status；已有结论后，迟到的上报不许改它。"""

    repo = SqlGenerationRepository(engine)
    owner = await make_user(engine)
    job = await insert_job(repo, owner, image_request())

    await repo.mark_submitting(job.id)
    reported = await repo.record_progress(
        job.id, provider_status="processing", only_if_status=STATUS_SUBMITTING
    )
    assert reported is not None
    assert reported.provider_status == "processing"

    await repo.mark_completed(
        job.id, output=GenerationOutput(url="https://cdn.test/out.mp4"), provider_status="completed"
    )
    late = await repo.record_progress(
        job.id, provider_status="uploading", only_if_status=STATUS_SUBMITTING
    )
    assert late is None, "已有结论，迟到的阶段上报不许改它"

    stored = await repo.get(job.id, owner=owner)
    assert stored.provider_status == "completed"


async def test_polling_skips_an_unchanged_upstream_status_and_writes_a_changed_one(
    engine: AsyncEngine,
) -> None:
    repo = SqlGenerationRepository(engine)
    owner = await make_user(engine)
    job = await insert_job(repo, owner, video_request())
    await repo.mark_submitting(job.id)
    await repo.mark_submitted(job.id, provider_task_id="t-1", provider_status="queued")

    unchanged = await repo.record_progress(
        job.id, provider_status="queued", only_if_status=STATUS_SUBMITTED, skip_unchanged=True
    )
    changed = await repo.record_progress(
        job.id, provider_status="running", only_if_status=STATUS_SUBMITTED, skip_unchanged=True
    )

    assert unchanged is None, "状态没变就不写"
    assert changed is not None and changed.provider_status == "running"
    assert (await repo.get(job.id, owner=owner)).provider_status == "running"


async def test_status_guard_lets_the_write_through_when_it_matches(engine: AsyncEngine) -> None:
    repo = SqlGenerationRepository(engine)
    owner = await make_user(engine)
    job = await insert_job(repo, owner)
    await repo.mark_submitting(job.id)

    failed = await repo.mark_failed(
        job.id,
        error_code="SUBMIT_INTERRUPTED",
        error_message="不知道发出去没有",
        only_if_status=STATUS_SUBMITTING,
    )
    assert failed is not None
    assert failed.status == STATUS_FAILED
    assert failed.error_code == "SUBMIT_INTERRUPTED"


async def test_reads_are_scoped_to_the_owner(engine: AsyncEngine) -> None:
    repo = SqlGenerationRepository(engine)
    mine = await make_user(engine)
    theirs = await make_user(engine)
    job = await insert_job(repo, theirs)

    with pytest.raises(NotFound):
        await repo.get(job.id, owner=mine)
    assert (await repo.get(job.id, owner=theirs)).id == job.id
    assert (await repo.get(job.id, owner=None)).id == job.id, "治理者视角不过滤"

    assert await repo.list_for_owner(owner=mine, limit=10) == ()
    assert len(await repo.list_for_owner(owner=None, limit=10)) == 1


async def test_origin_round_trips_and_filters_by_conversation(engine: AsyncEngine) -> None:

    repo = SqlGenerationRepository(engine)
    owner = await make_user(engine)
    conversation_id, task_id = uuid.uuid4(), uuid.uuid4()
    tagged = await repo.create(
        make_job(
            video_request(),
            owner_user_id=owner,
            conversation_id=conversation_id,
            metadata={"path": "video_shot.json", "shot": 3},
            task_id=task_id,
        )
    )
    await insert_job(repo, owner)

    assert (tagged.conversation_id, tagged.metadata, tagged.task_id) == (
        conversation_id,
        {"path": "video_shot.json", "shot": 3},
        task_id,
    )
    read_back = await repo.get(tagged.id, owner=owner)
    assert (read_back.conversation_id, read_back.metadata, read_back.task_id) == (
        conversation_id,
        {"path": "video_shot.json", "shot": 3},
        task_id,
    )

    listed = await repo.list_for_owner(owner=owner, limit=10, conversation_id=conversation_id)
    assert [job.id for job in listed] == [tagged.id]
    by_task = await repo.list_for_owner(owner=owner, limit=10, task_id=task_id)
    assert [job.id for job in by_task] == [tagged.id]
    assert len(await repo.list_for_owner(owner=owner, limit=10)) == 2, "不给就是不筛"


async def test_deleting_the_owner_takes_their_generations_with_it(
    engine: AsyncEngine,
) -> None:
    repo = SqlGenerationRepository(engine)
    owner = await make_user(engine)
    job = await insert_job(repo, owner)

    async with engine.begin() as conn:
        await conn.execute(text("DELETE FROM iclip.users WHERE id = :id"), {"id": owner})
    with pytest.raises(NotFound):
        await repo.get(job.id, owner=None)


async def test_metadata_containment_filtering_pagination_and_owner_scope(
    engine: AsyncEngine,
) -> None:
    """坐标存 JSONB 列，筛选走 ``@>`` 包含匹配，且在分页截断之前生效。"""

    def coordinate(frame: int) -> dict[str, Any]:
        return {"path": "video_shot.json", "shot": 1, "frame": frame}

    def edit(frame: int, owner_id: uuid.UUID) -> GenerationJob:
        return make_job(
            image_request(metadata=coordinate(frame)),
            owner_user_id=owner_id,
            metadata=coordinate(frame),
        )

    repo = SqlGenerationRepository(engine)
    owner = await make_user(engine)
    other = await make_user(engine)
    first = await repo.create(edit(1, owner))
    second = await repo.create(edit(1, owner))
    other_frame = await repo.create(edit(2, owner))
    await repo.create(make_job(owner_user_id=owner))
    foreign = await repo.create(edit(1, other))

    async with query_client(repo, owner) as http:

        async def page_before(before: uuid.UUID | None = None) -> httpx.Response:
            params = {
                "limit": "1",
                "kind": "image",
                "metadata": json.dumps({"shot": 1, "frame": 1}),
            }
            if before is not None:
                params["before"] = str(before)
            return await http.get("/generations", params=params)

        page = await page_before()
        assert page.status_code == 200, page.text
        assert [job["id"] for job in page.json()["items"]] == [str(second.id)]
        assert [job["id"] for job in (await page_before(second.id)).json()["items"]] == [
            str(first.id)
        ]
        assert (await page_before(first.id)).json()["items"] == []
        assert (await page_before(foreign.id)).status_code == 404
        by_shot = await http.get("/generations", params={"metadata": json.dumps({"shot": 1})})
        assert {job["id"] for job in by_shot.json()["items"]} == {
            str(first.id),
            str(second.id),
            str(other_frame.id),
        }
    assert (await repo.get(second.id, owner=owner)).request == second.request


async def test_in_flight_by_conversation_summarises_unfinished_video_jobs(
    engine: AsyncEngine,
) -> None:
    """侧栏角标要的摘要：全在排队是 queued，有一条交给上游就是 running，跑完的和图片不算；
    编辑段与合成也是视频行，在跑时对话同样算在出片。"""

    repo = SqlGenerationRepository(engine)
    owner = await make_user(engine)
    queued_only, running, settled, images_only, editing, composing = (
        uuid.uuid4() for _ in range(6)
    )

    await repo.create(make_job(video_request(), owner_user_id=owner, conversation_id=queued_only))
    await repo.create(make_job(video_request(), owner_user_id=owner, conversation_id=running))
    submitted = await repo.create(
        make_job(video_request(), owner_user_id=owner, conversation_id=running)
    )
    await repo.mark_submitting(submitted.id)
    finished = await repo.create(
        make_job(video_request(), owner_user_id=owner, conversation_id=settled)
    )
    await repo.mark_completed(
        finished.id,
        output=GenerationOutput(url="https://cdn.example.test/a.mp4"),
        provider_status="succeeded",
    )
    await repo.create(make_job(image_request(), owner_user_id=owner, conversation_id=images_only))
    edit = await repo.create(make_edit(finished, owner_user_id=owner, conversation_id=editing))
    composite = await repo.create(
        make_composite(edit, owner_user_id=owner, conversation_id=composing)
    )
    await repo.mark_submitting(composite.id)

    phases = await repo.in_flight_by_conversation(owner=owner, kind="video")

    assert phases == {
        queued_only: "queued",
        running: "running",
        editing: "queued",
        composing: "running",
    }
    assert await repo.in_flight_by_conversation(owner=await make_user(engine), kind="video") == {}


async def test_latest_master_by_conversation_takes_each_conversations_newest_master(
    engine: AsyncEngine,
) -> None:
    """审计列表要的最新素材片：按完成时刻取最晚的出片或合成，同一刻取 id 大的；编辑段、失败与在途的
    出片、没有地址的记录、图片都不算；每段对话只看记在自己名下的。"""

    repo = SqlGenerationRepository(engine)
    owner = await make_user(engine)
    newest, composed, tied, nothing = (uuid.uuid4() for _ in range(4))

    # 先建后完成：完成时刻最晚的是它，建立时刻却是最早的。
    started_first = await repo.create(
        make_job(video_request(), owner_user_id=owner, conversation_id=newest)
    )
    take = await finished(repo, owner, newest, "take")
    started_first = await complete(repo, started_first, "https://example.test/started-first.mp4")
    # 下面几条都比它晚，但都不是素材片。
    await complete(
        repo,
        await repo.create(make_edit(take, owner_user_id=owner, conversation_id=newest)),
        "https://example.test/edit.mp4",
    )
    failed = await repo.create(
        make_job(video_request(), owner_user_id=owner, conversation_id=newest)
    )
    await repo.mark_failed(failed.id, error_code="UPSTREAM_FAILED", error_message="上游拒了")
    await repo.create(make_job(video_request(), owner_user_id=owner, conversation_id=newest))
    await finished(repo, owner, newest, "image", image_request())
    no_address = await finished(repo, owner, newest, "no-address")
    async with engine.begin() as conn:
        await conn.execute(
            text(
                "UPDATE iclip.generation_jobs SET output = NULLIF(output - 'url', '{}'::jsonb)"
                " WHERE id = :id"
            ),
            {"id": no_address.id},
        )

    base = await finished(repo, owner, composed, "base")
    edit = await complete(
        repo,
        await repo.create(make_edit(base, owner_user_id=owner, conversation_id=composed)),
        "https://example.test/composed-edit.mp4",
    )
    composite = await complete(
        repo,
        await repo.create(make_composite(edit, owner_user_id=owner, conversation_id=composed)),
        "https://example.test/composite.mp4",
    )

    pair = [await finished(repo, owner, tied, name) for name in ("tie-a", "tie-b")]
    async with engine.begin() as conn:
        await conn.execute(
            text(
                "UPDATE iclip.generation_jobs SET finished_at = :at"
                " WHERE id = ANY(CAST(:ids AS uuid[]))"
            ),
            {"at": datetime.now(UTC), "ids": [job.id for job in pair]},
        )
    tie_winner = max(pair, key=lambda job: job.id)

    await finished(repo, owner, nothing, "nothing-image", image_request())
    # 没问到的对话里最晚的素材片，不串进别的对话。
    await finished(repo, owner, uuid.uuid4(), "outsider")

    latest = await repo.latest_master_by_conversation(
        [newest, composed, tied, nothing, uuid.uuid4()]
    )

    assert latest == {
        newest: started_first.output.url,
        composed: composite.output.url,
        tied: tie_winner.output.url,
    }
    assert await repo.latest_master_by_conversation([]) == {}


async def test_latest_master_by_conversation_leaves_inherited_masters_out(
    engine: AsyncEngine,
) -> None:
    """分叉副本读得到祖先的素材片，最新素材片却只看它自己名下的：只在继承来的出片上剪了一段、还没合成的
    副本没有素材片。"""

    chain = await three_level_fork(engine)
    repo = SqlGenerationRepository(engine)
    bare = await open_conversation(
        SqlConversationRepository(engine), chain.forker, forked_from=chain.parent.id
    )
    await complete(
        repo,
        await repo.create(
            make_edit(chain.from_parent, owner_user_id=chain.forker, conversation_id=bare.id)
        ),
        "https://example.test/bare-edit.mp4",
    )

    latest = await repo.latest_master_by_conversation(
        [chain.grand.id, chain.parent.id, chain.child.id, bare.id]
    )

    assert latest == {
        chain.grand.id: chain.grand_after_parent.output.url,
        chain.parent.id: chain.parent_after_child.output.url,
        chain.child.id: chain.own.output.url,
    }


async def test_operation_source_and_range_round_trip_and_filter(engine: AsyncEngine) -> None:
    """编辑段与合成的来源、原作落列，区间记在请求里，都读得回；列表按 operation、source_job_id 筛，
    与别的筛选叠加收窄。"""

    repo = SqlGenerationRepository(engine)
    owner = await make_user(engine)
    take = await repo.create(make_job(video_request(), owner_user_id=owner))
    edit = await repo.create(
        make_edit(take, owner_user_id=owner, range_start_ms=0, range_end_ms=2500)
    )
    composite = await repo.create(make_composite(edit, owner_user_id=owner))
    other_edit = await repo.create(make_edit(take, owner_user_id=owner))
    other_take = await repo.create(make_job(video_request(), owner_user_id=owner))
    unrelated_edit = await repo.create(make_edit(other_take, owner_user_id=owner))

    read_back = await repo.get(edit.id, owner=owner)
    assert (
        read_back.operation,
        read_back.source_job_id,
        read_back.root_job_id,
        *edit_range(read_back),
    ) == ("generate", take.id, take.id, 0, 2500)
    assert read_back.request == edit.request
    stored = await repo.get(composite.id, owner=owner)
    assert (stored.kind, stored.operation, stored.source_job_id, stored.root_job_id) == (
        "video",
        "compose",
        take.id,
        take.id,
    )
    assert stored.request == composite.request, (
        "合成的各段连同出处读回来原样，取到结尾的那段仍是开放的"
    )

    async with query_client(repo, owner) as http:

        async def listed(**filters: str) -> set[uuid.UUID]:
            response = await http.get("/generations", params=filters)
            assert response.status_code == 200, response.text
            return {uuid.UUID(job["id"]) for job in response.json()["items"]}

        assert await listed(sourceJobId=str(take.id)) == {edit.id, other_edit.id, composite.id}
        assert await listed(sourceJobId=str(edit.id)) == set(), "合成的来源是基底，不是夹入的编辑段"
        assert await listed(sourceJobId=str(take.id), operation="generate") == {
            edit.id,
            other_edit.id,
        }
        assert await listed(operation="compose") == {composite.id}
        assert await listed(rootJobId=str(take.id)) == {edit.id, other_edit.id, composite.id}
        assert await listed(operation="generate", rootJobId=str(take.id)) == {
            edit.id,
            other_edit.id,
        }
        assert await listed(operation="generate") == {
            take.id,
            edit.id,
            other_edit.id,
            other_take.id,
            unrelated_edit.id,
        }


async def test_shot_index_round_trips_and_filters_alongside_the_coordinates(
    engine: AsyncEngine,
) -> None:
    """镜号落列读回；列表按镜号筛，可与坐标、对话叠加收窄，坐标里的同名键不算镜号。"""

    repo = SqlGenerationRepository(engine)
    owner = await make_user(engine)
    conversation = uuid.uuid4()
    take = await repo.create(
        make_job(
            video_request(),
            owner_user_id=owner,
            conversation_id=conversation,
            shot_index=2,
            metadata={"frame": 1},
        )
    )
    edit = await repo.create(make_edit(take, owner_user_id=owner, conversation_id=conversation))
    other_shot = await repo.create(
        make_job(video_request(), owner_user_id=owner, conversation_id=conversation, shot_index=3)
    )
    tagged_only = await repo.create(
        make_job(
            video_request(), owner_user_id=owner, conversation_id=conversation, metadata={"shot": 2}
        )
    )

    assert (await repo.get(take.id, owner=owner)).shot_index == 2
    assert (await repo.get(edit.id, owner=owner)).shot_index == 2
    assert (await repo.get(tagged_only.id, owner=owner)).shot_index is None

    async with query_client(repo, owner) as http:

        async def listed(**filters: str) -> set[uuid.UUID]:
            response = await http.get("/generations", params=filters)
            assert response.status_code == 200, response.text
            return {uuid.UUID(job["id"]) for job in response.json()["items"]}

        assert await listed(shotIndex="2") == {take.id, edit.id}
        assert await listed(shotIndex="2", conversationId=str(uuid.uuid4())) == set()
        assert await listed(shotIndex="2", metadata=json.dumps({"frame": 1})) == {take.id}
        assert await listed(shotIndex="3") == {other_shot.id}
        assert await listed(shotIndex="4") == set()


async def test_duration_is_written_only_when_completion_brings_one(engine: AsyncEngine) -> None:
    """时长记进产出；完成时没给时长，产出里就没有。"""

    repo = SqlGenerationRepository(engine)
    owner = await make_user(engine)
    take = await repo.create(make_job(video_request(), owner_user_id=owner))
    edit = await repo.create(make_edit(take, owner_user_id=owner))
    composite = await repo.create(make_composite(edit, owner_user_id=owner))
    image = await insert_job(repo, owner, image_request())

    await repo.mark_submitting(composite.id)
    measured = await repo.mark_completed(
        composite.id,
        output=GenerationOutput(url="https://cdn.test/master.mp4", duration_ms=7040),
        provider_status="completed",
        only_if_status=STATUS_SUBMITTING,
    )
    await repo.mark_completed(
        image.id,
        output=GenerationOutput(url="https://cdn.test/out.png"),
        provider_status="succeeded",
    )

    assert measured is not None and measured.output.duration_ms == 7040
    stored = await repo.get(composite.id, owner=owner)
    assert stored.output.duration_ms == 7040
    assert (await repo.get(image.id, owner=owner)).output.duration_ms is None


async def test_settled_rows_land_once_on_the_database_clock_without_a_request(
    engine: AsyncEngine,
) -> None:
    """创建即完成的几行一次落：与输入同序，建立与完成是数据库时钟的同一刻，请求是 SQL NULL。
    同 id 再落一次跳过、不覆盖，返回值里没有它。"""

    repo = SqlGenerationRepository(engine)
    owner = await make_user(engine)
    stale = datetime.now(UTC) - timedelta(days=365)
    grid = await finished(repo, owner, uuid.uuid4(), "grid", image_request())
    upload = make_upload(owner_user_id=owner, created_at=stale, finished_at=stale)
    cells = [make_cut(grid), make_cut(grid)]

    landed = await repo.create_settled([upload, *cells])
    again = await repo.create_settled(
        [replace(upload, output=GenerationOutput(url="https://example.test/replaced.png"))]
    )

    assert [job.id for job in landed] == [upload.id, *(cell.id for cell in cells)]
    assert again == ()
    stored = await repo.get(upload.id, owner=None)
    assert (stored.operation, stored.request, stored.output.url) == (
        "upload",
        None,
        upload.output.url,
    )
    assert {job.provider for job in landed} == {None}, "上传与切图不交给执行方"
    assert stored.created_at == stored.finished_at
    assert stored.created_at > stale + timedelta(days=1), "应用传进来的时刻被数据库改写了"
    async with engine.connect() as conn:
        nulls = (
            await conn.execute(
                text(
                    "SELECT bool_and(request IS NULL) FROM iclip.generation_jobs "
                    "WHERE operation IN ('cut', 'upload')"
                )
            )
        ).scalar_one()
    assert nulls is True, "没有请求落的是 SQL NULL，不是 JSON null"


_MD5 = "0123456789abcdef0123456789abcdef"


async def test_a_video_upload_is_found_by_its_md5_earliest_first_across_owners(
    engine: AsyncEngine,
) -> None:
    """按 MD5 找视频上传：不看属主，取最早建立的那条；别的 MD5、没记 MD5 的不算，没有给 None。"""

    repo = SqlGenerationRepository(engine)
    sara, logan = await make_user(engine), await make_user(engine)
    other = "f" * 32
    first = _video_upload(sara, _MD5)
    later = _video_upload(logan, _MD5)
    await repo.create_settled([make_upload(kind="video", owner_user_id=logan)])
    await repo.create_settled([_video_upload(logan, other)])
    await repo.create_settled([first])
    await repo.create_settled([later])

    found = await repo.find_video_upload_by_md5(_MD5)

    assert found is not None
    assert (found.id, found.owner_user_id, found.output.content_md5) == (first.id, sara, _MD5)
    assert await repo.find_video_upload_by_md5("e" * 32) is None


async def test_an_output_round_trips_and_stores_only_its_present_top_level_keys(
    engine: AsyncEngine,
) -> None:
    """产出存成 snake_case 的对象：顶层空项不存，句子里的 ``speaker: null`` 照存，读回一致；
    没有产出存 SQL NULL，读回是空对象。"""

    repo = SqlGenerationRepository(engine)
    owner = await make_user(engine)
    take = await finished(repo, owner, uuid.uuid4(), "take")
    subtitle = await repo.create(make_subtitle(take))
    sentences = (
        SubtitleSentence(start_ms=0, end_ms=900, text="好。", speaker=None),
        SubtitleSentence(start_ms=900, end_ms=1500, text="走。", speaker=1),
    )
    await repo.mark_submitting(subtitle.id)
    done = await repo.mark_transcribed(
        subtitle.id, sentences=sentences, provider_status="succeeded", provider_task_id="r"
    )
    video = await repo.create(make_job(video_request(), owner_user_id=owner))
    full = GenerationOutput(
        url="https://cdn.test/v.mp4", watermark_url="https://cdn.test/v-wm.mp4", duration_ms=5040
    )
    await repo.mark_completed(video.id, output=full, provider_status="succeeded")
    pending = await repo.create(make_job(video_request(), owner_user_id=owner))

    async with engine.connect() as conn:
        found = await conn.execute(
            text(
                "SELECT id, output FROM iclip.generation_jobs WHERE id = ANY(CAST(:ids AS uuid[]))"
            ),
            {"ids": [subtitle.id, video.id, pending.id]},
        )
        rows: dict[uuid.UUID, Any] = {row.id: row.output for row in found}

    assert rows[subtitle.id] == {
        "sentences": [
            {"start_ms": 0, "end_ms": 900, "text": "好。", "speaker": None, "words": []},
            {"start_ms": 900, "end_ms": 1500, "text": "走。", "speaker": 1, "words": []},
        ]
    }
    assert rows[video.id] == {
        "url": "https://cdn.test/v.mp4",
        "watermark_url": "https://cdn.test/v-wm.mp4",
        "duration_ms": 5040,
    }
    assert rows[pending.id] is None
    assert done is not None and done.output == GenerationOutput(sentences=sentences)
    assert (await repo.get(subtitle.id, owner=owner)).output.sentences == sentences
    assert (await repo.get(video.id, owner=owner)).output == full
    assert (await repo.get(pending.id, owner=owner)).output == GenerationOutput()


async def test_an_output_with_an_unknown_key_fails_to_read(engine: AsyncEngine) -> None:
    repo = SqlGenerationRepository(engine)
    owner = await make_user(engine)
    take = await finished(repo, owner, uuid.uuid4(), "take")
    async with engine.begin() as conn:
        await conn.execute(
            text(
                'UPDATE iclip.generation_jobs SET output = output || \'{"output_url": "x"}\''
                " WHERE id = :id"
            ),
            {"id": take.id},
        )

    with pytest.raises(ValidationFailed, match="生成产出的形状不合法"):
        await repo.get(take.id, owner=owner)


async def test_the_latest_reference_trial_is_the_owners_newest_video_take_for_it(
    engine: AsyncEngine,
) -> None:
    repo = SqlGenerationRepository(engine)
    owner, other = await make_user(engine), await make_user(engine)
    reference, unrelated = uuid.uuid4(), uuid.uuid4()
    tag = {"referenceId": str(reference)}
    older = await repo.create(make_job(video_request(), owner_user_id=owner, metadata=tag))
    newer = await repo.create(make_job(video_request(), owner_user_id=owner, metadata=tag))
    await repo.create(make_job(video_request(), owner_user_id=other, metadata=tag))
    await repo.create(make_job(image_request(), owner_user_id=owner, metadata=tag))
    await repo.create(
        make_job(video_request(), owner_user_id=owner, metadata={"referenceId": str(unrelated)})
    )
    async with engine.begin() as conn:
        await conn.execute(
            text("UPDATE iclip.generation_jobs SET created_at = :at WHERE id = :id"),
            {"at": datetime.now(UTC) - timedelta(hours=1), "id": older.id},
        )

    found = await repo.latest_reference_trial(reference, owner=owner)

    assert found is not None and found.id == newer.id
    assert await repo.latest_reference_trial(reference, owner=None) is not None
    assert await repo.latest_reference_trial(uuid.uuid4(), owner=owner) is None


def _video_upload(owner: uuid.UUID, md5: str) -> GenerationJob:
    return make_upload(
        kind="video",
        owner_user_id=owner,
        output=GenerationOutput(url=f"https://example.test/{uuid.uuid4()}.mp4", content_md5=md5),
    )


async def test_a_record_is_found_by_its_address_within_the_conversation_and_what_it_inherits(
    engine: AsyncEngine,
) -> None:
    """按产物地址找某一种记录：本对话按属主收敛的、经继承读得到的；没有对话就只找没有对话的；给了
    操作只找那一种；未完成的、别的种类、别的对话、边界之后的都找不到；对上多条取最早建立的。"""

    repo = SqlGenerationRepository(engine)
    conversations = SqlConversationRepository(engine)
    author, forker, stranger = [await make_user(engine) for _ in range(3)]
    source = await open_conversation(conversations, author)
    early = await finished(repo, author, source.id, "early", image_request())
    copy = await open_conversation(conversations, forker, forked_from=source.id)
    late = await finished(repo, author, source.id, "late", image_request())
    own = await finished(repo, forker, copy.id, "own", image_request())
    twin = await finished(repo, forker, copy.id, "twin", image_request())
    elsewhere = await finished(repo, forker, uuid.uuid4(), "elsewhere", image_request())
    take = await finished(repo, forker, copy.id, "take")
    loose = await complete(
        repo,
        await repo.create(make_job(image_request(), owner_user_id=forker)),
        "https://example.test/loose.png",
    )
    (upload,) = await repo.create_settled(
        [
            make_upload(
                owner_user_id=forker, output=GenerationOutput(url="https://example.test/upload.png")
            )
        ]
    )
    (clip,) = await repo.create_settled(
        [
            make_upload(
                kind="video",
                owner_user_id=forker,
                output=GenerationOutput(url="https://example.test/clip.mp4"),
            )
        ]
    )
    watermarked = await finished(repo, forker, copy.id, "watermarked", image_request())
    broken = await repo.create(
        make_job(image_request(), owner_user_id=forker, conversation_id=copy.id)
    )
    await repo.mark_failed(broken.id, error_code="UPSTREAM_FAILED", error_message="上游拒了")
    set_output = text(
        "UPDATE iclip.generation_jobs SET output = CAST(:output AS jsonb) WHERE id = :id"
    )
    async with engine.begin() as conn:
        await conn.execute(
            set_output,
            {"output": json.dumps({"url": "https://example.test/broken.png"}), "id": broken.id},
        )
        await conn.execute(
            set_output, {"output": json.dumps({"url": own.output.url}), "id": twin.id}
        )
        await conn.execute(
            set_output,
            {
                "output": json.dumps(
                    {"url": watermarked.output.url, "watermark_url": "https://example.test/wm.png"}
                ),
                "id": watermarked.id,
            },
        )
    inheritance = await conversations.ancestry(copy.id)

    async def find(
        job_url: str | None,
        *,
        owner: uuid.UUID | None = forker,
        conversation_id: uuid.UUID | None = copy.id,
        operation: GenerationOperation | None = None,
        kind: GenerationKind = "image",
    ) -> uuid.UUID | None:
        assert job_url is not None
        found = await repo.find_by_output(
            job_url,
            kind=kind,
            owner=owner,
            conversation_id=conversation_id,
            inherited=inheritance if conversation_id == copy.id else (),
            operation=operation,
        )
        return None if found is None else found.id

    assert await find(own.output.url) == own.id, "同一地址两条，取最早建立的"
    assert await find(early.output.url) == early.id, "边界之内继承来的"
    assert await find(late.output.url) is None, "分叉之后才完成的不继承"
    assert await find(elsewhere.output.url) is None
    assert await find(take.output.url) is None, "视频不是图片"
    assert await find("https://example.test/broken.png") is None, "没完成的不算"
    assert await find("https://example.test/wm.png") is None, "水印版地址不算产物地址"
    assert await find(watermarked.output.url) == watermarked.id
    assert await find(own.output.url, owner=stranger) is None, "别人的按属主筛掉"
    assert await find(own.output.url, owner=None) == own.id, "不限属主就读得到"
    assert await find(loose.output.url) is None, "没有对话的行不在这段对话里"
    assert await find(loose.output.url, conversation_id=None) == loose.id
    assert await find(upload.output.url, conversation_id=None, operation="upload") == upload.id
    assert await find(loose.output.url, conversation_id=None, operation="upload") is None
    assert await find(take.output.url, kind="video") == take.id, "按种类找，视频也找得到"
    clip_url = clip.output.url
    assert await find(clip_url, conversation_id=None, operation="upload", kind="video") == clip.id
    assert await find(clip_url, conversation_id=None, operation="upload") is None, "图片里没有它"
    assert (
        await find(clip_url, owner=stranger, conversation_id=None, operation="upload", kind="video")
        is None
    ), "别人的上传按属主筛掉"


async def test_output_urls_answer_only_for_rows_that_have_one(engine: AsyncEngine) -> None:
    repo = SqlGenerationRepository(engine)
    owner = await make_user(engine)
    done = await finished(repo, owner, uuid.uuid4(), "done", image_request())
    pending = await insert_job(repo, owner, image_request())

    assert await repo.output_urls([]) == {}
    assert await repo.output_urls([done.id, pending.id, uuid.uuid4()]) == {done.id: done.output.url}


# --- 分叉继承 -------------------------------------------------------------------
# 场景与构造器在 tests/helpers/fork_lineage.py，资料库的集成测试用同一个场景。


async def test_each_hop_has_its_own_boundary_and_only_finished_takes_are_inherited(
    engine: AsyncEngine,
) -> None:
    """孙对话继承父对话在孙建立前完成的，和祖父在父建立前完成的；边界不是一刀切在孙的建立时刻。

    分叉那一刻还在跑、之后才完成的不算，失败的也不算；编辑段是一行普通的完成记录，照样继承。"""

    repo = SqlGenerationRepository(engine)
    conversations = SqlConversationRepository(engine)
    chain = await three_level_fork(engine)
    grand, parent, child = chain.grand, chain.parent, chain.child

    inheritance = await conversations.ancestry(child.id)
    assert inheritance == ((parent.id, child.created_at), (grand.id, parent.created_at)), (
        "近的祖先在前，边界是这条链上它的下一级对话的建立时刻"
    )
    listed = await repo.list_for_owner(
        owner=chain.forker, limit=20, conversation_id=child.id, inherited=inheritance
    )
    assert {job.id for job in listed} == {
        chain.own.id,
        chain.from_parent.id,
        chain.parent_edit.id,
        chain.from_grand.id,
    }
    assert {
        job.id
        for job in await repo.list_for_owner(owner=chain.forker, limit=20, conversation_id=child.id)
    } == {chain.own.id}, "不给边界对就只按属主"
    assert await conversations.ancestry(grand.id) == (), "不是分叉来的没有祖先"


async def test_ancestry_walks_through_a_deleted_source(engine: AsyncEngine) -> None:
    """源对话删成墓碑，副本从它那里继承的出片照旧在。"""

    conversations = SqlConversationRepository(engine)
    author = await make_user(engine)
    source = await open_conversation(conversations, author)
    copy = await open_conversation(conversations, author, forked_from=source.id)
    await conversations.delete(source.id, owner=author)

    assert await conversations.ancestry(copy.id) == ((source.id, copy.created_at),)


async def test_inherited_records_keep_their_facts_and_obey_the_other_filters(
    engine: AsyncEngine,
) -> None:
    """继承只是读得到：属主与所在对话不变。按原作、来源、种类、操作与坐标筛时，继承来的与自己的
    一视同仁。"""

    repo = SqlGenerationRepository(engine)
    conversations = SqlConversationRepository(engine)
    author, forker = await make_user(engine), await make_user(engine)
    source = await open_conversation(conversations, author)
    root = await finished(repo, author, source.id, "root", metadata={"shot": 1})
    await finished(repo, author, source.id, "other-shot", metadata={"shot": 2})
    frame = await finished(repo, author, source.id, "frame", image_request(), metadata={"shot": 1})
    edited = await finished(
        repo,
        author,
        source.id,
        "edited",
        edit_request(),
        source_job_id=root.id,
        root_job_id=root.id,
    )
    master = await finished(
        repo,
        author,
        source.id,
        "master",
        compose_request(),
        provider="ffmpeg",
        source_job_id=edited.id,
        root_job_id=root.id,
    )
    copy = await open_conversation(conversations, forker, forked_from=source.id)
    own_master = await finished(
        repo,
        forker,
        copy.id,
        "own-master",
        compose_request(),
        provider="ffmpeg",
        source_job_id=edited.id,
        root_job_id=root.id,
    )
    inheritance = await conversations.ancestry(copy.id)

    async def listed(**filters: Any) -> set[uuid.UUID]:
        found = await repo.list_for_owner(
            owner=forker, limit=20, conversation_id=copy.id, inherited=inheritance, **filters
        )
        return {job.id for job in found}

    assert await listed(root_job_id=root.id) == {edited.id, master.id, own_master.id}
    assert await listed(source_job_id=edited.id) == {master.id, own_master.id}
    assert await listed(operation="compose") == {master.id, own_master.id}
    assert await listed(kind="video", metadata={"shot": 1}) == {root.id}
    assert await listed(kind="image") == {frame.id}
    inherited_root = await repo.get(root.id, owner=forker, inherited=inheritance)
    assert (inherited_root.conversation_id, inherited_root.owner_user_id) == (source.id, author)


async def test_pages_turn_on_an_inherited_anchor_and_reads_stop_at_the_boundary(
    engine: AsyncEngine,
) -> None:
    """按对话翻页时上一页最后一条可能是继承来的，锚点要读得到它；边界之后的仍然读不到。"""

    repo = SqlGenerationRepository(engine)
    conversations = SqlConversationRepository(engine)
    author, forker = await make_user(engine), await make_user(engine)
    source = await open_conversation(conversations, author)
    older = await finished(repo, author, source.id, "older")
    newer = await finished(repo, author, source.id, "newer")
    copy = await open_conversation(conversations, forker, forked_from=source.id)
    too_late = await finished(repo, author, source.id, "too-late")
    own = await finished(repo, forker, copy.id, "own")
    inheritance = await conversations.ancestry(copy.id)

    pages: list[uuid.UUID] = []
    before: uuid.UUID | None = None
    while page := await repo.list_for_owner(
        owner=forker, limit=1, conversation_id=copy.id, before=before, inherited=inheritance
    ):
        pages.append(page[0].id)
        before = page[0].id
    assert pages == [own.id, newer.id, older.id]

    with pytest.raises(NotFound):
        await repo.get(newer.id, owner=forker)
    with pytest.raises(NotFound):
        await repo.get(too_late.id, owner=forker, inherited=inheritance)
