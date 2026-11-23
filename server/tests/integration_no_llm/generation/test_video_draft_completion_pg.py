from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from iclip.domains.generation.infra_sql import SqlGenerationRepository
from iclip.domains.generation.schemas import VideoDraftCompletionRequest, VideoGenerationIn
from tests.helpers.fork_lineage import finished, make_user
from tests.helpers.generation import draft_completion_request, make_job, video_request


def draft_request() -> VideoGenerationIn:
    return video_request(resolution="480p", provider_options={"draft": True})


async def stored_request(engine: AsyncEngine, job_id: uuid.UUID) -> dict[str, Any]:
    async with engine.connect() as conn:
        payload = (
            await conn.execute(
                text("SELECT request FROM iclip.generation_jobs WHERE id = :id"), {"id": job_id}
            )
        ).scalar_one()
    assert isinstance(payload, dict)
    return payload


async def test_a_completion_reads_back_as_one_and_a_draft_stores_no_draft_keys(
    engine: AsyncEngine,
) -> None:
    repo = SqlGenerationRepository(engine)
    owner = await make_user(engine)
    conversation = uuid.uuid4()
    draft = await finished(repo, owner, conversation, "draft", draft_request(), shot_index=2)
    completion = await repo.create(
        make_job(
            draft_completion_request(draft.id), owner_user_id=owner, conversation_id=conversation
        )
    )

    read = await repo.get(completion.id, owner=owner)
    assert isinstance(read.request, VideoDraftCompletionRequest)
    assert read.request == completion.request
    assert (read.source_job_id, read.root_job_id) == (None, None)
    read_draft = await repo.get(draft.id, owner=owner)
    assert type(read_draft.request) is VideoGenerationIn
    stored_draft = await stored_request(engine, draft.id)
    assert stored_draft["provider_options"] == {"draft": True}
    assert "draft_job_id" not in stored_draft and "draft_task_id" not in stored_draft


async def test_completions_of_a_draft_are_found_within_one_conversation_newest_first(
    engine: AsyncEngine,
) -> None:
    repo = SqlGenerationRepository(engine)
    me, someone = await make_user(engine), await make_user(engine)
    here, there = uuid.uuid4(), uuid.uuid4()
    draft = await finished(repo, me, here, "draft", draft_request())
    other_draft = await finished(repo, me, here, "other-draft", draft_request())

    first = await repo.create(
        make_job(draft_completion_request(draft.id), owner_user_id=me, conversation_id=here)
    )
    await repo.mark_failed(first.id, error_code="X", error_message="不行")
    second = await repo.create(
        make_job(draft_completion_request(draft.id), owner_user_id=someone, conversation_id=here)
    )
    await repo.create(
        make_job(draft_completion_request(draft.id), owner_user_id=me, conversation_id=there)
    )
    await repo.create(make_job(draft_completion_request(draft.id), owner_user_id=me))
    await repo.create(
        make_job(draft_completion_request(other_draft.id), owner_user_id=me, conversation_id=here)
    )
    await repo.create(make_job(video_request(), owner_user_id=me, conversation_id=here))

    found = await repo.draft_completions_of(draft.id, conversation_id=here)

    assert [job.id for job in found] == [second.id, first.id]
    assert await repo.draft_completions_of(uuid.uuid4(), conversation_id=here) == ()


async def test_completions_outside_any_conversation_are_found_only_there(
    engine: AsyncEngine,
) -> None:
    repo = SqlGenerationRepository(engine)
    owner = await make_user(engine)
    draft = await repo.create(make_job(draft_request(), owner_user_id=owner))
    loose = await repo.create(make_job(draft_completion_request(draft.id), owner_user_id=owner))
    await repo.create(
        make_job(
            draft_completion_request(draft.id), owner_user_id=owner, conversation_id=uuid.uuid4()
        )
    )

    found = await repo.draft_completions_of(draft.id, conversation_id=None)

    assert [job.id for job in found] == [loose.id]
