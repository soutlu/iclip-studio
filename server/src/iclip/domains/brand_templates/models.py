"""品牌模板的领域形状：位置、时长上限、一行记录与探出来的视频参数。术语见 docs/CONTEXT.md「资料库」。"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Final, Literal

Position = Literal["intro", "outro"]
"""模板放在整片的哪一头：片头或片尾。"""

MAX_TEMPLATE_MS: Final = 10_000
"""一条模板最长多少毫秒：片头片尾只是品牌露出，也占整片 120 秒的总长。"""


@dataclass(frozen=True, slots=True)
class ProbedVideo:
    """建模板时从视频本身量出来的参数，记在模板上。"""

    width: int
    height: int
    duration_ms: int
    has_audio: bool


@dataclass(frozen=True, slots=True)
class BrandTemplate:
    """一条品牌模板。``disabled_at`` 为空表示在用；停用不删，已有整片里的快照不受影响。"""

    id: uuid.UUID
    position: Position
    name: str
    url: str
    width: int
    height: int
    duration_ms: int
    has_audio: bool
    created_by: uuid.UUID
    created_at: datetime
    disabled_at: datetime | None


__all__ = ["MAX_TEMPLATE_MS", "BrandTemplate", "Position", "ProbedVideo"]
