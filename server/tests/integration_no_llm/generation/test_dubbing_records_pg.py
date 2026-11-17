from __future__ import annotations

import uuid

from sqlalchemy.ext.asyncio import AsyncEngine

from iclip.domains.generation.infra_sql import SqlGenerationRepository
from iclip.domains.generation.models import (
    STATUS_COMPLETED,
    STATUS_SUBMITTING,
    GenerationJob,
    GenerationOutput,
)
from iclip.domains.generation.schemas import (
    DubbedLine,
    DubbingAudioReference,
    DubbingLine,
    generation_out,
)
from tests.helpers.fork_lineage import make_user
from tests.helpers.generation import make_dubbing, make_job, video_request

TAKE_URL = "https://cdn.example.test/take.mp4"
VOICE_URL = "https://cdn.example.test/iclip/agent/uploads/voice.wav"
DUBBING_URL = "https://cdn.example.test/iclip/agent/generated-dubbing/d.m4a"

LINES = [
    DubbingLine(start_ms=0, end_ms=1_500, text="These shoes are light."),
    DubbingLine(start_ms=1_600, end_ms=2_400, text="Really light."),
]
RESULTS = (
    DubbedLine(index=0, speed=1.125, trimmed=False),
    DubbedLine(index=1, speed=1.25, trimmed=True),
)


async def completed_take(
    repo: SqlGenerationRepository, owner: uuid.UUID, conversation: uuid.UUID
) -> GenerationJob:
    take = await repo.create(
        make_job(video_request(), owner_user_id=owner, conversation_id=conversation)
    )
    done = await repo.mark_completed(
        take.id,
        output=GenerationOutput(url=TAKE_URL, watermark_url="https://cdn.example.test/wm.mp4"),
        provider_status="succeeded",
    )
    assert done is not None
    return done


async def test_a_dubbing_record_round_trips_its_request_track_and_per_line_results(
    engine: AsyncEngine,
) -> None:
    repo = SqlGenerationRepository(engine)
    owner = await make_user(engine)
    conversation = uuid.uuid4()
    take = await completed_take(repo, owner, conversation)
    job = make_dubbing(
        take,
        LINES,
        duration_ms=3_000,
        reference=DubbingAudioReference(kind="audio", url=VOICE_URL),
    )

    created = await repo.create(job)
    await repo.mark_submitting(created.id)
    done = await repo.mark_completed(
        created.id,
        output=GenerationOutput(url=DUBBING_URL, duration_ms=3_000, dubbed_lines=RESULTS),
        provider_status="succeeded",
        provider_task_id=str(created.id),
        only_if_status=STATUS_SUBMITTING,
    )

    assert done is not None
    read = await repo.get(created.id, owner=owner)
    assert read.request == job.request
    assert (read.status, read.output.url, read.output.dubbed_lines) == (
        STATUS_COMPLETED,
        DUBBING_URL,
        RESULTS,
    )
    listed = await repo.list_for_owner(owner=owner, limit=10, kind="dubbing", source_job_id=take.id)
    assert [item.id for item in listed] == [created.id]
    music = await repo.list_for_owner(owner=owner, limit=10, kind="audio")
    assert music == ()
    out = generation_out(read, source_address=TAKE_URL).model_dump(mode="json", by_alias=True)
    assert out["dubbedLines"] == [
        {"index": 0, "speed": 1.125, "trimmed": False},
        {"index": 1, "speed": 1.25, "trimmed": True},
    ]
    assert out["request"]["reference"] == {"kind": "audio", "url": VOICE_URL}
