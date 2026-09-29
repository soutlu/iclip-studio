"""审计报表的 Postgres 查询：跨 ``iclip.*`` 与 ``agent_runtime.*`` 九张表只读聚合，不建表、不写入。

同一份指标 SQL 服务全体、人、时段、对话四个维度，差别只在六段 CTE 各自的分组键表达式
（``_DIMENSIONS``）——各指标的时间锚点不同，键要在各自的 CTE 里算。任务执行清单另有一条头查询，
按排序键与方向各备一份（``_EXECUTIONS_SQL``）。键表达式与方向都是本文件的常量，不来自外部输入；
外部输入一律走绑定参数。"""

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

# ---------------------------------------------------------------------------
# 公共 CTE。videos 是全部口径的基础：只认有镜号（shot_index 列）且挂着对话的出片，
# 需求单从对话取；视频的人是属主的用户名，request 里的 user_name 只发给上游、报表不读。
# 失败与还没出结果的出片不计费，镜、次数与成片都只看成功的；它们只进单任务时长的区间、
# 视频悬挂、任务执行的圈定，以及没跑过的对话按最近一条视频定人。
# person 给每段对话定一个人：最近一轮运行的 user_name，没有运行就取最近一条视频的属主。
# 分叉出来的副本一律不进报表（``forked_from`` 非空）：它继承的出片记在源对话名下，源那边
# 已经数过；副本自己跑的是试验数据。挡在 videos / person / runs / agent_runs 四个根 CTE 上，
# 其余口径都从它们派生。
# SQL 里的 'video' / 'generate' / 'completed' / 'submitted' 镜像生成域的 KIND_VIDEO /
# OPERATION_GENERATE / STATUS_COMPLETED / STATUS_SUBMITTED，'video.downloaded' 镜像埋点的
# VIDEO_DOWNLOADED，'run_started' / 'run_completed' / 'run_failed' 镜像官方运行持久化的
# 事件词表（报表按表名直接查，不 import 业务模块与引擎）；集成测试的种子取自那些常量或真跑
# 运行驱动，改词这里的用例就红。
# ---------------------------------------------------------------------------

_VIDEOS: Final = """
videos AS (
    SELECT g.id, g.conversation_id, g.status, g.created_at, g.submitted_at, g.finished_at,
           g.duration_ms,
           -- 成片：出成了且有完成时刻；各口径只引用这一列。
           (g.status = 'completed' AND g.finished_at IS NOT NULL) AS delivered,
           -- 有人下载过它或以它为原作的合成：下载的那条沿原作折回出片。子查询不相关，
           -- 整个集合只算一遍，逐行只做成员判断。
           g.id IN (
               SELECT COALESCE(d.root_job_id, d.id)
               FROM iclip.tracking_events t
               JOIN iclip.generation_jobs d ON d.id = t.job_id
               WHERE t.name = 'video.downloaded'
           ) AS downloaded,
           g.shot_index AS shot,
           u.username AS user_name,
           c.task_id
    FROM iclip.generation_jobs g
    JOIN iclip.conversations c ON c.id = g.conversation_id
    JOIN iclip.users u ON u.id = g.owner_user_id
    -- 出片 = 没有来源的视频 generate，且有镜号；编辑段与合成抄了原作的镜号，也一律不算。
    WHERE g.kind = 'video' AND g.operation = 'generate' AND g.source_job_id IS NULL
      AND g.shot_index IS NOT NULL
      AND c.forked_from IS NULL
)"""

# 每段对话最近一条出片的属主先对整个 videos 排一次序取出来再左连：videos 是物化的 CTE，逐行
# 取最近一条会对它每段对话全扫一遍。最近一轮运行走 agent_jobs 的（对话，建立时刻）索引，逐行无妨。
_PERSON: Final = """
latest_video_owner AS (
    SELECT DISTINCT ON (v.conversation_id) v.conversation_id, v.user_name
    FROM videos v
    ORDER BY v.conversation_id, v.created_at DESC, v.id DESC
),
person AS (
    SELECT c.id AS conversation_id, c.title, c.owner_user_id, c.task_id,
           c.created_at, c.updated_at, c.deleted_at,
           COALESCE(
               (SELECT j.user_name FROM agent_runtime.agent_jobs j
                WHERE j.conversation_id = c.id::text
                ORDER BY j.created_at DESC LIMIT 1),
               o.user_name
           ) AS user_name
    FROM iclip.conversations c
    LEFT JOIN latest_video_owner o ON o.conversation_id = c.id
    WHERE c.forked_from IS NULL
)"""

# 镜：（对话，镜号）至少成功生成过一条才算，次数只数成功的。时间锚点 first_at 是第一条成功
# 生成的完成时刻，last_at 是最后一条的；人取按完成时刻排第一的那条成功生成的属主。
_SHOTS: Final = """
shots AS (
    SELECT v.conversation_id, v.shot, v.task_id,
           count(*) AS attempts,
           min(v.finished_at) AS first_at,
           max(v.finished_at) AS last_at,
           count(*) = 1 AS one_take,
           bool_or(v.downloaded) AS effective,
           (array_agg(v.user_name ORDER BY v.finished_at, v.id))[1] AS user_name
    FROM videos v
    WHERE v.delivered
    GROUP BY v.conversation_id, v.shot, v.task_id
)"""

# 运行按发起人归属，不经 person；需求单从对话取。
_RUNS: Final = """
runs AS (
    SELECT j.created_at, j.user_name, c.id AS conversation_id, c.task_id
    FROM agent_runtime.agent_jobs j
    JOIN iclip.conversations c ON c.id::text = j.conversation_id
    WHERE c.forked_from IS NULL
)"""

# 一轮 agent 运行：同一 run_id 从 run_started 到第一条 run_completed / run_failed，没有终态的
# 不计。只认 agent_job_runs 里登记的 run_id——那是运行驱动发放的顶层运行；子代理的内部运行
# 另有自己的 run_id（带 parent_run_id），不在那张表里。人与需求单同 runs：发起人、对话挂的单。
_AGENT_RUNS: Final = """
agent_runs AS (
    SELECT j.user_name, c.id AS conversation_id, c.task_id,
           min(e.timestamp) FILTER (WHERE e.kind = 'run_started') AS started_at,
           min(e.timestamp) FILTER (WHERE e.kind IN ('run_completed', 'run_failed')) AS ended_at
    FROM agent_runtime.agent_job_runs r
    JOIN agent_runtime.agent_jobs j ON j.prompt_id = r.prompt_id
    JOIN iclip.conversations c ON c.id::text = j.conversation_id
    JOIN agent_runtime.events e ON e.run_id = r.run_id
    WHERE c.forked_from IS NULL
      AND e.kind IN ('run_started', 'run_completed', 'run_failed')
    GROUP BY r.run_id, j.user_name, c.id, c.task_id
    HAVING bool_or(e.kind = 'run_started')
       AND bool_or(e.kind IN ('run_completed', 'run_failed'))
)"""

# 一段对话的起点：首次运行，没有运行就是对话建立时刻。交付周期与任务执行的开始都用它。
_STARTED_AT: Final = """COALESCE(
               (SELECT min(j.created_at) FROM agent_runtime.agent_jobs j
                WHERE j.conversation_id = {conversation}::text),
               {created}
           )"""

_CYCLES: Final = f"""
cycles AS (
    SELECT d.conversation_id, p.user_name, p.task_id, d.delivered_at,
           {_STARTED_AT.format(conversation="d.conversation_id", created="p.created_at")}
               AS started_at
    FROM (
        SELECT v.conversation_id, max(v.finished_at) AS delivered_at
        FROM videos v
        WHERE v.delivered
        GROUP BY v.conversation_id
    ) d
    JOIN person p ON p.conversation_id = d.conversation_id
)"""

# 单任务时长：每段有成片的对话一个样本，锚点同交付周期。区间 = 这段对话有终态的运行
# [开始, 终态] ∪ 每条出片 [受理, 完成]（没完成的只是受理那一刻），裁进交付周期 [起点, 最后成片]；
# 按开始排序合并，下一段的开始距已合并段的结束不超过 30 分钟就并进来、空档照算，超过就断开、
# 空档不计。已合并段的结束是排在前面的全部区间结束的最大值；样本值是各合并段长度之和。
_ACTIVE_CYCLES: Final = """
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
           sum(CASE WHEN m.reach IS NULL OR m.s > m.reach + interval '30 minutes' THEN 1 ELSE 0 END)
               OVER (PARTITION BY m.conversation_id ORDER BY m.s, m.e
                     ROWS UNBOUNDED PRECEDING) AS island
    FROM cycle_reach m
),
island_spans AS (
    SELECT l.conversation_id, max(l.e) - min(l.s) AS span
    FROM cycle_islands l
    GROUP BY l.conversation_id, l.island
),
active_cycles AS (
    SELECT y.conversation_id, y.user_name, y.task_id, y.started_at, y.delivered_at,
           COALESCE(sum(extract(epoch FROM w.span)), 0) AS active_seconds
    FROM cycles y
    LEFT JOIN island_spans w ON w.conversation_id = y.conversation_id
    GROUP BY y.conversation_id, y.user_name, y.task_id, y.started_at, y.delivered_at
)"""

# 成片连同废片标记：同一镜（对话 + 镜号）全时段按完成时刻、再按 id 排最后的那条以外都是废片。
# 窗口函数在全量上算，时间窗与筛选只能施加在引用它的 CTE 里，否则「全时段最后一条」会退化成
# 窗内或某人名下的最后一条。
_TAKES: Final = """
takes AS (
    SELECT v.*,
           row_number() OVER (PARTITION BY v.conversation_id, v.shot
                              ORDER BY v.finished_at DESC, v.id DESC) > 1 AS discarded
    FROM videos v
    WHERE v.delivered
)"""

_USAGE: Final = """
usage_rows AS (
    SELECT c.id AS conversation_id, p.user_name, p.task_id, u.model_name,
           u.requests, u.input_tokens, u.cache_read_tokens, u.cache_write_tokens,
           u.output_tokens, u.last_at
    FROM agent_runtime.conversation_usage u
    JOIN iclip.conversations c ON c.id::text = u.conversation_id
    JOIN person p ON p.conversation_id = c.id
)"""

# 筛选片段。占位 {t} 是各 CTE 的表别名，{anchor} 是该指标的时间锚点列。
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


# 时段维度把有界时间窗内的每一期都列进 keys，没数据的期计数为 0、分布为 NULL；
# 不限时间没有起点，只列有数据的期。上界减一微秒，until 恰在期首时不多出一期。
_PERIOD_AXIS: Final = """
    UNION SELECT axis FROM generate_series(
        date_trunc(CAST(:bucket AS text), CAST(:since AS timestamptz), CAST(:timezone AS text)),
        date_trunc(CAST(:bucket AS text),
                   COALESCE(CAST(:until AS timestamptz), now()) - interval '1 microsecond',
                   CAST(:timezone AS text)),
        CAST('1 ' || CAST(:bucket AS text) AS interval),
        CAST(:timezone AS text)) AS axis"""

_METRICS: Final = f"""
WITH {_VIDEOS}, {_PERSON}, {_SHOTS}, {_RUNS}, {_AGENT_RUNS}, {_CYCLES}, {_ACTIVE_CYCLES},
{_TAKES}, {_USAGE},
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
    """一个维度在六段 CTE 里各自的分组键表达式；``axis`` 是补进 keys 的空期。"""

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
    # 全体用非空常量做键，六段才能按键对上。
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

# 成功生成次数分布：每镜一条记录，按成功次数分档。锚点同镜，看该镜第一条成功生成的完成时刻。
# 不封顶，累计通过曲线与集中度都在前端从这份原始分布算，SQL 只负责分档计数。
_ATTEMPTS: Final = text(f"""
WITH {_VIDEOS}, {_SHOTS}
SELECT s.attempts, count(*) AS shots
FROM shots s
WHERE TRUE
{_WINDOW.format(anchor="s.first_at")}
{_FILTERS.format(t="s")}
GROUP BY s.attempts
ORDER BY s.attempts
""")

# 活跃日：时间窗里有人发起运行的本地日，锚点同运行次数，只看窗内的运行。
_ACTIVE_DAYS: Final = text(f"""
WITH {_RUNS}
SELECT count(DISTINCT date_trunc('day', r.created_at, CAST(:timezone AS text))) AS days
FROM runs r
WHERE TRUE
{_WINDOW.format(anchor="r.created_at")}
{_FILTERS.format(t="r")}
""")

# 每个时段里有成片的件，键与成片件数同一口径：需求单各一件，没挂需求单的对话各一件。
_DELIVERY_UNITS: Final = text(f"""
WITH {_VIDEOS}
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

# 每人每个时段的成片件数，与成片件数同一口径：需求单各一件，没挂需求单的对话各一件。人是视频
# 的属主，与指标 SQL 的人维度一致；属主没有用户名的不归任何人。
_USER_DELIVERIES: Final = text(f"""
WITH {_VIDEOS}
SELECT v.user_name, {_BUCKET.format(anchor="v.finished_at")} AS k,
       count(DISTINCT v.task_id)
           + count(DISTINCT v.conversation_id) FILTER (WHERE v.task_id IS NULL) AS deliveries
FROM videos v
WHERE v.delivered AND v.user_name IS NOT NULL
{_WINDOW.format(anchor="v.finished_at")}
GROUP BY 1, 2
""")

# 成功生成次数最多的镜，同数按最后一条成功生成的完成时刻；标题与人取对话的，已删的对话照列。
# 锚点同镜。
_TOP_SHOTS: Final = text(f"""
WITH {_VIDEOS}, {_PERSON}, {_SHOTS}
SELECT s.conversation_id, s.shot, s.attempts, p.title, p.user_name
FROM shots s
JOIN person p ON p.conversation_id = s.conversation_id
WHERE TRUE
{_WINDOW.format(anchor="s.first_at")}
{_FILTERS.format(t="s")}
ORDER BY s.attempts DESC, s.last_at DESC, s.conversation_id, s.shot
LIMIT :limit
""")

# ---------------------------------------------------------------------------
# 任务执行：建立时刻落在时间窗里、有运行或出片的对话（副本已由 person 挡掉，已删的照列）。
# 排序键与异常都按这段对话的全量算，不按时间窗裁；user_name 只筛行，放在最后一步，需求单卡住
# 按整个时间窗里的执行判。「从来没有成片」按 videos 判，副本自己的出片本就不计。视频悬挂的
# 'submitted' 镜像生成域的 STATUS_SUBMITTED（同文件头）。
# 排序键空值不论升降都排最后；翻页从上一页末行的（键，对话 id）接着取，末行已在空值尾段时
# 只在尾段里按对话 id 往后取。{key} / {kind} / {direction} / {op} 由 _EXECUTIONS_SQL 从常量填。
# ---------------------------------------------------------------------------

_EXECUTIONS: Final = f"""
WITH {_VIDEOS}, {_PERSON}, {_SHOTS}, {_AGENT_RUNS}, {_CYCLES}, {_ACTIVE_CYCLES},
executions AS (
    SELECT p.conversation_id, p.title, p.user_name, p.task_id, p.created_at, p.deleted_at,
           {_STARTED_AT.format(conversation="p.conversation_id", created="p.created_at")}
               AS started_at
    FROM person p
    WHERE p.created_at >= CAST(:since AS timestamptz)
      AND p.created_at < CAST(:until AS timestamptz)
      -- 对 videos 用不相关的 IN：整个集合哈希一次；逐行 EXISTS 会对物化的 CTE 每行全扫一遍。
      AND (EXISTS (SELECT 1 FROM agent_runtime.agent_jobs j
                   WHERE j.conversation_id = p.conversation_id::text)
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
    SELECT c.id AS conversation_id,
           sum(u.input_tokens + u.cache_read_tokens + u.cache_write_tokens + u.output_tokens)::bigint
               AS tokens
    FROM agent_runtime.conversation_usage u
    JOIN iclip.conversations c ON c.id::text = u.conversation_id
    WHERE c.id IN (SELECT e.conversation_id FROM executions e)
    GROUP BY c.id
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

# 排序键在 judged 上的列与它的 SQL 类型：retries / cycle 是 float8、tokens 是 bigint，游标回带的
# 取值与列同类型，相等比较才不会差一点而重复或漏行。
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

# 一页对话里成功过的镜，按镜号。
_SHOTS_OF: Final = text(f"""
WITH {_VIDEOS}, {_SHOTS}
SELECT s.conversation_id, s.shot, s.attempts, s.one_take, s.effective
FROM shots s
WHERE s.conversation_id = ANY(CAST(:ids AS uuid[]))
ORDER BY s.conversation_id, s.shot
""")

_USAGE_OF: Final = text("""
SELECT c.id AS conversation_id, u.model_name, u.requests, u.input_tokens,
       u.cache_read_tokens, u.cache_write_tokens, u.output_tokens
FROM agent_runtime.conversation_usage u
JOIN iclip.conversations c ON c.id::text = u.conversation_id
WHERE c.id = ANY(CAST(:ids AS uuid[]))
ORDER BY c.id, u.model_name
""")


def _scope_params(
    scope: Scope, *, conversation_ids: Sequence[uuid.UUID] | None = None
) -> dict[str, Any]:
    return {
        "since": scope.since,
        "until": scope.until,
        "user_name": scope.user_name,
        "conversation_ids": list(conversation_ids) if conversation_ids is not None else None,
    }


def _float(value: Any) -> float | None:
    """聚合列可能是 numeric / Decimal，也可能因为没有样本而是 NULL。"""

    return None if value is None else float(value)


def _int(value: Any) -> int:
    """LEFT JOIN 没对上的计数列是 NULL，按 0 读。"""

    return 0 if value is None else int(value)


def _total(value: Any) -> float:
    """LEFT JOIN 没对上的合计列是 NULL，按 0 读。"""

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
    """审计读查询的连接：本事务里关掉 JIT，连接归还时随回滚复位，不带给池里的其他用途。

    审计 SQL 的代价估算偏高，默认会触发 JIT，编译比真正执行慢一个数量级。``SET LOCAL`` 只在
    事务里生效：``connect()`` 在第一条语句前自动开事务，它就是这个事务的第一条语句。
    """

    async with engine.connect() as conn:
        await conn.execute(text("SET LOCAL jit = off"))
        yield conn


class PgAuditReports:
    """``AuditReports`` 的 Postgres 实现。每个方法一个连接、只读，都经 ``audit_connection``。"""

    def __init__(self, engine: AsyncEngine) -> None:
        self._engine = engine

    async def _metrics(
        self, dimension: str, params: dict[str, Any], *, conn: AsyncConnection | None = None
    ) -> Sequence[RowMapping]:
        statement = _METRICS_SQL[dimension]
        if conn is not None:
            return (await conn.execute(statement, params)).mappings().all()
        async with audit_connection(self._engine) as fresh:
            return (await fresh.execute(statement, params)).mappings().all()

    async def overall(self, scope: Scope) -> MetricsOut:
        rows = await self._metrics("overall", _scope_params(scope))
        return _metrics_of(rows[0]) if rows else EMPTY_METRICS

    async def by_user(self, scope: Scope) -> Mapping[str, MetricsOut]:
        rows = await self._metrics("user", _scope_params(scope))
        return {str(row["k"]): _metrics_of(row) for row in rows}

    async def by_period(
        self, scope: Scope, *, bucket: OverviewBucket, timezone: str
    ) -> Sequence[PeriodMetricsOut]:
        params = {**_scope_params(scope), "bucket": bucket, "timezone": timezone}
        rows = await self._metrics("period", params)
        return [PeriodMetricsOut(period_start=row["k"], metrics=_metrics_of(row)) for row in rows]

    async def active_days(self, scope: Scope, *, timezone: str) -> int:
        async with audit_connection(self._engine) as conn:
            days = (
                await conn.execute(_ACTIVE_DAYS, {**_scope_params(scope), "timezone": timezone})
            ).scalar_one()
        return int(days)

    async def delivery_units(
        self, scope: Scope, *, bucket: OverviewBucket, timezone: str
    ) -> Mapping[datetime, frozenset[str]]:
        params = {**_scope_params(scope), "bucket": bucket, "timezone": timezone}
        async with audit_connection(self._engine) as conn:
            rows = (await conn.execute(_DELIVERY_UNITS, params)).mappings().all()
        return {row["k"]: frozenset(row["units"]) for row in rows}

    async def user_deliveries(
        self, scope: Scope, *, bucket: OverviewBucket, timezone: str
    ) -> Mapping[str, Mapping[datetime, int]]:
        params = {
            "since": scope.since,
            "until": scope.until,
            "bucket": bucket,
            "timezone": timezone,
        }
        async with audit_connection(self._engine) as conn:
            rows = (await conn.execute(_USER_DELIVERIES, params)).mappings().all()
        found: dict[str, dict[datetime, int]] = {}
        for row in rows:
            found.setdefault(row["user_name"], {})[row["k"]] = int(row["deliveries"])
        return found

    async def top_shots(self, scope: Scope, *, limit: int) -> Sequence[TopShotOut]:
        async with audit_connection(self._engine) as conn:
            rows = (
                await conn.execute(_TOP_SHOTS, {**_scope_params(scope), "limit": limit})
            ).mappings()
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
        async with audit_connection(self._engine) as conn:
            rows = (await conn.execute(_ATTEMPTS, _scope_params(scope))).mappings().all()
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
            "since": scope.since,
            "until": scope.until,
            "user_name": scope.user_name,
            "retry_at_least": RETRY_AT_LEAST,
            "task_conversations": TASK_CONVERSATIONS,
            "stuck_before": now - timedelta(hours=STUCK_HOURS),
            "spend_tokens": spend_tokens,
            "after_value": after.value if after else None,
            "after_id": after.conversation_id if after else None,
            "limit": limit,
        }
        async with audit_connection(self._engine) as conn:
            rows = (await conn.execute(_EXECUTIONS_SQL[(sort, order)], params)).mappings().all()
            heads = [row for row in rows if row["conversation_id"] is not None]
            ids = [head["conversation_id"] for head in heads]
            metrics, shots, usage = await self._details(conn, ids) if ids else ({}, {}, {})

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
        self, conn: AsyncConnection, ids: Sequence[uuid.UUID]
    ) -> tuple[
        dict[uuid.UUID, MetricsOut],
        dict[uuid.UUID, list[ExecutionShotOut]],
        dict[uuid.UUID, list[ModelUsageOut]],
    ]:
        """一页对话的全量指标、镜与按模型用量；不带时间窗，用维度键圈定这一页的对话。"""

        metric_rows = await self._metrics(
            "conversation", _scope_params(Scope(), conversation_ids=ids), conn=conn
        )
        shot_rows = (await conn.execute(_SHOTS_OF, {"ids": list(ids)})).mappings().all()
        usage_rows = (await conn.execute(_USAGE_OF, {"ids": list(ids)})).mappings().all()

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


__all__ = ["PgAuditReports", "audit_connection"]
