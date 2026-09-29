"""审计读模型上由原始计数派生的比率口径。不连库。"""

from __future__ import annotations

from iclip.domains.audit.schemas import EMPTY_METRICS, MetricsOut, SpreadOut, UsageOut


def test_metrics_derive_ratios_and_go_blank_on_zero_denominators() -> None:
    usage = UsageOut(
        requests=3,
        input_tokens=100,
        cache_read_tokens=300,
        cache_write_tokens=100,
        output_tokens=50,
    )
    metrics = MetricsOut(
        completed_videos=4,
        delivered_tasks=1,
        delivered_orphan_conversations=1,
        producers=2,
        shots=4,
        attempts=6,
        one_take_shots=3,
        effective_shots=2,
        runs=5,
        active_users=2,
        delivered_conversations=2,
        cycle_seconds=SpreadOut(avg=1, median=1, p90=1, count=2),
        active_cycle_seconds=None,
        agent_run_seconds=None,
        upstream_seconds=None,
        length_videos=0,
        length_seconds=0.0,
        discarded_length_seconds=0.0,
        usage=usage,
    )

    assert metrics.deliveries == 2
    assert metrics.attempts_per_shot == 1.5
    assert metrics.one_take_rate == 0.75
    assert metrics.effective_rate == 0.5
    assert usage.total_tokens == 550
    assert usage.cache_hit_rate == 0.6
    assert metrics.tokens_per_delivery == 275
    assert EMPTY_METRICS.attempts_per_shot is None
    assert EMPTY_METRICS.one_take_rate is None
    assert EMPTY_METRICS.effective_rate is None
    assert EMPTY_METRICS.tokens_per_delivery is None
    assert EMPTY_METRICS.usage.cache_hit_rate is None
