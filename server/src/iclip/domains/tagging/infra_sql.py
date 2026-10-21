"""资料库标签的三张表与它们的 Postgres 仓储，以及给各库列表拼标签字段与筛选条件的 SQL 片段。

时间统一用数据库时钟；外部输入一律走绑定参数，拼进 SQL 的只有代码里的常量。"""

from __future__ import annotations

import uuid
from collections import defaultdict
from collections.abc import AsyncGenerator, Collection, Mapping, Sequence
from contextlib import asynccontextmanager
from typing import Any, Final

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
from sqlalchemy.engine import RowMapping
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine

from iclip.common.errors import ValidationFailed
from iclip.domains.tagging.models import (
    AUTO_FILL_AI,
    BUSY_STATUSES,
    ENTRY_KINDS,
    ERROR_MODEL_CALL_FAILED,
    KIND_HIT_CASE,
    KIND_REFERENCE,
    STATUS_COMPLETED,
    STATUS_FAILED,
    STATUS_PENDING,
    STATUS_RUNNING,
    AutoFill,
    Claim,
    EntryKey,
    EntryKind,
    TagCounts,
    TagErrorCode,
    TagNode,
)

DB_SCHEMA: Final = "iclip"

metadata_obj = MetaData(schema=DB_SCHEMA)

library_tags_table = Table(
    "library_tags",
    metadata_obj,
    Column("id", Uuid, primary_key=True),
    Column(
        "parent_id",
        Uuid,
        ForeignKey(f"{DB_SCHEMA}.library_tags.id", ondelete="CASCADE"),
        nullable=True,
    ),
    Column("name", Text, nullable=False),
    Column("auto_fill", Text, nullable=True),
    Column("guide", Text, nullable=True),
    Column("position", Integer, nullable=False),
    Column("created_at", DateTime(timezone=True), nullable=False, server_default=text("now()")),
    Column("updated_at", DateTime(timezone=True), nullable=False, server_default=text("now()")),
    UniqueConstraint("parent_id", "name", name="uq_library_tags_parent_name"),
    Index(
        "uq_library_tags_dimension_name",
        "name",
        unique=True,
        postgresql_where=text("parent_id IS NULL"),
    ),
)

library_entries_table = Table(
    "library_entries",
    metadata_obj,
    Column("id", Uuid, primary_key=True),
    Column("kind", Text, nullable=False),
    Column(
        "reference_id",
        Uuid,
        ForeignKey(f"{DB_SCHEMA}.reference_videos.id", ondelete="CASCADE"),
        nullable=True,
    ),
    Column(
        "job_id",
        Uuid,
        ForeignKey(f"{DB_SCHEMA}.generation_jobs.id", ondelete="CASCADE"),
        nullable=True,
    ),
    Column("tag_status", Text, nullable=True),
    Column("tag_error", Text, nullable=True),
    Column("tag_started_at", DateTime(timezone=True), nullable=True),
    Column("created_by", Uuid, ForeignKey(f"{DB_SCHEMA}.users.id"), nullable=True),
    Column("created_at", DateTime(timezone=True), nullable=False, server_default=text("now()")),
    Index(
        "uq_library_entries_reference",
        "kind",
        "reference_id",
        unique=True,
        postgresql_where=text("reference_id IS NOT NULL"),
    ),
    Index(
        "uq_library_entries_job",
        "kind",
        "job_id",
        unique=True,
        postgresql_where=text("job_id IS NOT NULL"),
    ),
)

library_entry_tags_table = Table(
    "library_entry_tags",
    metadata_obj,
    Column(
        "entry_id",
        Uuid,
        ForeignKey(f"{DB_SCHEMA}.library_entries.id", ondelete="CASCADE"),
        nullable=False,
    ),
    Column(
        "tag_id",
        Uuid,
        ForeignKey(f"{DB_SCHEMA}.library_tags.id", ondelete="CASCADE"),
        nullable=False,
    ),
    PrimaryKeyConstraint("entry_id", "tag_id"),
    Index("ix_library_entry_tags_tag", "tag_id"),
)

_SUBJECT_COLUMN: Final[Mapping[EntryKind, str]] = {
    KIND_REFERENCE: "reference_id",
    KIND_HIT_CASE: "job_id",
}
"""每种条目用哪一列指它那一库的行。"""

if set(_SUBJECT_COLUMN) != set(ENTRY_KINDS):
    raise RuntimeError("_SUBJECT_COLUMN 与 ENTRY_KINDS 对不上")


def _subject_column(kind: EntryKind) -> str:
    return _SUBJECT_COLUMN[kind]


_DIMENSION_OF: Final = """
WITH RECURSIVE dim(id, dimension_id) AS (
    SELECT id, id FROM iclip.library_tags WHERE parent_id IS NULL
    UNION ALL
    SELECT t.id, d.dimension_id FROM iclip.library_tags t JOIN dim d ON t.parent_id = d.id
),
ai_tags AS (
    SELECT d.id FROM dim d JOIN iclip.library_tags v ON v.id = d.dimension_id
    WHERE v.auto_fill = :ai AND d.id <> d.dimension_id
)"""
"""每个标签所在的维度，以及此刻在 AI 维度里的全部取值。"""

_TREE: Final = text("""
SELECT id, parent_id, name, auto_fill, guide, position
FROM iclip.library_tags
ORDER BY position, id""")

_LOCK_TREE: Final = text("SELECT pg_advisory_xact_lock(hashtext('iclip.library_tags'))")
"""改树的事务一个接一个：跨层重名与 AI 取值上限要读整棵树再判，只靠行锁和唯一约束挡不住并发。"""

_INSERT_TAG: Final = text("""
INSERT INTO iclip.library_tags (id, parent_id, name, guide, auto_fill, position)
VALUES (:id, :parent_id, :name, :guide, :auto_fill, :position)""")

_UPDATE_TAG: Final = text("""
UPDATE iclip.library_tags
SET name = :name, guide = :guide, auto_fill = :auto_fill, updated_at = now()
WHERE id = :id""")

_PLACE_TAGS: Final = text("""
UPDATE iclip.library_tags t SET position = v.position
FROM unnest(CAST(:ids AS uuid[]), CAST(:positions AS int[])) AS v(id, position)
WHERE t.id = v.id AND t.position <> v.position""")

_DELETE_TAG: Final = text("DELETE FROM iclip.library_tags WHERE id = :id RETURNING id")

_DUPLICATE_NAME_CONSTRAINTS: Final = frozenset(
    {"uq_library_tags_parent_name", "uq_library_tags_dimension_name"}
)

_COUNTS: Final = text("""
WITH RECURSIVE closure(ancestor, tag_id) AS (
    SELECT id, id FROM iclip.library_tags
    UNION ALL
    SELECT c.ancestor, t.id FROM iclip.library_tags t JOIN closure c ON t.parent_id = c.tag_id
)
SELECT c.ancestor AS tag_id,
       count(DISTINCT e.id) FILTER (
           WHERE e.kind = :reference AND r.deleted_at IS NULL) AS n_references,
       count(DISTINCT e.id) FILTER (WHERE e.kind = :hit_case) AS n_hit_cases
FROM closure c
JOIN iclip.library_entry_tags et ON et.tag_id = c.tag_id
JOIN iclip.library_entries e ON e.id = et.entry_id
LEFT JOIN iclip.reference_videos r ON r.id = e.reference_id
GROUP BY c.ancestor""")

_CLEAR_AI: Final = text(f"""{_DIMENSION_OF}
DELETE FROM iclip.library_entry_tags
WHERE entry_id = ANY(CAST(:entry_ids AS uuid[])) AND tag_id IN (SELECT id FROM ai_tags)""")

_INSERT_AI: Final = text(f"""{_DIMENSION_OF}
INSERT INTO iclip.library_entry_tags (entry_id, tag_id)
SELECT :entry_id, t.id FROM iclip.library_tags t
WHERE t.id = ANY(CAST(:tag_ids AS uuid[])) AND t.id IN (SELECT id FROM ai_tags)
ON CONFLICT DO NOTHING""")

_CLEAR_ALL: Final = text("DELETE FROM iclip.library_entry_tags WHERE entry_id = :entry_id")

_INSERT_ANY: Final = text("""
INSERT INTO iclip.library_entry_tags (entry_id, tag_id)
SELECT :entry_id, t.id FROM iclip.library_tags t
WHERE t.id = ANY(CAST(:tag_ids AS uuid[])) AND t.parent_id IS NOT NULL
ON CONFLICT DO NOTHING""")

_ABANDON: Final = text("""
UPDATE iclip.library_entries SET tag_status = :failed, tag_error = :error
WHERE id = :id AND tag_status = :pending
RETURNING id""")

_CLAIM: Final = text("""
UPDATE iclip.library_entries SET tag_status = :running, tag_started_at = now()
WHERE id = :id AND tag_status = :pending
RETURNING id, kind, reference_id, job_id, tag_started_at""")

_FINISH: Final = text("""
UPDATE iclip.library_entries SET tag_status = :completed, tag_error = NULL
WHERE id = :id AND tag_status = :running AND tag_started_at = :started_at
RETURNING id""")

_FAIL: Final = text("""
UPDATE iclip.library_entries SET tag_status = :failed, tag_error = :error
WHERE id = :id AND tag_status = :running AND tag_started_at = :started_at
RETURNING id""")

_TIME_OUT: Final = text("""
UPDATE iclip.library_entries SET tag_status = :failed, tag_error = 'timeout'
WHERE tag_status = :running AND tag_started_at < now() - make_interval(secs => :seconds)
RETURNING id""")


def _by_kind(statement: str) -> Mapping[EntryKind, Any]:
    """按条目种类各编一份；``{col}`` 换成那一种指向来源行的列名。"""

    return {kind: text(statement.format(col=column)) for kind, column in _SUBJECT_COLUMN.items()}


_ENSURE: Final = _by_kind("""
INSERT INTO iclip.library_entries (id, kind, {col}, created_by)
VALUES (:id, :kind, :subject_id, :created_by)
ON CONFLICT (kind, {col}) WHERE {col} IS NOT NULL DO NOTHING""")

_MARK_PENDING: Final = _by_kind("""
INSERT INTO iclip.library_entries (id, kind, {col}, created_by, tag_status)
VALUES (:id, :kind, :subject_id, :created_by, :pending)
ON CONFLICT (kind, {col}) WHERE {col} IS NOT NULL DO UPDATE SET tag_status = :pending
RETURNING id""")

_REQUEST: Final = _by_kind("""
UPDATE iclip.library_entries SET tag_status = :pending
WHERE kind = :kind AND {col} = :subject_id
  AND (tag_status IS NULL OR tag_status NOT IN (:pending, :running))
RETURNING id""")

_LOCK_ENTRY: Final = _by_kind("""
SELECT id, tag_status FROM iclip.library_entries
WHERE kind = :kind AND {col} = :subject_id
FOR UPDATE""")


def _key_of(row: RowMapping) -> EntryKey:
    kind: EntryKind = row["kind"]
    return EntryKey(kind=kind, subject_id=row[_subject_column(kind)])


def _key_params(key: EntryKey) -> dict[str, Any]:
    return {"kind": key.kind, "subject_id": key.subject_id}


def _build_tree(rows: Sequence[RowMapping]) -> tuple[TagNode, ...]:
    """行已按 ``position, id`` 排好；同级的先后照搬。"""

    children: dict[uuid.UUID | None, list[RowMapping]] = defaultdict(list)
    for row in rows:
        children[row["parent_id"]].append(row)

    def build(row: RowMapping) -> TagNode:
        return TagNode(
            id=row["id"],
            parent_id=row["parent_id"],
            name=row["name"],
            auto_fill=row["auto_fill"],
            guide=row["guide"],
            position=row["position"],
            children=tuple(build(child) for child in children[row["id"]]),
        )

    return tuple(build(row) for row in children[None])


async def _clear_ai(conn: AsyncConnection, entry_ids: Sequence[uuid.UUID]) -> None:
    if entry_ids:
        await conn.execute(_CLEAR_AI, {"entry_ids": list(entry_ids), "ai": AUTO_FILL_AI})


def _violated_constraint(error: IntegrityError) -> str:
    """违反的约束名；asyncpg 把它挂在被包起来的原异常上。"""

    cause = getattr(error.orig, "__cause__", None)
    return getattr(cause, "constraint_name", None) or ""


class _SqlTagTreeWriter:
    """``TagTreeWriter`` 的 Postgres 实现，用一条已拿到写锁的事务连接。"""

    def __init__(self, conn: AsyncConnection) -> None:
        self._conn = conn

    async def tree(self) -> tuple[TagNode, ...]:
        rows = (await self._conn.execute(_TREE)).mappings().all()
        return _build_tree(rows)

    async def insert(
        self,
        tag_id: uuid.UUID,
        *,
        parent_id: uuid.UUID | None,
        name: str,
        guide: str | None,
        auto_fill: AutoFill | None,
        position: int,
    ) -> None:
        await self._conn.execute(
            _INSERT_TAG,
            {
                "id": tag_id,
                "parent_id": parent_id,
                "name": name,
                "guide": guide,
                "auto_fill": auto_fill,
                "position": position,
            },
        )

    async def update(
        self, tag_id: uuid.UUID, *, name: str, guide: str | None, auto_fill: AutoFill | None
    ) -> None:
        await self._conn.execute(
            _UPDATE_TAG, {"id": tag_id, "name": name, "guide": guide, "auto_fill": auto_fill}
        )

    async def place(self, ordered: Sequence[uuid.UUID]) -> None:
        if ordered:
            await self._conn.execute(
                _PLACE_TAGS, {"ids": list(ordered), "positions": list(range(len(ordered)))}
            )

    async def delete(self, tag_id: uuid.UUID) -> bool:
        return (await self._conn.execute(_DELETE_TAG, {"id": tag_id})).first() is not None


class SqlTagStore:
    """``TagStore`` 的 Postgres 实现。"""

    def __init__(self, engine: AsyncEngine) -> None:
        self._engine = engine

    async def tree(self) -> tuple[TagNode, ...]:
        async with self._engine.connect() as conn:
            rows = (await conn.execute(_TREE)).mappings().all()
        return _build_tree(rows)

    @asynccontextmanager
    async def edit(self) -> AsyncGenerator[_SqlTagTreeWriter]:
        try:
            async with self._engine.begin() as conn:
                await conn.execute(_LOCK_TREE)
                yield _SqlTagTreeWriter(conn)
        except IntegrityError as exc:
            # 服务层已按树查过重名；走到这里是有人绕过了写锁直接改表。
            if _violated_constraint(exc) in _DUPLICATE_NAME_CONSTRAINTS:
                raise ValidationFailed("同一上级下已有同名标签") from exc
            raise

    async def counts(self) -> Mapping[uuid.UUID, TagCounts]:
        async with self._engine.connect() as conn:
            rows = (
                await conn.execute(
                    _COUNTS, {"reference": KIND_REFERENCE, "hit_case": KIND_HIT_CASE}
                )
            ).mappings()
            return {
                row["tag_id"]: TagCounts(
                    references=int(row["n_references"]), hit_cases=int(row["n_hit_cases"])
                )
                for row in rows
            }

    async def ensure(self, key: EntryKey, *, created_by: uuid.UUID | None) -> None:
        async with self._engine.begin() as conn:
            await conn.execute(
                _ENSURE[key.kind],
                {**_key_params(key), "id": uuid.uuid4(), "created_by": created_by},
            )

    async def mark_pending(self, key: EntryKey, *, created_by: uuid.UUID | None) -> uuid.UUID:
        async with self._engine.begin() as conn:
            entry_id = (
                await conn.execute(
                    _MARK_PENDING[key.kind],
                    {
                        **_key_params(key),
                        "id": uuid.uuid4(),
                        "created_by": created_by,
                        "pending": STATUS_PENDING,
                    },
                )
            ).scalar_one()
        return uuid.UUID(str(entry_id))

    async def request(self, key: EntryKey) -> uuid.UUID | None:
        async with self._engine.begin() as conn:
            entry_id = (
                await conn.execute(
                    _REQUEST[key.kind],
                    {**_key_params(key), "pending": STATUS_PENDING, "running": STATUS_RUNNING},
                )
            ).scalar_one_or_none()
        return entry_id

    async def abandon_pending(self, entry_id: uuid.UUID) -> None:
        async with self._engine.begin() as conn:
            abandoned = (
                await conn.execute(
                    _ABANDON,
                    {
                        "id": entry_id,
                        "failed": STATUS_FAILED,
                        "pending": STATUS_PENDING,
                        "error": ERROR_MODEL_CALL_FAILED,
                    },
                )
            ).first()
            if abandoned is not None:
                await _clear_ai(conn, [entry_id])

    async def replace(self, key: EntryKey, tag_ids: Collection[uuid.UUID]) -> bool:
        async with self._engine.begin() as conn:
            row = (await conn.execute(_LOCK_ENTRY[key.kind], _key_params(key))).mappings().first()
            if row is None:
                raise RuntimeError(f"条目 {key} 不存在；改标签前应已建好")
            if row["tag_status"] in BUSY_STATUSES:
                return False
            await conn.execute(_CLEAR_ALL, {"entry_id": row["id"]})
            await conn.execute(_INSERT_ANY, {"entry_id": row["id"], "tag_ids": list(tag_ids)})
        return True

    async def claim(self, entry_id: uuid.UUID) -> Claim | None:
        async with self._engine.begin() as conn:
            row = (
                (
                    await conn.execute(
                        _CLAIM,
                        {"id": entry_id, "running": STATUS_RUNNING, "pending": STATUS_PENDING},
                    )
                )
                .mappings()
                .first()
            )
        if row is None:
            return None
        return Claim(entry_id=row["id"], key=_key_of(row), started_at=row["tag_started_at"])

    async def finish(self, claim: Claim, tag_ids: Collection[uuid.UUID]) -> bool:
        async with self._engine.begin() as conn:
            finished = (
                await conn.execute(
                    _FINISH,
                    {
                        "id": claim.entry_id,
                        "started_at": claim.started_at,
                        "completed": STATUS_COMPLETED,
                        "running": STATUS_RUNNING,
                    },
                )
            ).first()
            if finished is None:
                return False
            await _clear_ai(conn, [claim.entry_id])
            await conn.execute(
                _INSERT_AI,
                {"entry_id": claim.entry_id, "tag_ids": list(tag_ids), "ai": AUTO_FILL_AI},
            )
        return True

    async def fail(self, claim: Claim, *, error_code: TagErrorCode) -> bool:
        async with self._engine.begin() as conn:
            failed = (
                await conn.execute(
                    _FAIL,
                    {
                        "id": claim.entry_id,
                        "started_at": claim.started_at,
                        "error": error_code,
                        "failed": STATUS_FAILED,
                        "running": STATUS_RUNNING,
                    },
                )
            ).first()
            if failed is None:
                return False
            await _clear_ai(conn, [claim.entry_id])
        return True

    async def time_out_stalled(self, *, older_than_seconds: int) -> int:
        async with self._engine.begin() as conn:
            ids = list(
                (
                    await conn.execute(
                        _TIME_OUT,
                        {
                            "seconds": float(older_than_seconds),
                            "failed": STATUS_FAILED,
                            "running": STATUS_RUNNING,
                        },
                    )
                ).scalars()
            )
            await _clear_ai(conn, ids)
        return len(ids)


def entry_join_sql(*, kind: EntryKind, subject_expr: str, alias: str = "le") -> str:
    """把来源行接上它的条目：``LEFT JOIN``，没有条目的行照样出来。``subject_expr`` 是来源行 id 的
    列表达式（如 ``r.id``），必须是代码里的常量。"""

    return (
        f"LEFT JOIN iclip.library_entries {alias}"
        f" ON {alias}.kind = '{kind}' AND {alias}.{_subject_column(kind)} = {subject_expr}"
    )


def entry_columns_sql(alias: str = "le") -> str:
    """配合 ``entry_join_sql`` 读出的三列：``tag_status``、``tag_error`` 与 ``tag_ids``（uuid 数组，
    按标签的 ``position``、id 排；没有条目时为空数组）。"""

    return (
        f"{alias}.tag_status, {alias}.tag_error,"
        " ARRAY(SELECT let.tag_id FROM iclip.library_entry_tags let"
        " JOIN iclip.library_tags lt ON lt.id = let.tag_id"
        f" WHERE let.entry_id = {alias}.id ORDER BY lt.position, lt.id) AS tag_ids"
    )


def entry_filter_sql(
    groups: Sequence[Sequence[uuid.UUID]],
    *,
    kind: EntryKind,
    subject_expr: str,
    param_prefix: str = "tag_group",
) -> tuple[str, dict[str, Any]]:
    """标签筛选：每组一个 ``EXISTS``，组间都要命中，组内命中任一即算。交回以 `` AND`` 开头的条件与
    它的绑定参数；没有组时是空串。``subject_expr`` 同 ``entry_join_sql``。"""

    clauses: list[str] = []
    params: dict[str, Any] = {}
    column = _subject_column(kind)
    for index, group in enumerate(groups):
        name = f"{param_prefix}_{index}"
        params[name] = list(group)
        clauses.append(
            "\n  AND EXISTS (SELECT 1 FROM iclip.library_entries fe"
            " JOIN iclip.library_entry_tags fet ON fet.entry_id = fe.id"
            f" WHERE fe.kind = '{kind}' AND fe.{column} = {subject_expr}"
            f" AND fet.tag_id = ANY(CAST(:{name} AS uuid[])))"
        )
    return "".join(clauses), params


__all__ = [
    "DB_SCHEMA",
    "SqlTagStore",
    "entry_columns_sql",
    "entry_filter_sql",
    "entry_join_sql",
    "library_entries_table",
    "library_entry_tags_table",
    "library_tags_table",
    "metadata_obj",
]
