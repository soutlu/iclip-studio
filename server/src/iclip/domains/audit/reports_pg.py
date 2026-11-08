from __future__ import annotations

import uuid
from collections.abc import AsyncGenerator, Mapping, Sequence
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Final

from sqlalchemy import TextClause, text
from sqlalchemy.engine import RowMapping
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine

from iclip.domains.audit.executions import (
    RETRY_AT_LEAST,
    STUCK_HOURS,
    TASK_CONVERSATIONS,
    ExecutionCursor,
)
from iclip.domains.audit.models import ExecutionSort, OverviewBucket, Scope, SortOrder
from iclip.domains.audit.repository import ExecutionPage
from iclip.domains.audit.runtime_facts import (
    PROMPT_FACTS,
    RUN_FACTS,
    SESSION_FACTS,
    USAGE_FACTS,
    RuntimeStats,
)
from iclip.domains.audit.schemas import (
    EMPTY_METRICS,
    AttemptBucketOut,
    ExecutionOut,
    ExecutionShotOut,
    MetricsOut,
    ModelUsageOut,
    PeriodMetricsOut,
    SpreadOut,
    TopShotOut,
    UsageOut,
)

_VIDEO_JOBS: Final = """
    FROM iclip.generation_jobs g
    JOIN iclip.conversations c ON c.id = g.conversation_id
    JOIN iclip.users u ON u.id = g.owner_user_id
    -- 出片 = 没有来源的视频 generate，且有镜号；编辑段与合成抄了原作的镜号，也一律不算。
    WHERE g.kind = 'video' AND g.operation = 'generate' AND g.source_job_id IS NULL
      AND g.shot_index IS NOT NULL
      AND c.forked_from IS NULL"""

# 完成的出片：出成了且有完成时刻；各口径只引用这一列。
_DELIVERED: Final = "(g.status = 'completed' AND g.finished_at IS NOT NULL)"

_VIDEOS: Final = f"""
    SELECT g.id, g.conversation_id, g.status, g.created_at, g.submitted_at, g.finished_at,
           (g.output ->> 'duration_ms')::int AS duration_ms,
           {_DELIVERED} AS delivered,
           g.id IN (SELECT r.job_id FROM iclip.video_generation_report r WHERE r.downloaded)
               AS downloaded,
           g.shot_index AS shot,
           u.username AS user_name,
           c.task_id
    {_VIDEO_JOBS}"""

_PERSON: Final = f"""
    WITH latest_video_owner AS (
        SELECT DISTINCT ON (v.conversation_id) v.conversation_id, v.user_name
        FROM videos v
        ORDER BY v.conversation_id, v.created_at DESC, v.id DESC
    )
    SELECT c.id AS conversation_id, c.title, c.owner_user_id, c.task_id,
           c.created_at, c.updated_at, c.deleted_at,
           COALESCE(f.latest_user_name, o.user_name) AS user_name,
           f.first_prompt_at
    FROM iclip.conversations c
    LEFT JOIN {SESSION_FACTS} ON f.conversation_id = c.id
    LEFT JOIN latest_video_owner o ON o.conversation_id = c.id
    WHERE c.forked_from IS NULL"""

_SHOTS: Final = """
    SELECT v.conversation_id, v.shot, v.task_id,
           count(*) AS attempts,
           min(v.finished_at) AS first_at,
           max(v.finished_at) AS last_at,
           count(*) = 1 AS one_take,
           bool_or(v.downloaded) AS effective,
           (array_agg(v.user_name ORDER BY v.finished_at, v.id))[1] AS user_name
    FROM videos v
    WHERE v.delivered
    GROUP BY v.conversation_id, v.shot, v.task_id"""

_RUNS: Final = f"""
    SELECT f.created_at, f.user_name, c.id AS conversation_id, c.task_id
    FROM {PROMPT_FACTS}
    JOIN iclip.conversations c ON c.id = f.conversation_id
    WHERE c.forked_from IS NULL"""

_AGENT_RUNS: Final = f"""
    SELECT f.user_name, c.id AS conversation_id, c.task_id, f.started_at, f.ended_at
    FROM {RUN_FACTS}
    JOIN iclip.conversations c ON c.id = f.conversation_id
    WHERE c.forked_from IS NULL"""

_STARTED_AT: Final = "COALESCE(p.first_prompt_at, p.created_at)"

_ACTIVE_CYCLES: Final = f"""
    WITH cycles AS (
        SELECT d.conversation_id, p.user_name, p.task_id, d.delivered_at,
               {_STARTED_AT} AS started_at
        FROM (
            SELECT v.conversation_id, max(v.finished_at) AS delivered_at
            FROM videos v
            WHERE v.delivered
            GROUP BY v.conversation_id
        ) d
        JOIN person p ON p.conversation_id = d.conversation_id
    ),
    cycle_spans AS (
        SELECT y.conversation_id,
               greatest(i.s, y.started_at) AS s,
               least(i.e, y.delivered_at) AS e
        FROM cycles y
        JOIN (
            SELECT a.conversation_id, a.started_at AS s, a.ended_at AS e FROM agent_runs a
            UNION ALL
            SELECT v.conversation_id, v.created_at, COALESCE(v.finished_at, v.created_at)
            FROM videos v
        ) i ON i.conversation_id = y.conversation_id
        WHERE i.s <= y.delivered_at AND i.e >= y.started_at
    ),
    cycle_reach AS (
        SELECT z.conversation_id, z.s, z.e,
               max(z.e) OVER (PARTITION BY z.conversation_id ORDER BY z.s, z.e
                              ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS reach
        FROM cycle_spans z
    ),
    cycle_islands AS (
        SELECT m.conversation_id, m.s, m.e,
               sum(CASE WHEN m.reach IS NULL OR m.s > m.reach + interval '30 minutes'
                        THEN 1 ELSE 0 END)
                   OVER (PARTITION BY m.conversation_id ORDER BY m.s, m.e
                         ROWS UNBOUNDED PRECEDING) AS island
        FROM cycle_reach m
    ),
    island_spans AS (
        SELECT l.conversation_id, max(l.e) - min(l.s) AS span
        FROM cycle_islands l
        GROUP BY l.conversation_id, l.island
    )
    SELECT y.conversation_id, y.user_name, y.task_id, y.started_at, y.delivered_at,
           COALESCE(sum(extract(epoch FROM w.span)), 0) AS active_seconds
    FROM cycles y
    LEFT JOIN island_spans w ON w.conversation_id = y.conversation_id
    GROUP BY y.conversation_id, y.user_name, y.task_id, y.started_at, y.delivered_at"""

_TAKES: Final = """
    SELECT v.*,
           row_number() OVER (PARTITION BY v.conversation_id, v.shot
                              ORDER BY v.finished_at DESC, v.id DESC) > 1 AS discarded
    FROM videos v
    WHERE v.delivered"""

_USAGE: Final = f"""
    SELECT p.conversation_id, p.user_name, p.task_id, f.model_name,
           f.requests, f.input_tokens, f.cache_read_tokens, f.cache_write_tokens,
           f.output_tokens, f.last_at
    FROM {USAGE_FACTS}
    JOIN person p ON p.conversation_id = f.conversation_id"""

_TABLES: Final[Mapping[str, str]] = {
    "videos": _VIDEOS,
    "person": _PERSON,
    "runs": _RUNS,
    "agent_runs": _AGENT_RUNS,
    "usage_rows": _USAGE,
    "shots": _SHOTS,
    "active_cycles": _ACTIVE_CYCLES,
}
# autovacuum 不分析临时表，不手动 ANALYZE 规划器就没有统计信息。
_BUILD_TABLES: Final = tuple(
    statement
    for name, body in _TABLES.items()
    for statement in (
        text(f"CREATE TEMP TABLE {name} ON COMMIT DROP AS {body}"),
        text(f"ANALYZE {name}"),
    )
)

_WINDOW: Final = """
    AND (CAST(:since AS timestamptz) IS NULL OR {anchor} >= CAST(:since AS timestamptz))
    AND (CAST(:until AS timestamptz) IS NULL OR {anchor} < CAST(:until AS timestamptz))"""
_FILTERS: Final = """
    AND (CAST(:user_name AS text) IS NULL OR {t}.user_name = CAST(:user_name AS text))
    AND (CAST(:conversation_ids AS uuid[]) IS NULL
         OR {t}.conversation_id = ANY(CAST(:conversation_ids AS uuid[])))"""


def _spread(expr: str, prefix: str) -> str:
    return f"""
           avg({expr}) AS {prefix}_avg,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY {expr}) AS {prefix}_median,
           percentile_cont(0.9) WITHIN GROUP (ORDER BY {expr}) AS {prefix}_p90,
           count({expr}) AS {prefix}_count"""


def _spread_columns(alias: str, prefix: str) -> str:
    return ", ".join(f"{alias}.{prefix}_{name}" for name in ("avg", "median", "p90", "count"))


_PERIOD_AXIS: Final = """
    UNION SELECT axis FROM generate_series(
        date_trunc(CAST(:bucket AS text), CAST(:since AS timestamptz), CAST(:timezone AS text)),
        date_trunc(CAST(:bucket AS text),
                   COALESCE(CAST(:until AS timestamptz), now()) - interval '1 microsecond',
                   CAST(:timezone AS text)),
        CAST('1 ' || CAST(:bucket AS text) AS interval),
        CAST(:timezone AS text)) AS axis"""

_METRICS: Final = f"""
WITH takes AS ({_TAKES}),
completed AS (
    SELECT {{k_video}} AS k,
           count(*) AS completed_videos,
           count(DISTINCT v.task_id) AS delivered_tasks,
           count(DISTINCT v.conversation_id) FILTER (WHERE v.task_id IS NULL)
               AS delivered_orphan_conversations,
           count(DISTINCT v.user_name) AS producers,
           count(v.duration_ms) AS length_videos,
           COALESCE(sum(v.duration_ms), 0) / 1000.0 AS length_seconds,
           COALESCE(sum(v.duration_ms) FILTER (WHERE v.discarded), 0) / 1000.0
               AS discarded_length_seconds,
           {_spread("extract(epoch FROM v.finished_at - v.submitted_at)", "upstream")}
    FROM takes v
    WHERE TRUE
    {_WINDOW.format(anchor="v.finished_at")}
    {_FILTERS.format(t="v")}
    GROUP BY 1
),
shot_metrics AS (
    SELECT {{k_shot}} AS k,
           count(*) AS shots,
           sum(s.attempts) AS attempts,
           count(*) FILTER (WHERE s.one_take) AS one_take_shots,
           count(*) FILTER (WHERE s.effective) AS effective_shots
    FROM shots s
    WHERE TRUE
    {_WINDOW.format(anchor="s.first_at")}
    {_FILTERS.format(t="s")}
    GROUP BY 1
),
run_metrics AS (
    SELECT {{k_run}} AS k,
           count(*) AS runs,
           count(DISTINCT r.user_name) AS active_users
    FROM runs r
    WHERE TRUE
    {_WINDOW.format(anchor="r.created_at")}
    {_FILTERS.format(t="r")}
    GROUP BY 1
),
agent_run_metrics AS (
    SELECT {{k_agent_run}} AS k,
           {_spread("extract(epoch FROM a.ended_at - a.started_at)", "agent_run")}
    FROM agent_runs a
    WHERE TRUE
    {_WINDOW.format(anchor="a.started_at")}
    {_FILTERS.format(t="a")}
    GROUP BY 1
),
cycle_metrics AS (
    SELECT {{k_cycle}} AS k,
           count(*) AS delivered_conversations,
           {_spread("extract(epoch FROM y.delivered_at - y.started_at)", "cycle")},
           {_spread("y.active_seconds", "active_cycle")}
    FROM active_cycles y
    WHERE TRUE
    {_WINDOW.format(anchor="y.delivered_at")}
    {_FILTERS.format(t="y")}
    GROUP BY 1
),
usage_metrics AS (
    SELECT {{k_usage}} AS k,
           sum(u.requests) AS requests,
           sum(u.input_tokens) AS input_tokens,
           sum(u.cache_read_tokens) AS cache_read_tokens,
           sum(u.cache_write_tokens) AS cache_write_tokens,
           sum(u.output_tokens) AS output_tokens
    FROM usage_rows u
    WHERE TRUE
    {_WINDOW.format(anchor="u.last_at")}
    {_FILTERS.format(t="u")}
    GROUP BY 1
),
keys AS (
    SELECT k FROM completed UNION SELECT k FROM shot_metrics UNION SELECT k FROM run_metrics
    UNION SELECT k FROM agent_run_metrics UNION SELECT k FROM cycle_metrics
    UNION SELECT k FROM usage_metrics{{axis}}
)
SELECT keys.k,
       c.completed_videos, c.delivered_tasks, c.delivered_orphan_conversations, c.producers,
       c.length_videos, c.length_seconds, c.discarded_length_seconds,
       {_spread_columns("c", "upstream")},
       s.shots, s.attempts, s.one_take_shots, s.effective_shots,
       r.runs, r.active_users,
       {_spread_columns("a", "agent_run")},
       y.delivered_conversations,
       {_spread_columns("y", "cycle")},
       {_spread_columns("y", "active_cycle")},
       u.requests, u.input_tokens, u.cache_read_tokens, u.cache_write_tokens, u.output_tokens
FROM keys
LEFT JOIN completed c ON c.k = keys.k
LEFT JOIN shot_metrics s ON s.k = keys.k
LEFT JOIN run_metrics r ON r.k = keys.k
LEFT JOIN agent_run_metrics a ON a.k = keys.k
LEFT JOIN cycle_metrics y ON y.k = keys.k
LEFT JOIN usage_metrics u ON u.k = keys.k
WHERE keys.k IS NOT NULL
ORDER BY keys.k
"""


@dataclass(frozen=True, slots=True)
class _Dimension:
    k_video: str
    k_shot: str
    k_run: str
    k_agent_run: str
    k_cycle: str
    k_usage: str
    axis: str = ""

    def sql(self) -> str:
        return _METRICS.format(
            k_video=self.k_video,
            k_shot=self.k_shot,
            k_run=self.k_run,
            k_agent_run=self.k_agent_run,
            k_cycle=self.k_cycle,
            k_usage=self.k_usage,
            axis=self.axis,
        )


def _same(column: str) -> _Dimension:
    return _Dimension(
        *(f"{alias}.{column}" for alias in ("v", "s", "r", "a", "y", "u")),
    )


_BUCKET: Final = "date_trunc(CAST(:bucket AS text), {anchor}, CAST(:timezone AS text))"

_DIMENSIONS: Final[Mapping[str, _Dimension]] = {
    "overall": _Dimension("'all'", "'all'", "'all'", "'all'", "'all'", "'all'"),
    "user": _same("user_name"),
    "conversation": _same("conversation_id"),
    "period": _Dimension(
        _BUCKET.format(anchor="v.finished_at"),
        _BUCKET.format(anchor="s.first_at"),
        _BUCKET.format(anchor="r.created_at"),
        _BUCKET.format(anchor="a.started_at"),
        _BUCKET.format(anchor="y.delivered_at"),
        _BUCKET.format(anchor="u.last_at"),
        axis=_PERIOD_AXIS,
    ),
}
_METRICS_SQL: Final = {name: text(dimension.sql()) for name, dimension in _DIMENSIONS.items()}

_ATTEMPTS: Final = text(f"""
SELECT s.attempts, count(*) AS shots
FROM shots s
WHERE TRUE
{_WINDOW.format(anchor="s.first_at")}
{_FILTERS.format(t="s")}
GROUP BY s.attempts
ORDER BY s.attempts
""")

_ACTIVE_DAYS: Final = text(f"""
SELECT count(DISTINCT date_trunc('day', r.created_at, CAST(:timezone AS text))) AS days
FROM runs r
WHERE TRUE
{_WINDOW.format(anchor="r.created_at")}
{_FILTERS.format(t="r")}
""")

_DELIVERY_UNITS: Final = text(f"""
SELECT {_BUCKET.format(anchor="v.finished_at")} AS k,
       array_agg(DISTINCT COALESCE(CAST(v.task_id AS text), 'c:' || CAST(v.conversation_id AS text)))
           AS units
FROM videos v
WHERE v.delivered
{_WINDOW.format(anchor="v.finished_at")}
{_FILTERS.format(t="v")}
GROUP BY 1
ORDER BY 1
""")

_USER_DELIVERIES: Final = text(f"""
SELECT v.user_name, {_BUCKET.format(anchor="v.finished_at")} AS k,
       count(DISTINCT v.task_id)
           + count(DISTINCT v.conversation_id) FILTER (WHERE v.task_id IS NULL) AS deliveries
FROM videos v
WHERE v.delivered AND v.user_name IS NOT NULL
{_WINDOW.format(anchor="v.finished_at")}
GROUP BY 1, 2
""")

_TOP_ORDER: Final = "{t}.attempts DESC, {t}.last_at DESC, {t}.conversation_id, {t}.shot"
_TOP_SHOTS: Final = text(f"""
WITH top AS (
    SELECT s.*
    FROM shots s
    WHERE TRUE
    {_WINDOW.format(anchor="s.first_at")}
    {_FILTERS.format(t="s")}
    ORDER BY {_TOP_ORDER.format(t="s")}
    LIMIT :limit
)
SELECT t.conversation_id, t.shot, t.attempts, p.title, p.user_name
FROM top t
JOIN person p ON p.conversation_id = t.conversation_id
ORDER BY {_TOP_ORDER.format(t="t")}
""")

_DELIVERED_CONVERSATIONS: Final = text(f"""
SELECT DISTINCT g.conversation_id
{_VIDEO_JOBS}
  AND {_DELIVERED}
  {_WINDOW.format(anchor="g.finished_at")}
""")

_CREATED_CONVERSATIONS: Final = text(f"""
SELECT c.id FROM iclip.conversations c
WHERE c.forked_from IS NULL
{_WINDOW.format(anchor="c.created_at")}
""")


_EXECUTIONS: Final = f"""
WITH executions AS (
    SELECT p.conversation_id, p.title, p.user_name, p.task_id, p.created_at, p.deleted_at,
           {_STARTED_AT} AS started_at
    FROM person p
    WHERE p.created_at >= CAST(:since AS timestamptz)
      AND p.created_at < CAST(:until AS timestamptz)
      -- 跑过（有首条消息）或有出片。
      AND (p.first_prompt_at IS NOT NULL
           OR p.conversation_id IN (SELECT v.conversation_id FROM videos v))
),
-- 没有成功镜的对话不在这里，每镜重试为空、也不标反复重试。
shot_totals AS (
    SELECT s.conversation_id,
           sum(s.attempts)::float8 / count(*)::float8 AS retries,
           max(s.attempts) AS most_attempts
    FROM shots s
    WHERE s.conversation_id IN (SELECT e.conversation_id FROM executions e)
    GROUP BY s.conversation_id
),
token_totals AS (
    SELECT u.conversation_id,
           sum(u.input_tokens + u.cache_read_tokens + u.cache_write_tokens + u.output_tokens)::bigint
               AS tokens
    FROM usage_rows u
    WHERE u.conversation_id IN (SELECT e.conversation_id FROM executions e)
    GROUP BY u.conversation_id
),
stuck_tasks AS (
    SELECT e.task_id
    FROM executions e
    WHERE e.task_id IS NOT NULL
    GROUP BY e.task_id
    HAVING count(*) >= CAST(:task_conversations AS int)
       AND e.task_id NOT IN (
           SELECT v.task_id FROM videos v WHERE v.delivered AND v.task_id IS NOT NULL)
),
judged AS (
    SELECT e.*, y.delivered_at, y.active_seconds::float8 AS cycle_seconds, t.retries,
           COALESCE(k.tokens, 0) AS tokens,
           -- 顺序固定：retry、stuck、spend、task_stuck；门槛为空的比较得 NULL，不标。
           array_remove(ARRAY[
               CASE WHEN t.most_attempts >= CAST(:retry_at_least AS int) THEN 'retry' END,
               CASE WHEN e.conversation_id IN (
                   SELECT v.conversation_id FROM videos v
                   WHERE v.status = 'submitted'
                     AND v.submitted_at < CAST(:stuck_before AS timestamptz)
               ) THEN 'stuck' END,
               CASE WHEN COALESCE(k.tokens, 0) > CAST(:spend_tokens AS float8) THEN 'spend' END,
               CASE WHEN e.task_id IN (SELECT q.task_id FROM stuck_tasks q) THEN 'task_stuck' END
           ], NULL) AS anomalies
    FROM executions e
    LEFT JOIN active_cycles y ON y.conversation_id = e.conversation_id
    LEFT JOIN shot_totals t ON t.conversation_id = e.conversation_id
    LEFT JOIN token_totals k ON k.conversation_id = e.conversation_id
),
scoped AS (
    SELECT j.*, {{key}} AS sort_key
    FROM judged j
    WHERE CAST(:user_name AS text) IS NULL OR j.user_name = CAST(:user_name AS text)
),
totals AS (
    SELECT count(*) AS total, count(*) FILTER (WHERE cardinality(s.anomalies) > 0) AS flagged
    FROM scoped s
)
-- 条数对整个筛选范围算；页挂在它上面 LEFT JOIN，空页也回一行条数、页列全空。
SELECT t.total, t.flagged, page.*
FROM totals t
LEFT JOIN LATERAL (
    SELECT s.*, tk.title AS task_title
    FROM scoped s
    LEFT JOIN iclip.tasks tk ON tk.id = s.task_id
    WHERE CAST(:after_id AS uuid) IS NULL
       OR (CAST(:after_value AS {{kind}}) IS NOT NULL
           AND (s.sort_key {{op}} CAST(:after_value AS {{kind}})
                OR (s.sort_key = CAST(:after_value AS {{kind}})
                    AND s.conversation_id {{op}} CAST(:after_id AS uuid))
                OR s.sort_key IS NULL))
       OR (CAST(:after_value AS {{kind}}) IS NULL
           AND s.sort_key IS NULL
           AND s.conversation_id {{op}} CAST(:after_id AS uuid))
    ORDER BY s.sort_key {{direction}} NULLS LAST, s.conversation_id {{direction}}
    LIMIT :limit
) page ON TRUE
ORDER BY page.sort_key {{direction}} NULLS LAST, page.conversation_id {{direction}}
"""

_SORT_KEYS: Final[Mapping[ExecutionSort, tuple[str, str]]] = {
    "start": ("j.created_at", "timestamptz"),
    "retries": ("j.retries", "float8"),
    "cycle": ("j.cycle_seconds", "float8"),
    "tokens": ("j.tokens", "bigint"),
}
_DIRECTIONS: Final[Mapping[SortOrder, tuple[str, str]]] = {
    "asc": ("ASC", ">"),
    "desc": ("DESC", "<"),
}
_EXECUTIONS_SQL: Final[Mapping[tuple[ExecutionSort, SortOrder], TextClause]] = {
    (sort, order): text(_EXECUTIONS.format(key=key, kind=kind, direction=direction, op=op))
    for sort, (key, kind) in _SORT_KEYS.items()
    for order, (direction, op) in _DIRECTIONS.items()
}

_SHOTS_OF: Final = text("""
SELECT s.conversation_id, s.shot, s.attempts, s.one_take, s.effective
FROM shots s
WHERE s.conversation_id = ANY(CAST(:ids AS uuid[]))
ORDER BY s.conversation_id, s.shot
""")

_USAGE_OF: Final = text("""
SELECT u.conversation_id, u.model_name, u.requests, u.input_tokens,
       u.cache_read_tokens, u.cache_write_tokens, u.output_tokens
FROM usage_rows u
WHERE u.conversation_id = ANY(CAST(:ids AS uuid[]))
ORDER BY u.conversation_id, u.model_name
""")


def _scope_params(scope: Scope) -> dict[str, Any]:
    return {
        "since": scope.since,
        "until": scope.until,
        "user_name": scope.user_name,
        "conversation_ids": None,
    }


def _float(value: Any) -> float | None:
    return None if value is None else float(value)


def _int(value: Any) -> int:
    return 0 if value is None else int(value)


def _total(value: Any) -> float:
    return 0.0 if value is None else float(value)


def _spread_of(row: RowMapping, prefix: str) -> SpreadOut | None:
    avg, median, p90 = (_float(row[f"{prefix}_{name}"]) for name in ("avg", "median", "p90"))
    if avg is None or median is None or p90 is None:
        return None
    return SpreadOut(avg=avg, median=median, p90=p90, count=_int(row[f"{prefix}_count"]))


def _usage_of(row: RowMapping) -> UsageOut:
    return UsageOut(
        requests=_int(row["requests"]),
        input_tokens=_int(row["input_tokens"]),
        cache_read_tokens=_int(row["cache_read_tokens"]),
        cache_write_tokens=_int(row["cache_write_tokens"]),
        output_tokens=_int(row["output_tokens"]),
    )


def _metrics_of(row: RowMapping) -> MetricsOut:
    return MetricsOut(
        completed_videos=_int(row["completed_videos"]),
        delivered_tasks=_int(row["delivered_tasks"]),
        delivered_orphan_conversations=_int(row["delivered_orphan_conversations"]),
        producers=_int(row["producers"]),
        shots=_int(row["shots"]),
        attempts=_int(row["attempts"]),
        one_take_shots=_int(row["one_take_shots"]),
        effective_shots=_int(row["effective_shots"]),
        runs=_int(row["runs"]),
        active_users=_int(row["active_users"]),
        delivered_conversations=_int(row["delivered_conversations"]),
        cycle_seconds=_spread_of(row, "cycle"),
        active_cycle_seconds=_spread_of(row, "active_cycle"),
        agent_run_seconds=_spread_of(row, "agent_run"),
        upstream_seconds=_spread_of(row, "upstream"),
        length_videos=_int(row["length_videos"]),
        length_seconds=_total(row["length_seconds"]),
        discarded_length_seconds=_total(row["discarded_length_seconds"]),
        usage=_usage_of(row),
    )


@asynccontextmanager
async def audit_connection(engine: AsyncEngine) -> AsyncGenerator[AsyncConnection]:
    async with engine.connect() as conn:
        await conn.execute(text("SET LOCAL jit = off"))
        yield conn


class PgAuditReports:
    def __init__(self, engine: AsyncEngine, stats: RuntimeStats) -> None:
        self._engine = engine
        self._stats = stats

    @asynccontextmanager
    async def snapshot(
        self, span: Scope, *, include_created: bool = False
    ) -> AsyncGenerator[PgAuditSnapshot]:
        bounds = {"since": span.since, "until": span.until}
        async with audit_connection(self._engine) as conn:
            delivered = (await conn.execute(_DELIVERED_CONVERSATIONS, bounds)).scalars().all()
            created = (
                (await conn.execute(_CREATED_CONVERSATIONS, bounds)).scalars().all()
                if include_created
                else ()
            )
        facts = await self._stats.facts(
            span.since, span.until, delivered=delivered, created=created
        )
        async with audit_connection(self._engine) as conn:
            params = facts.params()
            for statement in _BUILD_TABLES:
                await conn.execute(statement, params)
            yield PgAuditSnapshot(conn, span)


class PgAuditSnapshot:
    def __init__(self, conn: AsyncConnection, span: Scope) -> None:
        self._conn = conn
        self._span = span

    def _params(self, scope: Scope) -> dict[str, Any]:
        span = self._span
        if scope.since < span.since or (
            span.until is not None and (scope.until is None or scope.until > span.until)
        ):
            raise ValueError("筛选范围越出了快照的时间窗")
        return _scope_params(scope)

    async def _metrics(self, dimension: str, scope: Scope, **extra: Any) -> Sequence[RowMapping]:
        params = {**self._params(scope), **extra}
        return (await self._conn.execute(_METRICS_SQL[dimension], params)).mappings().all()

    async def overall(self, scope: Scope) -> MetricsOut:
        rows = await self._metrics("overall", scope)
        return _metrics_of(rows[0]) if rows else EMPTY_METRICS

    async def by_user(self, scope: Scope) -> Mapping[str, MetricsOut]:
        rows = await self._metrics("user", scope)
        return {str(row["k"]): _metrics_of(row) for row in rows}

    async def by_period(
        self, scope: Scope, *, bucket: OverviewBucket, timezone: str
    ) -> Sequence[PeriodMetricsOut]:
        rows = await self._metrics("period", scope, bucket=bucket, timezone=timezone)
        return [PeriodMetricsOut(period_start=row["k"], metrics=_metrics_of(row)) for row in rows]

    async def active_days(self, scope: Scope, *, timezone: str) -> int:
        params = {**self._params(scope), "timezone": timezone}
        return int((await self._conn.execute(_ACTIVE_DAYS, params)).scalar_one())

    async def delivery_units(
        self, scope: Scope, *, bucket: OverviewBucket, timezone: str
    ) -> Mapping[datetime, frozenset[str]]:
        params = {**self._params(scope), "bucket": bucket, "timezone": timezone}
        rows = (await self._conn.execute(_DELIVERY_UNITS, params)).mappings().all()
        return {row["k"]: frozenset(row["units"]) for row in rows}

    async def user_deliveries(
        self, scope: Scope, *, bucket: OverviewBucket, timezone: str
    ) -> Mapping[str, Mapping[datetime, int]]:
        params = {**self._params(scope), "bucket": bucket, "timezone": timezone}
        rows = (await self._conn.execute(_USER_DELIVERIES, params)).mappings().all()
        found: dict[str, dict[datetime, int]] = {}
        for row in rows:
            found.setdefault(row["user_name"], {})[row["k"]] = int(row["deliveries"])
        return found

    async def top_shots(self, scope: Scope, *, limit: int) -> Sequence[TopShotOut]:
        params = {**self._params(scope), "limit": limit}
        rows = (await self._conn.execute(_TOP_SHOTS, params)).mappings()
        return [
            TopShotOut(
                conversation_id=row["conversation_id"],
                title=row["title"],
                user_name=row["user_name"],
                shot=int(row["shot"]),
                attempts=int(row["attempts"]),
            )
            for row in rows
        ]

    async def attempt_distribution(self, scope: Scope) -> Sequence[AttemptBucketOut]:
        rows = (await self._conn.execute(_ATTEMPTS, self._params(scope))).mappings().all()
        return [
            AttemptBucketOut(attempts=_int(row["attempts"]), shots=_int(row["shots"]))
            for row in rows
        ]

    async def executions(
        self,
        scope: Scope,
        *,
        sort: ExecutionSort,
        order: SortOrder,
        limit: int,
        after: ExecutionCursor | None,
        spend_tokens: float | None,
        now: datetime,
    ) -> ExecutionPage:
        params = {
            **self._params(scope),
            "retry_at_least": RETRY_AT_LEAST,
            "task_conversations": TASK_CONVERSATIONS,
            "stuck_before": now - timedelta(hours=STUCK_HOURS),
            "spend_tokens": spend_tokens,
            "after_value": after.value if after else None,
            "after_id": after.conversation_id if after else None,
            "limit": limit,
        }
        rows = (await self._conn.execute(_EXECUTIONS_SQL[(sort, order)], params)).mappings().all()
        heads = [row for row in rows if row["conversation_id"] is not None]
        ids = [head["conversation_id"] for head in heads]
        metrics, shots, usage = await self._details(ids) if ids else ({}, {}, {})

        items = [
            ExecutionOut(
                conversation_id=head["conversation_id"],
                title=head["title"],
                user_name=head["user_name"],
                task_id=head["task_id"],
                task_title=head["task_title"],
                created_at=head["created_at"],
                started_at=head["started_at"],
                delivered_at=head["delivered_at"],
                deleted_at=head["deleted_at"],
                metrics=metrics.get(head["conversation_id"], EMPTY_METRICS),
                shots=shots.get(head["conversation_id"], []),
                usage=usage.get(head["conversation_id"], []),
                anomalies=list(head["anomalies"]),
            )
            for head in heads
        ]
        last = (
            ExecutionCursor(
                sort=sort,
                order=order,
                value=heads[-1]["sort_key"],
                conversation_id=heads[-1]["conversation_id"],
            )
            if heads
            else None
        )
        return ExecutionPage(
            items=items, total=_int(rows[0]["total"]), flagged=_int(rows[0]["flagged"]), last=last
        )

    async def _details(
        self, ids: Sequence[uuid.UUID]
    ) -> tuple[
        dict[uuid.UUID, MetricsOut],
        dict[uuid.UUID, list[ExecutionShotOut]],
        dict[uuid.UUID, list[ModelUsageOut]],
    ]:
        scoped = {"since": None, "until": None, "user_name": None, "conversation_ids": list(ids)}
        metric_rows = (
            (await self._conn.execute(_METRICS_SQL["conversation"], scoped)).mappings().all()
        )
        shot_rows = (await self._conn.execute(_SHOTS_OF, {"ids": list(ids)})).mappings().all()
        usage_rows = (await self._conn.execute(_USAGE_OF, {"ids": list(ids)})).mappings().all()

        shots: dict[uuid.UUID, list[ExecutionShotOut]] = {}
        for row in shot_rows:
            shots.setdefault(row["conversation_id"], []).append(
                ExecutionShotOut(
                    shot=int(row["shot"]),
                    attempts=int(row["attempts"]),
                    one_take=bool(row["one_take"]),
                    effective=bool(row["effective"]),
                )
            )
        usage: dict[uuid.UUID, list[ModelUsageOut]] = {}
        for row in usage_rows:
            usage.setdefault(row["conversation_id"], []).append(
                ModelUsageOut(model_name=row["model_name"], usage=_usage_of(row))
            )
        return {row["k"]: _metrics_of(row) for row in metric_rows}, shots, usage


__all__ = ["PgAuditReports", "PgAuditSnapshot", "audit_connection"]
