"""审计总览的纯规则：时间窗与粒度、上一期、回看下限，以及均线的补窗。不连库。"""

from __future__ import annotations

from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo

import pytest

from iclip.common.errors import ValidationFailed
from iclip.domains.audit.overview import (
    Cell,
    OverviewWindow,
    build_cells,
    plan_window,
    trend,
)
from iclip.domains.audit.schemas import (
    EMPTY_METRICS,
    MetricsOut,
    PeriodMetricsOut,
    SpreadOut,
    UsageOut,
)

UTC_ZONE = ZoneInfo("UTC")
SINGAPORE = ZoneInfo("Asia/Singapore")
NEW_YORK = ZoneInfo("America/New_York")
FAR_FUTURE = datetime(2030, 1, 1, tzinfo=UTC)


def midnight(day: date, zone: ZoneInfo) -> datetime:
    return datetime.combine(day, time(), tzinfo=zone).astimezone(UTC)


def metrics(
    *,
    users: int = 0,
    deliveries: int = 0,
    producers: int = 0,
    tokens: int = 0,
    length: float = 0.0,
    shots: int = 0,
    attempts: int = 0,
    one_take: int = 0,
    delivered_shots: int = 0,
    effective: int = 0,
    cycle: SpreadOut | None = None,
    upstream: SpreadOut | None = None,
) -> MetricsOut:
    """一格指标；``users`` 非零即这一格有人发起运行。token 全记在普通输入上。"""

    return EMPTY_METRICS.model_copy(
        update={
            "runs": users,
            "active_users": users,
            "delivered_tasks": deliveries,
            "producers": producers,
            "length_seconds": length,
            "shots": shots,
            "attempts": attempts,
            "one_take_shots": one_take,
            "delivered_shots": delivered_shots,
            "effective_shots": effective,
            "active_cycle_seconds": cycle,
            "upstream_seconds": upstream,
            "usage": UsageOut(
                requests=0,
                input_tokens=tokens,
                cache_read_tokens=0,
                cache_write_tokens=0,
                output_tokens=0,
            ),
        }
    )


def spread(avg: float, count: int) -> SpreadOut:
    return SpreadOut(avg=avg, median=avg, p90=avg, count=count)


def day_cells(
    window: OverviewWindow,
    days_back: dict[int, MetricsOut],
    units: dict[int, frozenset[str]] | None = None,
) -> list[Cell]:
    """从回看下限到 ``until`` 每个本地日一格；``days_back`` 以最后一格为 0 往前数。"""

    first = window.lookback.astimezone(window.zone).date()
    last = (window.until - timedelta(microseconds=1)).astimezone(window.zone).date()
    count = (last - first).days + 1
    rows = [
        PeriodMetricsOut(
            period_start=midnight(first + timedelta(days=offset), window.zone),
            metrics=days_back.get(count - 1 - offset, EMPTY_METRICS),
        )
        for offset in range(count)
    ]
    starts = [row.period_start for row in rows]
    by_start = {starts[count - 1 - back]: found for back, found in (units or {}).items()}
    return build_cells(rows, by_start, until=window.until)


def week_window(zone: ZoneInfo = UTC_ZONE) -> OverviewWindow:
    """按天的一周：2026-09-01 到 09-08 两个本地零点之间。"""

    return plan_window(
        since=midnight(date(2026, 9, 1), zone),
        until=midnight(date(2026, 9, 8), zone),
        zone=zone,
        now=FAR_FUTURE,
    )


@pytest.mark.parametrize(
    ("until", "bucket", "days"),
    [
        (midnight(date(2026, 9, 3), SINGAPORE), "hour", 2),
        (midnight(date(2026, 9, 3), SINGAPORE) + timedelta(microseconds=1), "day", 3),
        (midnight(date(2026, 12, 30), SINGAPORE), "day", 120),
        (midnight(date(2026, 12, 31), SINGAPORE), "week", 121),
    ],
)
def test_bucket_follows_calendar_days_spanned_in_the_timezone(
    until: datetime, bucket: str, days: int
) -> None:
    window = plan_window(
        since=midnight(date(2026, 9, 1), SINGAPORE), until=until, zone=SINGAPORE, now=FAR_FUTURE
    )

    assert (window.bucket, window.days) == (bucket, days)


def test_a_short_window_straddling_local_midnight_spans_two_days() -> None:
    """跨度按本地日历算：新加坡 23:00 到次日 01:00 只有两小时，也是两个日历日。"""

    since = datetime(2026, 9, 1, 23, tzinfo=SINGAPORE).astimezone(UTC)
    window = plan_window(
        since=since, until=since + timedelta(hours=2), zone=SINGAPORE, now=FAR_FUTURE
    )

    assert window.days == 2
    assert window.previous_since == since - timedelta(days=2)


def test_previous_period_keeps_local_wall_clock_across_dst() -> None:
    """纽约 11 月 1 日结束夏令时：往前挪 7 个日历日仍落在本地零点，UTC 上差 7 天零 1 小时。"""

    since = midnight(date(2026, 11, 2), NEW_YORK)
    until = midnight(date(2026, 11, 9), NEW_YORK)

    window = plan_window(since=since, until=until, zone=NEW_YORK, now=FAR_FUTURE)

    assert window.days == 7
    assert window.previous_since == midnight(date(2026, 10, 26), NEW_YORK)
    assert window.previous_until == since
    assert since - window.previous_since == timedelta(days=7, hours=1)


def test_until_is_capped_at_now() -> None:
    now = datetime(2026, 9, 15, 10, 30, tzinfo=UTC)
    since = datetime(2026, 9, 15, tzinfo=UTC)

    open_ended = plan_window(since=since, until=None, zone=UTC_ZONE, now=now)
    future = plan_window(since=since, until=now + timedelta(days=1), zone=UTC_ZONE, now=now)
    past = plan_window(since=since, until=now - timedelta(hours=1), zone=UTC_ZONE, now=now)

    assert open_ended.until == future.until == now
    assert past.until == now - timedelta(hours=1)
    assert open_ended.previous_until == now - timedelta(days=1)


def test_span_over_366_days_and_inverted_windows_are_rejected() -> None:
    since = midnight(date(2025, 1, 1), UTC_ZONE)

    ok = plan_window(since=since, until=since + timedelta(days=366), zone=UTC_ZONE, now=FAR_FUTURE)
    assert ok.days == 366
    with pytest.raises(ValidationFailed, match="366"):
        plan_window(since=since, until=since + timedelta(days=367), zone=UTC_ZONE, now=FAR_FUTURE)
    with pytest.raises(ValidationFailed, match="since"):
        plan_window(since=since, until=since, zone=UTC_ZONE, now=FAR_FUTURE)
    with pytest.raises(ValidationFailed, match="since"):
        plan_window(since=FAR_FUTURE, until=None, zone=UTC_ZONE, now=since)


def test_lookback_is_the_earlier_of_previous_start_and_sixty_days_back() -> None:
    short = week_window(SINGAPORE)
    long = plan_window(
        since=midnight(date(2026, 9, 1), SINGAPORE),
        until=midnight(date(2026, 12, 10), SINGAPORE),
        zone=SINGAPORE,
        now=FAR_FUTURE,
    )

    assert short.lookback == midnight(date(2026, 7, 3), SINGAPORE)
    assert long.lookback == long.previous_since == midnight(date(2026, 5, 24), SINGAPORE)


def test_count_averages_skip_inactive_days() -> None:
    """件数类只平均活跃日：七天里五天各两件、两天没人用，均线是 2，不是 10 / 7。"""

    window = week_window()
    busy = metrics(users=1, deliveries=2, producers=1, tokens=100, length=30.0)
    cells = day_cells(window, {back: busy for back in (0, 1, 3, 4, 6)})

    series = trend(cells, window)

    last = series[-1]
    assert [point.inactive for point in series] == [False, True, False, False, True, False, False]
    assert last.ma7 is not None and last.ma7.deliveries is not None
    assert last.ma7.deliveries.value == 2
    assert last.ma7.deliveries.since == window.since
    assert last.ma7.deliveries.until == window.until
    assert last.ma7.producers is not None and last.ma7.producers.value == 1
    assert last.ma7.total_tokens is not None and last.ma7.total_tokens.value == 100
    assert last.ma7.length_seconds is not None and last.ma7.length_seconds.value == 30


def test_fewer_than_three_active_days_widen_the_window_day_by_day() -> None:
    """七天窗里只有一个活跃日：往前一天天补，补到第 9 天前才凑够三个。"""

    window = week_window()
    cells = day_cells(
        window,
        {
            0: metrics(users=1, deliveries=3),
            8: metrics(users=1, deliveries=1),
            9: metrics(users=1, deliveries=2),
        },
    )

    ma7 = trend(cells, window)[-1].ma7

    assert ma7 is not None and ma7.deliveries is not None
    assert ma7.deliveries.since == window.since - timedelta(days=3)
    assert ma7.deliveries.value == 2
    assert ma7.attempts_per_shot.since <= ma7.deliveries.since


def test_sample_groups_widen_on_their_own_until_they_have_enough() -> None:
    """镜不够 30 个就逐格往前补；单任务样本窗里已有 10 个就不动，各报各的起点。"""

    window = week_window()
    cells = day_cells(
        window,
        {
            back: metrics(users=1, shots=2, attempts=4, one_take=1, delivered_shots=2, effective=1)
            for back in range(7)
        }
        | {
            10: metrics(shots=20, attempts=20, one_take=20, delivered_shots=10, effective=10),
            5: metrics(users=1, cycle=spread(100, 6), upstream=spread(50, 30)),
            2: metrics(users=1, cycle=spread(200, 4)),
        },
    )

    ma7 = trend(cells, window)[-1].ma7

    assert ma7 is not None
    # 窗里五天各两镜（另两天换成了只有耗时样本的格）共 10 镜；往前逐格补，前第 10 天那格的
    # 20 镜一进来刚好 30 个。
    assert ma7.attempts_per_shot.since == window.since - timedelta(days=4)
    assert ma7.attempts_per_shot.value == pytest.approx((5 * 4 + 20) / 30)
    assert ma7.one_take_rate.value == pytest.approx((5 + 20) / 30)
    assert ma7.effective_rate.value == pytest.approx((5 + 10) / (5 * 2 + 10))
    assert ma7.active_cycle_seconds.since == window.since
    assert ma7.active_cycle_seconds.value == pytest.approx((100 * 6 + 200 * 4) / 10)
    assert ma7.upstream_seconds.since == window.since
    assert ma7.upstream_seconds.value == 50


def test_widening_stops_at_lookback_and_reports_it() -> None:
    """一个活跃日都没有、样本也不够：补到回看下限为止，没有样本的值为空，起点如实报下限。"""

    window = week_window()
    cells = day_cells(window, {0: metrics(shots=1, attempts=2)})

    ma30 = trend(cells, window)[-1].ma30

    assert ma30 is not None and ma30.deliveries is not None
    assert ma30.deliveries.since == window.lookback
    assert ma30.deliveries.value is None
    assert ma30.attempts_per_shot.since == window.lookback
    assert ma30.attempts_per_shot.value == 2
    assert (ma30.upstream_seconds.since, ma30.upstream_seconds.value) == (window.lookback, None)
    assert ma30.tokens_per_delivery.value is None


def test_tokens_per_delivery_divide_by_deduplicated_units() -> None:
    """同一张需求单跨两天出片只算一件：两天的 token 合计除以 2 件，不是 3 件。"""

    window = week_window()
    cells = day_cells(
        window,
        {0: metrics(users=1, tokens=600), 1: metrics(users=1, tokens=300)},
        units={0: frozenset({"t1", "t2"}), 1: frozenset({"t1"})},
    )

    ma7 = trend(cells, window)[-1].ma7

    assert ma7 is not None
    assert ma7.tokens_per_delivery.value == 450
    assert ma7.input_tokens_per_delivery.value == 450
    assert ma7.output_tokens_per_delivery.value == 0
    # 件数不够 10 件，一直补到回看下限。
    assert ma7.tokens_per_delivery.since == window.lookback


def test_hourly_trend_has_no_count_averages_and_never_marks_inactive() -> None:
    since = midnight(date(2026, 9, 1), UTC_ZONE)
    window = plan_window(
        since=since, until=since + timedelta(hours=3), zone=UTC_ZONE, now=FAR_FUTURE
    )
    hours = int((window.until - window.lookback) / timedelta(hours=1))
    rows = [
        PeriodMetricsOut(
            period_start=window.lookback + timedelta(hours=offset),
            metrics=metrics(users=1, shots=1, attempts=3) if offset == hours - 1 else EMPTY_METRICS,
        )
        for offset in range(hours)
    ]

    series = trend(build_cells(rows, {}, until=window.until), window)

    assert window.bucket == "hour"
    assert [point.period_start for point in series] == [
        since + timedelta(hours=offset) for offset in range(3)
    ]
    assert not any(point.inactive for point in series)
    last = series[-1]
    assert last.ma7 is not None and last.ma30 is not None
    assert last.ma7.deliveries is None and last.ma7.total_tokens is None
    assert last.ma7.attempts_per_shot.value == 3
    assert last.ma7.attempts_per_shot.until == window.until


def test_head_metrics_replace_only_the_first_period() -> None:
    """``since`` 不在格边界上时，首期换成只算 ``since`` 之后的指标，期首仍是格起点。"""

    since = midnight(date(2026, 9, 1), UTC_ZONE) + timedelta(hours=9)
    window = plan_window(
        since=since, until=since + timedelta(days=4), zone=UTC_ZONE, now=FAR_FUTURE
    )
    whole = metrics(users=1, deliveries=5)
    cells = day_cells(window, {back: whole for back in range(5)})
    clipped = metrics(deliveries=1)

    series = trend(cells, window, head_metrics=clipped)

    assert series[0].period_start == midnight(date(2026, 9, 1), UTC_ZONE)
    assert series[0].metrics == clipped and series[0].inactive
    assert all(point.metrics == whole for point in series[1:])
    assert series[0].ma7 is not None and series[0].ma7.deliveries is not None
    assert series[0].ma7.deliveries.value == 5
