from __future__ import annotations

import uuid
from collections.abc import Collection, Mapping, Sequence
from typing import Any, Protocol

from iclip.common.errors import NotFound
from iclip.domains.generation.models import (
    GenerationJob,
    GenerationKind,
    GenerationOperation,
    GenerationOutput,
    GenerationStatus,
    InFlightPhase,
    Inheritance,
    inherited_through,
)
from iclip.domains.generation.schemas import OPERATION_UPLOAD, SubtitleSentence
from iclip.domains.identity.public import Principal, visible_owner_incl_act_as


class GenerationRepository(Protocol):
    async def create(self, job: GenerationJob) -> GenerationJob: ...

    async def create_settled(self, jobs: Sequence[GenerationJob]) -> tuple[GenerationJob, ...]: ...

    async def find_by_output(
        self,
        output_url: str,
        *,
        kind: GenerationKind,
        owner: uuid.UUID | None,
        conversation_id: uuid.UUID | None,
        inherited: Inheritance = (),
        operation: GenerationOperation | None = None,
    ) -> GenerationJob | None: ...

    async def find_video_upload_by_md5(self, content_md5: str) -> GenerationJob | None: ...

    async def latest_reference_trial(
        self, reference_id: uuid.UUID, *, owner: uuid.UUID | None
    ) -> GenerationJob | None: ...

    async def output_urls(self, ids: Collection[uuid.UUID]) -> Mapping[uuid.UUID, str]: ...

    async def get(
        self, job_id: uuid.UUID, *, owner: uuid.UUID | None, inherited: Inheritance = ()
    ) -> GenerationJob: ...

    async def list_for_owner(
        self,
        *,
        owner: uuid.UUID | None,
        limit: int,
        conversation_id: uuid.UUID | None = None,
        kind: GenerationKind | None = None,
        operation: GenerationOperation | None = None,
        metadata: Mapping[str, Any] | None = None,
        task_id: uuid.UUID | None = None,
        shot_index: int | None = None,
        root_job_id: uuid.UUID | None = None,
        source_job_id: uuid.UUID | None = None,
        before: uuid.UUID | None = None,
        inherited: Inheritance = (),
    ) -> tuple[GenerationJob, ...]: ...

    async def mark_submitting(self, job_id: uuid.UUID) -> GenerationJob | None: ...

    async def mark_submitted(
        self,
        job_id: uuid.UUID,
        *,
        provider_task_id: str,
        provider_status: str,
    ) -> GenerationJob: ...

    async def mark_completed(
        self,
        job_id: uuid.UUID,
        *,
        output: GenerationOutput,
        provider_status: str,
        provider_task_id: str | None = None,
        only_if_status: GenerationStatus | None = None,
    ) -> GenerationJob | None: ...

    async def mark_transcribed(
        self,
        job_id: uuid.UUID,
        *,
        sentences: tuple[SubtitleSentence, ...],
        provider_status: str,
        provider_task_id: str,
        only_if_status: GenerationStatus | None = None,
    ) -> GenerationJob | None: ...

    async def mark_failed(
        self,
        job_id: uuid.UUID,
        *,
        error_code: str,
        error_message: str,
        provider_status: str | None = None,
        only_if_status: GenerationStatus | None = None,
    ) -> GenerationJob | None: ...

    async def record_progress(
        self,
        job_id: uuid.UUID,
        *,
        provider_status: str,
        only_if_status: GenerationStatus | None = None,
        skip_unchanged: bool = False,
    ) -> GenerationJob | None: ...

    async def in_flight_by_conversation(
        self, *, owner: uuid.UUID | None, kind: GenerationKind
    ) -> Mapping[uuid.UUID, InFlightPhase]: ...

    async def latest_master_by_conversation(
        self, conversation_ids: Sequence[uuid.UUID]
    ) -> Mapping[uuid.UUID, str]: ...

    async def enhancements_of(self, source_job_id: uuid.UUID) -> tuple[GenerationJob, ...]: ...


async def conversation_record(
    repo: GenerationRepository,
    principal: Principal,
    job_id: uuid.UUID,
    *,
    conversation_id: uuid.UUID | None,
    inheritance: Inheritance,
    own_uploads: bool = False,
) -> GenerationJob | None:
    try:
        record = await repo.get(
            job_id, owner=visible_owner_incl_act_as(principal), inherited=inheritance
        )
    except NotFound:
        return None
    if record.conversation_id == conversation_id or inherited_through(record, inheritance):
        return record
    if (
        own_uploads
        and record.operation == OPERATION_UPLOAD
        and record.owner_user_id == principal.user_id
    ):
        return record
    return None


__all__ = ["GenerationRepository", "conversation_record"]
