from __future__ import annotations

from datetime import UTC, datetime
from typing import Final, overload
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from agent_runtime.errors import ValidationFailed

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
from iclip.domains.audit.repository import AuditReports, AuditSnapshot
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
    if moment is None or moment.tzinfo is not None:
        return moment
    return moment.replace(tzinfo=UTC)


def _check_timezone(name: str) -> str:
    try:
        ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError) as exc:
        raise ValidationFailed(f"timezone 不是一个可识别的时区名: {name}") from exc
    return name


async def _period(reports: AuditSnapshot, scope: Scope, timezone: str) -> OverviewPeriodOut:
    return OverviewPeriodOut(
        metrics=await reports.overall(scope),
        active_days=await reports.active_days(scope, timezone=timezone),
    )


async def _series(
    reports: AuditSnapshot, window: OverviewWindow, timezone: str
) -> list[TrendPointOut]:
    current = Scope(since=window.since, until=window.until)
    if window.bucket == "week":
        rows = await reports.by_period(current, bucket="week", timezone=timezone)
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
    rows = await reports.by_period(grid, bucket=window.grid, timezone=timezone)
    units = await reports.delivery_units(grid, bucket=window.grid, timezone=timezone)
    cells = build_cells(rows, units, until=window.until)
    head = head_cell(cells, window.since)
    head_metrics = (
        await reports.overall(Scope(since=window.since, until=head.end))
        if head.start < window.since
        else None
    )
    return trend(cells, window, head_metrics=head_metrics)


class AuditService:
    def __init__(self, reports: AuditReports) -> None:
        self._reports = reports

    async def overview(
        self, *, since: datetime, until: datetime | None = None, timezone: str = "UTC"
    ) -> OverviewOut:
        now = datetime.now(UTC)
        window = plan_window(
            since=_as_utc(since),
            until=_as_utc(until),
            zone=ZoneInfo(_check_timezone(timezone)),
            now=now,
        )
        current = Scope(since=window.since, until=window.until)
        previous = Scope(since=window.previous_since, until=window.previous_until)
        span = Scope(since=window.lookback, until=window.until)
        async with self._reports.snapshot(span) as reports:
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
                current=await _period(reports, current, timezone),
                previous=await _period(reports, previous, timezone),
                series=await _series(reports, window, timezone),
                attempt_distribution=list(await reports.attempt_distribution(current)),
                top_shots=list(await reports.top_shots(current, limit=TOP_SHOT_COUNT)),
            )

    async def people(
        self, *, since: datetime, until: datetime | None = None, timezone: str = "UTC"
    ) -> AuditPeopleOut:
        window = plan_window(
            since=_as_utc(since),
            until=_as_utc(until),
            zone=ZoneInfo(_check_timezone(timezone)),
            now=datetime.now(UTC),
        )
        scope = Scope(since=window.since, until=window.until)
        async with self._reports.snapshot(scope) as reports:
            metrics = await reports.by_user(scope)
            deliveries = await reports.user_deliveries(
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
        check_limit(limit)
        now = datetime.now(UTC)
        start = _as_utc(since)
        end = _as_utc(until)
        if end is None or end > now:
            end = now
        if start >= end:
            raise ValidationFailed("since 必须早于 until")
        after = None if cursor is None else decode_execution_cursor(cursor, sort=sort, order=order)
        span = Scope(since=start, until=end)
        async with self._reports.snapshot(span, include_created=True) as reports:
            baseline = await reports.overall(span)
            threshold = spend_tokens(baseline.tokens_per_delivery)
            page = await reports.executions(
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
