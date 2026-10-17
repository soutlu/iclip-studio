from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Literal

Orientation = Literal["portrait", "landscape"]
"""画幅朝向，按出片请求里的 ``aspect_ratio`` 判；认不出比例的（如 ``adaptive``）两边都不算。"""


@dataclass(frozen=True, slots=True)
class Scope:
    """一次查询的筛选范围，只看卡自己的成片。时间窗 ``[since, until)`` 作用在卡面成片的完成时刻上。"""

    user_name: str | None = None
    """卡的作者。"""
    since: datetime | None = None
    until: datetime | None = None
    orientation: Orientation | None = None
    q: str | None = None
    """关键词，按字面包含匹配卡面成片对应那条出片的正文与对话标题，不区分大小写。"""


@dataclass(frozen=True, slots=True)
class WholeFilmScope:
    user_name: str | None = None
    since: datetime | None = None
    until: datetime | None = None
    q: str | None = None


@dataclass(frozen=True, slots=True)
class VideoCursor:
    at: datetime
    video_id: uuid.UUID


__all__ = ["Orientation", "Scope", "VideoCursor", "WholeFilmScope"]
