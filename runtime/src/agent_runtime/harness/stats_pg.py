from __future__ import annotations

import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Final, Literal

from sqlalchemy import TextClause, text
from sqlalchemy.ext.asyncio import AsyncEngine


@dataclass(frozen=True, slots=True)
class StatsWindow:
    since: datetime
    until: datetime | None = None


StatsScope = StatsWindow | Sequence[uuid.UUID]


@dataclass(frozen=True, slots=True)
class PromptStat:
    session_id: uuid.UUID
    prompt_id: str
    user_name: str
    created_at: datetime


@dataclass(frozen=True, slots=True)
class RunStat:
    session_id: uuid.UUID
    run_id: str
    user_name: str
    started_at: datetime
    ended_at: datetime


@dataclass(frozen=True, slots=True)
class UsageStat:
    session_id: uuid.UUID
    model_name: str
    requests: int
    input_tokens: int
    cache_read_tokens: int
    cache_write_tokens: int
    output_tokens: int
    last_at: datetime


@dataclass(frozen=True, slots=True)
class SessionStat:
    session_id: uuid.UUID
    first_prompt_at: datetime
    latest_user_name: str


_Mode = Literal["window", "sessions"]

_BY_SESSIONS: Final = "AND {session} = ANY(CAST(:session_ids AS text[]))"
_BY_WINDOW: Final = """AND {anchor} >= CAST(:since AS timestamptz)
  AND (CAST(:until AS timestamptz) IS NULL OR {anchor} < CAST(:until AS timestamptz))"""


def _both(template: str, **columns: str) -> Mapping[_Mode, TextClause]:
    return {
        "sessions": text(template.format(scope=_BY_SESSIONS.format(**columns))),
        "window": text(template.format(scope=_BY_WINDOW.format(**columns))),
    }


_PROMPTS: Final = _both(
    """
SELECT s.id AS session_id, j.prompt_id, j.user_name, j.created_at
FROM agent_runtime.agent_jobs j
JOIN agent_runtime.sessions s ON s.id::text = j.conversation_id
WHERE s.app_id = :app_id
  AND s.preview_agent_id IS NULL
{scope}
ORDER BY j.conversation_id, j.created_at, j.prompt_id
""",
    session="j.conversation_id",
    anchor="j.created_at",
)

_STARTED_IN_WINDOW: Final = f"""AND r.run_id IN (
      SELECT b.run_id FROM agent_runtime.events b
      WHERE b.kind = 'run_started'
      {_BY_WINDOW.format(anchor="b.timestamp")})"""

_RUN_TIMES: Final = """
SELECT s.id AS session_id, r.run_id, j.user_name,
       min(e.timestamp) FILTER (WHERE e.kind = 'run_started') AS started_at,
       min(e.timestamp) FILTER (WHERE e.kind IN ('run_completed', 'run_failed')) AS ended_at
FROM agent_runtime.agent_job_runs r
JOIN agent_runtime.agent_jobs j ON j.prompt_id = r.prompt_id
JOIN agent_runtime.sessions s ON s.id::text = j.conversation_id
JOIN agent_runtime.events e ON e.run_id = r.run_id
WHERE s.app_id = :app_id
  AND s.preview_agent_id IS NULL
  AND e.kind IN ('run_started', 'run_completed', 'run_failed')
  {inner}
GROUP BY r.run_id, s.id, j.user_name
HAVING bool_or(e.kind = 'run_started')
   AND bool_or(e.kind IN ('run_completed', 'run_failed'))"""

_RUNS: Final[Mapping[_Mode, TextClause]] = {
    "sessions": text(
        f"""
SELECT * FROM ({_RUN_TIMES.format(inner=_BY_SESSIONS.format(session="j.conversation_id"))}) t
ORDER BY t.session_id, t.started_at, t.run_id
"""
    ),
    "window": text(
        f"""
SELECT * FROM ({_RUN_TIMES.format(inner=_STARTED_IN_WINDOW)}) t
WHERE TRUE
{_BY_WINDOW.format(anchor="t.started_at")}
ORDER BY t.session_id, t.started_at, t.run_id
"""
    ),
}

_USAGE: Final = _both(
    """
SELECT s.id AS session_id, u.model_name, u.requests, u.input_tokens,
       u.cache_read_tokens, u.cache_write_tokens, u.output_tokens, u.last_at
FROM agent_runtime.conversation_usage u
JOIN agent_runtime.sessions s ON s.id::text = u.conversation_id
WHERE s.app_id = :app_id
  AND s.preview_agent_id IS NULL
{scope}
ORDER BY u.conversation_id, u.model_name
""",
    session="u.conversation_id",
    anchor="u.last_at",
)

_SESSIONS: Final = text(f"""
SELECT DISTINCT ON (j.conversation_id)
       s.id AS session_id,
       min(j.created_at) OVER (PARTITION BY j.conversation_id) AS first_prompt_at,
       j.user_name AS latest_user_name
FROM agent_runtime.agent_jobs j
JOIN agent_runtime.sessions s ON s.id::text = j.conversation_id
WHERE s.app_id = :app_id
  AND s.preview_agent_id IS NULL
{_BY_SESSIONS.format(session="j.conversation_id")}
ORDER BY j.conversation_id, j.created_at DESC, j.prompt_id DESC
""")


def _query(
    statements: Mapping[_Mode, TextClause], app_id: str, scope: StatsScope
) -> tuple[TextClause, dict[str, Any]]:
    if isinstance(scope, StatsWindow):
        return statements["window"], {
            "app_id": app_id,
            "since": scope.since,
            "until": scope.until,
        }
    return statements["sessions"], {
        "app_id": app_id,
        "session_ids": [str(one) for one in scope],
    }


class PgRunStats:
    def __init__(self, engine: AsyncEngine) -> None:
        self._engine = engine

    async def _rows(self, statement: TextClause, params: dict[str, Any]) -> Sequence[Any]:
        async with self._engine.connect() as conn:
            return (await conn.execute(statement, params)).all()

    async def prompts(self, app_id: str, scope: StatsScope) -> tuple[PromptStat, ...]:
        rows = await self._rows(*_query(_PROMPTS, app_id, scope))
        return tuple(
            PromptStat(
                session_id=row.session_id,
                prompt_id=row.prompt_id,
                user_name=row.user_name,
                created_at=row.created_at,
            )
            for row in rows
        )

    async def runs(self, app_id: str, scope: StatsScope) -> tuple[RunStat, ...]:
        rows = await self._rows(*_query(_RUNS, app_id, scope))
        return tuple(
            RunStat(
                session_id=row.session_id,
                run_id=row.run_id,
                user_name=row.user_name,
                started_at=row.started_at,
                ended_at=row.ended_at,
            )
            for row in rows
        )

    async def usage(self, app_id: str, scope: StatsScope) -> tuple[UsageStat, ...]:
        rows = await self._rows(*_query(_USAGE, app_id, scope))
        return tuple(
            UsageStat(
                session_id=row.session_id,
                model_name=row.model_name,
                requests=row.requests,
                input_tokens=row.input_tokens,
                cache_read_tokens=row.cache_read_tokens,
                cache_write_tokens=row.cache_write_tokens,
                output_tokens=row.output_tokens,
                last_at=row.last_at,
            )
            for row in rows
        )

    async def sessions(
        self, app_id: str, session_ids: Sequence[uuid.UUID]
    ) -> tuple[SessionStat, ...]:
        rows = await self._rows(
            _SESSIONS, {"app_id": app_id, "session_ids": [str(one) for one in session_ids]}
        )
        return tuple(
            SessionStat(
                session_id=row.session_id,
                first_prompt_at=row.first_prompt_at,
                latest_user_name=row.latest_user_name,
            )
            for row in rows
        )


__all__ = [
    "PgRunStats",
    "PromptStat",
    "RunStat",
    "SessionStat",
    "StatsScope",
    "StatsWindow",
    "UsageStat",
]
