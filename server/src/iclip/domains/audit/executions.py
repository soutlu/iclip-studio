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
STUCK_HOURS: Final = 1
SPEND_TIMES: Final = 3
TASK_CONVERSATIONS: Final = 3

SortValue = datetime | float | int

NULLABLE_SORTS: Final[frozenset[ExecutionSort]] = frozenset({"retries", "cycle"})

_SORTS: Final[frozenset[str]] = frozenset(get_args(ExecutionSort))
_ORDERS: Final[frozenset[str]] = frozenset(get_args(SortOrder))
_SEPARATOR: Final = "|"
_NULL: Final = "~"


@dataclass(frozen=True, slots=True)
class ExecutionCursor:
    sort: ExecutionSort
    order: SortOrder
    value: SortValue | None
    conversation_id: uuid.UUID


def spend_tokens(tokens_per_delivery: float | None) -> float | None:
    return None if tokens_per_delivery is None else tokens_per_delivery * SPEND_TIMES


def encode_execution_cursor(cursor: ExecutionCursor) -> str:
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
