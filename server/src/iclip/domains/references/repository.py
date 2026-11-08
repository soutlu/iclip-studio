from __future__ import annotations

import uuid
from collections.abc import Awaitable, Callable, Sequence
from typing import Protocol

from iclip.domains.identity.public import Principal
from iclip.domains.references.models import (
    BreakdownErrorCode,
    Claim,
    ReferenceCursor,
    ReferenceVideo,
    Scope,
    TestVideoJob,
)
from iclip.domains.references.test_prompt import TestPrompt


class ReferenceStore(Protocol):
    async def ensure_row(
        self,
        video_url: str,
        *,
        owner: uuid.UUID,
        requested_by: uuid.UUID,
        api_key_id: uuid.UUID | None,
    ) -> tuple[ReferenceVideo, bool]: ...

    async def get(self, reference_id: uuid.UUID) -> ReferenceVideo | None: ...

    async def list(
        self, scope: Scope, *, limit: int, after: ReferenceCursor | None
    ) -> Sequence[ReferenceVideo]: ...

    async def count(self, scope: Scope) -> int: ...

    async def owner_counts(self) -> Sequence[tuple[str, int]]: ...

    async def update(
        self,
        reference_id: uuid.UUID,
        *,
        version: int,
        document: str,
    ) -> int | None: ...

    async def requeue(
        self,
        reference_id: uuid.UUID,
        *,
        from_failed_only: bool,
        requested_by: uuid.UUID,
        api_key_id: uuid.UUID | None,
    ) -> bool: ...

    async def abandon_pending(self, reference_id: uuid.UUID) -> None: ...

    async def claim(self, reference_id: uuid.UUID) -> Claim | None: ...

    async def finish(self, claim: Claim, *, document: str) -> bool: ...

    async def fail(self, claim: Claim, *, error_code: BreakdownErrorCode) -> bool: ...

    async def time_out_stalled(self, *, older_than_seconds: int) -> int: ...

    async def restore(self, reference_id: uuid.UUID, *, owner: uuid.UUID) -> None: ...

    async def remove(self, reference_id: uuid.UUID) -> bool: ...


class VideoBreakdowns(Protocol):
    async def breakdown(self, video_url: str) -> str: ...


OwnVideoUpload = Callable[[Principal, uuid.UUID], Awaitable[str | None]]


class BreakdownQueue(Protocol):
    async def enqueue_breakdown(self, reference_id: uuid.UUID) -> None: ...


class TestVideos(Protocol):
    async def latest(self, owner: uuid.UUID, reference_id: uuid.UUID) -> TestVideoJob | None: ...

    async def submit(
        self,
        principal: Principal,
        reference_id: uuid.UUID,
        prompt: TestPrompt,
        aspect_ratio: str,
        *,
        user_name: str,
    ) -> None: ...


__all__ = [
    "BreakdownQueue",
    "OwnVideoUpload",
    "ReferenceStore",
    "TestVideos",
    "VideoBreakdowns",
]
