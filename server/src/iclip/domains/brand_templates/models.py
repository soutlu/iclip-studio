"""品牌资源的领域形状、视频参数与字体直传回执。术语见 docs/CONTEXT.md「资料库」。"""

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
    """一条品牌资源。类型开放，媒体参数按资源实际情况填写；停用不影响已有整片快照。"""

    id: uuid.UUID
    kind: str
    brand: str | None
    name: str
    url: str
    width: int | None
    height: int | None
    duration_ms: int | None
    has_audio: bool | None
    created_by: uuid.UUID
    created_at: datetime
    disabled_at: datetime | None


@dataclass(frozen=True, slots=True)
class FontUploadTicket:
    upload_id: uuid.UUID
    upload_url: str
    headers: dict[str, str]
    expires_at: datetime


__all__ = ["MAX_TEMPLATE_MS", "BrandTemplate", "FontUploadTicket", "Position", "ProbedVideo"]
