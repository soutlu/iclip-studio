from __future__ import annotations

from typing import Final, Literal

SkillStatus = Literal["active", "archived"]

MAX_ARCHIVE_BYTES: Final = 6 * 1024 * 1024


__all__ = [
    "MAX_ARCHIVE_BYTES",
    "SkillStatus",
]
