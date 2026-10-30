"""iClip Studio 能力的外部依赖协议，由组合根适配生成域。"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Literal, Protocol


class InvalidNodeImageRequest(ValueError):
    """生图请求在受理时被拒：没有产生付费调用。"""


@dataclass(frozen=True, slots=True)
class NodeImageRequest:
    """给工程文件里一个生图节点出一张图。取值由生成域统一校验。"""

    node: str
    """节点的名字；生成记录按它标记，制作页按它列这个节点的版本。"""

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
    """生图节点与生成记录之间的往来：出图、查进度。``user_id`` 是运行属主，实现方每次按它重建主体。"""

    async def submit(self, user_id: uuid.UUID, request: NodeImageRequest) -> NodeImageJob:
        """受理生成并返回任务记录；实际出图由后台执行。被拒抛 ``InvalidNodeImageRequest``。"""
        ...

    async def get(self, user_id: uuid.UUID, job_id: uuid.UUID) -> NodeImageJob: ...


__all__ = [
    "InvalidNodeImageRequest",
    "NodeImageJob",
    "NodeImageRequest",
    "NodeImages",
]
