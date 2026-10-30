"""镜头能力的外部依赖协议，由组合根接到生成、对象存储与媒体处理上。文件存储复用平台 FileStore。

抽帧拼板与宫格切图要下载、解码、拼图与转存，都在宿主服务里做，插件只经 ``FrameBoards`` 与
``GridCuts`` 两个端口要结果。"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Annotated, Final, Literal, Protocol

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

from iclip_video.shot_video.shots import ShotSpan

ImageChannel = Literal["dev", "pro"]

JobStatus = Literal["pending", "submitting", "submitted", "completed", "failed"]

EXTRACTION_VERSION: Final = 1


class InvalidImageRequest(ValueError):
    """生成请求校验失败，由工具转换为模型可修正的错误。"""


@dataclass(frozen=True, slots=True)
class ImageRequest:
    """图像生成参数，取值由生成域统一校验。"""

    prompt: str
    model: str
    """要哪家图片模型。工具按自己那条链路需要的能力钉死，不由配置决定。"""

    aspect_ratio: str
    resolution: str
    channel: ImageChannel
    user_name: str
    """替谁出的图：运行依赖里带的归属标签，上游按它落表对账。"""
    reference_image_urls: tuple[str, ...] = ()
    conversation_id: str | None = None
    """生成来源对话 id。生成域只把它当归档标签落列，不校验对话是否存在或可见。"""


@dataclass(frozen=True, slots=True)
class ImageJob:
    """生成进度快照，保留原始错误码供调用方判断。"""

    job_id: uuid.UUID
    status: JobStatus
    channel: ImageChannel
    output_url: str | None = None
    error_code: str | None = None
    error_message: str | None = None

    @property
    def finished(self) -> bool:
        return self.status in ("completed", "failed")


class ImageGenerations(Protocol):
    """图像生成提交与状态查询协议。``user_id`` 是运行属主，实现方每次按它重建主体。"""

    async def submit(self, user_id: uuid.UUID, request: ImageRequest) -> ImageJob:
        """受理生成并返回任务记录；实际 Provider 调用由后台执行。"""
        ...

    async def get(self, user_id: uuid.UUID, job_id: uuid.UUID) -> ImageJob: ...


class LedgerBoard(BaseModel):
    """台账里的一块预览板：板号从 1 起，对应拆解文档的第几个结构层级。"""

    model_config = ConfigDict(extra="forbid", frozen=True)

    board: Annotated[int, Field(strict=True, ge=1)]
    url: str


class ExtractionLedger(BaseModel):
    """取帧台账 ``frames/extraction.json`` 的结构，磁盘上字段名是 camelCase。

    文件在模型可写的工作区里，读回时按本模型校验。"""

    model_config = ConfigDict(
        alias_generator=to_camel, populate_by_name=True, extra="forbid", frozen=True
    )

    extraction_version: int
    extraction_key: str
    boards: list[LedgerBoard]


@dataclass(frozen=True, slots=True)
class BoardsResult:
    """一次取帧的台账，以及它是不是原样复用了传入的那份。"""

    ledger: ExtractionLedger
    reused: bool


class FrameBoardsFailed(Exception):
    """取帧拼板没成。``str()`` 就是回给模型的话，工具原样转成重试。"""


class ShotsOutOfRange(FrameBoardsFailed):
    """拆解文档里有镜头的时间码超出了视频时长。"""


class BoardsUnreadable(FrameBoardsFailed):
    """视频取不到、解不开，或预览板拼不出来。"""


class BoardsNotStored(FrameBoardsFailed):
    """预览板没存进对象存储。"""


class FrameBoards(Protocol):
    """按镜头区间从参考视频抽帧、拼成带帧号的预览板。"""

    async def boards(
        self,
        *,
        video_url: str,
        rows: Sequence[Sequence[ShotSpan]],
        previous: ExtractionLedger | None,
    ) -> BoardsResult:
        """下载参考视频、核对镜头时间码没超出时长，再按视频内容与镜头区间算取帧 key。

        ``previous`` 是工作区里现有的台账：key 对得上、每块板的地址都是按这个 key 与板号发布的
        地址时原样交回（``reused`` 为 True）；否则按固定间隔抽帧、每个结构层级拼一块板并上传，
        交回新台账。板号是层级序号，没有一帧落在片内的层级不出板。

        Raises:
            FrameBoardsFailed: 时间码越界、视频或预览板处理失败、预览板没存下，各是一个子类。
        """
        ...


class GridCutFailed(Exception):
    """宫格没切成或没存下。``str()`` 是诊断原因，只进日志，不给模型。"""


class ShotCells(BaseModel):
    """出图整图要留下的几格，按帧号认，顺序即整图的阅读顺序。"""

    model_config = ConfigDict(extra="forbid", frozen=True)

    kind: Literal["shot_cells"] = "shot_cells"
    cell_ids: tuple[str, ...] = Field(min_length=1)


class AnchorSheets(BaseModel):
    """设定图要留下的几格，按从 1 起的序号认，顺序即整图的阅读顺序。"""

    model_config = ConfigDict(extra="forbid", frozen=True)

    kind: Literal["anchor_sheets"] = "anchor_sheets"
    indexes: tuple[Annotated[int, Field(strict=True, ge=1)], ...] = Field(min_length=1)


CutCells = Annotated[ShotCells | AnchorSheets, Field(discriminator="kind")]
"""一次切格留下哪几格、它们是什么产物。存到哪个对象 key 由宿主按它定，插件不管存储布局。"""


class GridCuts(Protocol):
    """把一张生成好的宫格切成单格并转存。"""

    async def cut(
        self,
        user_id: uuid.UUID,
        job_id: uuid.UUID,
        *,
        grid_url: str,
        cells: ShotCells | AnchorSheets,
        aspect: str | None,
    ) -> tuple[str, ...]:
        """下载 ``grid_url``，按检测到的分隔带切成整版的格数（给了 ``aspect`` 就把每格居中收缩到这个
        画幅），把前几格按 ``cells`` 的顺序转存，并以任务 ``job_id`` 为来源各记一条切图；交回与
        ``cells`` 同序的地址。``user_id`` 是运行属主。

        Raises:
            GridCutFailed: 下载、切格、画幅或转存失败。切图记录落不下是数据库的事，原样抛出。
        """
        ...


__all__ = [
    "EXTRACTION_VERSION",
    "AnchorSheets",
    "BoardsNotStored",
    "BoardsResult",
    "BoardsUnreadable",
    "CutCells",
    "ExtractionLedger",
    "FrameBoards",
    "FrameBoardsFailed",
    "GridCutFailed",
    "GridCuts",
    "ImageChannel",
    "ImageGenerations",
    "ImageJob",
    "ImageRequest",
    "InvalidImageRequest",
    "JobStatus",
    "LedgerBoard",
    "ShotCells",
    "ShotsOutOfRange",
]
