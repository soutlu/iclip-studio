from __future__ import annotations

import uuid
from collections.abc import Collection, Mapping, Sequence
from dataclasses import asdict
from typing import Any, Final

from pydantic import BaseModel, ConfigDict
from sqlalchemy import (
    Column,
    DateTime,
    Index,
    Integer,
    MetaData,
    Table,
    Text,
    TextClause,
    Uuid,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.engine import RowMapping
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine

from iclip.domains.references.models import (
    AUDIO_KINDS,
    AUDIO_VOICE,
    FAST_ABOVE_BPM,
    KIND_AUDIO,
    KIND_VIDEO,
    SLOW_BELOW_BPM,
    STATUS_COMPLETED,
    STATUS_FAILED,
    STATUS_PENDING,
    STATUS_RUNNING,
    TEMPO_FAST,
    TEMPO_MEDIUM,
    TEMPO_SLOW,
    AudioKind,
    AudioScope,
    AudioText,
    AudioTraits,
    BgmGenre,
    BgmMood,
    BreakdownErrorCode,
    Claim,
    NewReferenceAudio,
    ReferenceAudio,
    ReferenceCursor,
    ReferenceVideo,
    Scope,
    SfxCategory,
    VoiceAge,
    VoiceGender,
    VoiceScenario,
)
from iclip.domains.tagging.public import (
    KIND_REFERENCE,
    entry_columns_sql,
    entry_filter_sql,
    entry_join_sql,
)

DB_SCHEMA: Final = "iclip"

metadata_obj = MetaData(schema=DB_SCHEMA)

# 三张表上都不设外键与取值约束：种类、子类、拆解状态等取值只在应用层校验（见 models）。
# 主表与子表一对一，按 reference_id 对上；列表与详情只认两边都有的。
references_table = Table(
    "references",
    metadata_obj,
    Column("id", Uuid, primary_key=True),
    Column("kind", Text, nullable=False),
    Column("title", Text, nullable=False, server_default=text("''")),
    Column("description", Text, nullable=True),
    Column("url", Text, nullable=False),
    Column("duration_ms", Integer, nullable=True),
    Column("owner_user_id", Uuid, nullable=False),
    Column("api_key_id", Uuid, nullable=True),
    Column("upload_id", Uuid, nullable=True),
    Column("source_job_id", Uuid, nullable=True),
    Column("created_at", DateTime(timezone=True), nullable=False, server_default=text("now()")),
    Column("updated_at", DateTime(timezone=True), nullable=False, server_default=text("now()")),
    Column("deleted_at", DateTime(timezone=True), nullable=True),
    Index(
        "ix_references_listed",
        "kind",
        text("created_at DESC"),
        "id",
        postgresql_where=text("deleted_at IS NULL"),
    ),
    Index(
        "ix_references_owner", "owner_user_id", "kind", postgresql_where=text("deleted_at IS NULL")
    ),
    Index("ix_references_url", "kind", "url"),
)

reference_videos_table = Table(
    "reference_videos",
    metadata_obj,
    Column("reference_id", Uuid, primary_key=True),
    Column("breakdown_status", Text, nullable=False),
    Column("error_code", Text, nullable=True),
    Column("document", Text, nullable=True),
    Column("version", Integer, nullable=False, server_default=text("1")),
    Column("requested_by", Uuid, nullable=True),
    Column("started_at", DateTime(timezone=True), nullable=True),
    Column("test_job_id", Uuid, nullable=True),
    Column("meta", JSONB, nullable=False, server_default=text("'{}'::jsonb")),
    Index(
        "ix_reference_videos_running",
        "started_at",
        postgresql_where=text("breakdown_status = 'running'"),
    ),
)

reference_audios_table = Table(
    "reference_audios",
    metadata_obj,
    Column("reference_id", Uuid, primary_key=True),
    Column("audio_kind", Text, nullable=False),
    Column("locale", Text, nullable=True),
    Column("transcript", Text, nullable=True),
    Column("meta", JSONB, nullable=False, server_default=text("'{}'::jsonb")),
    Index("ix_reference_audios_kind", "audio_kind", "reference_id"),
)


class _AudioMeta(BaseModel):
    """音频子表 ``meta`` 的形状：``AudioTraits`` 的各项属性加波形峰值。没有的键即没填（早先入库的是
    ``{}``）；多出的键、类型或取值不对直接报错。"""

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    gender: VoiceGender | None = None
    age: VoiceAge | None = None
    scenarios: tuple[VoiceScenario, ...] = ()
    mood: BgmMood | None = None
    genre: BgmGenre | None = None
    bpm: int | None = None
    sfx_category: SfxCategory | None = None
    peaks: tuple[float, ...] | None = None


# 同一个地址的参考视频按地址排队新建与恢复，代替唯一约束；两个键：命名空间与地址。
_LOCK_VIDEO_URL: Final = text(
    "SELECT pg_advisory_xact_lock(hashtext('iclip.references.video'), hashtext(:url))"
)

_VIDEO_ROW: Final = f"""
SELECT r.id, r.url AS video_url, r.owner_user_id, u.username AS owner_user_name,
       r.upload_id, r.source_job_id, v.breakdown_status, v.error_code, v.document, v.version,
       v.test_job_id, r.created_at, r.updated_at, r.deleted_at, {entry_columns_sql()}
FROM iclip.references r
JOIN iclip.reference_videos v ON v.reference_id = r.id
JOIN iclip.users u ON u.id = r.owner_user_id
{entry_join_sql(kind=KIND_REFERENCE, subject_expr="r.id")}"""

_VIDEO_BY_ID: Final = text(f"{_VIDEO_ROW}\nWHERE r.id = :id AND r.kind = '{KIND_VIDEO}'")

_VIDEO_ID_AT: Final = text(f"""
SELECT r.id FROM iclip.references r
JOIN iclip.reference_videos v ON v.reference_id = r.id
WHERE r.kind = '{KIND_VIDEO}' AND r.url = :url
ORDER BY r.created_at, r.id
LIMIT 1""")

_INSERT_REFERENCE: Final = text("""
INSERT INTO iclip.references
    (id, kind, title, description, url, duration_ms, owner_user_id, api_key_id, upload_id,
     source_job_id)
VALUES (:id, :kind, :title, :description, :url, :duration_ms, :owner, :api_key_id, :upload_id,
        :source_job_id)""")

_INSERT_VIDEO: Final = text("""
INSERT INTO iclip.reference_videos (reference_id, breakdown_status, requested_by)
VALUES (:id, :pending, :requested_by)""")

_RESTORE_VIDEO: Final = text(f"""
UPDATE iclip.references
SET deleted_at = NULL, owner_user_id = :owner, api_key_id = :api_key_id, upload_id = :upload_id,
    source_job_id = :source_job_id, updated_at = now()
WHERE id = :id AND kind = '{KIND_VIDEO}' AND deleted_at IS NOT NULL""")

_VIDEO_FILTER: Final = rf"""
WHERE r.kind = '{KIND_VIDEO}' AND r.deleted_at IS NULL
  AND (CAST(:user_name AS text) IS NULL OR u.username = CAST(:user_name AS text))
  AND (CAST(:pattern AS text) IS NULL OR v.document ILIKE CAST(:pattern AS text) ESCAPE '\')
  AND (CAST(:since AS timestamptz) IS NULL OR r.created_at >= CAST(:since AS timestamptz))
  AND (CAST(:until AS timestamptz) IS NULL OR r.created_at < CAST(:until AS timestamptz))"""

_PAGE: Final = """
  AND (CAST(:after_at AS timestamptz) IS NULL
       OR (r.created_at, r.id) < (CAST(:after_at AS timestamptz), CAST(:after_id AS uuid)))
ORDER BY r.created_at DESC, r.id DESC
LIMIT :limit"""


def _video_list_statement(tag_filter: str) -> TextClause:
    return text(f"{_VIDEO_ROW}{_VIDEO_FILTER}{tag_filter}{_PAGE}")


def _video_count_statement(tag_filter: str) -> TextClause:
    return text(f"""
SELECT count(*) FROM iclip.references r
JOIN iclip.reference_videos v ON v.reference_id = r.id
JOIN iclip.users u ON u.id = r.owner_user_id{_VIDEO_FILTER}{tag_filter}""")


def _owner_counts(child: str, kind: str) -> TextClause:
    return text(f"""
SELECT u.username, count(*) AS n
FROM iclip.references r
JOIN iclip.{child} c ON c.reference_id = r.id
JOIN iclip.users u ON u.id = r.owner_user_id
WHERE r.kind = '{kind}' AND r.deleted_at IS NULL
GROUP BY u.username
ORDER BY n DESC, u.username""")


_VIDEO_OWNER_COUNTS: Final = _owner_counts("reference_videos", KIND_VIDEO)


def _touching(update: str, returning: str) -> TextClause:
    """改视频子表的同一条语句里把主表的 ``updated_at`` 也改掉；``update`` 要 ``RETURNING`` 出
    ``reference_id``。"""

    return text(f"""
WITH changed AS ({update}),
touched AS (
    UPDATE iclip.references r SET updated_at = now()
    FROM changed c WHERE r.id = c.reference_id
)
SELECT {returning} FROM changed""")


_UPDATE_DOCUMENT: Final = _touching(
    """
    UPDATE iclip.reference_videos v
    SET document = :document, version = v.version + 1
    FROM iclip.references r
    WHERE v.reference_id = :id AND r.id = v.reference_id AND r.deleted_at IS NULL
      AND v.version = :version AND v.breakdown_status IN (:completed, :failed)
    RETURNING v.reference_id, v.version""",
    "version",
)

_REQUEUE: Final = _touching(
    """
    UPDATE iclip.reference_videos
    SET breakdown_status = :pending, requested_by = :requested_by
    WHERE reference_id = :id AND breakdown_status = ANY(CAST(:from_statuses AS text[]))
    RETURNING reference_id""",
    "reference_id",
)

_ABANDON: Final = _touching(
    """
    UPDATE iclip.reference_videos
    SET breakdown_status = :failed, error_code = 'model_call_failed'
    WHERE reference_id = :id AND breakdown_status = :pending
    RETURNING reference_id""",
    "reference_id",
)

_CLAIM: Final = _touching(
    """
    UPDATE iclip.reference_videos v
    SET breakdown_status = :running, started_at = now()
    FROM iclip.references r
    WHERE v.reference_id = :id AND r.id = v.reference_id AND v.breakdown_status = :pending
    RETURNING v.reference_id, r.url, r.owner_user_id, v.requested_by, v.started_at""",
    "reference_id, url, owner_user_id, requested_by, started_at",
)

_FINISH: Final = _touching(
    """
    UPDATE iclip.reference_videos
    SET breakdown_status = :completed, document = :document,
        error_code = NULL, version = version + 1
    WHERE reference_id = :id AND breakdown_status = :running AND started_at = :started_at
    RETURNING reference_id""",
    "reference_id",
)

_FAIL: Final = _touching(
    """
    UPDATE iclip.reference_videos
    SET breakdown_status = :failed, error_code = :error_code
    WHERE reference_id = :id AND breakdown_status = :running AND started_at = :started_at
    RETURNING reference_id""",
    "reference_id",
)

_TIME_OUT: Final = _touching(
    """
    UPDATE iclip.reference_videos
    SET breakdown_status = :failed, error_code = 'timeout'
    WHERE breakdown_status = :running
      AND started_at < now() - make_interval(secs => :seconds)
    RETURNING reference_id""",
    "reference_id",
)

_SET_TEST_JOB: Final = text("""
UPDATE iclip.reference_videos SET test_job_id = :job_id WHERE reference_id = :id""")


def _remove_statement(kind: str) -> TextClause:
    return text(f"""
UPDATE iclip.references
SET deleted_at = now(), updated_at = now()
WHERE id = :id AND kind = '{kind}' AND deleted_at IS NULL
RETURNING id""")


_REMOVE_VIDEO: Final = _remove_statement(KIND_VIDEO)
_REMOVE_AUDIO: Final = _remove_statement(KIND_AUDIO)

_AUDIO_ROW: Final = """
SELECT r.id, r.url, r.title, r.description, r.duration_ms, r.owner_user_id,
       u.username AS owner_user_name, r.upload_id, r.source_job_id, a.audio_kind, a.locale,
       a.transcript, CAST(a.meta AS text) AS meta, r.created_at, r.updated_at, r.deleted_at
FROM iclip.references r
JOIN iclip.reference_audios a ON a.reference_id = r.id
JOIN iclip.users u ON u.id = r.owner_user_id"""

_AUDIO_BY_ID: Final = text(f"{_AUDIO_ROW}\nWHERE r.id = :id AND r.kind = '{KIND_AUDIO}'")

_INSERT_AUDIO: Final = text("""
INSERT INTO iclip.reference_audios (reference_id, audio_kind, locale, transcript, meta)
VALUES (:id, :audio_kind, :locale, :transcript, CAST(:meta AS jsonb))""")

_BPM: Final = "CAST(a.meta->>'bpm' AS integer)"

# 每组筛选：参数为 NULL 不筛，否则命中组里任一即算；没设语种另由 :no_locale 表达。没填 bpm 的不落
# 在任何速度档里。
_AUDIO_FILTER: Final = rf"""
WHERE r.kind = '{KIND_AUDIO}' AND r.deleted_at IS NULL
  AND (CAST(:audio_kind AS text) IS NULL OR a.audio_kind = CAST(:audio_kind AS text))
  AND ((CAST(:locales AS text[]) IS NULL AND NOT CAST(:no_locale AS boolean))
       OR a.locale = ANY(CAST(:locales AS text[]))
       OR (CAST(:no_locale AS boolean) AND a.locale IS NULL))
  AND (CAST(:genders AS text[]) IS NULL OR a.meta->>'gender' = ANY(CAST(:genders AS text[])))
  AND (CAST(:ages AS text[]) IS NULL OR a.meta->>'age' = ANY(CAST(:ages AS text[])))
  AND (CAST(:scenarios AS text[]) IS NULL
       OR jsonb_exists_any(a.meta->'scenarios', CAST(:scenarios AS text[])))
  AND (CAST(:moods AS text[]) IS NULL OR a.meta->>'mood' = ANY(CAST(:moods AS text[])))
  AND (CAST(:genres AS text[]) IS NULL OR a.meta->>'genre' = ANY(CAST(:genres AS text[])))
  AND (CAST(:tempos AS text[]) IS NULL
       OR ('{TEMPO_SLOW}' = ANY(CAST(:tempos AS text[])) AND {_BPM} < {SLOW_BELOW_BPM})
       OR ('{TEMPO_MEDIUM}' = ANY(CAST(:tempos AS text[]))
           AND {_BPM} BETWEEN {SLOW_BELOW_BPM} AND {FAST_ABOVE_BPM})
       OR ('{TEMPO_FAST}' = ANY(CAST(:tempos AS text[])) AND {_BPM} > {FAST_ABOVE_BPM}))
  AND (CAST(:sfx_categories AS text[]) IS NULL
       OR a.meta->>'sfx_category' = ANY(CAST(:sfx_categories AS text[])))
  AND (CAST(:user_name AS text) IS NULL OR u.username = CAST(:user_name AS text))
  AND (CAST(:pattern AS text) IS NULL
       OR r.title ILIKE CAST(:pattern AS text) ESCAPE '\'
       OR r.description ILIKE CAST(:pattern AS text) ESCAPE '\'
       OR a.transcript ILIKE CAST(:pattern AS text) ESCAPE '\')
  AND (CAST(:since AS timestamptz) IS NULL OR r.created_at >= CAST(:since AS timestamptz))
  AND (CAST(:until AS timestamptz) IS NULL OR r.created_at < CAST(:until AS timestamptz))"""

_AUDIO_LIST: Final = text(f"{_AUDIO_ROW}{_AUDIO_FILTER}{_PAGE}")

_AUDIO_COUNT: Final = text(f"""
SELECT count(*) FROM iclip.references r
JOIN iclip.reference_audios a ON a.reference_id = r.id
JOIN iclip.users u ON u.id = r.owner_user_id{_AUDIO_FILTER}""")

_AUDIO_KIND_COUNTS: Final = text(f"""
SELECT a.audio_kind, count(*) AS n
FROM iclip.references r
JOIN iclip.reference_audios a ON a.reference_id = r.id
WHERE r.kind = '{KIND_AUDIO}' AND r.deleted_at IS NULL
GROUP BY a.audio_kind""")

_AUDIO_OWNER_COUNTS: Final = _owner_counts("reference_audios", KIND_AUDIO)

_UPDATE_AUDIO_MAIN: Final = text(f"""
UPDATE iclip.references
SET title = :title, description = :description, updated_at = now()
WHERE id = :id AND kind = '{KIND_AUDIO}' AND deleted_at IS NULL
RETURNING id""")

# 属性整组写进 meta（没填的写 null），波形峰值留着不动。
_UPDATE_AUDIO_CHILD: Final = text("""
UPDATE iclip.reference_audios
SET locale = :locale, transcript = :transcript, meta = meta || CAST(:traits AS jsonb)
WHERE reference_id = :id""")

_LISTED_IDS: Final = text(f"""
SELECT r.id FROM iclip.references r
LEFT JOIN iclip.reference_videos v ON v.reference_id = r.id
LEFT JOIN iclip.reference_audios a ON a.reference_id = r.id
WHERE r.id = ANY(CAST(:ids AS uuid[])) AND r.deleted_at IS NULL
  AND ((r.kind = '{KIND_VIDEO}' AND v.reference_id IS NOT NULL)
       OR (r.kind = '{KIND_AUDIO}' AND a.reference_id IS NOT NULL))""")

_VOICE: Final = text(f"""
SELECT r.url, a.transcript FROM iclip.references r
JOIN iclip.reference_audios a ON a.reference_id = r.id
WHERE r.id = :id AND r.kind = '{KIND_AUDIO}' AND r.deleted_at IS NULL
  AND a.audio_kind = '{AUDIO_VOICE}'""")

_AUDIO_IDS_AT: Final = text(f"""
SELECT DISTINCT ON (r.url) r.url, r.id FROM iclip.references r
JOIN iclip.reference_audios a ON a.reference_id = r.id
WHERE r.kind = '{KIND_AUDIO}' AND r.url = ANY(CAST(:urls AS text[])) AND r.deleted_at IS NULL
ORDER BY r.url, r.created_at, r.id""")


def _video_of(row: RowMapping) -> ReferenceVideo:
    return ReferenceVideo(
        id=row["id"],
        video_url=row["video_url"],
        owner_user_id=row["owner_user_id"],
        owner_user_name=row["owner_user_name"],
        upload_id=row["upload_id"],
        source_job_id=row["source_job_id"],
        tag_ids=tuple(row["tag_ids"]),
        tag_status=row["tag_status"],
        tag_error=row["tag_error"],
        breakdown_status=row["breakdown_status"],
        error_code=row["error_code"],
        document=row["document"],
        version=row["version"],
        test_job_id=row["test_job_id"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
        deleted_at=row["deleted_at"],
    )


def _audio_of(row: RowMapping) -> ReferenceAudio:
    meta = _AudioMeta.model_validate_json(row["meta"])
    return ReferenceAudio(
        id=row["id"],
        url=row["url"],
        title=row["title"],
        description=row["description"],
        duration_ms=row["duration_ms"],
        owner_user_id=row["owner_user_id"],
        owner_user_name=row["owner_user_name"],
        upload_id=row["upload_id"],
        source_job_id=row["source_job_id"],
        audio_kind=row["audio_kind"],
        locale=row["locale"],
        transcript=row["transcript"],
        traits=AudioTraits(**meta.model_dump(exclude={"peaks"})),
        peaks=meta.peaks,
        created_at=row["created_at"],
        updated_at=row["updated_at"],
        deleted_at=row["deleted_at"],
    )


def _meta_json(traits: AudioTraits, *, peaks: tuple[float, ...] | None = None) -> str:
    """``traits`` 连同 ``peaks`` 写成 ``meta`` 的 JSON；不给 ``peaks`` 时不带这个键。"""

    meta = _AudioMeta(**asdict(traits), peaks=peaks)
    return meta.model_dump_json(exclude=None if peaks is not None else {"peaks"})


def _text_array(values: Sequence[str]) -> list[str] | None:
    return list(values) or None


def _like_pattern(q: str | None) -> str | None:
    if q is None:
        return None
    escaped = q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


def _page_params(after: ReferenceCursor | None, limit: int) -> dict[str, Any]:
    return {
        "after_at": after.at if after else None,
        "after_id": after.reference_id if after else None,
        "limit": limit,
    }


def _video_scope_params(scope: Scope) -> dict[str, Any]:
    return {
        "user_name": scope.user_name,
        "pattern": _like_pattern(scope.q),
        "since": scope.since,
        "until": scope.until,
    }


def _audio_scope_params(scope: AudioScope) -> dict[str, Any]:
    return {
        "audio_kind": scope.audio_kind,
        "locales": _text_array([locale for locale in scope.locales if locale is not None]),
        "no_locale": None in scope.locales,
        "genders": _text_array(scope.genders),
        "ages": _text_array(scope.ages),
        "scenarios": _text_array(scope.scenarios),
        "moods": _text_array(scope.moods),
        "genres": _text_array(scope.genres),
        "tempos": _text_array(scope.tempos),
        "sfx_categories": _text_array(scope.sfx_categories),
        "user_name": scope.user_name,
        "pattern": _like_pattern(scope.q),
        "since": scope.since,
        "until": scope.until,
    }


def _tag_filter(scope: Scope) -> tuple[str, dict[str, Any]]:
    return entry_filter_sql(scope.tag_groups, kind=KIND_REFERENCE, subject_expr="r.id")


async def _one(conn: AsyncConnection, statement: Any, params: Mapping[str, Any]) -> RowMapping:
    row = (await conn.execute(statement, dict(params))).mappings().first()
    if row is None:
        raise RuntimeError("刚写下或刚认出的参考资产读不回来")
    return row


class SqlReferenceStore:
    """参考视频的读写。"""

    def __init__(self, engine: AsyncEngine) -> None:
        self._engine = engine

    async def ensure_row(
        self,
        video_url: str,
        *,
        owner: uuid.UUID,
        requested_by: uuid.UUID,
        api_key_id: uuid.UUID | None,
        upload_id: uuid.UUID | None = None,
        source_job_id: uuid.UUID | None = None,
        restore: bool,
    ) -> tuple[ReferenceVideo, bool]:
        lineage = {
            "owner": owner,
            "api_key_id": api_key_id,
            "upload_id": upload_id,
            "source_job_id": source_job_id,
        }
        async with self._engine.begin() as conn:
            await conn.execute(_LOCK_VIDEO_URL, {"url": video_url})
            found = (await conn.execute(_VIDEO_ID_AT, {"url": video_url})).scalar_one_or_none()
            reference_id = found if found is not None else uuid.uuid4()
            if found is None:
                await conn.execute(
                    _INSERT_REFERENCE,
                    {
                        **lineage,
                        "id": reference_id,
                        "kind": KIND_VIDEO,
                        "title": "",
                        "description": None,
                        "url": video_url,
                        "duration_ms": None,
                    },
                )
                await conn.execute(
                    _INSERT_VIDEO,
                    {"id": reference_id, "pending": STATUS_PENDING, "requested_by": requested_by},
                )
            elif restore:
                await conn.execute(_RESTORE_VIDEO, {**lineage, "id": reference_id})
            row = await _one(conn, _VIDEO_BY_ID, {"id": reference_id})
        return _video_of(row), found is None

    async def get(self, reference_id: uuid.UUID) -> ReferenceVideo | None:
        async with self._engine.connect() as conn:
            row = (await conn.execute(_VIDEO_BY_ID, {"id": reference_id})).mappings().first()
        return None if row is None else _video_of(row)

    async def list(
        self, scope: Scope, *, limit: int, after: ReferenceCursor | None
    ) -> Sequence[ReferenceVideo]:
        tag_filter, tag_params = _tag_filter(scope)
        params = {**_video_scope_params(scope), **tag_params, **_page_params(after, limit)}
        async with self._engine.connect() as conn:
            rows = (await conn.execute(_video_list_statement(tag_filter), params)).mappings().all()
        return [_video_of(row) for row in rows]

    async def count(self, scope: Scope) -> int:
        tag_filter, tag_params = _tag_filter(scope)
        params = {**_video_scope_params(scope), **tag_params}
        async with self._engine.connect() as conn:
            return int(
                (await conn.execute(_video_count_statement(tag_filter), params)).scalar_one()
            )

    async def owner_counts(self) -> Sequence[tuple[str, int]]:
        async with self._engine.connect() as conn:
            rows = await conn.execute(_VIDEO_OWNER_COUNTS)
            return [(str(row[0]), int(row[1])) for row in rows]

    async def update(
        self,
        reference_id: uuid.UUID,
        *,
        version: int,
        document: str,
    ) -> int | None:
        async with self._engine.begin() as conn:
            row = (
                await conn.execute(
                    _UPDATE_DOCUMENT,
                    {
                        "id": reference_id,
                        "version": version,
                        "document": document,
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
        return Claim(
            id=row["reference_id"],
            video_url=row["url"],
            owner_user_id=row["owner_user_id"],
            requested_by=row["requested_by"],
            started_at=row["started_at"],
        )

    async def finish(self, claim: Claim, *, document: str) -> bool:
        async with self._engine.begin() as conn:
            row = (
                await conn.execute(
                    _FINISH,
                    {
                        "id": claim.id,
                        "started_at": claim.started_at,
                        "document": document,
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

    async def set_test_job(self, reference_id: uuid.UUID, job_id: uuid.UUID) -> None:
        async with self._engine.begin() as conn:
            await conn.execute(_SET_TEST_JOB, {"id": reference_id, "job_id": job_id})

    async def remove(self, reference_id: uuid.UUID) -> bool:
        async with self._engine.begin() as conn:
            row = (await conn.execute(_REMOVE_VIDEO, {"id": reference_id})).first()
        return row is not None


class SqlReferenceAudioStore:
    """参考音频的读写。"""

    def __init__(self, engine: AsyncEngine) -> None:
        self._engine = engine

    async def insert(self, audio: NewReferenceAudio) -> ReferenceAudio:
        reference_id = uuid.uuid4()
        async with self._engine.begin() as conn:
            await conn.execute(
                _INSERT_REFERENCE,
                {
                    "id": reference_id,
                    "kind": KIND_AUDIO,
                    "title": audio.title,
                    "description": audio.description,
                    "url": audio.url,
                    "duration_ms": audio.duration_ms,
                    "owner": audio.owner_user_id,
                    "api_key_id": audio.api_key_id,
                    "upload_id": audio.upload_id,
                    "source_job_id": audio.source_job_id,
                },
            )
            await conn.execute(
                _INSERT_AUDIO,
                {
                    "id": reference_id,
                    "audio_kind": audio.audio_kind,
                    "locale": audio.locale,
                    "transcript": audio.transcript,
                    "meta": _meta_json(audio.traits, peaks=audio.peaks),
                },
            )
            row = await _one(conn, _AUDIO_BY_ID, {"id": reference_id})
        return _audio_of(row)

    async def get(self, reference_id: uuid.UUID) -> ReferenceAudio | None:
        async with self._engine.connect() as conn:
            row = (await conn.execute(_AUDIO_BY_ID, {"id": reference_id})).mappings().first()
        return None if row is None else _audio_of(row)

    async def list(
        self, scope: AudioScope, *, limit: int, after: ReferenceCursor | None
    ) -> Sequence[ReferenceAudio]:
        params = {**_audio_scope_params(scope), **_page_params(after, limit)}
        async with self._engine.connect() as conn:
            rows = (await conn.execute(_AUDIO_LIST, params)).mappings().all()
        return [_audio_of(row) for row in rows]

    async def count(self, scope: AudioScope) -> int:
        async with self._engine.connect() as conn:
            return int((await conn.execute(_AUDIO_COUNT, _audio_scope_params(scope))).scalar_one())

    async def kind_counts(self) -> Sequence[tuple[AudioKind, int]]:
        async with self._engine.connect() as conn:
            counted = {str(row[0]): int(row[1]) for row in await conn.execute(_AUDIO_KIND_COUNTS)}
        return [(kind, counted.get(kind, 0)) for kind in AUDIO_KINDS]

    async def owner_counts(self) -> Sequence[tuple[str, int]]:
        async with self._engine.connect() as conn:
            rows = await conn.execute(_AUDIO_OWNER_COUNTS)
            return [(str(row[0]), int(row[1])) for row in rows]

    async def update(self, reference_id: uuid.UUID, text: AudioText) -> bool:
        async with self._engine.begin() as conn:
            updated = (
                await conn.execute(
                    _UPDATE_AUDIO_MAIN,
                    {"id": reference_id, "title": text.title, "description": text.description},
                )
            ).first()
            if updated is None:
                return False
            await conn.execute(
                _UPDATE_AUDIO_CHILD,
                {
                    "id": reference_id,
                    "locale": text.locale,
                    "transcript": text.transcript,
                    "traits": _meta_json(text.traits),
                },
            )
        return True

    async def remove(self, reference_id: uuid.UUID) -> bool:
        async with self._engine.begin() as conn:
            row = (await conn.execute(_REMOVE_AUDIO, {"id": reference_id})).first()
        return row is not None


class SqlReferenceLookup:
    """按地址或 id 核对参考资产，供生成与成片导出用。"""

    def __init__(self, engine: AsyncEngine) -> None:
        self._engine = engine

    async def unlisted(self, reference_ids: Sequence[uuid.UUID]) -> tuple[uuid.UUID, ...]:
        """``reference_ids`` 里不在资料库、或已经移除的那些，按原顺序。"""

        if not reference_ids:
            return ()
        async with self._engine.connect() as conn:
            listed = {
                row[0] for row in await conn.execute(_LISTED_IDS, {"ids": list(reference_ids)})
            }
        return tuple(one for one in dict.fromkeys(reference_ids) if one not in listed)

    async def voice(self, reference_id: uuid.UUID) -> tuple[str, str | None] | None:
        """一条没移除的音色的地址与台词；不存在、移除了或不是音色时为 None。"""

        async with self._engine.connect() as conn:
            row = (await conn.execute(_VOICE, {"id": reference_id})).first()
        return None if row is None else (str(row[0]), row[1])

    async def audio_ids_at(self, urls: Collection[str]) -> Mapping[str, uuid.UUID]:
        """每个地址对上的最早一条没移除的参考音频；对不上的地址不在答复里。"""

        if not urls:
            return {}
        async with self._engine.connect() as conn:
            rows = await conn.execute(_AUDIO_IDS_AT, {"urls": list(urls)})
            return {str(row[0]): row[1] for row in rows}


__all__ = [
    "DB_SCHEMA",
    "SqlReferenceAudioStore",
    "SqlReferenceLookup",
    "SqlReferenceStore",
    "metadata_obj",
    "reference_audios_table",
    "reference_videos_table",
    "references_table",
]
