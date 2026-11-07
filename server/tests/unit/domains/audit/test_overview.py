from __future__ import annotations

from datetime import UTC, date, datetime, time, timedelta
from itertools import pairwise
from zoneinfo import ZoneInfo

import pytest
from cue.errors import ValidationFailed

from iclip.domains.audit.overview import (
    Cell,
    OverviewWindow,
    build_cells,
    fill_periods,
    period_starts,
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
    effective: int = 0,
    cycle: SpreadOut | None = None,
    upstream: SpreadOut | None = None,
) -> MetricsOut:
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
    since = datetime(2026, 9, 1, 23, tzinfo=SINGAPORE).astimezone(UTC)
    window = plan_window(
        since=since, until=since + timedelta(hours=2), zone=SINGAPORE, now=FAR_FUTURE
    )

    assert window.days == 2
    assert window.previous_since == since - timedelta(days=2)


def test_previous_period_keeps_local_wall_clock_across_dst() -> None:
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


def test_daily_axis_runs_from_the_day_of_since_to_the_day_before_until() -> None:
    since = datetime(2026, 9, 1, 15, tzinfo=SINGAPORE).astimezone(UTC)
    window = plan_window(
        since=since, until=midnight(date(2026, 9, 5), SINGAPORE), zone=SINGAPORE, now=FAR_FUTURE
    )

    assert window.bucket == "day"
    assert period_starts(window) == [midnight(date(2026, 9, day), SINGAPORE) for day in range(1, 5)]


def test_weekly_axis_starts_on_the_local_monday() -> None:
    since = datetime(2026, 3, 4, 9, tzinfo=SINGAPORE).astimezone(UTC)
    window = plan_window(
        since=since, until=since + timedelta(days=130), zone=SINGAPORE, now=FAR_FUTURE
    )

    starts = period_starts(window)

    assert window.bucket == "week"
    assert starts[0] == midnight(date(2026, 3, 2), SINGAPORE)
    assert all(later - earlier == timedelta(days=7) for earlier, later in pairwise(starts))
    assert starts[-1] <= window.until < starts[-1] + timedelta(days=7)


def test_daily_axis_keeps_local_midnight_across_dst() -> None:
    window = plan_window(
        since=midnight(date(2026, 10, 30), NEW_YORK),
        until=midnight(date(2026, 11, 3), NEW_YORK),
        zone=NEW_YORK,
        now=FAR_FUTURE,
    )

    starts = period_starts(window)

    assert starts == [midnight(date(2026, 10, 30) + timedelta(days=n), NEW_YORK) for n in range(4)]
    assert starts[3] - starts[2] == timedelta(hours=25)


def test_fill_periods_refuses_counts_before_the_first_period() -> None:
    starts = period_starts(week_window(SINGAPORE))

    with pytest.raises(ValueError, match="早于"):
        fill_periods(starts, {starts[0] - timedelta(days=1): 1})


def test_fewer_than_three_active_days_widen_the_window_day_by_day() -> None:
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
    window = week_window()
    cells = day_cells(
        window,
        {back: metrics(users=1, shots=2, attempts=4, one_take=1, effective=1) for back in range(7)}
        | {
            10: metrics(shots=20, attempts=20, one_take=20, effective=10),
            5: metrics(users=1, cycle=spread(100, 6), upstream=spread(50, 30)),
            2: metrics(users=1, cycle=spread(200, 4)),
        },
    )

    ma7 = trend(cells, window)[-1].ma7

    assert ma7 is not None
    assert ma7.attempts_per_shot.since == window.since - timedelta(days=4)
    assert ma7.attempts_per_shot.value == pytest.approx((5 * 4 + 20) / 30)
    assert ma7.one_take_rate.value == pytest.approx((5 + 20) / 30)
    assert ma7.effective_rate.value == pytest.approx((5 + 10) / 30)
    assert ma7.active_cycle_seconds.since == window.since
    assert ma7.active_cycle_seconds.value == pytest.approx((100 * 6 + 200 * 4) / 10)
    assert ma7.upstream_seconds.since == window.since
    assert ma7.upstream_seconds.value == 50


def test_widening_stops_at_lookback_and_reports_it() -> None:
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


def test_head_metrics_replace_only_the_first_period() -> None:
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
