"""音频记录落在生成记录表里：生成背景音乐的往返，以及它不混进视频的在途与成片口径。"""

from __future__ import annotations

import uuid

from sqlalchemy.ext.asyncio import AsyncEngine

from iclip.domains.generation.infra_sql import SqlGenerationRepository
from iclip.domains.generation.models import STATUS_COMPLETED, STATUS_SUBMITTING
from iclip.domains.generation.schemas import MusicRequest
from tests.helpers.fork_lineage import make_user
from tests.helpers.generation import MUSIC_PROMPT, make_job, make_music, video_request

MUSIC_URL = "https://cdn.example.test/iclip/agent/generated-music/m.m4a"
TAKE_URL = "https://cdn.example.test/take.mp4"


async def test_generated_music_round_trips_its_request_address_and_duration(
    engine: AsyncEngine,
) -> None:
    repo = SqlGenerationRepository(engine)
    owner = await make_user(engine)
    conversation = uuid.uuid4()

    created = await repo.create(make_music(owner_user_id=owner, conversation_id=conversation))
    assert created.request == MusicRequest(model="qwen-audio-3.1-tts-next", prompt=MUSIC_PROMPT)
    await repo.mark_submitting(created.id)
    done = await repo.mark_completed(
        created.id,
        output_url=MUSIC_URL,
        provider_status="succeeded",
        provider_task_id="req-7",
        duration_ms=31_500,
        only_if_status=STATUS_SUBMITTING,
    )

    assert done is not None
    assert (done.status, done.output_url, done.duration_ms) == (
        STATUS_COMPLETED,
        MUSIC_URL,
        31_500,
    )
    assert (await repo.get(created.id, owner=owner)).request == created.request
    listed = await repo.list_for_owner(
        owner=owner, limit=10, kind="audio", conversation_id=conversation
    )
    assert [job.id for job in listed] == [created.id]


async def test_audio_records_do_not_count_as_videos_in_flight_or_masters(
    engine: AsyncEngine,
) -> None:
    """对话的「视频在跑」与最新成片只看视频：排队、提交中、完成的背景音乐都不算。"""

    repo = SqlGenerationRepository(engine)
    owner = await make_user(engine)
    quiet, busy_music = uuid.uuid4(), uuid.uuid4()
    take = await repo.create(make_job(video_request(), owner_user_id=owner, conversation_id=quiet))
    await repo.mark_completed(
        take.id,
        output_url=TAKE_URL,
        watermark_output_url="https://cdn.example.test/take-wm.mp4",
        provider_status="succeeded",
    )
    await repo.create(make_music(owner_user_id=owner, conversation_id=quiet))
    submitting = await repo.create(make_music(owner_user_id=owner, conversation_id=busy_music))
    await repo.mark_submitting(submitting.id)
    finished = await repo.create(make_music(owner_user_id=owner, conversation_id=quiet))
    await repo.mark_submitting(finished.id)
    await repo.mark_completed(
        finished.id, output_url=MUSIC_URL, provider_status="succeeded", duration_ms=1000
    )

    assert await repo.in_flight_by_conversation([quiet, busy_music], kind="video") == {}
    assert await repo.latest_master_by_conversation([quiet, busy_music]) == {quiet: TAKE_URL}
