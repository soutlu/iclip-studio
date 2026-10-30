"""技能库的端口：自有四张表的仓储。"""

from __future__ import annotations

import uuid
from collections.abc import Mapping
from contextlib import AbstractAsyncContextManager
from typing import Protocol

from iclip.domains.skills.models import (
    DraftFile,
    DraftFileInfo,
    FileEntry,
    Skill,
    SkillStatus,
    SkillSummary,
    SkillVersion,
)


class SkillWriter(Protocol):
    """一个技能的一次修改：开始时锁住这个技能的行，同一技能的修改一个接一个；块正常结束提交、出错
    回滚。草稿文件的大小与 hash 由仓储按内容算。"""

    @property
    def skill(self) -> Skill:
        """锁住时读到的这一行。"""
        ...

    async def draft(self) -> tuple[DraftFileInfo, ...]:
        """草稿的全部文件，不带内容，按 ``path`` 排。"""
        ...

    async def draft_contents(self) -> dict[str, str]:
        """草稿的全部文件，路径 → 内容。"""
        ...

    async def put_file(self, path: str, content: str, *, by: uuid.UUID) -> None:
        """写一个草稿文件，没有就建。"""
        ...

    async def delete_file(self, path: str) -> None: ...

    async def replace_draft(self, files: Mapping[str, str], *, by: uuid.UUID) -> None:
        """删掉草稿的全部文件，换成 ``files``。"""
        ...

    async def update(
        self,
        *,
        display_name: str | None = None,
        description: str | None = None,
        status: SkillStatus | None = None,
    ) -> None:
        """给了的项照写，``None`` 不动。"""
        ...

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
    ) -> None:
        """写一个新版本：版本号取这个技能已有的最大号加一，连同全部文件一起写入，把最新版指到它，
        并把技能的 ``description`` 改成给的。"""
        ...


class SkillStore(Protocol):
    """``skills``、``skill_draft_files``、``skill_versions``、``skill_version_files`` 的数据访问。"""

    async def list(self) -> tuple[SkillSummary, ...]:
        """全部技能，按建立时刻倒序、同一时刻按 id 倒序。"""
        ...

    async def get(self, skill_id: uuid.UUID) -> Skill | None: ...

    async def by_name(self, name: str) -> Skill | None: ...

    async def draft(self, skill_id: uuid.UUID) -> tuple[DraftFileInfo, ...]:
        """草稿的全部文件，不带内容，按 ``path`` 排。"""
        ...

    async def draft_file(self, skill_id: uuid.UUID, path: str) -> DraftFile | None: ...

    async def versions(self, skill_id: uuid.UUID) -> tuple[SkillVersion, ...]:
        """这个技能的全部版本，版本号从大到小。"""
        ...

    async def version(self, skill_id: uuid.UUID, version_id: uuid.UUID) -> SkillVersion | None:
        """这个技能的这个版本；版本不属于它给 ``None``。"""
        ...

    async def version_files(self, version_id: uuid.UUID) -> dict[str, str]:
        """这个版本的全部文件，路径 → 内容。"""
        ...

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
    ) -> None:
        """建一个在用的技能连同它的草稿文件，同一个事务；标识已被占用是 ``Conflict``。"""
        ...

    def edit(self, skill_id: uuid.UUID) -> AbstractAsyncContextManager[SkillWriter]:
        """开一次修改，见 ``SkillWriter``；没有这个技能是 ``NotFound``。"""
        ...


__all__ = ["SkillStore", "SkillWriter"]
