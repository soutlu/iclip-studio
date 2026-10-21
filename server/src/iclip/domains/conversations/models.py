"""对话持久模型，记录身份、标题、归属与最近运行标识。运行历史由 agent 引擎持久化。"""

from __future__ import annotations

import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal, Protocol

TitleKind = Literal["default", "generated", "custom"]
"""标题来源，取值须与数据库检查约束同步。"""


@dataclass(frozen=True, slots=True)
class Conversation:
    """一段对话的持久事实行。已删除的行只经治理者的读路径进入领域层，属主与所有写路径都当它不存在。"""

    id: uuid.UUID
    owner_user_id: uuid.UUID
    agent_id: str
    """Agent 由配置声明，无对应数据库外键。"""
    title: str
    title_kind: TitleKind
    """仅 default 标题可自动生成；已生成或用户自定义的标题不再自动覆盖。"""
    last_run_id: str | None
    """最近一次运行的 id，用于重连未结束的运行；未发过消息时为空。"""
    task_id: uuid.UUID | None
    """可修改的需求单归属；为空时不关联需求单。"""
    collection_id: uuid.UUID | None
    """可修改的合集归属；为空时未分类。"""
    created_at: datetime
    updated_at: datetime
    deleted_at: datetime | None = None
    """属主删除它的时刻；活着的对话为空。"""
    completed_at: datetime | None = None
    """属主标记这活儿收尾的时刻；没标过为空。属主再动手（开跑新一轮、提交出片）自动抹回空。"""
    forked_from: uuid.UUID | None = None
    """分叉来源对话；不是分叉来的为空。与 ``fork_turn`` 同时有值。"""
    fork_turn: int | None = None
    """分叉自源对话的第几轮，从 1 数。与 ``forked_from`` 同时有值。"""


@dataclass(frozen=True, slots=True)
class ConversationActivity:
    """对话活动投影。各字段独立，等待审批或回答时 busy 仍为真。"""

    busy: bool = False
    pending_interaction: Literal["none", "approval", "question"] = "none"
    last_turn_reason: Literal["completed", "failed", "aborted"] | None = None
    """最近结束轮次的结果；从未完成轮次时为 None。"""
    video_generation: Literal["none", "queued", "running"] = "none"
    """这段对话下还没跑完的视频出片到哪一步；跑完与失败在分镜页看，这里不记。"""


IDLE_ACTIVITY = ConversationActivity()
"""无运行记录或活动信息时使用的空闲状态。"""


@dataclass(frozen=True, slots=True)
class WholeFilmDraft:
    """一段对话的成片草稿：只有当前一份，每存一次版本号加一，第一次存是 1。"""

    conversation_id: uuid.UUID
    document: Mapping[str, Any]
    """前端编辑器与渲染服务读写的那份 JSON，原样存取；形状见 ``whole_film_schemas``。"""
    revision: int
    updated_by: uuid.UUID
    updated_at: datetime


class EventWatermark(Protocol):
    """某一刻各段对话的会话事件水位，由组合根从广播方取来。

    读库或写库之前取一份：行上的 ``lastSeq`` 按它填，客户端拿帧序号与它比先后。"""

    @property
    def epoch(self) -> str:
        """序号所属的进程；不同 epoch 的序号不可比。"""
        ...

    def seq_of(self, conversation_id: uuid.UUID) -> int:
        """这段对话在取水位那一刻已发出的最大事件序号；没发过是 0。"""
        ...


WholeFilmExportStatus = Literal["queued", "rendering", "uploading", "done", "failed", "cancelled"]
"""一次导出走到哪一步，取值照渲染服务。"""


@dataclass(frozen=True, slots=True)
class WholeFilmExportError:
    """导出失败的原因：``code`` 是渲染服务自己的（render-failed、upload-failed、media-unreachable、
    timeout），或本系统的（RENDER_LOST、RENDER_REJECTED、RENDER_UNAVAILABLE、PROVIDER_TIMEOUT 等），
    ``message`` 是给人看的一句话。"""

    code: str
    message: str


@dataclass(frozen=True, slots=True)
class WholeFilmExport:
    """一次成片导出，即那条成片生成记录给人看的样子。"""

    id: uuid.UUID
    status: WholeFilmExportStatus
    progress: float | None
    """0–1，只在渲染服务答得上来时有。"""
    queue_position: int | None
    """排队时前面还有几个；渲染服务答不上来或不在排队为 None。"""
    error: WholeFilmExportError | None
    download_url: str | None
    """只在 done 时有：成片的公开地址，长期有效。"""
    source_job_ids: tuple[uuid.UUID, ...]
    """这次用到的素材片，去重、按在画面轨里第一次出现的先后。"""


__all__ = [
    "IDLE_ACTIVITY",
    "Conversation",
    "ConversationActivity",
    "EventWatermark",
    "TitleKind",
    "WholeFilmDraft",
    "WholeFilmExport",
    "WholeFilmExportError",
    "WholeFilmExportStatus",
]
