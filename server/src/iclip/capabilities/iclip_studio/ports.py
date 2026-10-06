"""iClip Studio 能力的外部依赖协议，由组合根适配对象存储、ffmpeg 与生成域。"""

from __future__ import annotations

import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Literal, Protocol

from iclip.domains.identity.public import Principal


class BreakdownError(RuntimeError):
    """视频拆解没有产出可用的文档。"""

    def __init__(self, message: str, *, retryable: bool) -> None:
        super().__init__(message)
        self.retryable = retryable
        """再调一次有没有可能成功：对方临时出错或答得不完整是 True，请求被拒或等到超时是 False。"""


@dataclass(frozen=True, slots=True)
class SampledVideo:
    """从一条视频里按固定帧率抽出的帧与整条音轨。"""

    frames: tuple[bytes, ...]
    """时间升序的 JPEG；第 i 帧对应 i / 帧率 秒。"""

    audio: bytes | None
    """整条音轨的 MP3；视频没有音轨时为 None。"""


class VideoSampler(Protocol):
    """读视频时长，并为模型准备帧与音轨。失败抛 ``MediaError``。"""

    async def duration_seconds(self, video_url: str) -> float:
        """不下载整片，只读时长。"""
        ...

    async def sample(self, video_url: str) -> SampledVideo:
        """下载视频，抽帧并取出音轨。"""
        ...


class SharedBreakdowns(Protocol):
    """所有用户共用的拆解结果，按视频地址存取。

    它只用来省掉重复的模型调用：取不到一律当作没拆过，存不下只记日志，都不让拆解失败。
    """

    async def get(self, video_url: str) -> str | None:
        """这条视频已有的拆解文档；没有或取不到返回 None。"""
        ...

    async def put(self, video_url: str, document: str) -> None:
        """存下这条视频的拆解文档；已有的不覆盖。"""
        ...


class InvalidNodeImageRequest(ValueError):
    """生图请求在受理时被拒：没有产生付费调用。"""


@dataclass(frozen=True, slots=True)
class NodeImageRequest:
    """给工程文件里一个生图节点出一张图。取值由生成域统一校验。"""

    node: str
    """节点的名字；生成记录按它标记，之后按它找这个节点的结果。"""

    prompt: str
    model: str
    aspect_ratio: str
    resolution: str
    reference_image_urls: tuple[str, ...]
    user_name: str
    """替谁出的图：运行依赖里带的归属标签，上游按它落表对账。"""

    conversation_id: str


@dataclass(frozen=True, slots=True)
class NodeImageJob:
    """一次生图的进度快照。"""

    job_id: uuid.UUID
    status: Literal["pending", "submitting", "submitted", "completed", "failed"]
    output_url: str | None = None
    error_message: str | None = None

    @property
    def finished(self) -> bool:
        return self.status in ("completed", "failed")


class NodeImages(Protocol):
    """生图节点与生成记录之间的往来：出图、查进度、找一个节点最近的结果、认一个地址。"""

    async def submit(self, principal: Principal, request: NodeImageRequest) -> NodeImageJob:
        """受理生成并返回任务记录；实际出图由后台执行。被拒抛 ``InvalidNodeImageRequest``。"""
        ...

    async def get(self, principal: Principal, job_id: uuid.UUID) -> NodeImageJob: ...

    async def latest(
        self, principal: Principal, conversation_id: str, nodes: Sequence[str]
    ) -> Mapping[str, str]:
        """这些节点各自最近一次生成成功的图片地址；没有成功过的节点不在结果里。"""
        ...

    async def belongs(self, principal: Principal, conversation_id: str, url: str) -> bool:
        """这个地址是不是这段对话里一张已完成的图片：生成、编辑或切出来的，含继承来的。"""
        ...


__all__ = [
    "BreakdownError",
    "InvalidNodeImageRequest",
    "NodeImageJob",
    "NodeImageRequest",
    "NodeImages",
    "SampledVideo",
    "SharedBreakdowns",
    "VideoSampler",
]
