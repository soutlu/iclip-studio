from __future__ import annotations

import uuid
from collections.abc import Sequence
from typing import Any, Final

from iclip_video.shot_prompt import parse_shot_prompt
from pydantic import BaseModel, ConfigDict, Field, TypeAdapter
from sqlalchemy import TextClause, text
from sqlalchemy.engine import RowMapping
from sqlalchemy.ext.asyncio import AsyncEngine

from iclip.domains.library.models import (
    HitCaseScope,
    MaterialSource,
    Scope,
    VideoCursor,
    WholeFilmScope,
)
from iclip.domains.library.repository import CardRow, WholeFilmCardRow
from iclip.domains.library.schemas import (
    FaceOut,
    HitCaseEntryOut,
    HitCaseOut,
    LibraryAuthorOut,
    LibraryVideoOut,
    ScriptCutOut,
    ScriptOut,
    ShotGroupOut,
    TakeOut,
    VersionOut,
    WholeFilmCardOut,
    WholeFilmVersionOut,
)
from iclip.domains.tagging.public import (
    KIND_HIT_CASE,
    entry_columns_sql,
    entry_filter_sql,
    entry_join_sql,
)

_COMPOSE: Final = "compose"

_INDEXED_MASTER: Final = """g.kind = 'video' AND g.status = 'completed' AND (g.output ->> 'url') IS NOT NULL
      AND ((g.operation = 'generate' AND g.source_job_id IS NULL) OR g.operation = 'compose')"""
"""与 ``ix_generation_jobs_masters`` 的部分索引条件同式：只用它的查询才能走仅索引扫描。"""

_MASTER: Final = (
    _INDEXED_MASTER
    + """
      AND NOT (coalesce(g.metadata, '{}') ? 'referenceId')"""
)

_OUTPUT_COLUMNS: Final = """(g.output ->> 'url') AS output_url,
           (g.output ->> 'watermark_url') AS watermark_output_url,
           (g.output ->> 'duration_ms')::int AS duration_ms"""

_JOB_COLUMNS: Final = f"""g.id, g.operation, g.shot_index, g.root_job_id, {_OUTPUT_COLUMNS},
           g.finished_at, g.owner_user_id"""

_FACE_COLUMNS: Final = f"""g.id, g.operation, {_OUTPUT_COLUMNS}, g.finished_at, g.owner_user_id,
           COALESCE(g.root_job_id, g.id) AS take_id"""


def _unattached_masters_of(card: str) -> str:
    return f"""(g.root_job_id = {card} OR (g.id = {card} AND g.root_job_id IS NULL))
      AND {_MASTER}
      AND NOT EXISTS (SELECT 1 FROM iclip.conversations c WHERE c.id = g.conversation_id)"""


_DANGLING: Final = f"""
master_conversations AS (
    (SELECT g.conversation_id AS id
     FROM iclip.generation_jobs g
     WHERE g.conversation_id IS NOT NULL AND {_INDEXED_MASTER}
     ORDER BY g.conversation_id
     LIMIT 1)
    UNION ALL
    SELECT (SELECT g.conversation_id
            FROM iclip.generation_jobs g
            WHERE g.conversation_id > m.id AND {_INDEXED_MASTER}
            ORDER BY g.conversation_id
            LIMIT 1)
    FROM master_conversations m
    WHERE m.id IS NOT NULL
),
dangling AS (
    SELECT m.id
    FROM master_conversations m
    WHERE m.id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM iclip.conversations c WHERE c.id = m.id)
)"""

_ALL_UNATTACHED_MASTERS: Final = f"""
    SELECT {_FACE_COLUMNS}
    FROM iclip.generation_jobs g
    WHERE g.conversation_id IS NULL AND {_MASTER}
    UNION ALL
    SELECT {_FACE_COLUMNS}
    FROM dangling d
    JOIN iclip.generation_jobs g ON g.conversation_id = d.id
    WHERE {_MASTER}"""

_UNATTACHED_MASTERS_OF_CARD: Final = f"""
    SELECT {_FACE_COLUMNS}
    FROM iclip.generation_jobs g
    WHERE {_unattached_masters_of("CAST(:card_id AS uuid)")}"""


def _faces(conversation_scope: str, unattached_masters: str) -> str:
    return f"""
faces AS (
    SELECT cv.id AS card_id, cv.id AS conversation_id, cv.title, cv.agent_id, cv.task_id,
           cv.owner_user_id AS conversation_owner,
           cv.deleted_at IS NOT NULL AS conversation_deleted,
           au.username AS user_name, f.*
    FROM iclip.conversations cv
    JOIN iclip.users au ON au.id = cv.owner_user_id
    CROSS JOIN LATERAL (
        SELECT {_FACE_COLUMNS}
        FROM iclip.generation_jobs g
        WHERE g.conversation_id = cv.id AND {_MASTER}
        ORDER BY g.finished_at DESC, g.id DESC
        LIMIT 1
    ) f{conversation_scope}
    UNION ALL
    SELECT o.take_id, CAST(NULL AS uuid), CAST(NULL AS text), CAST(NULL AS text),
           CAST(NULL AS uuid), CAST(NULL AS uuid), false, au.username, o.*
    FROM (
        SELECT DISTINCT ON (m.take_id) m.*
        FROM ({unattached_masters}
        ) m
        ORDER BY m.take_id, m.finished_at DESC, m.id DESC
    ) o
    JOIN iclip.generation_jobs t ON t.id = o.take_id
    JOIN iclip.users au ON au.id = t.owner_user_id
)"""


_ALL_FACES: Final = (_DANGLING, _faces("", _ALL_UNATTACHED_MASTERS))

_FACES_OF_CARD: Final = _faces(
    "\n    WHERE cv.id = CAST(:card_id AS uuid)", _UNATTACHED_MASTERS_OF_CARD
)

_ORIENTATION: Final = r"""CASE WHEN t.request->>'aspect_ratio' ~ '^[0-9]+(\.[0-9]+)?:[0-9]+(\.[0-9]+)?$' THEN
               CASE sign(split_part(t.request->>'aspect_ratio', ':', 1)::numeric
                         - split_part(t.request->>'aspect_ratio', ':', 2)::numeric)
                   WHEN 1 THEN 'landscape' WHEN -1 THEN 'portrait' ELSE 'square' END
           END"""

_FACE_FILTER: Final = """
WHERE (CAST(:user_name AS text) IS NULL OR f.user_name = CAST(:user_name AS text))
  AND (CAST(:since AS timestamptz) IS NULL OR f.finished_at >= CAST(:since AS timestamptz))
  AND (CAST(:until AS timestamptz) IS NULL OR f.finished_at < CAST(:until AS timestamptz))"""

_CANDIDATES: Final = "\nFROM faces f" + _FACE_FILTER

_NARROWED_CANDIDATES: Final = (
    """
FROM faces f
JOIN iclip.generation_jobs t ON t.id = f.take_id"""
    + _FACE_FILTER
    + rf"""
  AND (CAST(:orientation AS text) IS NULL OR ({_ORIENTATION}) = CAST(:orientation AS text))
  AND (CAST(:pattern AS text) IS NULL
       OR t.request->>'prompt' ILIKE CAST(:pattern AS text) ESCAPE '\'
       OR f.title ILIKE CAST(:pattern AS text) ESCAPE '\')"""
)


def _page(candidates: str) -> str:
    return f"""
page AS (
    SELECT f.*{candidates}
      AND (CAST(:after_at AS timestamptz) IS NULL
           OR (f.finished_at, f.card_id)
              < (CAST(:after_at AS timestamptz), CAST(:after_id AS uuid)))
    ORDER BY f.finished_at DESC, f.card_id DESC
    LIMIT :limit
)"""


def _cards(source: str) -> str:
    return f"""
cards AS (
    SELECT s.card_id AS id, s.conversation_id,
           s.id AS face_id, s.operation AS face_operation, s.output_url AS face_output_url,
           s.watermark_output_url AS face_watermark_output_url,
           s.duration_ms AS face_duration_ms, s.finished_at AS face_finished_at,
           fu.username AS face_user_name,
           t.id AS take_id, t.request AS take_request,
           s.title, s.agent_id, s.task_id, s.conversation_owner, s.conversation_deleted,
           s.user_name
    FROM {source} s
    JOIN iclip.generation_jobs t ON t.id = s.take_id
    JOIN iclip.users fu ON fu.id = s.owner_user_id
)"""


_SEEDS_OF_PAGE: Final = """
seeds AS (SELECT p.card_id AS id FROM page p)"""

_SEEDS_OF_CARD: Final = """
seeds AS (SELECT f.card_id AS id FROM faces f)"""

_LINEAGE: Final = """
lineage AS (
    SELECT c.id AS card_id, c.id AS conversation_id, c.forked_from, c.created_at,
           CAST(NULL AS timestamptz) AS boundary
    FROM seeds s
    JOIN iclip.conversations c ON c.id = s.id
    UNION ALL
    SELECT l.card_id, p.id, p.forked_from, p.created_at, l.created_at
    FROM lineage l
    JOIN iclip.conversations p ON p.id = l.forked_from
)"""

# OFFSET 0 不让规划器把子查询拉平：递归 CTE 的行数按十倍估，拉平后会改用哈希连接扫全部素材片。
_VISIBLE: Final = f"""
visible AS (
    SELECT l.card_id, o.*
    FROM lineage l
    CROSS JOIN LATERAL (
        SELECT {_JOB_COLUMNS}
        FROM iclip.generation_jobs g
        WHERE g.conversation_id = l.conversation_id AND {_MASTER}
          AND (l.boundary IS NULL OR (g.status = 'completed' AND g.finished_at <= l.boundary))
        OFFSET 0
    ) o
    UNION ALL
    SELECT s.id, {_JOB_COLUMNS}
    FROM seeds s
    JOIN iclip.generation_jobs g ON {_unattached_masters_of("s.id")}
)"""

_FILL: Final = """
fill AS (
    SELECT v.card_id, count(*) AS version_count,
           count(DISTINCT COALESCE('#' || v.shot_index::text,
                                   COALESCE(v.root_job_id, v.id)::text)) AS group_count
    FROM visible v
    GROUP BY v.card_id
)"""


def _statement(ctes: Sequence[str], body: str) -> TextClause:
    return text("WITH RECURSIVE" + ",".join(ctes) + "\n" + body)


_LINEAGE_CTES: Final = (_LINEAGE, _VISIBLE)


def _videos_statement(candidates: str) -> TextClause:
    return _statement(
        (
            *_ALL_FACES,
            _page(candidates),
            _cards("page"),
            _SEEDS_OF_PAGE,
            *_LINEAGE_CTES,
            _FILL,
        ),
        """SELECT c.*, f.group_count, f.version_count
FROM cards c
JOIN fill f ON f.card_id = c.id
ORDER BY c.face_finished_at DESC, c.id DESC""",
    )


_VIDEOS: Final = _videos_statement(_CANDIDATES)
_NARROWED_VIDEOS: Final = _videos_statement(_NARROWED_CANDIDATES)

_COUNT: Final = _statement(_ALL_FACES, "SELECT count(*) AS n" + _CANDIDATES)
_NARROWED_COUNT: Final = _statement(_ALL_FACES, "SELECT count(*) AS n" + _NARROWED_CANDIDATES)

_CARD_OF: Final = _statement(
    (_FACES_OF_CARD, _cards("faces"), _SEEDS_OF_CARD, *_LINEAGE_CTES, _FILL),
    """SELECT c.*, f.group_count, f.version_count
FROM cards c
JOIN fill f ON f.card_id = c.id""",
)

_VERSIONS: Final = _statement(
    (_FACES_OF_CARD, _SEEDS_OF_CARD, *_LINEAGE_CTES),
    """SELECT v.id, v.operation, v.shot_index, v.output_url, v.watermark_output_url,
       v.duration_ms, v.finished_at, u.username AS user_name,
       t.id AS take_id, t.request AS take_request
FROM visible v
JOIN iclip.generation_jobs t ON t.id = COALESCE(v.root_job_id, v.id)
JOIN iclip.users u ON u.id = v.owner_user_id
ORDER BY v.finished_at, v.id""",
)

_AUTHORS: Final = _statement(
    _ALL_FACES,
    """SELECT f.user_name, count(*) AS n FROM faces f
WHERE f.user_name IS NOT NULL
GROUP BY f.user_name
ORDER BY n DESC, f.user_name""",
)

_WHOLE_FILM: Final = """g.kind = 'whole_film' AND g.status = 'completed'
      AND (g.output ->> 'url') IS NOT NULL"""

_FILM_CARDS: Final = f"""
WITH film_cards AS (
    SELECT c.id, c.title, c.owner_user_id AS conversation_owner,
           c.deleted_at IS NOT NULL AS conversation_deleted,
           u.username AS user_name, max(g.finished_at) AS face_finished_at
    FROM iclip.generation_jobs g
    JOIN iclip.conversations c ON c.id = g.conversation_id
    JOIN iclip.users u ON u.id = c.owner_user_id
    WHERE {_WHOLE_FILM}
    GROUP BY c.id, u.id
)"""

_FILM_FILTER: Final = r"""
WHERE (CAST(:user_name AS text) IS NULL OR f.user_name = CAST(:user_name AS text))
  AND (CAST(:since AS timestamptz) IS NULL OR f.face_finished_at >= CAST(:since AS timestamptz))
  AND (CAST(:until AS timestamptz) IS NULL OR f.face_finished_at < CAST(:until AS timestamptz))
  AND (CAST(:pattern AS text) IS NULL OR f.title ILIKE CAST(:pattern AS text) ESCAPE '\')"""

_WHOLE_FILMS: Final = text(
    _FILM_CARDS
    + f""",
page AS (
    SELECT f.* FROM film_cards f{_FILM_FILTER}
      AND (CAST(:after_at AS timestamptz) IS NULL
           OR (f.face_finished_at, f.id)
              < (CAST(:after_at AS timestamptz), CAST(:after_id AS uuid)))
    ORDER BY f.face_finished_at DESC, f.id DESC
    LIMIT :limit
)
SELECT p.id AS conversation_id, p.title, p.conversation_owner, p.conversation_deleted,
       p.user_name, g.id AS job_id, (g.output ->> 'url') AS output_url, g.finished_at,
       vu.username AS version_user_name, g.request->'videos' AS sources
FROM page p
JOIN iclip.generation_jobs g ON g.conversation_id = p.id
JOIN iclip.users vu ON vu.id = g.owner_user_id
WHERE {_WHOLE_FILM}
ORDER BY p.face_finished_at DESC, p.id DESC, g.finished_at, g.id"""
)

_COUNT_WHOLE_FILMS: Final = text(
    _FILM_CARDS + "\nSELECT count(*) AS n FROM film_cards f" + _FILM_FILTER
)

_WHOLE_FILM_AUTHORS: Final = text(
    _FILM_CARDS
    + """
SELECT f.user_name, count(*) AS n FROM film_cards f
WHERE f.user_name IS NOT NULL
GROUP BY f.user_name
ORDER BY n DESC, f.user_name"""
)


_MATERIAL_OF: Final = text(f"""
SELECT g.id, COALESCE(({_MASTER}), false) AS is_material,
       c.id AS conversation_id, c.owner_user_id AS conversation_owner
FROM iclip.generation_jobs g
LEFT JOIN iclip.conversations c ON c.id = g.conversation_id
WHERE g.id = :job_id""")

_HIT_CASE_ENTRY: Final = text(f"""
SELECT le.created_at AS added_at, au.username AS added_by, {entry_columns_sql()}
FROM iclip.generation_jobs g
{entry_join_sql(kind=KIND_HIT_CASE, subject_expr="g.id")}
LEFT JOIN iclip.users au ON au.id = le.created_by
WHERE g.id = :job_id AND le.id IS NOT NULL""")

_HIT_CASES_FROM: Final = f"""
FROM iclip.generation_jobs g
{entry_join_sql(kind=KIND_HIT_CASE, subject_expr="g.id")}
JOIN iclip.generation_jobs t ON t.id = COALESCE(g.root_job_id, g.id)
JOIN iclip.users u ON u.id = g.owner_user_id
LEFT JOIN iclip.conversations c ON c.id = g.conversation_id
WHERE le.id IS NOT NULL AND {_MASTER}"""
"""在库的爆款素材：有条目、仍是素材片；卡 id 的算法同素材卡。"""

_HIT_CASES_FILTER: Final = """
  AND (CAST(:user_name AS text) IS NULL OR u.username = CAST(:user_name AS text))
  AND (CAST(:since AS timestamptz) IS NULL OR le.created_at >= CAST(:since AS timestamptz))
  AND (CAST(:until AS timestamptz) IS NULL OR le.created_at < CAST(:until AS timestamptz))"""

_HIT_CASE_AUTHORS: Final = text(f"""
SELECT u.username AS user_name, count(*) AS n{_HIT_CASES_FROM}
  AND u.username IS NOT NULL
GROUP BY u.username
ORDER BY n DESC, u.username""")


def _hit_cases_statement(scope_filter: str) -> TextClause:
    return text(f"""
SELECT g.id, g.operation, {_OUTPUT_COLUMNS}, g.finished_at,
       u.username AS user_name, COALESCE(c.id, g.root_job_id, g.id) AS card_id, c.title,
       t.id AS take_id, t.request AS take_request, le.created_at AS added_at,
       {entry_columns_sql()}{_HIT_CASES_FROM}{scope_filter}
  AND (CAST(:after_at AS timestamptz) IS NULL
       OR (le.created_at, g.id) < (CAST(:after_at AS timestamptz), CAST(:after_id AS uuid)))
ORDER BY le.created_at DESC, g.id DESC
LIMIT :limit""")


def _count_hit_cases_statement(scope_filter: str) -> TextClause:
    return text(f"SELECT count(*) AS n{_HIT_CASES_FROM}{scope_filter}")


def _hit_case_filter(scope: HitCaseScope) -> tuple[str, dict[str, Any]]:
    tag_filter, tag_params = entry_filter_sql(
        scope.tag_groups, kind=KIND_HIT_CASE, subject_expr="g.id"
    )
    return _HIT_CASES_FILTER + tag_filter, {
        **tag_params,
        "user_name": scope.user_name,
        "since": scope.since,
        "until": scope.until,
    }


class _StoredCut(BaseModel):
    model_config = ConfigDict(extra="ignore", frozen=True)

    timestamps: tuple[float, float]
    prompt: str
    image_indexes: list[int]


class _StoredShot(BaseModel):
    model_config = ConfigDict(extra="ignore", frozen=True)

    global_settings: str
    timeline: list[_StoredCut]


class _StoredVideoRequest(BaseModel):
    model_config = ConfigDict(extra="ignore", frozen=True)

    prompt: str
    shot: _StoredShot | None = None
    model: str | None = None
    aspect_ratio: str | None = None
    seconds: int | None = None
    resolution: str | None = None
    generate_audio: bool | None = None
    reference_image_urls: list[str] = []


class _StoredWholeFilmSource(BaseModel):
    """成片导出请求里 ``videos`` 的一项（按别名落库），只取素材片 id。"""

    model_config = ConfigDict(extra="ignore", frozen=True)

    job_id: uuid.UUID = Field(alias="jobId")


_WHOLE_FILM_SOURCES: Final = TypeAdapter(list[_StoredWholeFilmSource])


def _script_of(request: _StoredVideoRequest) -> ScriptOut | None:
    if request.shot is not None:
        return ScriptOut(
            global_settings=request.shot.global_settings,
            timeline=[
                ScriptCutOut(
                    start=cut.timestamps[0],
                    end=cut.timestamps[1],
                    prompt=cut.prompt,
                    image_indexes=cut.image_indexes,
                )
                for cut in request.shot.timeline
            ],
        )
    parsed = parse_shot_prompt(request.prompt)
    if parsed is None:
        return None
    return ScriptOut(
        global_settings=parsed.global_settings,
        timeline=[
            ScriptCutOut(
                start=cut.timestamps[0],
                end=cut.timestamps[1],
                prompt=cut.prompt,
                image_indexes=list(cut.image_indexes),
            )
            for cut in parsed.timeline
        ],
    )


def _take_of(take_id: uuid.UUID, stored: object) -> TakeOut:
    request = _StoredVideoRequest.model_validate(stored)
    return TakeOut(
        id=take_id,
        model=request.model,
        aspect_ratio=request.aspect_ratio,
        seconds=request.seconds,
        resolution=request.resolution,
        generate_audio=request.generate_audio,
        prompt=request.prompt,
        script=_script_of(request),
        reference_image_urls=request.reference_image_urls,
    )


def _face_of(row: RowMapping, prefix: str = "") -> FaceOut:
    return FaceOut(
        kind="composite" if row[f"{prefix}operation"] == _COMPOSE else "take",
        job_id=row[f"{prefix}id"],
        output_url=row[f"{prefix}output_url"],
        watermark_output_url=row[f"{prefix}watermark_output_url"],
        duration_ms=row[f"{prefix}duration_ms"],
        finished_at=row[f"{prefix}finished_at"],
        user_name=row[f"{prefix}user_name"],
    )


def _version_of(row: RowMapping) -> VersionOut:
    return VersionOut(
        **_face_of(row).model_dump(), take=_take_of(row["take_id"], row["take_request"])
    )


def _card_of(row: RowMapping) -> CardRow:
    video = LibraryVideoOut(
        id=row["id"],
        conversation_id=row["conversation_id"],
        can_open_conversation=False,
        title=row["title"],
        agent_id=row["agent_id"],
        task_id=row["task_id"],
        user_name=row["user_name"],
        group_count=int(row["group_count"]),
        version_count=int(row["version_count"]),
        face=_face_of(row, "face_"),
        take=_take_of(row["take_id"], row["take_request"]),
    )
    return CardRow(
        video=video,
        conversation_owner=row["conversation_owner"],
        conversation_deleted=bool(row["conversation_deleted"]),
    )


def _groups_of(rows: Sequence[RowMapping]) -> list[ShotGroupOut]:
    groups: dict[tuple[str, int | uuid.UUID], tuple[int | None, list[VersionOut]]] = {}
    for row in rows:
        shot: int | None = row["shot_index"]
        key = ("#", shot) if shot is not None else ("@", row["take_id"])
        groups.setdefault(key, (shot, []))[1].append(_version_of(row))
    ordered = sorted(groups.values(), key=lambda group: (group[0] is None, group[0] or 0))
    return [ShotGroupOut(shot_index=shot, versions=versions) for shot, versions in ordered]


def _like_pattern(q: str) -> str:
    escaped = q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


def _scope_params(scope: Scope) -> dict[str, Any]:
    return {
        "user_name": scope.user_name,
        "since": scope.since,
        "until": scope.until,
        "orientation": scope.orientation,
        "pattern": None if scope.q is None else _like_pattern(scope.q),
    }


def _narrowed(scope: Scope) -> bool:
    return scope.orientation is not None or scope.q is not None


def _film_scope_params(scope: WholeFilmScope) -> dict[str, Any]:
    return {
        "user_name": scope.user_name,
        "since": scope.since,
        "until": scope.until,
        "pattern": None if scope.q is None else _like_pattern(scope.q),
    }


def _film_cards_of(rows: Sequence[RowMapping]) -> list[WholeFilmCardRow]:
    cards: dict[uuid.UUID, tuple[RowMapping, list[WholeFilmVersionOut]]] = {}
    for row in rows:
        version = WholeFilmVersionOut(
            job_id=row["job_id"],
            output_url=row["output_url"],
            finished_at=row["finished_at"],
            user_name=row["version_user_name"],
            source_job_ids=[
                source.job_id for source in _WHOLE_FILM_SOURCES.validate_python(row["sources"])
            ],
        )
        cards.setdefault(row["conversation_id"], (row, []))[1].append(version)
    return [
        WholeFilmCardRow(
            card=WholeFilmCardOut(
                conversation_id=head["conversation_id"],
                can_open_conversation=False,
                title=head["title"],
                user_name=head["user_name"],
                face=versions[-1],
                versions=versions,
            ),
            conversation_owner=head["conversation_owner"],
            conversation_deleted=bool(head["conversation_deleted"]),
        )
        for head, versions in cards.values()
    ]


def _hit_case_of(row: RowMapping) -> HitCaseOut:
    return HitCaseOut(
        job_id=row["id"],
        card_id=row["card_id"],
        title=row["title"],
        face=_face_of(row),
        take=_take_of(row["take_id"], row["take_request"]),
        tag_ids=list(row["tag_ids"]),
        tag_status=row["tag_status"],
        tag_error=row["tag_error"],
        added_at=row["added_at"],
    )


class PgLibraryReports:
    def __init__(self, engine: AsyncEngine) -> None:
        self._engine = engine

    async def material_of(self, job_id: uuid.UUID) -> MaterialSource | None:
        async with self._engine.connect() as conn:
            row = (await conn.execute(_MATERIAL_OF, {"job_id": job_id})).mappings().first()
        if row is None:
            return None
        return MaterialSource(
            job_id=row["id"],
            is_material=bool(row["is_material"]),
            conversation_id=row["conversation_id"],
            conversation_owner=row["conversation_owner"],
        )

    async def hit_case_entry(self, job_id: uuid.UUID) -> HitCaseEntryOut | None:
        async with self._engine.connect() as conn:
            row = (await conn.execute(_HIT_CASE_ENTRY, {"job_id": job_id})).mappings().first()
        if row is None:
            return None
        return HitCaseEntryOut(
            tag_ids=list(row["tag_ids"]),
            tag_status=row["tag_status"],
            tag_error=row["tag_error"],
            added_at=row["added_at"],
            added_by=row["added_by"],
        )

    async def hit_cases(
        self,
        scope: HitCaseScope,
        *,
        limit: int,
        after: VideoCursor | None,
    ) -> Sequence[HitCaseOut]:
        scope_filter, scope_params = _hit_case_filter(scope)
        params = {
            **scope_params,
            "after_at": after.at if after else None,
            "after_id": after.video_id if after else None,
            "limit": limit,
        }
        async with self._engine.connect() as conn:
            rows = (await conn.execute(_hit_cases_statement(scope_filter), params)).mappings().all()
        return [_hit_case_of(row) for row in rows]

    async def count_hit_cases(self, scope: HitCaseScope) -> int:
        scope_filter, scope_params = _hit_case_filter(scope)
        async with self._engine.connect() as conn:
            result = await conn.execute(_count_hit_cases_statement(scope_filter), scope_params)
            return int(result.scalar_one())

    async def hit_case_authors(self) -> Sequence[LibraryAuthorOut]:
        return await self._authors(_HIT_CASE_AUTHORS)

    async def videos(
        self, scope: Scope, *, limit: int, after: VideoCursor | None
    ) -> Sequence[CardRow]:
        params = {
            **_scope_params(scope),
            "after_at": after.at if after else None,
            "after_id": after.video_id if after else None,
            "limit": limit,
        }
        statement = _NARROWED_VIDEOS if _narrowed(scope) else _VIDEOS
        async with self._engine.connect() as conn:
            rows = (await conn.execute(statement, params)).mappings().all()
        return [_card_of(row) for row in rows]

    async def count(self, scope: Scope) -> int:
        statement = _NARROWED_COUNT if _narrowed(scope) else _COUNT
        async with self._engine.connect() as conn:
            return int((await conn.execute(statement, _scope_params(scope))).scalar_one())

    async def card_of(self, card_id: uuid.UUID) -> CardRow | None:
        async with self._engine.connect() as conn:
            row = (await conn.execute(_CARD_OF, {"card_id": card_id})).mappings().first()
        return None if row is None else _card_of(row)

    async def groups_of(self, card_id: uuid.UUID) -> Sequence[ShotGroupOut]:
        async with self._engine.connect() as conn:
            rows = (await conn.execute(_VERSIONS, {"card_id": card_id})).mappings().all()
        return _groups_of(rows)

    async def authors(self) -> Sequence[LibraryAuthorOut]:
        return await self._authors(_AUTHORS)

    async def whole_film_authors(self) -> Sequence[LibraryAuthorOut]:
        return await self._authors(_WHOLE_FILM_AUTHORS)

    async def _authors(self, statement: TextClause) -> Sequence[LibraryAuthorOut]:
        async with self._engine.connect() as conn:
            rows = (await conn.execute(statement)).mappings().all()
        return [LibraryAuthorOut(user_name=row["user_name"], count=int(row["n"])) for row in rows]

    async def whole_films(
        self, scope: WholeFilmScope, *, limit: int, after: VideoCursor | None
    ) -> Sequence[WholeFilmCardRow]:
        params = {
            **_film_scope_params(scope),
            "after_at": after.at if after else None,
            "after_id": after.video_id if after else None,
            "limit": limit,
        }
        async with self._engine.connect() as conn:
            rows = (await conn.execute(_WHOLE_FILMS, params)).mappings().all()
        return _film_cards_of(rows)

    async def count_whole_films(self, scope: WholeFilmScope) -> int:
        async with self._engine.connect() as conn:
            result = await conn.execute(_COUNT_WHOLE_FILMS, _film_scope_params(scope))
            return int(result.scalar_one())


__all__ = ["PgLibraryReports"]
