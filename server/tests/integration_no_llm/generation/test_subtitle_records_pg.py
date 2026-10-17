"""字幕记录落在生成记录表里：组合约束、逐句结果的往返与状态守卫，以及它不混进视频的在途与成片口径。"""

from __future__ import annotations

import json
import uuid
from collections.abc import Mapping
from typing import Any

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncEngine

from iclip.domains.generation.infra_sql import SqlGenerationRepository
from iclip.domains.generation.models import (
    STATUS_COMPLETED,
    STATUS_FAILED,
    STATUS_SUBMITTING,
    GenerationJob,
)
from iclip.domains.generation.schemas import SubtitleRequest, SubtitleSentence, SubtitleWord
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
        output_url=TAKE_URL,
        watermark_output_url="https://cdn.example.test/take-wm.mp4",
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
    assert created.sentences is None
    await repo.mark_submitting(created.id)
    done = await repo.mark_transcribed(
        created.id,
        sentences=SENTENCES,
        provider_status="succeeded",
        provider_task_id="req-1",
        only_if_status=STATUS_SUBMITTING,
    )

    assert done is not None
    assert (done.status, done.sentences, done.output_url) == (STATUS_COMPLETED, SENTENCES, None)
    assert done.submitted_at is not None and done.finished_at is not None
    assert (await repo.get(created.id, owner=owner)).sentences == SENTENCES
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
                text("SELECT jsonb_typeof(sentences) FROM iclip.generation_jobs WHERE id = :id"),
                {"id": created.id},
            )
        ).scalar_one()
    assert stored == "array"
    assert (await repo.get(created.id, owner=owner)).sentences == ()


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
    assert (stored.status, stored.sentences) == (STATUS_FAILED, None)


async def test_subtitle_records_do_not_count_as_videos_in_flight_or_masters(
    engine: AsyncEngine,
) -> None:
    """对话的「视频在跑」与最新成片只看视频：排队、提交中、完成的字幕记录都不算。"""

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

    assert await repo.in_flight_by_conversation([quiet, busy_subtitles], kind="video") == {}
    assert await repo.latest_master_by_conversation([quiet, busy_subtitles]) == {quiet: TAKE_URL}


_SUBTITLE_ROW: dict[str, Any] = {
    "kind": "subtitle",
    "operation": "generate",
    "request": json.dumps({"model": "m", "videoUrl": TAKE_URL}),
    "status": "pending",
    "source": True,
    "root": False,
    "shot_index": None,
    "range": None,
    "source_url": None,
    "output_url": None,
    "watermark_output_url": None,
    "sentences": None,
}
"""一条合法的排队中字幕记录；各用例在它上面改几列，``source`` / ``root`` 为真就指那条出片。"""

_REFUSED: dict[str, dict[str, Any]] = {
    "没有来源": {"source": False},
    "带原作": {"root": True},
    "带镜号": {"shot_index": 1},
    "带区间": {"range": (0, 1000)},
    "带外部地址": {"source_url": TAKE_URL},
    "带产物地址": {"output_url": TAKE_URL},
    "带水印地址": {"watermark_output_url": TAKE_URL},
    "完成了却没有结果": {"status": "completed"},
    "结果不是数组": {"status": "completed", "sentences": json.dumps({"text": "x"})},
    "结果是 JSON null": {"status": "completed", "sentences": "null"},
    "没有请求": {"request": None},
    "本地拼接": {"operation": "compose"},
    "上传": {"operation": "upload", "request": None, "status": "completed"},
    "视频带结果": {"kind": "video", "source": False, "sentences": "[]"},
    "图片带结果": {"kind": "image", "source": False, "sentences": "[]"},
}

_ACCEPTED: dict[str, dict[str, Any]] = {
    "排队中": {},
    "完成且有几句": {
        "status": "completed",
        "sentences": json.dumps(
            [{"start_ms": 0, "end_ms": 900, "text": "好", "speaker": 0}], ensure_ascii=False
        ),
    },
    "完成且没有口播": {"status": "completed", "sentences": "[]"},
    "失败没有结果": {"status": "failed"},
}


async def _insert(engine: AsyncEngine, shape: Mapping[str, Any]) -> None:
    """绕过受理层直接写一行；来源与原作指一条现成的出片。"""

    repo = SqlGenerationRepository(engine)
    owner = await make_user(engine)
    take = await completed_take(repo, owner)
    row = {**_SUBTITLE_ROW, **shape}
    span = row["range"]
    async with engine.begin() as conn:
        await conn.execute(
            text(
                "INSERT INTO iclip.generation_jobs (id, owner_user_id, kind, operation, provider,"
                " request, status, source_job_id, root_job_id, shot_index, range_start_ms,"
                " range_end_ms, source_url, output_url, watermark_output_url, sentences,"
                " created_at, finished_at)"
                " VALUES (:id, :owner, :kind, :operation, 'qwen_asr', CAST(:request AS jsonb),"
                " :status, :source, :root, :shot_index, :start, :end, :source_url, :output_url,"
                " :watermark_output_url, CAST(:sentences AS jsonb), now(),"
                " CASE WHEN :status = 'pending' THEN NULL ELSE now() END)"
            ),
            {
                "id": uuid.uuid4(),
                "owner": owner,
                "kind": row["kind"],
                "operation": row["operation"],
                "request": row["request"],
                "status": row["status"],
                "source": take.id if row["source"] else None,
                "root": take.id if row["root"] else None,
                "shot_index": row["shot_index"],
                "start": None if span is None else span[0],
                "end": None if span is None else span[1],
                "source_url": row["source_url"],
                "output_url": row["output_url"],
                "watermark_output_url": row["watermark_output_url"],
                "sentences": row["sentences"],
            },
        )


@pytest.mark.parametrize("shape", list(_REFUSED))
async def test_subtitle_rows_of_no_known_shape_are_refused(engine: AsyncEngine, shape: str) -> None:
    with pytest.raises(IntegrityError):
        await _insert(engine, _REFUSED[shape])


@pytest.mark.parametrize("shape", list(_ACCEPTED))
async def test_subtitle_rows_of_a_known_shape_are_accepted(engine: AsyncEngine, shape: str) -> None:
    await _insert(engine, _ACCEPTED[shape])
