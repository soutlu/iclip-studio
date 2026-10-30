"""视频拆解插件的外部依赖协议，由组合根接到参考视频上。"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Literal, Protocol

BreakdownFailureReason = Literal["video_unreadable", "model_call_failed", "model_failed", "timeout"]
"""一次拆解为什么没拿到文档。``video_unreadable`` 视频取不到或解不开；``model_call_failed`` 模型调用
失败（限流、服务端错、连不上、答得不完整），再拆可能就好；``model_failed`` 请求被拒或等满了总超时；
``timeout`` 等满了上限还没拆完。"""


@dataclass(frozen=True, slots=True)
class FailedBreakdown:
    """这条视频这次没拆成。"""

    reason: BreakdownFailureReason


class ReferenceBreakdowns(Protocol):
    """参考视频的拆解：所有对话与资料库共用一份，按视频地址认。"""

    async def ensure(self, user_id: uuid.UUID, video_url: str) -> str | FailedBreakdown:
        """交回这条视频的拆解文档：已有就直接给；没有或上次没拆成就排一次拆解，等到出结果。
        ``user_id`` 是运行属主，实现方每次按它重建主体。"""
        ...


__all__ = [
    "BreakdownFailureReason",
    "FailedBreakdown",
    "ReferenceBreakdowns",
]
