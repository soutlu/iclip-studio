"""超分记录落在生成记录表里：两种来源的往返、按来源找它们，以及它们不混进视频的在跑与素材片口径。"""

from __future__ import annotations

import uuid

from sqlalchemy.ext.asyncio import AsyncEngine

from iclip.domains.generation.infra_sql import SqlGenerationRepository
from iclip.domains.generation.models import STATUS_COMPLETED, STATUS_FAILED
from iclip.domains.generation.render import PROVIDER_NAME as RENDER_PROVIDER
from iclip.domains.generation.schemas import KIND_VIDEO, OPERATION_ENHANCE
from tests.helpers.fork_lineage import complete, finished, make_user
from tests.helpers.generation import (
    make_enhancement,
    make_job,
    make_subtitle,
    whole_film_request,
)

HD_URL = "https://cdn.example.test/hd.mp4"
HD_WATERMARK_URL = "https://cdn.example.test/hd-wm.mp4"


async def test_enhancements_of_a_take_and_of_a_film_round_trip_as_videos(
    engine: AsyncEngine,
) -> None:
    """素材片与成片的高清版都是视频 / 超分，读回来请求、来源与镜号照旧。"""

    repo = SqlGenerationRepository(engine)
    owner = await make_user(engine)
    take = await finished(repo, owner, uuid.uuid4(), "take", shot_index=4)
    film = await repo.create(
        make_job(
            whole_film_request(take.id),
            owner_user_id=owner,
            conversation_id=uuid.uuid4(),
            provider=RENDER_PROVIDER,
        )
    )
    film = await complete(repo, film, "https://cdn.example.test/film.mp4")

    for source in (take, film):
        created = await repo.create(make_enhancement(source, owner_user_id=owner))
        await repo.mark_submitting(created.id)
        await repo.mark_submitted(created.id, provider_task_id="e-1", provider_status="queued")
        await repo.mark_completed(
            created.id,
            output_url=HD_URL,
            watermark_output_url=HD_WATERMARK_URL,
            provider_status="succeeded",
        )
        read = await repo.get(created.id, owner=owner)

        assert (read.kind, read.operation) == (KIND_VIDEO, OPERATION_ENHANCE)
        assert read.request == created.request
        assert (read.source_job_id, read.root_job_id, read.conversation_id) == (
            source.id,
            None,
            None,
        )
        assert read.shot_index == source.shot_index
        assert (read.status, read.output_url, read.watermark_output_url) == (
            STATUS_COMPLETED,
            HD_URL,
            HD_WATERMARK_URL,
        )


async def test_enhancements_of_a_source_are_everyones_newest_first_and_nothing_else(
    engine: AsyncEngine,
) -> None:
    """按来源找：谁提的都在，失败的也在，新建的在前；同一来源的字幕记录、别的来源的超分都不在。"""

    repo = SqlGenerationRepository(engine)
    me, someone = await make_user(engine), await make_user(engine)
    take = await finished(repo, me, uuid.uuid4(), "take")
    other = await finished(repo, me, uuid.uuid4(), "other")

    first = await repo.create(make_enhancement(take, "1080p", owner_user_id=someone))
    await repo.mark_failed(first.id, error_code="X", error_message="不行")
    second = await repo.create(make_enhancement(take, "720p", owner_user_id=me))
    third = await repo.create(make_enhancement(take, "1080p", owner_user_id=me))
    await repo.create(make_subtitle(take))
    await repo.create(make_enhancement(other, "1080p", owner_user_id=me))

    found = await repo.enhancements_of(take.id)

    assert [job.id for job in found] == [third.id, second.id, first.id]
    assert found[-1].status == STATUS_FAILED
    assert await repo.enhancements_of(uuid.uuid4()) == ()


async def test_enhancements_do_not_count_as_videos_in_flight_or_masters(
    engine: AsyncEngine,
) -> None:
    """超分记录不挂对话：在跑的不算来源那段对话的视频在跑，完成的不是那段对话最新的素材片。
    成片的高清版也是视频，同样不算导出那段对话的。"""

    repo = SqlGenerationRepository(engine)
    owner = await make_user(engine)
    conversation = uuid.uuid4()
    take = await finished(repo, owner, conversation, "take")
    film = await repo.create(
        make_job(
            whole_film_request(take.id),
            owner_user_id=owner,
            conversation_id=conversation,
            provider=RENDER_PROVIDER,
        )
    )
    film = await complete(repo, film, "https://cdn.example.test/film.mp4")

    for source in (take, film):
        running = await repo.create(make_enhancement(source, "1080p", owner_user_id=owner))
        await repo.mark_submitting(running.id)
        done = await repo.create(make_enhancement(source, "720p", owner_user_id=owner))
        await complete(repo, done, HD_URL)

    assert await repo.in_flight_by_conversation([conversation], kind="video") == {}
    assert await repo.latest_master_by_conversation([conversation]) == {
        conversation: take.output_url
    }
