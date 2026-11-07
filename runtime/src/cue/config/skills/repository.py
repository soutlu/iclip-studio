from __future__ import annotations

import uuid
from collections.abc import Mapping
from contextlib import AbstractAsyncContextManager
from typing import Protocol

from cue.agent_usage import AgentUsage
from cue.config.skills.models import (
    DraftFile,
    DraftFileInfo,
    FileEntry,
    Skill,
    SkillStatus,
    SkillSummary,
    SkillVersion,
)


class SkillWriter(Protocol):
    @property
    def skill(self) -> Skill: ...

    async def draft(self) -> tuple[DraftFileInfo, ...]: ...

    async def draft_contents(self) -> dict[str, str]: ...

    async def put_file(self, path: str, content: str, *, by: uuid.UUID) -> None: ...

    async def delete_file(self, path: str) -> None: ...

    async def move_file(self, source: str, target: str, *, by: uuid.UUID) -> None: ...

    async def replace_draft(self, files: Mapping[str, str], *, by: uuid.UUID) -> None: ...

    async def update(
        self,
        *,
        name: str | None = None,
        display_name: str | None = None,
        description: str | None = None,
        status: SkillStatus | None = None,
    ) -> None: ...

    async def add_version(
        self,
        version_id: uuid.UUID,
        *,
        note: str | None,
        files: Mapping[str, str],
        manifest: tuple[FileEntry, ...],
        content_hash: str,
        description: str,
        by: uuid.UUID,
    ) -> None: ...


class SkillStore(Protocol):
    async def list(self) -> tuple[SkillSummary, ...]: ...

    async def get(self, skill_id: uuid.UUID) -> Skill | None: ...

    async def by_name(self, name: str) -> Skill | None: ...

    async def draft(self, skill_id: uuid.UUID) -> tuple[DraftFileInfo, ...]: ...

    async def draft_file(self, skill_id: uuid.UUID, path: str) -> DraftFile | None: ...

    async def versions(self, skill_id: uuid.UUID) -> tuple[SkillVersion, ...]: ...

    async def version(self, skill_id: uuid.UUID, version_id: uuid.UUID) -> SkillVersion | None: ...

    async def version_files(self, version_id: uuid.UUID) -> dict[str, str]: ...

    async def version_file(self, version_id: uuid.UUID, path: str) -> str | None: ...

    async def create(
        self,
        skill_id: uuid.UUID,
        *,
        name: str,
        display_name: str,
        description: str,
        files: Mapping[str, str],
        by: uuid.UUID,
    ) -> None: ...

    def edit(self, skill_id: uuid.UUID) -> AbstractAsyncContextManager[SkillWriter]: ...


class SkillUsages(Protocol):
    async def skill_users(self, skill_id: uuid.UUID) -> tuple[AgentUsage, ...]: ...


__all__ = ["SkillStore", "SkillUsages", "SkillWriter"]
