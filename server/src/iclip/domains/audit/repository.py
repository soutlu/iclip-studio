from __future__ import annotations

from collections.abc import Mapping, Sequence
from contextlib import AbstractAsyncContextManager
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
    items: Sequence[ExecutionOut]
    total: int
    flagged: int
    last: ExecutionCursor | None


class AuditSnapshot(Protocol):
    async def overall(self, scope: Scope) -> MetricsOut: ...

    async def by_user(self, scope: Scope) -> Mapping[str, MetricsOut]: ...

    async def by_period(
        self, scope: Scope, *, bucket: OverviewBucket, timezone: str
    ) -> Sequence[PeriodMetricsOut]: ...

    async def active_days(self, scope: Scope, *, timezone: str) -> int: ...

    async def delivery_units(
        self, scope: Scope, *, bucket: OverviewBucket, timezone: str
    ) -> Mapping[datetime, frozenset[str]]: ...

    async def user_deliveries(
        self, scope: Scope, *, bucket: OverviewBucket, timezone: str
    ) -> Mapping[str, Mapping[datetime, int]]: ...

    async def top_shots(self, scope: Scope, *, limit: int) -> Sequence[TopShotOut]: ...

    async def attempt_distribution(self, scope: Scope) -> Sequence[AttemptBucketOut]: ...

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
    ) -> ExecutionPage: ...


class AuditReports(Protocol):
    def snapshot(
        self, span: Scope, *, include_created: bool = False
    ) -> AbstractAsyncContextManager[AuditSnapshot]: ...


__all__ = ["AuditReports", "AuditSnapshot", "ExecutionPage"]
