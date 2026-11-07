from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Final

from cue.errors import ValidationFailed

MAX_LIST_LIMIT: Final = 100
DEFAULT_LIST_LIMIT: Final = 20

_SEPARATOR: Final = "|"

BAD_CURSOR: Final = "cursor 不是一个有效的翻页位置"


@dataclass(frozen=True, slots=True)
class Cursor:
    at: datetime
    key: str

    def uuid_key(self) -> uuid.UUID:
        try:
            return uuid.UUID(self.key)
        except ValueError as exc:
            raise ValidationFailed(BAD_CURSOR) from exc


def encode_cursor(at: datetime, key: object) -> str:
    return f"{at.isoformat()}{_SEPARATOR}{key}"


def decode_cursor(raw: str) -> Cursor:
    stamp, separator, key = raw.partition(_SEPARATOR)
    if not separator or not stamp or not key:
        raise ValidationFailed(BAD_CURSOR)
    try:
        at = datetime.fromisoformat(stamp)
    except ValueError as exc:
        raise ValidationFailed(BAD_CURSOR) from exc
    return Cursor(at=at, key=key)


def check_limit(limit: int) -> None:
    if not 1 <= limit <= MAX_LIST_LIMIT:
        raise ValidationFailed(f"limit 必须在 1 到 {MAX_LIST_LIMIT} 之间")


__all__ = [
    "BAD_CURSOR",
    "DEFAULT_LIST_LIMIT",
    "MAX_LIST_LIMIT",
    "Cursor",
    "check_limit",
    "decode_cursor",
    "encode_cursor",
]
