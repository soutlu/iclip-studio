"""资料库查询的入口形状：成片卡与整片卡各自的筛选范围，以及共用的翻页游标。读模型见 schemas.py。"""

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
    """整片页一次查询的筛选范围。时间窗 ``[since, until)`` 作用在卡面整片的完成时刻上。

    没有画幅朝向：整片的画幅取第一段成片、渲染时才量，请求里不记比例。"""

    user_name: str | None = None
    """卡的作者，即对话属主。"""
    since: datetime | None = None
    until: datetime | None = None
    q: str | None = None
    """关键词，按字面包含匹配对话标题，不区分大小写；整片没有正文可搜。"""


@dataclass(frozen=True, slots=True)
class VideoCursor:
    """列表的排序键：卡面的完成时刻加卡 id。成片卡与整片卡共用。"""

    at: datetime
    video_id: uuid.UUID
    """卡 id（对话 id，不挂对话的成片卡是出片 id），不是卡面那条成片的 id。"""


__all__ = ["Orientation", "Scope", "VideoCursor", "WholeFilmScope"]
