"""审计总览的纯规则：时间窗、粒度、上一期、回看下限、分期的轴，以及按基础格补窗的 7 / 30 日均线。

对外表述见合同 §12「总览」。这里不连库：服务层按 ``OverviewWindow`` 发查询，把基础格交回来算。
按人页签的时间窗、粒度与每期成片数的轴也用这里的规则。"""

from __future__ import annotations

from bisect import bisect_left, bisect_right
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from typing import Final, Literal
from zoneinfo import ZoneInfo

from iclip.common.errors import ValidationFailed
from iclip.domains.audit.models import OverviewBucket
from iclip.domains.audit.schemas import (
    MetricsOut,
    MovingAverageOut,
    MovingAveragesOut,
    PeriodDeliveriesOut,
    PeriodMetricsOut,
    SpreadOut,
    TrendPointOut,
)

MAX_SPAN_DAYS: Final = 366
HOURLY_SPAN_DAYS: Final = 2
"""跨的日历日不超过这么多天按小时。"""
DAILY_SPAN_DAYS: Final = 120
"""不超过这么多天按天，更长按周。"""
LOOKBACK_DAYS: Final = 60
"""均线补窗至少能往本期起点前回看这么多天。"""
MIN_ACTIVE_DAYS: Final = 3
SHOT_SAMPLES: Final = 30
CYCLE_SAMPLES: Final = 10
UPSTREAM_SAMPLES: Final = 30
DELIVERY_SAMPLES: Final = 10

_TICK: Final = timedelta(microseconds=1)

GridBucket = Literal["hour", "day"]


@dataclass(frozen=True, slots=True)
class OverviewWindow:
    """一次总览的时间窗。时刻都是 UTC；``days`` 是本期在 ``zone`` 里跨的日历日数。"""

    since: datetime
    until: datetime
    previous_since: datetime
    previous_until: datetime
    bucket: OverviewBucket
    zone: ZoneInfo
    days: int
    lookback: datetime
    """基础格的起点：上一期起点与本期起点前 60 天里早的那个，所在本地日的零点。"""

    @property
    def grid(self) -> GridBucket:
        """基础格的粒度：按小时时按小时，否则按天。"""

        return "hour" if self.bucket == "hour" else "day"


@dataclass(frozen=True, slots=True)
class Cell:
    """基础格的一格 ``[start, end)``：整格的指标与格里有成片的件。"""

    start: datetime
    end: datetime
    metrics: MetricsOut
    units: frozenset[str]


def _local_day(moment: datetime, zone: ZoneInfo) -> date:
    return moment.astimezone(zone).date()


def _midnight(day: date, zone: ZoneInfo) -> datetime:
    return datetime.combine(day, time(), tzinfo=zone).astimezone(UTC)


def _shift_days(moment: datetime, days: int, zone: ZoneInfo) -> datetime:
    """按 ``zone`` 的墙钟挪 ``days`` 个日历日：跨夏令时也落在同一个本地时刻。"""

    return (moment.astimezone(zone) + timedelta(days=days)).astimezone(UTC)


def plan_window(
    *, since: datetime, until: datetime | None, zone: ZoneInfo, now: datetime
) -> OverviewWindow:
    """按合同 §12 定时间窗。入参须带时区，定出来的时刻一律换成 UTC。

    ``until`` 为空或晚于 ``now`` 按 ``now``；跨度是 ``since`` 与 ``until`` 前一刻在 ``zone`` 里的
    本地日期之差加一。``since`` 不早于 ``until`` 或跨度超过 366 天抛 ``ValidationFailed``。
    """

    since = since.astimezone(UTC)
    end = (now if until is None or until > now else until).astimezone(UTC)
    if since >= end:
        raise ValidationFailed("since 必须早于 until")
    days = (_local_day(end - _TICK, zone) - _local_day(since, zone)).days + 1
    if days > MAX_SPAN_DAYS:
        raise ValidationFailed(f"时间窗最长 {MAX_SPAN_DAYS} 天，这次跨了 {days} 天")
    bucket: OverviewBucket = (
        "hour" if days <= HOURLY_SPAN_DAYS else "day" if days <= DAILY_SPAN_DAYS else "week"
    )
    previous_since = _shift_days(since, -days, zone)
    earliest = min(previous_since, _shift_days(since, -LOOKBACK_DAYS, zone))
    return OverviewWindow(
        since=since,
        until=end,
        previous_since=previous_since,
        previous_until=_shift_days(end, -days, zone),
        bucket=bucket,
        zone=zone,
        days=days,
        lookback=_midnight(_local_day(earliest, zone), zone),
    )


def period_start(moment: datetime, bucket: OverviewBucket, zone: ZoneInfo) -> datetime:
    """``moment`` 所在期的期首（UTC），与 SQL 的 ``date_trunc(bucket, moment, zone)`` 同一规则：
    本地整点、本地零点，或本地周一零点。"""

    if bucket == "hour":
        local = moment.astimezone(zone)
        return local.replace(minute=0, second=0, microsecond=0).astimezone(UTC)
    day = _local_day(moment, zone)
    if bucket == "week":
        day -= timedelta(days=day.weekday())
    return _midnight(day, zone)


def period_starts(window: OverviewWindow) -> list[datetime]:
    """本期每一期的期首，早的在前：从 ``since`` 所在期到 ``until`` 前一刻所在期，一期不缺。

    按天、按周照 ``zone`` 的墙钟挪，跨夏令时也落在本地零点；按小时每期一个钟头。
    """

    starts: list[datetime] = []
    current = period_start(window.since, window.bucket, window.zone)
    while current < window.until:
        starts.append(current)
        if window.bucket == "hour":
            current = period_start(current + timedelta(hours=1), "hour", window.zone)
        else:
            current = _shift_days(current, 7 if window.bucket == "week" else 1, window.zone)
    return starts


def fill_periods(
    starts: Sequence[datetime], counts: Mapping[datetime, int]
) -> list[PeriodDeliveriesOut]:
    """把只列了有成片的期的计数铺到轴上，缺的期补 0。

    计数的键是 SQL 按同一粒度截出的期首，按「不晚于它的最后一个期首」落期，不要求与轴逐字相等。
    """

    totals = [0] * len(starts)
    for start, count in counts.items():
        index = bisect_right(starts, start) - 1
        if index < 0:
            raise ValueError(f"计数的期首 {start.isoformat()} 早于轴的第一期")
        totals[index] += count
    return [
        PeriodDeliveriesOut(period_start=start, deliveries=total)
        for start, total in zip(starts, totals, strict=True)
    ]


def build_cells(
    rows: Sequence[PeriodMetricsOut],
    units: Mapping[datetime, frozenset[str]],
    *,
    until: datetime,
) -> list[Cell]:
    """把时段查询的行接成首尾相连的格：每格结束在下一格开始，最后一格结束在 ``until``。"""

    ends = [*(row.period_start for row in rows[1:]), until]
    return [
        Cell(
            start=row.period_start,
            end=end,
            metrics=row.metrics,
            units=units.get(row.period_start, frozenset()),
        )
        for row, end in zip(rows, ends, strict=True)
    ]


def head_cell(cells: Sequence[Cell], since: datetime) -> Cell:
    """``since`` 所在的格，趋势的第一期。``since`` 不在它的起点上时，调用方要另查首期指标。"""

    starts = [cell.start for cell in cells]
    return cells[max(bisect_right(starts, since) - 1, 0)]


def trend(
    cells: Sequence[Cell], window: OverviewWindow, *, head_metrics: MetricsOut | None = None
) -> list[TrendPointOut]:
    """按小时或按天的趋势：``since`` 所在格起到最后一格，每格一期，各带 7 / 30 日均线。

    ``head_metrics`` 是首期只算 ``since`` 之后的指标；给了就替掉首格的整格指标，均线仍用整格。
    ``inactive`` 只在按天时可能为真：这一期里没有人发起运行。
    """

    starts = [cell.start for cell in cells]
    head = max(bisect_right(starts, window.since) - 1, 0)
    points: list[TrendPointOut] = []
    for index in range(head, len(cells)):
        metrics = cells[index].metrics
        if index == head and head_metrics is not None:
            metrics = head_metrics
        points.append(
            TrendPointOut(
                period_start=cells[index].start,
                inactive=window.bucket == "day" and metrics.active_users == 0,
                metrics=metrics,
                ma7=_moving_averages(cells, starts, index, days=7, window=window),
                ma30=_moving_averages(cells, starts, index, days=30, window=window),
            )
        )
    return points


def _moving_averages(
    cells: Sequence[Cell],
    starts: Sequence[datetime],
    index: int,
    *,
    days: int,
    window: OverviewWindow,
) -> MovingAveragesOut:
    """第 ``index`` 格那一期的一组均线：窗止于该格的结束，名义上往前推 ``days`` 个本地日。

    先按本地日往前补到窗里至少 3 个活跃日；样本类在此基础上各自按格往前补到样本数够。都补到
    第 0 格（回看下限）为止，报的 ``since`` 是实际覆盖的起点。
    """

    zone = window.zone
    until = cells[index].end
    nominal = _midnight(_local_day(until - _TICK, zone) - timedelta(days=days - 1), zone)
    base = _widen_to_active_days(
        cells, starts, min(bisect_left(starts, nominal), index), index, zone
    )

    def average(lo: int, value: float | None) -> MovingAverageOut:
        return MovingAverageOut(value=value, since=cells[lo].start, until=until)

    def per_active_day(pick: Callable[[MetricsOut], float]) -> MovingAverageOut | None:
        if window.grid != "day":
            return None
        values = [
            pick(cell.metrics) for cell in cells[base : index + 1] if cell.metrics.active_users
        ]
        return average(base, sum(values) / len(values) if values else None)

    shots_lo = _widen_to_samples(cells, base, index, SHOT_SAMPLES, lambda m: m.shots)
    shots = [cell.metrics for cell in cells[shots_lo : index + 1]]
    shot_count = sum(m.shots for m in shots)

    cycle_lo = _widen_to_samples(
        cells, base, index, CYCLE_SAMPLES, lambda m: _count(m.active_cycle_seconds)
    )
    upstream_lo = _widen_to_samples(
        cells, base, index, UPSTREAM_SAMPLES, lambda m: _count(m.upstream_seconds)
    )

    units_lo, units = _widen_to_units(cells, base, index)
    delivered = [cell.metrics.usage for cell in cells[units_lo : index + 1]]

    def per_delivery(tokens: int) -> MovingAverageOut:
        return average(units_lo, tokens / len(units) if units else None)

    return MovingAveragesOut(
        deliveries=per_active_day(lambda m: m.deliveries),
        producers=per_active_day(lambda m: m.producers),
        total_tokens=per_active_day(lambda m: m.usage.total_tokens),
        length_seconds=per_active_day(lambda m: m.length_seconds),
        attempts_per_shot=average(
            shots_lo, sum(m.attempts for m in shots) / shot_count if shot_count else None
        ),
        one_take_rate=average(
            shots_lo, sum(m.one_take_shots for m in shots) / shot_count if shot_count else None
        ),
        effective_rate=average(
            shots_lo, sum(m.effective_shots for m in shots) / shot_count if shot_count else None
        ),
        active_cycle_seconds=average(
            cycle_lo,
            _pooled_mean(cells[cycle_lo : index + 1], lambda m: m.active_cycle_seconds),
        ),
        upstream_seconds=average(
            upstream_lo,
            _pooled_mean(cells[upstream_lo : index + 1], lambda m: m.upstream_seconds),
        ),
        tokens_per_delivery=per_delivery(sum(u.total_tokens for u in delivered)),
        input_tokens_per_delivery=per_delivery(sum(u.input_tokens for u in delivered)),
        output_tokens_per_delivery=per_delivery(sum(u.output_tokens for u in delivered)),
        cache_write_tokens_per_delivery=per_delivery(sum(u.cache_write_tokens for u in delivered)),
        cache_read_tokens_per_delivery=per_delivery(sum(u.cache_read_tokens for u in delivered)),
    )


def _widen_to_active_days(
    cells: Sequence[Cell], starts: Sequence[datetime], lo: int, hi: int, zone: ZoneInfo
) -> int:
    """窗 ``[lo, hi]`` 里的活跃日不足 3 天就按本地日往前补一天，补到第 0 格为止；返回新的 ``lo``。

    活跃日只看窗里的格：某个本地日在窗内的格里有人发起运行。
    """

    active = {
        _local_day(cell.start, zone) for cell in cells[lo : hi + 1] if cell.metrics.active_users
    }
    while len(active) < MIN_ACTIVE_DAYS and lo > 0:
        previous_day = _midnight(_local_day(cells[lo].start, zone) - timedelta(days=1), zone)
        widened = min(bisect_left(starts, previous_day), lo - 1)
        active.update(
            _local_day(cell.start, zone) for cell in cells[widened:lo] if cell.metrics.active_users
        )
        lo = widened
    return lo


def _widen_to_samples(
    cells: Sequence[Cell], lo: int, hi: int, need: int, samples: Callable[[MetricsOut], int]
) -> int:
    """窗 ``[lo, hi]`` 的样本数不足 ``need`` 就逐格往前补，补到第 0 格为止；返回新的 ``lo``。"""

    count = sum(samples(cell.metrics) for cell in cells[lo : hi + 1])
    while count < need and lo > 0:
        lo -= 1
        count += samples(cells[lo].metrics)
    return lo


def _widen_to_units(cells: Sequence[Cell], lo: int, hi: int) -> tuple[int, frozenset[str]]:
    """同上，样本是窗里去重后的成片件；件跨格只算一次，所以对集合取并而不是把各格件数相加。"""

    units: set[str] = set().union(*(cell.units for cell in cells[lo : hi + 1]))
    while len(units) < DELIVERY_SAMPLES and lo > 0:
        lo -= 1
        units |= cells[lo].units
    return lo, frozenset(units)


def _count(spread: SpreadOut | None) -> int:
    return 0 if spread is None else spread.count


def _pooled_mean(
    cells: Sequence[Cell], pick: Callable[[MetricsOut], SpreadOut | None]
) -> float | None:
    """各格的平均按样本数加权合成整个窗的平均；没有样本为空。"""

    total = 0.0
    count = 0
    for cell in cells:
        spread = pick(cell.metrics)
        if spread is not None:
            total += spread.avg * spread.count
            count += spread.count
    return total / count if count else None


__all__ = [
    "CYCLE_SAMPLES",
    "DELIVERY_SAMPLES",
    "MAX_SPAN_DAYS",
    "MIN_ACTIVE_DAYS",
    "SHOT_SAMPLES",
    "UPSTREAM_SAMPLES",
    "Cell",
    "OverviewWindow",
    "build_cells",
    "fill_periods",
    "head_cell",
    "period_start",
    "period_starts",
    "plan_window",
    "trend",
]
