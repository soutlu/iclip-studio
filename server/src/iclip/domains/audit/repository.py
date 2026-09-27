"""审计报表的读取协议。实现在 reports_pg.py，服务层只依赖这里。"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import datetime
from typing import Protocol

from iclip.domains.audit.models import (
    AnomalyCursor,
    AnomalyKind,
    ConversationCursor,
    PeriodBucket,
    Scope,
    Thresholds,
)
from iclip.domains.audit.schemas import (
    AnomalyCountOut,
    AnomalyOut,
    AttemptBucketOut,
    ConversationAuditOut,
    MetricsOut,
    PeriodMetricsOut,
    TaskMetricsOut,
    TopShotOut,
    UserMetricsOut,
)


class AuditReports(Protocol):
    async def overall(self, scope: Scope) -> MetricsOut:
        """整个筛选范围一格。"""
        ...

    async def by_user(self, scope: Scope) -> Sequence[UserMetricsOut]:
        """每个有动静的人一行，成片件数多的排前面。"""
        ...

    async def by_task(self, scope: Scope) -> Sequence[TaskMetricsOut]:
        """每张有动静的需求单一行；没挂需求单的对话不在这里。"""
        ...

    async def by_period(
        self, scope: Scope, *, bucket: PeriodBucket, timezone: str
    ) -> Sequence[PeriodMetricsOut]:
        """按 ``timezone`` 的小时 / 日 / 周 / 月切时段，每段一行，早的排前面。"""
        ...

    async def active_days(self, scope: Scope, *, timezone: str) -> int:
        """时间窗里有人发起运行的 ``timezone`` 本地日数；只看窗内的运行，部分覆盖的日也算。"""
        ...

    async def delivery_units(
        self, scope: Scope, *, bucket: PeriodBucket, timezone: str
    ) -> Mapping[datetime, frozenset[str]]:
        """每个时段里有成片的件：需求单 id，没挂需求单的是 ``c:`` 加对话 id；锚点同成片件数。

        只列有成片的时段。跨时段求件数时对集合取并，与 ``MetricsOut.deliveries`` 同一口径。
        """
        ...

    async def top_shots(self, scope: Scope, *, limit: int) -> Sequence[TopShotOut]:
        """出片次数最多的镜，多的在前、同数最近出过片的在前；时间窗作用在该镜首次出片时刻上。"""
        ...

    async def attempt_distribution(self, scope: Scope) -> Sequence[AttemptBucketOut]:
        """出片次数分布，次数少的排前面；时间窗作用在该镜首次出片时刻上。不封顶。"""
        ...

    async def conversations(
        self, scope: Scope, *, limit: int, after: ConversationCursor | None
    ) -> Sequence[ConversationAuditOut]:
        """有成片的对话，最后成片晚的排前面；时间窗作用在最后成片时刻上。"""
        ...

    async def anomalies(
        self,
        scope: Scope,
        thresholds: Thresholds,
        *,
        kinds: Sequence[AnomalyKind] | None,
        limit: int,
        after: AnomalyCursor | None,
    ) -> Sequence[AnomalyOut]:
        """异常按发生时刻倒序；``kinds`` 为 ``None`` 时全部种类都要。"""
        ...

    async def anomaly_counts(
        self, scope: Scope, thresholds: Thresholds
    ) -> Sequence[AnomalyCountOut]:
        """整个筛选范围里每种异常各有几条，只列出现过的种类，多的排前面。"""
        ...


__all__ = ["AuditReports"]
