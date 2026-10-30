"""技能库的四张表与它们的 Postgres 仓储。

时间统一用数据库时钟；外部输入一律走绑定参数。状态取值、文件规则与版本号递增只在 Python 里，表上不加
CHECK；``latest_version_id`` 不加外键，只由写版本的事务在同一技能的行锁下改。"""

from __future__ import annotations

import uuid
from collections import defaultdict
from collections.abc import AsyncGenerator, Mapping
from contextlib import asynccontextmanager
from typing import Any, Final

from agent_runtime.errors import Conflict, NotFound
from sqlalchemy import (
    Column,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    MetaData,
    PrimaryKeyConstraint,
    Table,
    Text,
    UniqueConstraint,
    Uuid,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.engine import RowMapping
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine

from iclip.domains.skills.models import (
    STATUS_ACTIVE,
    DraftFile,
    DraftFileInfo,
    FileEntry,
    Skill,
    SkillStatus,
    SkillSummary,
    SkillVersion,
)
from iclip.domains.skills.rules import content_hash, file_entry

DB_SCHEMA: Final = "iclip"

metadata_obj = MetaData(schema=DB_SCHEMA)

skills_table = Table(
    "skills",
    metadata_obj,
    Column("id", Uuid, primary_key=True),
    Column("name", Text, nullable=False),
    Column("display_name", Text, nullable=False),
    Column("description", Text, nullable=False),
    Column("latest_version_id", Uuid, nullable=True),
    Column("status", Text, nullable=False),
    Column("created_by", Uuid, ForeignKey(f"{DB_SCHEMA}.users.id"), nullable=False),
    Column("created_at", DateTime(timezone=True), nullable=False, server_default=text("now()")),
    Column("updated_at", DateTime(timezone=True), nullable=False, server_default=text("now()")),
    UniqueConstraint("name", name="uq_skills_name"),
)

skill_draft_files_table = Table(
    "skill_draft_files",
    metadata_obj,
    Column("skill_id", Uuid, ForeignKey(f"{DB_SCHEMA}.skills.id"), nullable=False),
    Column("path", Text, nullable=False),
    Column("content", Text, nullable=False),
    Column("size", Integer, nullable=False),
    Column("hash", Text, nullable=False),
    Column("updated_by", Uuid, ForeignKey(f"{DB_SCHEMA}.users.id"), nullable=False),
    Column("updated_at", DateTime(timezone=True), nullable=False, server_default=text("now()")),
    PrimaryKeyConstraint("skill_id", "path"),
)

skill_versions_table = Table(
    "skill_versions",
    metadata_obj,
    Column("id", Uuid, primary_key=True),
    Column("skill_id", Uuid, ForeignKey(f"{DB_SCHEMA}.skills.id"), nullable=False),
    Column("version", Integer, nullable=False),
    Column("note", Text, nullable=True),
    Column("manifest", JSONB, nullable=False),
    Column("content_hash", Text, nullable=False),
    Column("created_by", Uuid, ForeignKey(f"{DB_SCHEMA}.users.id"), nullable=False),
    Column("created_at", DateTime(timezone=True), nullable=False, server_default=text("now()")),
    UniqueConstraint("skill_id", "version", name="uq_skill_versions_skill_version"),
    Index("ix_skill_versions_content_hash", "content_hash"),
)

skill_version_files_table = Table(
    "skill_version_files",
    metadata_obj,
    Column("version_id", Uuid, ForeignKey(f"{DB_SCHEMA}.skill_versions.id"), nullable=False),
    Column("path", Text, nullable=False),
    Column("content", Text, nullable=False),
    PrimaryKeyConstraint("version_id", "path"),
)

_DUPLICATE_NAME: Final = "uq_skills_name"

_SKILL_COLUMNS: Final = """
s.id, s.name, s.display_name, s.description, s.latest_version_id, s.status, s.created_by,
s.created_at, s.updated_at, v.version AS latest_version, v.content_hash AS latest_content_hash
FROM iclip.skills s LEFT JOIN iclip.skill_versions v ON v.id = s.latest_version_id"""

_LIST: Final = text(f"SELECT {_SKILL_COLUMNS} ORDER BY s.created_at DESC, s.id DESC")
_GET: Final = text(f"SELECT {_SKILL_COLUMNS} WHERE s.id = :id")
_BY_NAME: Final = text(f"SELECT {_SKILL_COLUMNS} WHERE s.name = :name")
_LOCK: Final = text(f"SELECT {_SKILL_COLUMNS} WHERE s.id = :id FOR UPDATE OF s")

_ALL_DRAFT_ENTRIES: Final = text("""
SELECT skill_id, path, size, hash FROM iclip.skill_draft_files""")

_DRAFT: Final = text("""
SELECT path, size, hash, updated_at FROM iclip.skill_draft_files
WHERE skill_id = :skill_id ORDER BY path COLLATE "C"
""")
"""按码位排，与清单（Python 的 ``sorted``）同一个先后；库的默认排序规则会把大小写混着排。"""

_DRAFT_CONTENTS: Final = text("""
SELECT path, content FROM iclip.skill_draft_files WHERE skill_id = :skill_id""")

_DRAFT_FILE: Final = text("""
SELECT path, content, size, hash, updated_at FROM iclip.skill_draft_files
WHERE skill_id = :skill_id AND path = :path""")

_PUT_FILE: Final = text("""
INSERT INTO iclip.skill_draft_files (skill_id, path, content, size, hash, updated_by)
VALUES (:skill_id, :path, :content, :size, :hash, :by)
ON CONFLICT (skill_id, path) DO UPDATE
SET content = EXCLUDED.content, size = EXCLUDED.size, hash = EXCLUDED.hash,
    updated_by = EXCLUDED.updated_by, updated_at = now()""")

_DELETE_FILE: Final = text("""
DELETE FROM iclip.skill_draft_files WHERE skill_id = :skill_id AND path = :path""")

_CLEAR_DRAFT: Final = text("DELETE FROM iclip.skill_draft_files WHERE skill_id = :skill_id")

_TOUCH: Final = text("UPDATE iclip.skills SET updated_at = now() WHERE id = :id")

_NEXT_VERSION: Final = text("""
SELECT coalesce(max(version), 0) + 1 FROM iclip.skill_versions WHERE skill_id = :skill_id""")

_POINT_TO: Final = text("""
UPDATE iclip.skills
SET latest_version_id = :version_id, description = :description, updated_at = now()
WHERE id = :id""")

_VERSION_COLUMNS: Final = """
id, skill_id, version, note, manifest, content_hash, created_by, created_at
FROM iclip.skill_versions"""

_VERSIONS: Final = text(f"""
SELECT {_VERSION_COLUMNS} WHERE skill_id = :skill_id ORDER BY version DESC""")

_VERSION: Final = text(f"SELECT {_VERSION_COLUMNS} WHERE skill_id = :skill_id AND id = :id")

_VERSION_FILES: Final = text("""
SELECT path, content FROM iclip.skill_version_files WHERE version_id = :version_id""")

_VERSION_FILE: Final = text("""
SELECT content FROM iclip.skill_version_files WHERE version_id = :version_id AND path = :path""")


def _skill_of(row: RowMapping) -> Skill:
    status: SkillStatus = row["status"]
    return Skill(
        id=row["id"],
        name=row["name"],
        display_name=row["display_name"],
        description=row["description"],
        latest_version_id=row["latest_version_id"],
        latest_version=row["latest_version"],
        latest_content_hash=row["latest_content_hash"],
        status=status,
        created_by=row["created_by"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


def _version_of(row: RowMapping) -> SkillVersion:
    return SkillVersion(
        id=row["id"],
        skill_id=row["skill_id"],
        version=row["version"],
        note=row["note"],
        manifest=tuple(
            FileEntry(path=one["path"], size=one["size"], hash=one["hash"])
            for one in row["manifest"]
        ),
        content_hash=row["content_hash"],
        created_by=row["created_by"],
        created_at=row["created_at"],
    )


def _info_of(row: RowMapping) -> DraftFileInfo:
    return DraftFileInfo(
        path=row["path"], size=row["size"], hash=row["hash"], updated_at=row["updated_at"]
    )


def _draft_rows(
    skill_id: uuid.UUID, files: Mapping[str, str], by: uuid.UUID
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for path, content in files.items():
        entry = file_entry(path, content)
        rows.append(
            {
                "skill_id": skill_id,
                "path": path,
                "content": content,
                "size": entry.size,
                "hash": entry.hash,
                "updated_by": by,
            }
        )
    return rows


def _violated_constraint(error: IntegrityError) -> str:
    """违反的约束名；asyncpg 把它挂在被包起来的原异常上。"""

    cause = getattr(error.orig, "__cause__", None)
    return getattr(cause, "constraint_name", None) or ""


class _SqlSkillWriter:
    """``SkillWriter`` 的 Postgres 实现，用一条已锁住技能行的事务连接。"""

    def __init__(self, conn: AsyncConnection, skill: Skill) -> None:
        self._conn = conn
        self._skill = skill

    @property
    def skill(self) -> Skill:
        return self._skill

    async def draft(self) -> tuple[DraftFileInfo, ...]:
        rows = (await self._conn.execute(_DRAFT, {"skill_id": self._skill.id})).mappings()
        return tuple(_info_of(row) for row in rows)

    async def draft_contents(self) -> dict[str, str]:
        rows = (await self._conn.execute(_DRAFT_CONTENTS, {"skill_id": self._skill.id})).all()
        return {path: content for path, content in rows}

    async def put_file(self, path: str, content: str, *, by: uuid.UUID) -> None:
        entry = file_entry(path, content)
        await self._conn.execute(
            _PUT_FILE,
            {
                "skill_id": self._skill.id,
                "path": path,
                "content": content,
                "size": entry.size,
                "hash": entry.hash,
                "by": by,
            },
        )
        await self._touch()

    async def delete_file(self, path: str) -> None:
        await self._conn.execute(_DELETE_FILE, {"skill_id": self._skill.id, "path": path})
        await self._touch()

    async def replace_draft(self, files: Mapping[str, str], *, by: uuid.UUID) -> None:
        await self._conn.execute(_CLEAR_DRAFT, {"skill_id": self._skill.id})
        if files:
            await self._conn.execute(
                skill_draft_files_table.insert(), _draft_rows(self._skill.id, files, by)
            )
        await self._touch()

    async def update(
        self,
        *,
        display_name: str | None = None,
        description: str | None = None,
        status: SkillStatus | None = None,
    ) -> None:
        values: dict[str, Any] = {
            key: value
            for key, value in (
                ("display_name", display_name),
                ("description", description),
                ("status", status),
            )
            if value is not None
        }
        if values:
            await self._conn.execute(
                skills_table.update()
                .where(skills_table.c.id == self._skill.id)
                .values(**values, updated_at=text("now()"))
            )

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
        number = (
            await self._conn.execute(_NEXT_VERSION, {"skill_id": self._skill.id})
        ).scalar_one()
        await self._conn.execute(
            skill_versions_table.insert().values(
                id=version_id,
                skill_id=self._skill.id,
                version=number,
                note=note,
                manifest=[
                    {"path": entry.path, "size": entry.size, "hash": entry.hash}
                    for entry in manifest
                ],
                content_hash=content_hash,
                created_by=by,
            )
        )
        if files:
            await self._conn.execute(
                skill_version_files_table.insert(),
                [
                    {"version_id": version_id, "path": path, "content": content}
                    for path, content in files.items()
                ],
            )
        await self._conn.execute(
            _POINT_TO,
            {"id": self._skill.id, "version_id": version_id, "description": description},
        )

    async def _touch(self) -> None:
        await self._conn.execute(_TOUCH, {"id": self._skill.id})


class SqlSkillStore:
    """``SkillStore`` 的 Postgres 实现。"""

    def __init__(self, engine: AsyncEngine) -> None:
        self._engine = engine

    async def list(self) -> tuple[SkillSummary, ...]:
        async with self._engine.connect() as conn:
            skills = [_skill_of(row) for row in (await conn.execute(_LIST)).mappings()]
            entries: dict[uuid.UUID, list[FileEntry]] = defaultdict(list)
            for row in (await conn.execute(_ALL_DRAFT_ENTRIES)).mappings():
                entries[row["skill_id"]].append(
                    FileEntry(path=row["path"], size=row["size"], hash=row["hash"])
                )
        return tuple(
            SkillSummary(skill=skill, draft_hash=content_hash(entries[skill.id]))
            for skill in skills
        )

    async def get(self, skill_id: uuid.UUID) -> Skill | None:
        async with self._engine.connect() as conn:
            row = (await conn.execute(_GET, {"id": skill_id})).mappings().first()
        return _skill_of(row) if row is not None else None

    async def by_name(self, name: str) -> Skill | None:
        async with self._engine.connect() as conn:
            row = (await conn.execute(_BY_NAME, {"name": name})).mappings().first()
        return _skill_of(row) if row is not None else None

    async def draft(self, skill_id: uuid.UUID) -> tuple[DraftFileInfo, ...]:
        async with self._engine.connect() as conn:
            rows = (await conn.execute(_DRAFT, {"skill_id": skill_id})).mappings().all()
        return tuple(_info_of(row) for row in rows)

    async def draft_file(self, skill_id: uuid.UUID, path: str) -> DraftFile | None:
        async with self._engine.connect() as conn:
            row = (
                (await conn.execute(_DRAFT_FILE, {"skill_id": skill_id, "path": path}))
                .mappings()
                .first()
            )
        if row is None:
            return None
        return DraftFile(
            path=row["path"],
            content=row["content"],
            size=row["size"],
            hash=row["hash"],
            updated_at=row["updated_at"],
        )

    async def versions(self, skill_id: uuid.UUID) -> tuple[SkillVersion, ...]:
        async with self._engine.connect() as conn:
            rows = (await conn.execute(_VERSIONS, {"skill_id": skill_id})).mappings().all()
        return tuple(_version_of(row) for row in rows)

    async def version(self, skill_id: uuid.UUID, version_id: uuid.UUID) -> SkillVersion | None:
        async with self._engine.connect() as conn:
            row = (
                (await conn.execute(_VERSION, {"skill_id": skill_id, "id": version_id}))
                .mappings()
                .first()
            )
        return _version_of(row) if row is not None else None

    async def version_files(self, version_id: uuid.UUID) -> dict[str, str]:
        async with self._engine.connect() as conn:
            rows = (await conn.execute(_VERSION_FILES, {"version_id": version_id})).all()
        return {path: content for path, content in rows}

    async def version_file(self, version_id: uuid.UUID, path: str) -> str | None:
        async with self._engine.connect() as conn:
            return (
                await conn.execute(_VERSION_FILE, {"version_id": version_id, "path": path})
            ).scalar_one_or_none()

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
        try:
            async with self._engine.begin() as conn:
                await conn.execute(
                    skills_table.insert().values(
                        id=skill_id,
                        name=name,
                        display_name=display_name,
                        description=description,
                        status=STATUS_ACTIVE,
                        created_by=by,
                    )
                )
                if files:
                    await conn.execute(
                        skill_draft_files_table.insert(), _draft_rows(skill_id, files, by)
                    )
        except IntegrityError as exc:
            if _violated_constraint(exc) == _DUPLICATE_NAME:
                raise Conflict(f"已有标识为「{name}」的技能") from exc
            raise

    @asynccontextmanager
    async def edit(self, skill_id: uuid.UUID) -> AsyncGenerator[_SqlSkillWriter]:
        async with self._engine.begin() as conn:
            row = (await conn.execute(_LOCK, {"id": skill_id})).mappings().first()
            if row is None:
                raise NotFound("技能不存在")
            yield _SqlSkillWriter(conn, _skill_of(row))


__all__ = [
    "SqlSkillStore",
    "metadata_obj",
    "skill_draft_files_table",
    "skill_version_files_table",
    "skill_versions_table",
    "skills_table",
]
