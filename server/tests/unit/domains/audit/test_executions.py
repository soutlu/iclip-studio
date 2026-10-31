"""执行清单游标的异常输入：拒绝缺段、非法时间与非有限数值。"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

import pytest
from agent_runtime.errors import ValidationFailed

from iclip.domains.audit.executions import (
    decode_execution_cursor,
)
from iclip.domains.audit.models import ExecutionSort
from iclip.platform.paging import BAD_CURSOR

ID = uuid.UUID("0b7c4f3e-8d52-4c1a-9f0e-3a1d2b4c5e6f")
MOMENT = datetime(2026, 9, 15, 12, 30, 45, 123456, tzinfo=UTC)


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
