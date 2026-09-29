"""任务执行清单的纯规则：翻页游标的往返与拒收、消耗离群的门槛。不连库。"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

import pytest

from iclip.common.errors import ValidationFailed
from iclip.domains.audit.executions import (
    ExecutionCursor,
    SortValue,
    decode_execution_cursor,
    encode_execution_cursor,
    spend_tokens,
)
from iclip.domains.audit.models import ExecutionSort, SortOrder
from iclip.platform.paging import BAD_CURSOR

ID = uuid.UUID("0b7c4f3e-8d52-4c1a-9f0e-3a1d2b4c5e6f")
MOMENT = datetime(2026, 9, 15, 12, 30, 45, 123456, tzinfo=UTC)


@pytest.mark.parametrize(
    ("sort", "order", "value"),
    [
        ("start", "desc", MOMENT),
        ("start", "asc", MOMENT),
        # 浮点按最短往返写法，回来的是同一个 double，与 SQL 里 float8 的列逐位相等。
        ("retries", "desc", 5 / 3),
        ("retries", "asc", None),
        ("cycle", "asc", 1234.567891),
        ("cycle", "desc", None),
        ("tokens", "desc", 0),
        ("tokens", "asc", 98765432109),
    ],
)
def test_cursor_round_trips(sort: ExecutionSort, order: SortOrder, value: SortValue | None) -> None:
    cursor = ExecutionCursor(sort=sort, order=order, value=value, conversation_id=ID)

    decoded = decode_execution_cursor(encode_execution_cursor(cursor), sort=sort, order=order)

    assert decoded == cursor
    assert type(decoded.value) is type(value)


@pytest.mark.parametrize(
    ("sort", "order"),
    [("retries", "desc"), ("start", "asc"), ("tokens", "asc")],
)
def test_cursor_from_another_sort_or_order_is_rejected(
    sort: ExecutionSort, order: SortOrder
) -> None:
    """游标只对发它的那种排序与方向有效；换了任一个都不能接着翻。"""

    raw = encode_execution_cursor(
        ExecutionCursor(sort="start", order="desc", value=MOMENT, conversation_id=ID)
    )

    with pytest.raises(ValidationFailed, match=BAD_CURSOR):
        decode_execution_cursor(raw, sort=sort, order=order)


@pytest.mark.parametrize(
    ("raw", "sort"),
    [
        ("not-a-cursor", "start"),
        (f"start|desc|{MOMENT.isoformat()}", "start"),
        (f"start|desc|{MOMENT.isoformat()}|{ID}|extra", "start"),
        (f"start|desc|not-a-date|{ID}", "start"),
        # 无时区的时刻不是本列表发的。
        (f"start|desc|2026-09-15T12:30:45|{ID}", "start"),
        (f"start|desc|{MOMENT.isoformat()}|not-a-uuid", "start"),
        # 开始时刻与 token 合计不会为空，空值尾段的标记只给另两种排序。
        (f"start|desc|~|{ID}", "start"),
        (f"tokens|desc|~|{ID}", "tokens"),
        (f"tokens|desc|1.5|{ID}", "tokens"),
        (f"retries|desc|abc|{ID}", "retries"),
        (f"retries|desc|nan|{ID}", "retries"),
        (f"cycle|desc|inf|{ID}", "cycle"),
        (f"sideways|desc|1|{ID}", "start"),
    ],
)
def test_malformed_cursors_are_rejected(raw: str, sort: ExecutionSort) -> None:
    with pytest.raises(ValidationFailed, match=BAD_CURSOR):
        decode_execution_cursor(raw, sort=sort, order="desc")


def test_spend_threshold_is_three_times_the_period_average() -> None:
    assert spend_tokens(1205.0) == 3615.0
    assert spend_tokens(None) is None
