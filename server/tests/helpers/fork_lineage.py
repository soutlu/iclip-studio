from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from iclip.domains.conversations.infra_sql import SqlConversationRepository
from iclip.domains.conversations.models import Conversation
from iclip.domains.generation.infra_sql import SqlGenerationRepository
from iclip.domains.generation.models import GenerationJob, GenerationOutput
from iclip.domains.generation.stored_requests import GenerationRequest
from tests.helpers.generation import edit_request, make_job, video_request


async def make_user(engine: AsyncEngine) -> uuid.UUID:
    user_id = uuid.uuid4()
    async with engine.begin() as conn:
        await conn.execute(
            text(
                "INSERT INTO iclip.users"
                " (id, email, hashed_password, is_active, is_superuser, is_verified,"
                "  display_name, avatar_url, roles, direct_permissions, city, job_title,"
                "  departments)"
                " VALUES (:id, :email, 'x', true, false, true, '', '',"
                " '[\"editor\"]'::jsonb, '[]'::jsonb, '', '', '[]'::jsonb)"
            ),
            {"id": user_id, "email": f"{user_id}@example.test"},
        )
    return user_id


async def complete(repo: SqlGenerationRepository, job: GenerationJob, url: str) -> GenerationJob:
    await repo.mark_submitting(job.id)
    await repo.mark_submitted(job.id, provider_task_id=str(job.id), provider_status="queued")
    completed = await repo.mark_completed(
        job.id, output=GenerationOutput(url=url), provider_status="succeeded"
    )
    assert completed is not None
    return completed


async def open_conversation(
    conversations: SqlConversationRepository,
    owner: uuid.UUID,
    *,
    forked_from: uuid.UUID | None = None,
) -> Conversation:
    now = datetime.now(UTC)
    created, _ = await conversations.create_if_absent(
        Conversation(
            id=uuid.uuid4(),
            owner_user_id=owner,
            agent_id="storyboard",
            title="t",
            title_kind="custom",
            last_run_id=None,
            task_id=None,
            collection_id=None,
            created_at=now,
            updated_at=now,
            forked_from=forked_from,
            fork_turn=None if forked_from is None else 1,
        )
    )
    return created


async def finished(
    repo: SqlGenerationRepository,
    owner: uuid.UUID,
    conversation_id: uuid.UUID,
    name: str,
    request: GenerationRequest | None = None,
    **fields: Any,
) -> GenerationJob:
    job = await repo.create(
        make_job(
            request or video_request(),
            owner_user_id=owner,
            conversation_id=conversation_id,
            **fields,
        )
    )
    return await complete(repo, job, f"https://example.test/{name}.mp4")


@dataclass(frozen=True, slots=True)
class ForkChain:
    author: uuid.UUID
    forker: uuid.UUID
    grand: Conversation
    parent: Conversation
    child: Conversation
    from_grand: GenerationJob
    grand_after_parent: GenerationJob
    from_parent: GenerationJob
    in_flight: GenerationJob
    parent_edit: GenerationJob
    failed: GenerationJob
    parent_after_child: GenerationJob
    own: GenerationJob


async def three_level_fork(engine: AsyncEngine) -> ForkChain:
    repo = SqlGenerationRepository(engine)
    conversations = SqlConversationRepository(engine)
    author, forker = await make_user(engine), await make_user(engine)
    grand = await open_conversation(conversations, author)
    from_grand = await finished(repo, author, grand.id, "grand-early")
    parent = await open_conversation(conversations, author, forked_from=grand.id)
    grand_after_parent = await finished(repo, author, grand.id, "grand-after-parent")
    from_parent = await finished(repo, author, parent.id, "parent-early")
    in_flight = await repo.create(
        make_job(video_request(), owner_user_id=author, conversation_id=parent.id)
    )
    parent_edit = await finished(
        repo,
        author,
        parent.id,
        "parent-edit",
        edit_request(),
        source_job_id=from_parent.id,
        root_job_id=from_parent.id,
    )
    failed = await repo.create(
        make_job(video_request(), owner_user_id=author, conversation_id=parent.id)
    )
    await repo.mark_failed(failed.id, error_code="UPSTREAM_FAILED", error_message="上游拒了")
    child = await open_conversation(conversations, forker, forked_from=parent.id)
    in_flight = await complete(repo, in_flight, "https://example.test/in-flight.mp4")
    parent_after_child = await finished(repo, author, parent.id, "parent-after-child")
    own = await finished(repo, forker, child.id, "child-own")
    return ForkChain(
        author=author,
        forker=forker,
        grand=grand,
        parent=parent,
        child=child,
        from_grand=from_grand,
        grand_after_parent=grand_after_parent,
        from_parent=from_parent,
        in_flight=in_flight,
        parent_edit=parent_edit,
        failed=failed,
        parent_after_child=parent_after_child,
        own=own,
    )


__all__ = [
    "ForkChain",
    "complete",
    "finished",
    "make_user",
    "open_conversation",
    "three_level_fork",
]
