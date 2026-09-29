"""审计报表的读取协议。实现在 reports_pg.py，服务层只依赖这里。"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Protocol

from iclip.domains.audit.executions import ExecutionCursor
from iclip.domains.audit.models import ExecutionSort, OverviewBucket, Scope, SortOrder
from iclip.domains.audit.schemas import (
    AttemptBucketOut,
    ExecutionOut,
    MetricsOut,
    PeriodMetricsOut,
    TopShotOut,
)


@dataclass(frozen=True, slots=True)
class ExecutionPage:
    """任务执行的一页，连同整个筛选范围的条数与命中异常的条数。"""

    items: Sequence[ExecutionOut]
    total: int
    flagged: int
    last: ExecutionCursor | None
    """本页末行的位置；空页为空。"""


class AuditReports(Protocol):
    async def overall(self, scope: Scope) -> MetricsOut:
        """整个筛选范围一格。"""
        ...

    async def by_user(self, scope: Scope) -> Mapping[str, MetricsOut]:
        """每个有动静的人一格，键是用户名；属主没有用户名的视频不归任何人，不在这里。"""
        ...

    async def by_period(
        self, scope: Scope, *, bucket: OverviewBucket, timezone: str
    ) -> Sequence[PeriodMetricsOut]:
        """按 ``timezone`` 的小时 / 日 / 周切时段，每段一行，早的排前面。"""
        ...

    async def active_days(self, scope: Scope, *, timezone: str) -> int:
        """时间窗里有人发起运行的 ``timezone`` 本地日数；只看窗内的运行，部分覆盖的日也算。"""
        ...

    async def delivery_units(
        self, scope: Scope, *, bucket: OverviewBucket, timezone: str
    ) -> Mapping[datetime, frozenset[str]]:
        """每个时段里有成片的件：需求单 id，没挂需求单的是 ``c:`` 加对话 id；锚点同成片件数。

        只列有成片的时段。跨时段求件数时对集合取并，与 ``MetricsOut.deliveries`` 同一口径。
        """
        ...

    async def user_deliveries(
        self, scope: Scope, *, bucket: OverviewBucket, timezone: str
    ) -> Mapping[str, Mapping[datetime, int]]:
        """每人每个时段的成片件数，与 ``MetricsOut.deliveries`` 同一口径；只列有成片的时段。"""
        ...

    async def top_shots(self, scope: Scope, *, limit: int) -> Sequence[TopShotOut]:
        """成功生成次数最多的镜，多的在前、同数最后一条成功生成完成晚的在前；时间窗作用在该镜
        第一条成功生成的完成时刻上。"""
        ...

    async def attempt_distribution(self, scope: Scope) -> Sequence[AttemptBucketOut]:
        """成功生成次数分布，次数少的排前面；时间窗作用在该镜第一条成功生成的完成时刻上。不封顶。"""
        ...

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
        """建立时刻落在 ``[since, until)`` 里、有运行或出片的对话，按排序键翻页，空值恒在最后。

        ``user_name`` 只筛行；需求单卡住按整个时间窗判，消耗离群的门槛 ``spend_tokens`` 由调用方
        给，为空即谁都不标；视频悬挂以 ``now`` 往前推门槛小时数判。
        """
        ...


__all__ = ["AuditReports", "ExecutionPage"]
