"""参考视频的领域形状：拆解状态与失败原因、一行记录。术语见 docs/CONTEXT.md「参考视频」。"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Final, Literal

BreakdownStatus = Literal["pending", "running", "completed", "failed"]
"""``pending`` 已排队；``running`` 后台在拆解；``completed`` 有拆解；``failed`` 最近一次没拆成，原来的
拆解保留。"""

STATUS_PENDING: Final = "pending"
STATUS_RUNNING: Final = "running"
STATUS_COMPLETED: Final = "completed"
STATUS_FAILED: Final = "failed"

BreakdownErrorCode = Literal["video_unreadable", "model_call_failed", "model_failed", "timeout"]
"""最近一次拆解失败的原因。``video_unreadable`` 取不到或解不开视频；``model_call_failed`` 模型调用
失败（限流、服务端错、连不上、答得不完整），再试可能就好；``model_failed`` 请求被拒或等满了总超时；
``timeout`` 拆解中超过 ``BREAKDOWN_TIMEOUT_SECONDS`` 没结束，被周期任务收尾。"""

ERROR_VIDEO_UNREADABLE: Final = "video_unreadable"
ERROR_MODEL_CALL_FAILED: Final = "model_call_failed"
ERROR_MODEL_FAILED: Final = "model_failed"
ERROR_TIMEOUT: Final = "timeout"

BREAKDOWN_TIMEOUT_SECONDS: Final = 20 * 60
"""拆解中的行最多等这么久：单次拆解请求最长 900 秒，再加余量。超过即按 ``timeout`` 收尾；对话里等
一条拆解的上限也是它。"""


class BreakdownFailed(Exception):
    """一次拆解没有产出文档；``code`` 是落到行上的失败原因。"""

    def __init__(self, message: str, *, code: BreakdownErrorCode) -> None:
        super().__init__(message)
        self.code: BreakdownErrorCode = code


@dataclass(frozen=True, slots=True)
class ReferenceVideo:
    """``reference_videos`` 的一行，连同属主的用户名与它在灵感库里的标签。"""

    id: uuid.UUID
    video_url: str
    owner_user_id: uuid.UUID
    owner_user_name: str | None
    tag_ids: tuple[uuid.UUID, ...]
    tag_status: str | None
    """打标状态，取值见标签域；还没打过标为 ``None``。"""
    tag_error: str | None
    breakdown_status: BreakdownStatus
    error_code: BreakdownErrorCode | None
    document: str | None
    version: int
    created_at: datetime
    updated_at: datetime
    deleted_at: datetime | None


@dataclass(frozen=True, slots=True)
class Claim:
    """后台任务接手的一次拆解。``started_at`` 是这一次的凭据：写回时核对它，被收尾后又重拆的行不会
    被上一次的结果盖掉。"""

    id: uuid.UUID
    video_url: str
    owner_user_id: uuid.UUID
    started_at: datetime


@dataclass(frozen=True, slots=True)
class Outcome:
    """对话里等一条拆解的结果：有文档就用文档，否则是失败原因。"""

    document: str | None
    error_code: BreakdownErrorCode | None = None


TestVideoStatus = Literal["running", "completed", "failed"]
"""试生成的状态：``running`` 还没结束（排队、提交中或等上游），其余是终态。"""

TEST_VIDEO_RUNNING: Final = "running"
TEST_VIDEO_COMPLETED: Final = "completed"
TEST_VIDEO_FAILED: Final = "failed"


@dataclass(frozen=True, slots=True)
class TestVideoJob:
    """属主名下这条参考视频最新的一次试生成，从生成记录投影过来，不引用生成域的类型。"""

    status: TestVideoStatus
    url: str | None
    """试生成地址；还没完成或失败了为 ``None``。"""
    error_message: str | None
    """上游给的失败原文。"""
    prompt: str | None
    """记录里发给模型的正文；记录读不出视频请求时为 ``None``。"""
    created_at: datetime


@dataclass(frozen=True, slots=True)
class Scope:
    """列表的筛选范围。时间窗 ``[since, until)`` 作用在建立时刻上。"""

    tag_groups: tuple[tuple[uuid.UUID, ...], ...] = ()
    """按维度分好、已展开下级的标签组：组间都要命中，组内命中任一即算。"""
    user_name: str | None = None
    """属主的用户名。"""
    q: str | None = None
    """按字面包含匹配拆解全文，不区分大小写。"""
    since: datetime | None = None
    until: datetime | None = None


@dataclass(frozen=True, slots=True)
class ReferenceCursor:
    """列表的排序键：建立时刻加行 id。"""

    at: datetime
    reference_id: uuid.UUID


__all__ = [
    "BREAKDOWN_TIMEOUT_SECONDS",
    "ERROR_MODEL_CALL_FAILED",
    "ERROR_MODEL_FAILED",
    "ERROR_TIMEOUT",
    "ERROR_VIDEO_UNREADABLE",
    "STATUS_COMPLETED",
    "STATUS_FAILED",
    "STATUS_PENDING",
    "STATUS_RUNNING",
    "TEST_VIDEO_COMPLETED",
    "TEST_VIDEO_FAILED",
    "TEST_VIDEO_RUNNING",
    "BreakdownErrorCode",
    "BreakdownFailed",
    "BreakdownStatus",
    "Claim",
    "Outcome",
    "ReferenceCursor",
    "ReferenceVideo",
    "Scope",
    "TestVideoJob",
    "TestVideoStatus",
]
