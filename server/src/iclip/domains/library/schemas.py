from __future__ import annotations

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel


class CamelModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel, populate_by_name=True, extra="forbid", frozen=True
    )


class ScriptCutOut(CamelModel):
    """一镜：起止秒、正文、正文里引用的参考图编号（``@ImageN`` 的 N，按首次出现顺序）。"""

    start: float
    end: float
    prompt: str
    image_indexes: list[int]


class ScriptOut(CamelModel):
    """结构化的镜头组：全局设定加逐镜时间线。"""

    global_settings: str
    timeline: list[ScriptCutOut]


class TakeOut(CamelModel):
    """一版素材片对应的出片：参数与脚本照出片那一刻的请求。合成沿原作取，原作可以在祖先对话里。"""

    id: uuid.UUID
    model: str | None
    aspect_ratio: str | None
    seconds: int | None
    resolution: str | None
    generate_audio: bool | None
    prompt: str
    """发给模型的原文，复制就给它。"""
    script: ScriptOut | None
    """镜头组：请求里带结构化的就用它，否则按拼装规则从原文拆；拆不出来是 ``None``，即纯文本。"""
    reference_image_urls: list[str]


class FaceOut(CamelModel):
    """一版素材片的版本头：卡面放的那一版，也是详情里每一版的公共部分。"""

    kind: Literal["take", "composite"]
    """``take`` 是出片，``composite`` 是合成。"""
    job_id: uuid.UUID
    output_url: str
    watermark_output_url: str | None
    """合成是本系统拼的，没有水印版，恒为 ``None``。"""
    duration_ms: int | None
    """实际时长，毫秒：出片取上游实测的，合成是本系统量的；上游没给为 ``None``。"""
    finished_at: datetime
    """完成时刻。卡面的完成时刻决定列表顺序与时间筛选，组内按它编版本。"""
    user_name: str | None
    """这一版属主的用户名；账号没有用户名时为 ``None``。"""


class VersionOut(FaceOut):
    """详情里的一版：版本头加它对应的出片。"""

    take: TakeOut


class ShotGroupOut(CamelModel):
    """卡里的一个镜头组：有镜号的按镜号成组；没有镜号的是一条出片连同同原作的合成。"""

    shot_index: int | None
    versions: list[VersionOut]
    """早完成的在前，第 N 条就是第 N 版。"""


class LibraryVideoOut(CamelModel):
    """资料库的一张素材卡：一段对话的分镜，装着这段对话读得到的全部素材片（自己的加继承来的）；
    不挂对话的出片一条一张卡，同原作的合成跟着它。"""

    id: uuid.UUID
    """卡 id：对话 id；不挂对话的卡是那条出片的 id。详情按它取。"""
    conversation_id: uuid.UUID | None
    """来源对话，对所有读者都给；不挂对话为 ``None``。"""
    can_open_conversation: bool
    """这位读者能不能打开来源对话，口径同对话的可读范围（治理者含墓碑）；不挂对话恒为 ``False``。"""
    title: str | None
    """来源对话的标题，对话删了照给；不挂对话为 ``None``。"""
    agent_id: str | None
    task_id: uuid.UUID | None
    user_name: str | None
    """卡的作者：对话属主的用户名，不挂对话的是出片属主的；账号没有用户名时为 ``None``。"""
    group_count: int
    """卡里有几个镜头组，含继承来的。"""
    version_count: int
    """卡里一共几版素材片，各组相加，含继承来的。"""
    face: FaceOut
    """卡面：对话自己最新的素材片。"""
    take: TakeOut
    """卡面那一版对应的出片。"""


class LibraryVideosOut(CamelModel):
    items: list[LibraryVideoOut]
    next_cursor: str | None
    total: int | None
    """当前筛选下一共几张卡；只有第一页（不带 ``cursor``）给，翻页时为 ``None``。"""


class LibraryVideoDetailOut(CamelModel):
    video: LibraryVideoOut
    groups: list[ShotGroupOut]
    """有镜号的组按镜号从小到大在前；没镜号的组在后，按出片完成先后。"""
    can_make_same: bool
    """这位读者能不能拿这张卡做同款：卡挂着对话、读者打得开它（同 ``canOpenConversation``），
    且那段对话的工作区里有 ``film.icml`` 或 ``video_shot.json``。只在详情里给。"""


class WholeFilmVersionOut(CamelModel):
    """成片卡里的一版：这段对话的一次已完成导出。"""

    job_id: uuid.UUID
    """那条成片记录。"""
    output_url: str
    finished_at: datetime
    user_name: str | None
    """导出的人的用户名；账号没有用户名时为 ``None``。"""
    source_job_ids: list[uuid.UUID]
    """这次导出用到的素材片，按导出请求里的先后；只有组件段的导出为空。下载时各记一次下载。"""


class WholeFilmCardOut(CamelModel):
    """资料库「成片」的一张卡：一段对话自己的全部导出，不含继承来的。成片没有脚本，不能做同款。"""

    conversation_id: uuid.UUID
    """卡 id 就是来源对话 id。"""
    can_open_conversation: bool
    """这位读者能不能打开来源对话，口径同素材卡。"""
    title: str | None
    """来源对话的标题，对话删了照给。"""
    user_name: str | None
    """卡的作者：对话属主的用户名。"""
    face: WholeFilmVersionOut
    """卡面：最新完成的一版，即 ``versions`` 的最后一条。"""
    versions: list[WholeFilmVersionOut]
    """早完成的在前，第 N 条就是第 N 版。"""


class WholeFilmCardsOut(CamelModel):
    items: list[WholeFilmCardOut]
    next_cursor: str | None
    total: int | None
    """当前筛选下一共几张卡；只有第一页（不带 ``cursor``）给，翻页时为 ``None``。"""


class LibraryAuthorOut(CamelModel):
    user_name: str
    count: int
    """这个人作者的卡有几张。"""


class LibraryAuthorsOut(CamelModel):
    items: list[LibraryAuthorOut]


__all__ = [
    "FaceOut",
    "LibraryAuthorOut",
    "LibraryAuthorsOut",
    "LibraryVideoDetailOut",
    "LibraryVideoOut",
    "LibraryVideosOut",
    "ScriptCutOut",
    "ScriptOut",
    "ShotGroupOut",
    "TakeOut",
    "VersionOut",
    "WholeFilmCardOut",
    "WholeFilmCardsOut",
    "WholeFilmVersionOut",
]
