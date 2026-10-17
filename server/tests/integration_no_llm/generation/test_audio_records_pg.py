"""音频记录落在生成记录表里：组合约束、生成背景音乐的往返，以及它不混进视频的在途与成片口径。"""

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


_MUSIC_ROW: dict[str, Any] = {
    "kind": "audio",
    "operation": "generate",
    "request": json.dumps({"model": "m", "prompt": "轻快"}),
    "status": "pending",
    "conversation": True,
    "source": False,
    "root": False,
    "shot_index": None,
    "range": None,
    "source_url": None,
    "output_url": None,
    "watermark_output_url": None,
    "duration_ms": None,
    "sentences": None,
    "content_md5": None,
}
"""一条合法的排队中背景音乐；各用例在它上面改几列，``source`` / ``root`` 为真就指一条现成的出片。"""

_UPLOAD: dict[str, Any] = {
    "operation": "upload",
    "request": None,
    "status": "completed",
    "conversation": False,
    "output_url": MUSIC_URL,
}

_REFUSED: dict[str, dict[str, Any]] = {
    "生成没挂对话": {"conversation": False},
    "完成了却没有地址": {"status": "completed", "duration_ms": 1000},
    "完成了却没有时长": {"status": "completed", "output_url": MUSIC_URL},
    "带来源": {"source": True},
    "带原作": {"root": True},
    "带镜号": {"shot_index": 1},
    "带区间": {"range": (0, 1000)},
    "带外部地址": {"source_url": TAKE_URL},
    "带水印地址": {"watermark_output_url": TAKE_URL},
    "带逐句结果": {"sentences": "[]"},
    "带 MD5": {"content_md5": "0123456789abcdef0123456789abcdef"},
    "生成没有请求": {"request": None},
    "本地拼接": {"operation": "compose"},
    "切图": {"operation": "cut", "request": None, "status": "completed", "output_url": MUSIC_URL},
    "上传带请求": {**_UPLOAD, "request": json.dumps({"model": "m", "prompt": "轻快"})},
    "上传没有地址": {**_UPLOAD, "output_url": None},
    "上传带 MD5": {**_UPLOAD, "content_md5": "0123456789abcdef0123456789abcdef"},
    "不认识的种类": {"kind": "music"},
}

_ACCEPTED: dict[str, dict[str, Any]] = {
    "生成排队中": {},
    "生成完成": {"status": "completed", "output_url": MUSIC_URL, "duration_ms": 31_500},
    "生成失败": {"status": "failed"},
    "上传": _UPLOAD,
    "上传挂对话": {**_UPLOAD, "conversation": True},
}


async def _insert(engine: AsyncEngine, shape: Mapping[str, Any]) -> None:
    """绕过受理层直接写一行；来源与原作指一条现成的出片。"""

    repo = SqlGenerationRepository(engine)
    owner = await make_user(engine)
    take = await repo.create(make_job(video_request(), owner_user_id=owner))
    row = {**_MUSIC_ROW, **shape}
    span = row["range"]
    async with engine.begin() as conn:
        await conn.execute(
            text(
                "INSERT INTO iclip.generation_jobs (id, owner_user_id, conversation_id, kind,"
                " operation, provider, request, status, source_job_id, root_job_id, shot_index,"
                " range_start_ms, range_end_ms, source_url, output_url, watermark_output_url,"
                " duration_ms, sentences, content_md5, created_at, finished_at)"
                " VALUES (:id, :owner, :conversation, :kind, :operation, 'qwen_music',"
                " CAST(:request AS jsonb), :status, :source, :root, :shot_index, :start, :end,"
                " :source_url, :output_url, :watermark_output_url, :duration_ms,"
                " CAST(:sentences AS jsonb), :content_md5, now(),"
                " CASE WHEN :status = 'pending' THEN NULL ELSE now() END)"
            ),
            {
                "id": uuid.uuid4(),
                "owner": owner,
                "conversation": uuid.uuid4() if row["conversation"] else None,
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
                "duration_ms": row["duration_ms"],
                "sentences": row["sentences"],
                "content_md5": row["content_md5"],
            },
        )


@pytest.mark.parametrize("shape", list(_REFUSED))
async def test_audio_rows_of_no_known_shape_are_refused(engine: AsyncEngine, shape: str) -> None:
    with pytest.raises(IntegrityError):
        await _insert(engine, _REFUSED[shape])


@pytest.mark.parametrize("shape", list(_ACCEPTED))
async def test_audio_rows_of_a_known_shape_are_accepted(engine: AsyncEngine, shape: str) -> None:
    await _insert(engine, _ACCEPTED[shape])
