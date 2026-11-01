"""运行统计的只读查询：按应用取消息、跑到终态的顶层运行、按模型的累计用量与每段会话的首末消息。

每条查询都经 ``agent_runtime.sessions`` 只认 ``app_id`` 这个应用的会话，预览会话不算（它们不是应用的对话，
报表不该数到）。取法二选一：按时间窗（各行自己的时刻落在 ``[since, until)`` 里，``until`` 为空不设上界）
或按会话 id 取这几段会话的全部行。只返回事实行，不做聚合；行按（会话，时刻，id）排好。
"""

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
    """时间窗 ``[since, until)``；``until`` 为空不设上界。"""

    since: datetime
    until: datetime | None = None


StatsScope = StatsWindow | Sequence[uuid.UUID]
"""按时间窗，或按这几段会话。"""


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

# 会话 id 按文本比：队列与用量表的会话列是文本，写的是带横线的小写写法。
_BY_SESSIONS: Final = "AND {session} = ANY(CAST(:session_ids AS text[]))"
_BY_WINDOW: Final = """AND {anchor} >= CAST(:since AS timestamptz)
  AND (CAST(:until AS timestamptz) IS NULL OR {anchor} < CAST(:until AS timestamptz))"""


def _both(template: str, **columns: str) -> Mapping[_Mode, TextClause]:
    """同一条查询按两种取法各备一份：模板里的 ``{scope}`` 换成按会话或按时间窗的筛选。"""

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

# 顶层运行只认 agent_job_runs 登记过的 run_id（运行驱动发放的）；子代理的内部运行带 parent_run_id、不登记。
# 开始是第一条 run_started 事件，结束是第一条 run_completed / run_failed，两头缺一不算。按会话取时先在
# 聚合前圈住会话。时间窗看开始事件，只能在聚合之后筛：聚合前先经 idx_events_run_started 圈出窗里有
# 开始事件的运行（第一条开始事件在窗里的一定在其中），只聚合它们的事件，结束事件不按窗裁；圈进来的
# 第一条开始事件在窗外的，由聚合后的筛选去掉。
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

# 最近一条消息按发起时刻，同一时刻按 prompt_id 大的算。
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
    """运行统计的 Postgres 读取。每个方法一个连接、只读。"""

    def __init__(self, engine: AsyncEngine) -> None:
        self._engine = engine

    async def _rows(self, statement: TextClause, params: dict[str, Any]) -> Sequence[Any]:
        async with self._engine.connect() as conn:
            return (await conn.execute(statement, params)).all()

    async def prompts(self, app_id: str, scope: StatsScope) -> tuple[PromptStat, ...]:
        """消息；时间窗看发起时刻。"""

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
        """跑到终态的顶层运行；时间窗看开始事件的时刻。"""

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
        """按（会话，模型）的累计用量；时间窗看最后一次累加的时刻。"""

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
        """这几段会话里跑过的：第一条消息的时刻、最近一条消息的 ``user_name``。"""

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
