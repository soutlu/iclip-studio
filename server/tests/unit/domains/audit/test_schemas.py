"""审计读模型的空值语义：没有分母时不产生比率。"""

from __future__ import annotations

from iclip.domains.audit.schemas import EMPTY_METRICS


def test_zero_denominators_have_no_ratios() -> None:
    assert EMPTY_METRICS.attempts_per_shot is None
    assert EMPTY_METRICS.one_take_rate is None
    assert EMPTY_METRICS.effective_rate is None
    assert EMPTY_METRICS.tokens_per_delivery is None
    assert EMPTY_METRICS.usage.cache_hit_rate is None
