"""字幕记录落在生成记录表里：逐句结果的往返与状态守卫，以及它不混进视频的在途与素材片口径。"""

from __future__ import annotations

import uuid

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from iclip.domains.generation.infra_sql import SqlGenerationRepository
from iclip.domains.generation.models import (
    STATUS_COMPLETED,
    STATUS_FAILED,
    STATUS_SUBMITTING,
    GenerationJob,
    GenerationOutput,
)
from iclip.domains.generation.schemas import (
    SubtitleRequest,
    SubtitleSentence,
    SubtitleWord,
    generation_out,
)
from tests.helpers.fork_lineage import make_user
from tests.helpers.generation import make_job, make_subtitle, video_request

TAKE_URL = "https://cdn.example.test/take.mp4"

SENTENCES = (
    SubtitleSentence(
        start_ms=0,
        end_ms=1500,
        text="这双鞋很轻。",
        speaker=0,
        words=(
            SubtitleWord(start_ms=0, end_ms=700, text="这双鞋"),
            SubtitleWord(start_ms=700, end_ms=1500, text="很轻", punctuation="。"),
        ),
    ),
    SubtitleSentence(start_ms=1600, end_ms=2400, text="Light.", speaker=None),
)


async def completed_take(
    repo: SqlGenerationRepository, owner: uuid.UUID, conversation: uuid.UUID | None = None
) -> GenerationJob:
    take = await repo.create(
        make_job(video_request(), owner_user_id=owner, conversation_id=conversation)
    )
    done = await repo.mark_completed(
        take.id,
        output=GenerationOutput(url=TAKE_URL, watermark_url="https://cdn.example.test/take-wm.mp4"),
        provider_status="succeeded",
    )
    assert done is not None
    return done


async def test_a_subtitle_record_round_trips_its_request_and_sentences(
    engine: AsyncEngine,
) -> None:
    repo = SqlGenerationRepository(engine)
    owner = await make_user(engine)
    conversation = uuid.uuid4()
    take = await completed_take(repo, owner, conversation)

    created = await repo.create(make_subtitle(take))
    assert created.request == SubtitleRequest(model="qwen-audio-3.1-asr-flash", video_url=TAKE_URL)
    assert created.output.sentences is None
    await repo.mark_submitting(created.id)
    done = await repo.mark_transcribed(
        created.id,
        sentences=SENTENCES,
        provider_status="succeeded",
        provider_task_id="req-1",
        only_if_status=STATUS_SUBMITTING,
    )

    assert done is not None
    assert (done.status, done.output.sentences, done.output.url) == (
        STATUS_COMPLETED,
        SENTENCES,
        None,
    )
    assert done.submitted_at is not None and done.finished_at is not None
    assert (await repo.get(created.id, owner=owner)).output.sentences == SENTENCES
    listed = await repo.list_for_owner(
        owner=owner, limit=10, kind="subtitle", source_job_id=take.id
    )
    assert [job.id for job in listed] == [created.id]
    in_conversation = await repo.list_for_owner(owner=owner, limit=10, conversation_id=conversation)
    assert {job.id for job in in_conversation} == {take.id, created.id}


async def test_no_voice_over_is_stored_as_an_empty_array(engine: AsyncEngine) -> None:
    repo = SqlGenerationRepository(engine)
    owner = await make_user(engine)
    created = await repo.create(make_subtitle(await completed_take(repo, owner)))
    await repo.mark_submitting(created.id)

    await repo.mark_transcribed(
        created.id, sentences=(), provider_status="no_audio", provider_task_id=str(created.id)
    )

    async with engine.connect() as conn:
        stored = (
            await conn.execute(
                text(
                    "SELECT jsonb_typeof(output -> 'sentences') FROM iclip.generation_jobs"
                    " WHERE id = :id"
                ),
                {"id": created.id},
            )
        ).scalar_one()
    assert stored == "array"
    read = await repo.get(created.id, owner=owner)
    assert read.output.sentences == ()
    out = generation_out(read, source_address=None).model_dump(mode="json", by_alias=True)
    assert out["sentences"] == [], "接口给空数组"


async def test_the_status_guard_keeps_a_failed_subtitle_record_failed(engine: AsyncEngine) -> None:
    repo = SqlGenerationRepository(engine)
    owner = await make_user(engine)
    created = await repo.create(make_subtitle(await completed_take(repo, owner)))
    await repo.mark_submitting(created.id)
    await repo.mark_failed(
        created.id,
        error_code="PROVIDER_RESULT_UNKNOWN",
        error_message="等不到",
        only_if_status=STATUS_SUBMITTING,
    )

    late = await repo.mark_transcribed(
        created.id,
        sentences=SENTENCES,
        provider_status="succeeded",
        provider_task_id="req-1",
        only_if_status=STATUS_SUBMITTING,
    )

    assert late is None
    stored = await repo.get(created.id, owner=owner)
    assert (stored.status, stored.output.sentences) == (STATUS_FAILED, None)


async def test_subtitle_records_do_not_count_as_videos_in_flight_or_masters(
    engine: AsyncEngine,
) -> None:
    """对话的「视频在跑」与最新素材片只看视频：排队、提交中、完成的字幕记录都不算。"""

    repo = SqlGenerationRepository(engine)
    owner = await make_user(engine)
    quiet, busy_subtitles = uuid.uuid4(), uuid.uuid4()
    take = await completed_take(repo, owner, quiet)
    await repo.create(make_subtitle(take))
    submitting = await repo.create(make_subtitle(take, conversation_id=busy_subtitles))
    await repo.mark_submitting(submitting.id)
    finished = await repo.create(make_subtitle(take))
    await repo.mark_submitting(finished.id)
    await repo.mark_transcribed(
        finished.id, sentences=SENTENCES, provider_status="succeeded", provider_task_id="r"
    )

    assert await repo.in_flight_by_conversation(owner=owner, kind="video") == {}
    assert await repo.latest_master_by_conversation([quiet, busy_subtitles]) == {quiet: TAKE_URL}
