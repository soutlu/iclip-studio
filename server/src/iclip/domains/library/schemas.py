from __future__ import annotations

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

from iclip.domains.library.models import HitCaseIneligible
from iclip.domains.tagging.public import TagErrorCode, TagStatus


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
    script: ScriptOut | None
    reference_image_urls: list[str]


class FaceOut(CamelModel):
    """一版素材片的版本头：卡面放的那一版，也是详情里每一版的公共部分。"""

    kind: Literal["take", "composite"]
    job_id: uuid.UUID
    output_url: str
    watermark_output_url: str | None
    duration_ms: int | None
    finished_at: datetime
    user_name: str | None


class VersionOut(FaceOut):
    """详情里的一版：版本头加它对应的出片。"""

    take: TakeOut


class ShotGroupOut(CamelModel):
    """卡里的一个镜头组：有镜号的按镜号成组；没有镜号的是一条出片连同同原作的合成。"""

    shot_index: int | None
    versions: list[VersionOut]


class LibraryVideoOut(CamelModel):
    """资料库的一张素材卡：一段对话的分镜，装着这段对话读得到的全部素材片（自己的加继承来的）；
    不挂对话的出片一条一张卡，同原作的合成跟着它。"""

    id: uuid.UUID
    conversation_id: uuid.UUID | None
    can_open_conversation: bool
    title: str | None
    agent_id: str | None
    task_id: uuid.UUID | None
    user_name: str | None
    group_count: int
    version_count: int
    face: FaceOut
    take: TakeOut


class LibraryVideosOut(CamelModel):
    items: list[LibraryVideoOut]
    next_cursor: str | None
    total: int | None


class LibraryVideoDetailOut(CamelModel):
    video: LibraryVideoOut
    groups: list[ShotGroupOut]
    can_make_same: bool


class WholeFilmVersionOut(CamelModel):
    """成片卡里的一版：这段对话的一次已完成导出。"""

    job_id: uuid.UUID
    output_url: str
    finished_at: datetime
    user_name: str | None
    source_job_ids: list[uuid.UUID]


class WholeFilmCardOut(CamelModel):
    """资料库「成片」的一张卡：一段对话自己的全部导出，不含继承来的。成片没有脚本，不能做同款。"""

    conversation_id: uuid.UUID
    can_open_conversation: bool
    title: str | None
    user_name: str | None
    face: WholeFilmVersionOut
    versions: list[WholeFilmVersionOut]


class WholeFilmCardsOut(CamelModel):
    items: list[WholeFilmCardOut]
    next_cursor: str | None
    total: int | None


class LibraryAuthorOut(CamelModel):
    user_name: str
    count: int


class LibraryAuthorsOut(CamelModel):
    items: list[LibraryAuthorOut]


class HitCaseOut(CamelModel):
    """爆款素材库的一条：成片素材里被挑进来的一条素材片（一版），连同它的标签。"""

    job_id: uuid.UUID
    card_id: uuid.UUID
    title: str | None
    face: FaceOut
    take: TakeOut
    tag_ids: list[uuid.UUID]
    tag_status: TagStatus | None
    tag_error: TagErrorCode | None
    added_at: datetime


class HitCasesOut(CamelModel):
    items: list[HitCaseOut]
    next_cursor: str | None
    total: int | None


class HitCaseEntryOut(CamelModel):
    """一条素材片在爆款素材库里的条目。"""

    tag_ids: list[uuid.UUID]
    tag_status: TagStatus | None
    tag_error: TagErrorCode | None
    added_at: datetime
    added_by: str | None


class HitCaseStateOut(CamelModel):
    """一条素材片与爆款素材库的关系：能不能入选、入选了没有。"""

    job_id: uuid.UUID
    eligible: bool
    ineligible_reason: HitCaseIneligible | None
    entry: HitCaseEntryOut | None


class HitCaseIn(CamelModel):
    """入选时一起写上的标签。"""

    tag_ids: list[uuid.UUID] = Field(default_factory=list)


class HitCaseTagsIn(CamelModel):
    """整份替换这条爆款素材在所有维度上的标签。"""

    tag_ids: list[uuid.UUID]


__all__ = [
    "FaceOut",
    "HitCaseEntryOut",
    "HitCaseIn",
    "HitCaseOut",
    "HitCaseStateOut",
    "HitCaseTagsIn",
    "HitCasesOut",
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
