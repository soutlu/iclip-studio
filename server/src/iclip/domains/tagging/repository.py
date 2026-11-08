from __future__ import annotations

import uuid
from collections.abc import Collection, Mapping, Sequence
from contextlib import AbstractAsyncContextManager
from typing import Protocol

from iclip.domains.tagging.models import (
    AutoFill,
    Claim,
    EntryKey,
    TagCounts,
    TagErrorCode,
    TagNode,
)


class TagTreeWriter(Protocol):
    async def tree(self) -> tuple[TagNode, ...]: ...

    async def insert(
        self,
        tag_id: uuid.UUID,
        *,
        parent_id: uuid.UUID | None,
        name: str,
        guide: str | None,
        auto_fill: AutoFill | None,
        position: int,
    ) -> None: ...

    async def update(
        self, tag_id: uuid.UUID, *, name: str, guide: str | None, auto_fill: AutoFill | None
    ) -> None: ...

    async def place(self, ordered: Sequence[uuid.UUID]) -> None: ...

    async def delete(self, tag_id: uuid.UUID) -> bool: ...


class TagStore(Protocol):
    async def tree(self) -> tuple[TagNode, ...]: ...

    def edit(self) -> AbstractAsyncContextManager[TagTreeWriter]: ...

    async def counts(self) -> Mapping[uuid.UUID, TagCounts]: ...

    async def ensure(self, key: EntryKey, *, created_by: uuid.UUID | None) -> None: ...

    async def mark_pending(self, key: EntryKey, *, created_by: uuid.UUID | None) -> uuid.UUID: ...

    async def request(self, key: EntryKey) -> uuid.UUID | None: ...

    async def abandon_pending(self, entry_id: uuid.UUID) -> None: ...

    async def replace(self, key: EntryKey, tag_ids: Collection[uuid.UUID]) -> bool: ...

    async def claim(self, entry_id: uuid.UUID) -> Claim | None: ...

    async def finish(self, claim: Claim, tag_ids: Collection[uuid.UUID]) -> bool: ...

    async def fail(self, claim: Claim, *, error_code: TagErrorCode) -> bool: ...

    async def time_out_stalled(self, *, older_than_seconds: int) -> int: ...

    async def remove(self, key: EntryKey) -> None: ...


class SourceText(Protocol):
    async def text(self, key: EntryKey) -> str | None: ...


class Tagger(Protocol):
    async def tag(self, text: str, dimensions: Sequence[TagNode]) -> tuple[uuid.UUID, ...]: ...


class TaggingQueuePort(Protocol):
    async def enqueue_tagging(self, entry_id: uuid.UUID) -> None: ...


__all__ = ["SourceText", "TagStore", "TagTreeWriter", "Tagger", "TaggingQueuePort"]
