"""审计报表用例：把查询参数整理成筛选范围，负责游标与参数校验，拼装总览、按人与任务执行。
治理者权限由路由声明。"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Final, overload
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from iclip.common.errors import ValidationFailed
from iclip.domains.audit.executions import (
    RETRY_AT_LEAST,
    SPEND_TIMES,
    STUCK_HOURS,
    TASK_CONVERSATIONS,
    decode_execution_cursor,
    encode_execution_cursor,
    spend_tokens,
)
from iclip.domains.audit.models import ExecutionSort, Scope, SortOrder
from iclip.domains.audit.overview import (
    OverviewWindow,
    build_cells,
    fill_periods,
    head_cell,
    period_starts,
    plan_window,
    trend,
)
from iclip.domains.audit.repository import AuditReports
from iclip.domains.audit.schemas import (
    AuditExecutionsOut,
    AuditPeopleOut,
    ExecutionThresholdsOut,
    OverviewOut,
    OverviewPeriodOut,
    OverviewWindowOut,
    PersonOut,
    TrendPointOut,
)
from iclip.platform.paging import check_limit

TOP_SHOT_COUNT: Final = 3


@overload
def _as_utc(moment: datetime) -> datetime: ...
@overload
def _as_utc(moment: None) -> None: ...
@overload
def _as_utc(moment: datetime | None) -> datetime | None: ...
def _as_utc(moment: datetime | None) -> datetime | None:
    """无时区输入按 UTC 解释，避免与 timestamptz 比较时驱动报错。"""

    if moment is None or moment.tzinfo is not None:
        return moment
    return moment.replace(tzinfo=UTC)


def _check_timezone(name: str) -> str:
    try:
        ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError) as exc:
        raise ValidationFailed(f"timezone 不是一个可识别的时区名: {name}") from exc
    return name


class AuditService:
    def __init__(self, reports: AuditReports) -> None:
        self._reports = reports

    async def overview(
        self, *, since: datetime, until: datetime | None = None, timezone: str = "UTC"
    ) -> OverviewOut:
        """审计总览：本期与上一期整段各查一次，趋势按粒度分期；时间窗与均线规则见 overview.py。"""

        now = datetime.now(UTC)
        window = plan_window(
            since=_as_utc(since),
            until=_as_utc(until),
            zone=ZoneInfo(_check_timezone(timezone)),
            now=now,
        )
        current = Scope(since=window.since, until=window.until)
        previous = Scope(since=window.previous_since, until=window.previous_until)
        return OverviewOut(
            window=OverviewWindowOut(
                since=window.since,
                until=window.until,
                previous_since=window.previous_since,
                previous_until=window.previous_until,
                bucket=window.bucket,
                timezone=timezone,
                generated_at=now,
            ),
            current=await self._period(current, timezone),
            previous=await self._period(previous, timezone),
            series=await self._series(window, timezone),
            attempt_distribution=list(await self._reports.attempt_distribution(current)),
            top_shots=list(await self._reports.top_shots(current, limit=TOP_SHOT_COUNT)),
        )

    async def _period(self, scope: Scope, timezone: str) -> OverviewPeriodOut:
        return OverviewPeriodOut(
            metrics=await self._reports.overall(scope),
            active_days=await self._reports.active_days(scope, timezone=timezone),
        )

    async def _series(self, window: OverviewWindow, timezone: str) -> list[TrendPointOut]:
        """按周直接切本期；按小时 / 按天先铺回看下限起的基础格，均线从格里补窗。"""

        current = Scope(since=window.since, until=window.until)
        if window.bucket == "week":
            rows = await self._reports.by_period(current, bucket="week", timezone=timezone)
            return [
                TrendPointOut(
                    period_start=row.period_start,
                    inactive=False,
                    metrics=row.metrics,
                    ma7=None,
                    ma30=None,
                )
                for row in rows
            ]
        grid = Scope(since=window.lookback, until=window.until)
        rows = await self._reports.by_period(grid, bucket=window.grid, timezone=timezone)
        units = await self._reports.delivery_units(grid, bucket=window.grid, timezone=timezone)
        cells = build_cells(rows, units, until=window.until)
        head = head_cell(cells, window.since)
        # since 不在格边界上时，首期只算 since 之后的，与按周的首期同一规则；均线仍用整格。
        head_metrics = (
            await self._reports.overall(Scope(since=window.since, until=head.end))
            if head.start < window.since
            else None
        )
        return trend(cells, window, head_metrics=head_metrics)

    async def people(
        self, *, since: datetime, until: datetime | None = None, timezone: str = "UTC"
    ) -> AuditPeopleOut:
        """时间窗里出过片或跑过的人，成片多的在前、再看运行次数、同数按名字；时间窗与粒度同总览。"""

        window = plan_window(
            since=_as_utc(since),
            until=_as_utc(until),
            zone=ZoneInfo(_check_timezone(timezone)),
            now=datetime.now(UTC),
        )
        scope = Scope(since=window.since, until=window.until)
        metrics = await self._reports.by_user(scope)
        deliveries = await self._reports.user_deliveries(
            scope, bucket=window.bucket, timezone=timezone
        )
        starts = period_starts(window)
        active = sorted(
            (
                (name, found)
                for name, found in metrics.items()
                if found.deliveries > 0 or found.runs > 0
            ),
            key=lambda item: (-item[1].deliveries, -item[1].runs, item[0]),
        )
        return AuditPeopleOut(
            bucket=window.bucket,
            items=[
                PersonOut(
                    user_name=name,
                    metrics=found,
                    trend=fill_periods(starts, deliveries.get(name, {})),
                )
                for name, found in active
            ],
        )

    async def executions(
        self,
        *,
        since: datetime,
        until: datetime | None = None,
        user_name: str | None = None,
        sort: ExecutionSort = "start",
        order: SortOrder = "desc",
        limit: int = 20,
        cursor: str | None = None,
    ) -> AuditExecutionsOut:
        """任务执行一页；``until`` 为空或晚于此刻按此刻。消耗离群的基准按整个时间窗算，不看
        ``user_name``。满页才给下一页游标，游标只对发它的那种排序与方向有效。"""

        check_limit(limit)
        now = datetime.now(UTC)
        start = _as_utc(since)
        end = _as_utc(until)
        if end is None or end > now:
            end = now
        if start >= end:
            raise ValidationFailed("since 必须早于 until")
        after = None if cursor is None else decode_execution_cursor(cursor, sort=sort, order=order)
        baseline = await self._reports.overall(Scope(since=start, until=end))
        threshold = spend_tokens(baseline.tokens_per_delivery)
        page = await self._reports.executions(
            Scope(since=start, until=end, user_name=user_name),
            sort=sort,
            order=order,
            limit=limit,
            after=after,
            spend_tokens=threshold,
            now=now,
        )
        next_cursor = (
            encode_execution_cursor(page.last)
            if page.last is not None and len(page.items) == limit
            else None
        )
        return AuditExecutionsOut(
            items=list(page.items),
            next_cursor=next_cursor,
            total=page.total,
            flagged=page.flagged,
            thresholds=ExecutionThresholdsOut(
                retry_at_least=RETRY_AT_LEAST,
                stuck_hours=STUCK_HOURS,
                spend_times=SPEND_TIMES,
                task_conversations=TASK_CONVERSATIONS,
                spend_tokens=threshold,
            ),
        )


__all__ = ["AuditService"]
