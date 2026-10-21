from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Literal

Orientation = Literal["portrait", "landscape"]
"""画幅朝向，按出片请求里的 ``aspect_ratio`` 判；认不出比例的（如 ``adaptive``）两边都不算。"""


@dataclass(frozen=True, slots=True)
class Scope:
    """一次查询的筛选范围，只看卡自己的素材片。时间窗 ``[since, until)`` 作用在卡面素材片的完成时刻上。"""

    user_name: str | None = None
    """卡的作者。"""
    since: datetime | None = None
    until: datetime | None = None
    orientation: Orientation | None = None
    q: str | None = None
    """关键词，按字面包含匹配卡面素材片对应那条出片的正文与对话标题，不区分大小写。"""


@dataclass(frozen=True, slots=True)
class WholeFilmScope:
    """成片卡的筛选范围。时间窗 ``[since, until)`` 作用在卡面成片的完成时刻上。"""

    user_name: str | None = None
    """卡的作者，即对话属主。"""
    since: datetime | None = None
    until: datetime | None = None
    q: str | None = None
    """关键词，按字面包含匹配对话标题，不区分大小写。"""


@dataclass(frozen=True, slots=True)
class HitCaseScope:
    """爆款素材的筛选范围。时间窗 ``[since, until)`` 作用在入选时刻上。"""

    tag_groups: tuple[tuple[uuid.UUID, ...], ...] = ()
    """按维度分好、已展开下级的标签组：组间都要命中，组内命中任一即算。"""
    user_name: str | None = None
    """这一版素材片属主的用户名，与卡面作者一致。"""
    since: datetime | None = None
    until: datetime | None = None


@dataclass(frozen=True, slots=True)
class VideoCursor:
    at: datetime
    video_id: uuid.UUID


HitCaseIneligible = Literal["not_material", "no_conversation", "no_treatment"]
"""一条视频为什么进不了爆款素材库：``not_material`` 不是素材片（资料库收录口径，试生成除外）；
``no_conversation`` 不挂对话或那段对话不存在；``no_treatment`` 所在对话的工作区里没有新片执行方案。"""


@dataclass(frozen=True, slots=True)
class MaterialSource:
    """一条生成记录够不够格进爆款素材库要看的事实。对话按 job 自己的 ``conversation_id`` 认，删了的
    照样算；不挂对话或对话不存在时两项都是 ``None``。"""

    job_id: uuid.UUID
    is_material: bool
    conversation_id: uuid.UUID | None
    conversation_owner: uuid.UUID | None
    """所在对话的属主：新片执行方案在他名下那段对话的工作区里。"""


__all__ = [
    "HitCaseIneligible",
    "HitCaseScope",
    "MaterialSource",
    "Orientation",
    "Scope",
    "VideoCursor",
    "WholeFilmScope",
]
