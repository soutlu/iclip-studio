"""参考视频表与它的 Postgres 仓储。时间统一用数据库时钟；外部输入一律走绑定参数。"""

from __future__ import annotations

import uuid
from collections.abc import Mapping, Sequence
from typing import Any, Final

from sqlalchemy import (
    CheckConstraint,
    Column,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    MetaData,
    Table,
    Text,
    UniqueConstraint,
    Uuid,
    text,
)
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.engine import RowMapping
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine

from iclip.domains.references.models import (
    CATEGORIES,
    STATUS_COMPLETED,
    STATUS_FAILED,
    STATUS_PENDING,
    STATUS_RUNNING,
    VIDEO_TYPES,
    BreakdownErrorCode,
    CategoryValue,
    Claim,
    ReferenceCursor,
    ReferenceVideo,
    Scope,
    Tags,
    VideoTypeValue,
)

DB_SCHEMA: Final = "iclip"

metadata_obj = MetaData(schema=DB_SCHEMA)

reference_videos_table = Table(
    "reference_videos",
    metadata_obj,
    Column("id", Uuid, primary_key=True),
    # 同一个文件上传时已合成一个地址，所以一条视频一行按地址认。
    Column("video_url", Text, nullable=False),
    # 上传的人，或第一次拆它的人。
    Column(
        "owner_user_id",
        Uuid,
        ForeignKey(f"{DB_SCHEMA}.users.id", name="fk_reference_videos_owner"),
        nullable=False,
    ),
    Column("video_types", ARRAY(Text), nullable=False, server_default=text("'{}'")),
    Column("categories", ARRAY(Text), nullable=False, server_default=text("'{}'")),
    Column("breakdown_status", Text, nullable=False),
    Column("error_code", Text, nullable=True),
    # 唯一一份当前拆解，不留历史。
    Column("document", Text, nullable=True),
    Column("version", Integer, nullable=False, server_default=text("1")),
    # 最近一次拆解是谁要的；不关联外键，与生成记录的 api_key_id 同一做法。
    Column("requested_by", Uuid, nullable=True),
    Column("api_key_id", Uuid, nullable=True),
    Column("started_at", DateTime(timezone=True), nullable=True),
    Column("created_at", DateTime(timezone=True), nullable=False, server_default=text("now()")),
    Column("updated_at", DateTime(timezone=True), nullable=False, server_default=text("now()")),
    # 从资料库移除；按地址仍能读到它的拆解。
    Column("deleted_at", DateTime(timezone=True), nullable=True),
    UniqueConstraint("video_url", name="uq_reference_videos_video_url"),
    CheckConstraint(
        "breakdown_status IN ('pending', 'running', 'completed', 'failed')",
        name="ck_reference_videos_status",
    ),
    CheckConstraint(
        "error_code IN ('video_unreadable', 'model_call_failed', 'model_failed', 'timeout')",
        name="ck_reference_videos_error_code",
    ),
    Index(
        "ix_reference_videos_listed",
        text("created_at DESC"),
        "id",
        postgresql_where=text("deleted_at IS NULL"),
    ),
    Index("ix_reference_videos_video_types", "video_types", postgresql_using="gin"),
    Index("ix_reference_videos_categories", "categories", postgresql_using="gin"),
)

_ROW: Final = """
SELECT r.id, r.video_url, r.owner_user_id, u.username AS owner_user_name, r.video_types,
       r.categories, r.breakdown_status, r.error_code, r.document, r.version, r.created_at,
       r.updated_at, r.deleted_at
FROM iclip.reference_videos r
JOIN iclip.users u ON u.id = r.owner_user_id"""

_BY_ID: Final = text(f"{_ROW}\nWHERE r.id = :id")
_BY_URL: Final = text(f"{_ROW}\nWHERE r.video_url = :video_url")

_INSERT: Final = text("""
INSERT INTO iclip.reference_videos
    (id, video_url, owner_user_id, breakdown_status, requested_by, api_key_id)
VALUES (:id, :video_url, :owner, :pending, :requested_by, :api_key_id)
ON CONFLICT (video_url) DO NOTHING
RETURNING id""")

_FILTER: Final = r"""
WHERE r.deleted_at IS NULL
  AND (cardinality(CAST(:video_types AS text[])) = 0
       OR r.video_types && CAST(:video_types AS text[]))
  AND (cardinality(CAST(:categories AS text[])) = 0
       OR r.categories && CAST(:categories AS text[]))
  AND (CAST(:user_name AS text) IS NULL OR u.username = CAST(:user_name AS text))
  AND (CAST(:pattern AS text) IS NULL OR r.document ILIKE CAST(:pattern AS text) ESCAPE '\')
  AND (CAST(:since AS timestamptz) IS NULL OR r.created_at >= CAST(:since AS timestamptz))
  AND (CAST(:until AS timestamptz) IS NULL OR r.created_at < CAST(:until AS timestamptz))"""

_LIST: Final = text(f"""{_ROW}{_FILTER}
  AND (CAST(:after_at AS timestamptz) IS NULL
       OR (r.created_at, r.id) < (CAST(:after_at AS timestamptz), CAST(:after_id AS uuid)))
ORDER BY r.created_at DESC, r.id DESC
LIMIT :limit""")

_COUNT: Final = text(f"""
SELECT count(*) FROM iclip.reference_videos r
JOIN iclip.users u ON u.id = r.owner_user_id{_FILTER}""")

_TYPE_COUNTS: Final = text("""
SELECT t.value, count(*) AS n
FROM iclip.reference_videos r, unnest(r.video_types) AS t(value)
WHERE r.deleted_at IS NULL
GROUP BY t.value""")

_CATEGORY_COUNTS: Final = text("""
SELECT c.value, count(*) AS n
FROM iclip.reference_videos r, unnest(r.categories) AS c(value)
WHERE r.deleted_at IS NULL
GROUP BY c.value""")

_OWNER_COUNTS: Final = text("""
SELECT u.username, count(*) AS n
FROM iclip.reference_videos r
JOIN iclip.users u ON u.id = r.owner_user_id
WHERE r.deleted_at IS NULL
GROUP BY u.username
ORDER BY n DESC, u.username""")

_UPDATE: Final = text("""
UPDATE iclip.reference_videos
SET document = :document, video_types = CAST(:video_types AS text[]),
    categories = CAST(:categories AS text[]), version = version + 1, updated_at = now()
WHERE id = :id AND deleted_at IS NULL AND version = :version
  AND breakdown_status IN (:completed, :failed)
RETURNING version""")

_REQUEUE: Final = text("""
UPDATE iclip.reference_videos
SET breakdown_status = :pending, requested_by = :requested_by, api_key_id = :api_key_id,
    updated_at = now()
WHERE id = :id AND breakdown_status = ANY(CAST(:from_statuses AS text[]))
RETURNING id""")

_ABANDON: Final = text("""
UPDATE iclip.reference_videos
SET breakdown_status = :failed, error_code = 'model_call_failed', updated_at = now()
WHERE id = :id AND breakdown_status = :pending""")

_CLAIM: Final = text("""
UPDATE iclip.reference_videos
SET breakdown_status = :running, started_at = now(), updated_at = now()
WHERE id = :id AND breakdown_status = :pending
RETURNING id, video_url, started_at""")

_FINISH: Final = text("""
UPDATE iclip.reference_videos
SET breakdown_status = :completed, document = :document,
    video_types = CAST(:video_types AS text[]), categories = CAST(:categories AS text[]),
    error_code = NULL, version = version + 1, updated_at = now()
WHERE id = :id AND breakdown_status = :running AND started_at = :started_at
RETURNING id""")

_FAIL: Final = text("""
UPDATE iclip.reference_videos
SET breakdown_status = :failed, error_code = :error_code, updated_at = now()
WHERE id = :id AND breakdown_status = :running AND started_at = :started_at
RETURNING id""")

_TIME_OUT: Final = text("""
UPDATE iclip.reference_videos
SET breakdown_status = :failed, error_code = 'timeout', updated_at = now()
WHERE breakdown_status = :running
  AND started_at < now() - make_interval(secs => :seconds)
RETURNING id""")

_RESTORE: Final = text("""
UPDATE iclip.reference_videos
SET deleted_at = NULL, owner_user_id = :owner, updated_at = now()
WHERE id = :id AND deleted_at IS NOT NULL""")

_REMOVE: Final = text("""
UPDATE iclip.reference_videos
SET deleted_at = now(), updated_at = now()
WHERE id = :id AND deleted_at IS NULL
RETURNING id""")


def _row_of(row: RowMapping) -> ReferenceVideo:
    return ReferenceVideo(
        id=row["id"],
        video_url=row["video_url"],
        owner_user_id=row["owner_user_id"],
        owner_user_name=row["owner_user_name"],
        video_types=tuple(row["video_types"]),
        categories=tuple(row["categories"]),
        breakdown_status=row["breakdown_status"],
        error_code=row["error_code"],
        document=row["document"],
        version=row["version"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
        deleted_at=row["deleted_at"],
    )


def _like_pattern(q: str) -> str:
    """关键词按字面包含：``%``、``_`` 与转义符本身都转义掉。"""

    escaped = q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


def _scope_params(scope: Scope) -> dict[str, Any]:
    return {
        "video_types": list(scope.video_types),
        "categories": list(scope.categories),
        "user_name": scope.user_name,
        "pattern": None if scope.q is None else _like_pattern(scope.q),
        "since": scope.since,
        "until": scope.until,
    }


def _tag_params(tags: Tags) -> dict[str, Any]:
    return {"video_types": list(tags.video_types), "categories": list(tags.categories)}


async def _one(conn: AsyncConnection, statement: Any, params: Mapping[str, Any]) -> RowMapping:
    row = (await conn.execute(statement, dict(params))).mappings().first()
    if row is None:
        raise RuntimeError("刚写下或刚认出的参考视频读不回来")
    return row


class SqlReferenceStore:
    """``ReferenceStore`` 的 Postgres 实现。"""

    def __init__(self, engine: AsyncEngine) -> None:
        self._engine = engine

    async def ensure_row(
        self,
        video_url: str,
        *,
        owner: uuid.UUID,
        requested_by: uuid.UUID,
        api_key_id: uuid.UUID | None,
    ) -> tuple[ReferenceVideo, bool]:
        async with self._engine.begin() as conn:
            # 撞上别的事务正在插的同一个地址时，ON CONFLICT 等它提交再放弃；下一条语句看得到那一行。
            inserted = (
                await conn.execute(
                    _INSERT,
                    {
                        "id": uuid.uuid4(),
                        "video_url": video_url,
                        "owner": owner,
                        "pending": STATUS_PENDING,
                        "requested_by": requested_by,
                        "api_key_id": api_key_id,
                    },
                )
            ).first()
            row = await _one(conn, _BY_URL, {"video_url": video_url})
        return _row_of(row), inserted is not None

    async def get(self, reference_id: uuid.UUID) -> ReferenceVideo | None:
        async with self._engine.connect() as conn:
            row = (await conn.execute(_BY_ID, {"id": reference_id})).mappings().first()
        return None if row is None else _row_of(row)

    async def list(
        self, scope: Scope, *, limit: int, after: ReferenceCursor | None
    ) -> Sequence[ReferenceVideo]:
        params = {
            **_scope_params(scope),
            "after_at": after.at if after else None,
            "after_id": after.reference_id if after else None,
            "limit": limit,
        }
        async with self._engine.connect() as conn:
            rows = (await conn.execute(_LIST, params)).mappings().all()
        return [_row_of(row) for row in rows]

    async def count(self, scope: Scope) -> int:
        async with self._engine.connect() as conn:
            return int((await conn.execute(_COUNT, _scope_params(scope))).scalar_one())

    async def filter_counts(
        self,
    ) -> tuple[Mapping[VideoTypeValue, int], Sequence[tuple[CategoryValue, int]]]:
        async with self._engine.connect() as conn:
            types = {row[0]: int(row[1]) for row in await conn.execute(_TYPE_COUNTS)}
            categories = {row[0]: int(row[1]) for row in await conn.execute(_CATEGORY_COUNTS)}
        type_counts: dict[VideoTypeValue, int] = {
            one.value: types.get(one.value, 0) for one in VIDEO_TYPES
        }
        # 条数多的在前，同数按清单的先后；表里只会有清单里的值，写入都经过校验。
        listed: list[tuple[CategoryValue, int]] = [
            (name, categories[name]) for name in CATEGORIES if name in categories
        ]
        used = sorted(listed, key=lambda item: -item[1])
        return type_counts, used

    async def owner_counts(self) -> Sequence[tuple[str, int]]:
        async with self._engine.connect() as conn:
            rows = await conn.execute(_OWNER_COUNTS)
            return [(str(row[0]), int(row[1])) for row in rows]

    async def update(
        self,
        reference_id: uuid.UUID,
        *,
        version: int,
        document: str,
        tags: Tags,
    ) -> int | None:
        async with self._engine.begin() as conn:
            row = (
                await conn.execute(
                    _UPDATE,
                    {
                        "id": reference_id,
                        "version": version,
                        "document": document,
                        **_tag_params(tags),
                        "completed": STATUS_COMPLETED,
                        "failed": STATUS_FAILED,
                    },
                )
            ).first()
        return None if row is None else int(row[0])

    async def requeue(
        self,
        reference_id: uuid.UUID,
        *,
        from_failed_only: bool,
        requested_by: uuid.UUID,
        api_key_id: uuid.UUID | None,
    ) -> bool:
        from_statuses = [STATUS_FAILED] if from_failed_only else [STATUS_COMPLETED, STATUS_FAILED]
        async with self._engine.begin() as conn:
            row = (
                await conn.execute(
                    _REQUEUE,
                    {
                        "id": reference_id,
                        "pending": STATUS_PENDING,
                        "requested_by": requested_by,
                        "api_key_id": api_key_id,
                        "from_statuses": from_statuses,
                    },
                )
            ).first()
        return row is not None

    async def abandon_pending(self, reference_id: uuid.UUID) -> None:
        async with self._engine.begin() as conn:
            await conn.execute(
                _ABANDON, {"id": reference_id, "failed": STATUS_FAILED, "pending": STATUS_PENDING}
            )

    async def claim(self, reference_id: uuid.UUID) -> Claim | None:
        async with self._engine.begin() as conn:
            row = (
                (
                    await conn.execute(
                        _CLAIM,
                        {"id": reference_id, "running": STATUS_RUNNING, "pending": STATUS_PENDING},
                    )
                )
                .mappings()
                .first()
            )
        if row is None:
            return None
        return Claim(id=row["id"], video_url=row["video_url"], started_at=row["started_at"])

    async def finish(self, claim: Claim, *, document: str, tags: Tags) -> bool:
        async with self._engine.begin() as conn:
            row = (
                await conn.execute(
                    _FINISH,
                    {
                        "id": claim.id,
                        "started_at": claim.started_at,
                        "document": document,
                        **_tag_params(tags),
                        "completed": STATUS_COMPLETED,
                        "running": STATUS_RUNNING,
                    },
                )
            ).first()
        return row is not None

    async def fail(self, claim: Claim, *, error_code: BreakdownErrorCode) -> bool:
        async with self._engine.begin() as conn:
            row = (
                await conn.execute(
                    _FAIL,
                    {
                        "id": claim.id,
                        "started_at": claim.started_at,
                        "error_code": error_code,
                        "failed": STATUS_FAILED,
                        "running": STATUS_RUNNING,
                    },
                )
            ).first()
        return row is not None

    async def time_out_stalled(self, *, older_than_seconds: int) -> int:
        async with self._engine.begin() as conn:
            rows = (
                await conn.execute(
                    _TIME_OUT,
                    {
                        "seconds": float(older_than_seconds),
                        "failed": STATUS_FAILED,
                        "running": STATUS_RUNNING,
                    },
                )
            ).all()
        return len(rows)

    async def restore(self, reference_id: uuid.UUID, *, owner: uuid.UUID) -> None:
        async with self._engine.begin() as conn:
            await conn.execute(_RESTORE, {"id": reference_id, "owner": owner})

    async def remove(self, reference_id: uuid.UUID) -> bool:
        async with self._engine.begin() as conn:
            row = (await conn.execute(_REMOVE, {"id": reference_id})).first()
        return row is not None


__all__ = ["DB_SCHEMA", "SqlReferenceStore", "metadata_obj", "reference_videos_table"]
