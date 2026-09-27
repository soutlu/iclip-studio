"""审计报表用例：把查询参数整理成筛选范围，负责游标与参数校验，拼装总览。治理者权限由路由声明。"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from datetime import UTC, datetime
from typing import Final, get_args, overload
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from iclip.common.errors import ValidationFailed
from iclip.domains.audit.models import (
    DEFAULT_THRESHOLDS,
    AnomalyCursor,
    AnomalyKind,
    Bucket,
    ConversationCursor,
    Scope,
    Thresholds,
)
from iclip.domains.audit.overview import OverviewWindow, build_cells, head_cell, plan_window, trend
from iclip.domains.audit.repository import AuditReports
from iclip.domains.audit.schemas import (
    AnomaliesOut,
    AuditConversationsOut,
    OverviewOut,
    OverviewPeriodOut,
    OverviewWindowOut,
    SummaryOut,
    TrendPointOut,
)
from iclip.platform.paging import BAD_CURSOR, check_limit, decode_cursor, encode_cursor

_ANOMALY_KINDS: Final[frozenset[str]] = frozenset(get_args(AnomalyKind))

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


def _scope(
    *,
    since: datetime | None,
    until: datetime | None,
    user_name: str | None,
    task_id: uuid.UUID | None,
) -> Scope:
    since, until = _as_utc(since), _as_utc(until)
    if since is not None and until is not None and since >= until:
        raise ValidationFailed("since 必须早于 until")
    return Scope(since=since, until=until, user_name=user_name, task_id=task_id)


def _check_timezone(name: str) -> str:
    try:
        ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError) as exc:
        raise ValidationFailed(f"timezone 不是一个可识别的时区名: {name}") from exc
    return name


def _conversation_after(cursor: str | None) -> ConversationCursor | None:
    """把游标还原成对话明细的排序键；``None`` 即从头取。"""

    if cursor is None:
        return None
    parsed = decode_cursor(cursor)
    return ConversationCursor(delivered_at=parsed.at, conversation_id=parsed.uuid_key())


def _anomaly_after(cursor: str | None) -> AnomalyCursor | None:
    """把游标还原成异常的排序键；尾键得是「种类:对象」，种类不认识就不是这个列表发的。"""

    if cursor is None:
        return None
    parsed = decode_cursor(cursor)
    kind, separator, rest = parsed.key.partition(":")
    if not separator or not rest or kind not in _ANOMALY_KINDS:
        raise ValidationFailed(BAD_CURSOR)
    return AnomalyCursor(at=parsed.at, ref=parsed.key)


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

    async def summary(
        self,
        *,
        since: datetime | None = None,
        until: datetime | None = None,
        user_name: str | None = None,
        task_id: uuid.UUID | None = None,
        bucket: Bucket | None = None,
        timezone: str = "UTC",
    ) -> SummaryOut:
        """全体一格、每人一行、每单一行；给了 ``bucket`` 再按 ``timezone`` 的日 / 周 / 月切一条序列。"""

        scope = _scope(since=since, until=until, user_name=user_name, task_id=task_id)
        series = None
        if bucket is not None:
            series = await self._reports.by_period(
                scope, bucket=bucket, timezone=_check_timezone(timezone)
            )
        return SummaryOut(
            overall=await self._reports.overall(scope),
            users=list(await self._reports.by_user(scope)),
            tasks=list(await self._reports.by_task(scope)),
            series=None if series is None else list(series),
            attempt_distribution=list(await self._reports.attempt_distribution(scope)),
            # 总览只要各种异常有几条；阈值按缺省算，与异常页不带参数时同一口径。
            anomaly_counts=list(await self._reports.anomaly_counts(scope, DEFAULT_THRESHOLDS)),
        )

    async def conversations(
        self,
        *,
        since: datetime | None = None,
        until: datetime | None = None,
        user_name: str | None = None,
        task_id: uuid.UUID | None = None,
        limit: int = 20,
        cursor: str | None = None,
    ) -> AuditConversationsOut:
        """有成片的对话，最后成片晚的排前面。满页才给下一页游标。"""

        check_limit(limit)
        scope = _scope(since=since, until=until, user_name=user_name, task_id=task_id)
        items = await self._reports.conversations(
            scope, limit=limit, after=_conversation_after(cursor)
        )
        last = items[-1] if len(items) == limit else None
        next_cursor = (
            None if last is None else encode_cursor(last.delivered_at, last.conversation_id)
        )
        return AuditConversationsOut(items=list(items), next_cursor=next_cursor)

    async def anomalies(
        self,
        *,
        since: datetime | None = None,
        until: datetime | None = None,
        user_name: str | None = None,
        task_id: uuid.UUID | None = None,
        kinds: Sequence[AnomalyKind] | None = None,
        thresholds: Thresholds = DEFAULT_THRESHOLDS,
        limit: int = 20,
        cursor: str | None = None,
    ) -> AnomaliesOut:
        """异常按发生时刻倒序。``kinds`` 为空即全部种类。"""

        check_limit(limit)
        scope = _scope(since=since, until=until, user_name=user_name, task_id=task_id)
        items = await self._reports.anomalies(
            scope,
            thresholds,
            kinds=kinds or None,
            limit=limit,
            after=_anomaly_after(cursor),
        )
        last = items[-1] if len(items) == limit else None
        next_cursor = None if last is None else encode_cursor(last.at, last.ref)
        return AnomaliesOut(items=list(items), next_cursor=next_cursor)


__all__ = ["AuditService"]
