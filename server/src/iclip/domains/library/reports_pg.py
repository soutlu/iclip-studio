from __future__ import annotations

import uuid
from collections.abc import Sequence
from typing import Any, Final

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter
from sqlalchemy import TextClause, text
from sqlalchemy.engine import RowMapping
from sqlalchemy.ext.asyncio import AsyncEngine

from iclip.common.shot_prompt import parse_shot_prompt
from iclip.domains.library.models import MaterialSource, Scope, VideoCursor, WholeFilmScope
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

_MASTER: Final = """g.kind = 'video' AND g.status = 'completed' AND g.output_url IS NOT NULL
      AND ((g.operation = 'generate' AND g.source_job_id IS NULL) OR g.operation = 'compose')
      AND NOT (coalesce(g.metadata, '{}') ? 'referenceId')"""

_JOB_COLUMNS: Final = """g.id, g.operation, g.shot_index, g.root_job_id, g.output_url,
           g.watermark_output_url, g.duration_ms, g.finished_at, g.owner_user_id"""

_OWN_MASTERS: Final = f"""
own_masters AS (
    SELECT g.id, g.operation, g.output_url, g.watermark_output_url, g.duration_ms,
           g.finished_at, g.owner_user_id, c.id AS card_conversation,
           COALESCE(c.id, g.root_job_id, g.id) AS card_id,
           COALESCE(g.root_job_id, g.id) AS take_id
    FROM iclip.generation_jobs g
    LEFT JOIN iclip.conversations c ON c.id = g.conversation_id
    WHERE {_MASTER}
)"""

_FACES: Final = """
faces AS (
    SELECT DISTINCT ON (m.card_id) m.*
    FROM own_masters m
    ORDER BY m.card_id, m.finished_at DESC, m.id DESC
)"""

_CARDS: Final = r"""
cards AS (
    SELECT f.card_id AS id, f.card_conversation AS conversation_id,
           f.id AS face_id, f.operation AS face_operation, f.output_url AS face_output_url,
           f.watermark_output_url AS face_watermark_output_url,
           f.duration_ms AS face_duration_ms, f.finished_at AS face_finished_at,
           fu.username AS face_user_name,
           t.id AS take_id, t.request AS take_request,
           c.title, c.agent_id, c.task_id, c.owner_user_id AS conversation_owner,
           c.deleted_at IS NOT NULL AS conversation_deleted,
           au.username AS user_name,
           CASE WHEN t.request->>'aspect_ratio' ~ '^[0-9]+(\.[0-9]+)?:[0-9]+(\.[0-9]+)?$' THEN
               CASE sign(split_part(t.request->>'aspect_ratio', ':', 1)::numeric
                         - split_part(t.request->>'aspect_ratio', ':', 2)::numeric)
                   WHEN 1 THEN 'landscape' WHEN -1 THEN 'portrait' ELSE 'square' END
           END AS orientation
    FROM faces f
    JOIN iclip.generation_jobs t ON t.id = f.take_id
    JOIN iclip.users fu ON fu.id = f.owner_user_id
    LEFT JOIN iclip.conversations c ON c.id = f.card_conversation
    JOIN iclip.users au ON au.id = COALESCE(c.owner_user_id, t.owner_user_id)
)"""

_FILTER: Final = r"""
WHERE (CAST(:user_name AS text) IS NULL OR c.user_name = CAST(:user_name AS text))
  AND (CAST(:since AS timestamptz) IS NULL OR c.face_finished_at >= CAST(:since AS timestamptz))
  AND (CAST(:until AS timestamptz) IS NULL OR c.face_finished_at < CAST(:until AS timestamptz))
  AND (CAST(:orientation AS text) IS NULL OR c.orientation = CAST(:orientation AS text))
  AND (CAST(:pattern AS text) IS NULL
       OR c.take_request->>'prompt' ILIKE CAST(:pattern AS text) ESCAPE '\'
       OR c.title ILIKE CAST(:pattern AS text) ESCAPE '\')"""

_PAGE: Final = f"""
page AS (
    SELECT c.* FROM cards c{_FILTER}
      AND (CAST(:after_at AS timestamptz) IS NULL
           OR (c.face_finished_at, c.id)
              < (CAST(:after_at AS timestamptz), CAST(:after_id AS uuid)))
    ORDER BY c.face_finished_at DESC, c.id DESC
    LIMIT :limit
)"""

_SEEDS_OF_PAGE: Final = """
seeds AS (SELECT p.id FROM page p)"""

_SEEDS_OF_CARD: Final = """
seeds AS (SELECT c.id FROM cards c WHERE c.id = CAST(:card_id AS uuid))"""

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

_VISIBLE: Final = f"""
visible AS (
    SELECT l.card_id, {_JOB_COLUMNS}
    FROM lineage l
    JOIN iclip.generation_jobs g ON g.conversation_id = l.conversation_id
    WHERE {_MASTER}
      AND (l.boundary IS NULL OR (g.status = 'completed' AND g.finished_at <= l.boundary))
    UNION ALL
    SELECT COALESCE(g.root_job_id, g.id), {_JOB_COLUMNS}
    FROM iclip.generation_jobs g
    LEFT JOIN iclip.conversations c ON c.id = g.conversation_id
    WHERE {_MASTER} AND c.id IS NULL
      AND COALESCE(g.root_job_id, g.id) IN (SELECT s.id FROM seeds s)
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


_CARD_CTES: Final = (_OWN_MASTERS, _FACES, _CARDS)
_LINEAGE_CTES: Final = (_LINEAGE, _VISIBLE)

_VIDEOS: Final = _statement(
    (*_CARD_CTES, _PAGE, _SEEDS_OF_PAGE, *_LINEAGE_CTES, _FILL),
    """SELECT p.*, f.group_count, f.version_count
FROM page p
JOIN fill f ON f.card_id = p.id
ORDER BY p.face_finished_at DESC, p.id DESC""",
)

_COUNT: Final = _statement(_CARD_CTES, "SELECT count(*) AS n FROM cards c" + _FILTER)

_CARD_OF: Final = _statement(
    (*_CARD_CTES, _SEEDS_OF_CARD, *_LINEAGE_CTES, _FILL),
    """SELECT c.*, f.group_count, f.version_count
FROM cards c
JOIN fill f ON f.card_id = c.id
WHERE c.id = CAST(:card_id AS uuid)""",
)

_VERSIONS: Final = _statement(
    (*_CARD_CTES, _SEEDS_OF_CARD, *_LINEAGE_CTES),
    """SELECT v.id, v.operation, v.shot_index, v.output_url, v.watermark_output_url,
       v.duration_ms, v.finished_at, u.username AS user_name,
       t.id AS take_id, t.request AS take_request
FROM visible v
JOIN iclip.generation_jobs t ON t.id = COALESCE(v.root_job_id, v.id)
JOIN iclip.users u ON u.id = v.owner_user_id
ORDER BY v.finished_at, v.id""",
)

_AUTHORS: Final = _statement(
    _CARD_CTES,
    """SELECT c.user_name, count(*) AS n FROM cards c
WHERE c.user_name IS NOT NULL
GROUP BY c.user_name
ORDER BY n DESC, c.user_name""",
)

_WHOLE_FILM: Final = """g.kind = 'whole_film' AND g.status = 'completed'
      AND g.output_url IS NOT NULL"""

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
       p.user_name, g.id AS job_id, g.output_url, g.finished_at,
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
"""在库的爆款素材：有条目、仍是素材片；卡 id 的算法同 ``own_masters``。"""


def _hit_cases_statement(tag_filter: str) -> TextClause:
    return text(f"""
SELECT g.id, g.operation, g.output_url, g.watermark_output_url, g.duration_ms, g.finished_at,
       u.username AS user_name, COALESCE(c.id, g.root_job_id, g.id) AS card_id, c.title,
       t.id AS take_id, t.request AS take_request, le.created_at AS added_at,
       {entry_columns_sql()}{_HIT_CASES_FROM}{tag_filter}
  AND (CAST(:after_at AS timestamptz) IS NULL
       OR (le.created_at, g.id) < (CAST(:after_at AS timestamptz), CAST(:after_id AS uuid)))
ORDER BY le.created_at DESC, g.id DESC
LIMIT :limit""")


def _count_hit_cases_statement(tag_filter: str) -> TextClause:
    return text(f"SELECT count(*) AS n{_HIT_CASES_FROM}{tag_filter}")


def _hit_case_filter(tag_groups: Sequence[Sequence[uuid.UUID]]) -> tuple[str, dict[str, Any]]:
    return entry_filter_sql(tag_groups, kind=KIND_HIT_CASE, subject_expr="g.id")


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
        tag_groups: Sequence[Sequence[uuid.UUID]],
        *,
        limit: int,
        after: VideoCursor | None,
    ) -> Sequence[HitCaseOut]:
        tag_filter, tag_params = _hit_case_filter(tag_groups)
        params = {
            **tag_params,
            "after_at": after.at if after else None,
            "after_id": after.video_id if after else None,
            "limit": limit,
        }
        async with self._engine.connect() as conn:
            rows = (await conn.execute(_hit_cases_statement(tag_filter), params)).mappings().all()
        return [_hit_case_of(row) for row in rows]

    async def count_hit_cases(self, tag_groups: Sequence[Sequence[uuid.UUID]]) -> int:
        tag_filter, tag_params = _hit_case_filter(tag_groups)
        async with self._engine.connect() as conn:
            result = await conn.execute(_count_hit_cases_statement(tag_filter), tag_params)
            return int(result.scalar_one())

    async def videos(
        self, scope: Scope, *, limit: int, after: VideoCursor | None
    ) -> Sequence[CardRow]:
        params = {
            **_scope_params(scope),
            "after_at": after.at if after else None,
            "after_id": after.video_id if after else None,
            "limit": limit,
        }
        async with self._engine.connect() as conn:
            rows = (await conn.execute(_VIDEOS, params)).mappings().all()
        return [_card_of(row) for row in rows]

    async def count(self, scope: Scope) -> int:
        async with self._engine.connect() as conn:
            return int((await conn.execute(_COUNT, _scope_params(scope))).scalar_one())

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
