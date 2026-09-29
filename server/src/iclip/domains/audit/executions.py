"""任务执行清单的纯规则：四种异常的门槛与按排序键翻页的游标。对外表述见合同 §12「任务执行」。"""

from __future__ import annotations

import math
import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Final, get_args

from iclip.common.errors import ValidationFailed
from iclip.domains.audit.models import ExecutionSort, SortOrder
from iclip.platform.paging import BAD_CURSOR

RETRY_AT_LEAST: Final = 3
"""单镜成功生成达到这么多次算反复重试。"""
STUCK_HOURS: Final = 1
"""出片停在 ``submitted``、提交上游超过这么多小时算视频悬挂。"""
SPEND_TIMES: Final = 3
"""对话 token 合计超过本期每件成片平均 token 的这么多倍算消耗离群。"""
TASK_CONVERSATIONS: Final = 3
"""需求单在本期至少有这么多段执行、又从来没有成片算卡住。"""

SortValue = datetime | float | int
"""排序键的取值：``start`` 是时刻，``retries`` / ``cycle`` 是浮点，``tokens`` 是整数。"""

NULLABLE_SORTS: Final[frozenset[ExecutionSort]] = frozenset({"retries", "cycle"})
"""取值可能为空的排序键；空值不论升降都排最后。"""

_SORTS: Final[frozenset[str]] = frozenset(get_args(ExecutionSort))
_ORDERS: Final[frozenset[str]] = frozenset(get_args(SortOrder))
_SEPARATOR: Final = "|"
_NULL: Final = "~"


@dataclass(frozen=True, slots=True)
class ExecutionCursor:
    """上一页末行的位置：按哪种排序发的，末行的排序键与对话 id。``value`` 为空即已进入空值尾段。"""

    sort: ExecutionSort
    order: SortOrder
    value: SortValue | None
    conversation_id: uuid.UUID


def spend_tokens(tokens_per_delivery: float | None) -> float | None:
    """消耗离群的门槛：本期每件成片平均 token × ``SPEND_TIMES``；本期没有成片为空。"""

    return None if tokens_per_delivery is None else tokens_per_delivery * SPEND_TIMES


def encode_execution_cursor(cursor: ExecutionCursor) -> str:
    """把位置写成不透明游标：「排序键|方向|取值|对话 id」，空值写 ``~``。"""

    value = cursor.value
    if value is None:
        text = _NULL
    elif isinstance(value, datetime):
        text = value.isoformat()
    elif isinstance(value, float):
        text = repr(value)
    else:
        text = str(value)
    return _SEPARATOR.join((cursor.sort, cursor.order, text, str(cursor.conversation_id)))


def decode_execution_cursor(raw: str, *, sort: ExecutionSort, order: SortOrder) -> ExecutionCursor:
    """还原游标并核对它是这种排序发的；形状不对、排序键或方向对不上都抛 ``ValidationFailed``。"""

    parts = raw.split(_SEPARATOR)
    if len(parts) != 4:
        raise ValidationFailed(BAD_CURSOR)
    found_sort, found_order, text, key = parts
    if found_sort not in _SORTS or found_order not in _ORDERS:
        raise ValidationFailed(BAD_CURSOR)
    if found_sort != sort or found_order != order:
        raise ValidationFailed(BAD_CURSOR)
    try:
        conversation_id = uuid.UUID(key)
    except ValueError as exc:
        raise ValidationFailed(BAD_CURSOR) from exc
    return ExecutionCursor(
        sort=sort, order=order, value=_parse_value(sort, text), conversation_id=conversation_id
    )


def _parse_value(sort: ExecutionSort, text: str) -> SortValue | None:
    if text == _NULL:
        if sort not in NULLABLE_SORTS:
            raise ValidationFailed(BAD_CURSOR)
        return None
    try:
        if sort == "start":
            moment = datetime.fromisoformat(text)
            if moment.tzinfo is None:
                raise ValidationFailed(BAD_CURSOR)
            return moment
        if sort == "tokens":
            return int(text)
        number = float(text)
    except ValueError as exc:
        raise ValidationFailed(BAD_CURSOR) from exc
    if not math.isfinite(number):
        raise ValidationFailed(BAD_CURSOR)
    return number


__all__ = [
    "NULLABLE_SORTS",
    "RETRY_AT_LEAST",
    "SPEND_TIMES",
    "STUCK_HOURS",
    "TASK_CONVERSATIONS",
    "ExecutionCursor",
    "SortValue",
    "decode_execution_cursor",
    "encode_execution_cursor",
    "spend_tokens",
]
