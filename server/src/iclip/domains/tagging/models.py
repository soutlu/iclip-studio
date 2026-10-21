"""资料库标签的领域形状：标签树、条目的种类与打标状态、失败原因。术语见 docs/CONTEXT.md「标签」。"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Final, Literal

AutoFill = Literal["ai"]
"""维度行上的 ``auto_fill``：``ai`` 是 AI 打这个维度；``None`` 只靠人填。"""

AUTO_FILL_AI: Final = "ai"

EntryKind = Literal["reference", "hit_case"]
"""条目属于哪个库：``reference`` 灵感库的一条参考视频；``hit_case`` 爆款素材库的一条素材片。"""

KIND_REFERENCE: Final = "reference"
KIND_HIT_CASE: Final = "hit_case"
ENTRY_KINDS: Final[tuple[EntryKind, ...]] = (KIND_REFERENCE, KIND_HIT_CASE)

TagStatus = Literal["pending", "running", "completed", "failed"]
"""条目的打标状态；``None`` 是还没打过标。"""

STATUS_PENDING: Final = "pending"
STATUS_RUNNING: Final = "running"
STATUS_COMPLETED: Final = "completed"
STATUS_FAILED: Final = "failed"
BUSY_STATUSES: Final = frozenset({STATUS_PENDING, STATUS_RUNNING})

TagErrorCode = Literal["no_source_text", "model_call_failed", "model_failed", "timeout"]
"""最近一次打标失败的原因。``no_source_text`` 取不到打标用的文字；``model_call_failed`` 模型调用
失败（限流、服务端错、连不上、答得不完整，或没排上队），再试可能就好；``model_failed`` 请求被拒、
等满了总超时或答的不合格式；``timeout`` 打标中超过 ``TAGGING_TIMEOUT_SECONDS`` 没结束。"""

ERROR_NO_SOURCE_TEXT: Final = "no_source_text"
ERROR_MODEL_CALL_FAILED: Final = "model_call_failed"
ERROR_MODEL_FAILED: Final = "model_failed"
ERROR_TIMEOUT: Final = "timeout"

TAGGING_TIMEOUT_SECONDS: Final = 10 * 60
"""打标中的条目最多等这么久，超过即按 ``timeout`` 收尾。"""

AI_VALUE_LIMIT: Final = 500
"""``auto_fill = ai`` 的全部维度下的取值（含小类）合计最多这么多：一次打标把它们全部写进输出约束，
实测 500 个时模型仍答得合格式。"""

MAX_TAG_NAME_CHARS: Final = 50
MAX_TAG_GUIDE_CHARS: Final = 1000


@dataclass(frozen=True, slots=True)
class TagNode:
    """标签树的一个节点。``parent_id`` 为 ``None`` 的是维度；``children`` 按 ``position`` 排好。"""

    id: uuid.UUID
    parent_id: uuid.UUID | None
    name: str
    auto_fill: AutoFill | None
    guide: str | None
    position: int
    children: tuple[TagNode, ...] = ()

    def descendants(self) -> tuple[TagNode, ...]:
        """自己以下的全部节点，先序，不含自己。"""

        found: list[TagNode] = []
        for child in self.children:
            found.append(child)
            found.extend(child.descendants())
        return tuple(found)


@dataclass(frozen=True, slots=True)
class TagCounts:
    """带这个标签或它任一下级的条目数，按库分开。"""

    references: int = 0
    """没移除的参考视频。"""
    hit_cases: int = 0


@dataclass(frozen=True, slots=True)
class EntryKey:
    """一个库里的一条：种类加那一库的 id（参考视频 id 或素材片的生成记录 id）。"""

    kind: EntryKind
    subject_id: uuid.UUID


@dataclass(frozen=True, slots=True)
class Claim:
    """后台任务接手的一次打标。写回时核对 ``started_at``：被收尾后又重新打标的条目不会被上一次的
    结果盖掉。"""

    entry_id: uuid.UUID
    key: EntryKey
    started_at: datetime


class TaggingFailed(Exception):
    """一次打标没有给出可用的标签；``code`` 是落到条目上的失败原因。"""

    def __init__(self, message: str, *, code: TagErrorCode) -> None:
        super().__init__(message)
        self.code: TagErrorCode = code


__all__ = [
    "AI_VALUE_LIMIT",
    "AUTO_FILL_AI",
    "BUSY_STATUSES",
    "ENTRY_KINDS",
    "ERROR_MODEL_CALL_FAILED",
    "ERROR_MODEL_FAILED",
    "ERROR_NO_SOURCE_TEXT",
    "ERROR_TIMEOUT",
    "KIND_HIT_CASE",
    "KIND_REFERENCE",
    "MAX_TAG_GUIDE_CHARS",
    "MAX_TAG_NAME_CHARS",
    "STATUS_COMPLETED",
    "STATUS_FAILED",
    "STATUS_PENDING",
    "STATUS_RUNNING",
    "TAGGING_TIMEOUT_SECONDS",
    "AutoFill",
    "Claim",
    "EntryKey",
    "EntryKind",
    "TagCounts",
    "TagErrorCode",
    "TagNode",
    "TagStatus",
    "TaggingFailed",
]
