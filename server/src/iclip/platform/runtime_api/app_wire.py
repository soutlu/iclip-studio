from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Any, Final, Self

from pydantic import Field, model_validator

from iclip.platform.runtime_api.file_store.store import FileEntry
from iclip.platform.runtime_api.transcript.wire import (
    Envelope,
    PromptId,
    PromptParts,
    SessionActivityOut,
)

END_USER_HEADER: Final = "X-End-User"

MAX_AGENT_ID_CHARS = 128

AgentIdField = Annotated[str, Field(min_length=1, max_length=MAX_AGENT_ID_CHARS)]


class PreviewTargetIn(Envelope):
    """预览会话试的是哪个 agent 的哪一份：``version_id`` 为空是它当下的草稿（每次运行重读），否则是它的那一版。"""

    agent_id: AgentIdField
    version_id: uuid.UUID | None = None


class SessionOpenIn(Envelope):
    """开一个会话，``agent_id`` 与 ``preview`` 恰好给一个：给 ``agent_id`` 固定这个 agent 此刻的当前版本；
    给 ``preview`` 开预览会话（不看上不上菜单、在不在用、发没发布过）。"""

    id: uuid.UUID
    agent_id: AgentIdField | None = None
    preview: PreviewTargetIn | None = None

    @model_validator(mode="after")
    def _one_target(self) -> Self:
        if (self.agent_id is None) == (self.preview is None):
            raise ValueError("agent_id 与 preview 恰好给一个")
        return self


class SessionForkIn(Envelope):
    """从路径上的源会话第 ``turn`` 轮分叉出 ``target_id``；目标的属主是 ``X-End-User``。"""

    target_id: uuid.UUID
    source_user: uuid.UUID
    turn: Annotated[int, Field(ge=1)]
    agent_id: AgentIdField | None = None


class FilesCopyIn(Envelope):
    """按清单把源会话的几份文件拷进 ``target_id``；目标的属主是 ``X-End-User``。"""

    target_id: uuid.UUID
    source_user: uuid.UUID
    files: tuple[tuple[str, str], ...]
    require_any: tuple[str, ...] = ()


class FilesCopyOut(Envelope):
    copied: bool


class ActivitiesIn(Envelope):
    ids: tuple[uuid.UUID, ...]


class ActivitiesOut(Envelope):
    items: dict[uuid.UUID, SessionActivityOut]


class BusyOut(Envelope):
    ids: tuple[uuid.UUID, ...]


class SessionPromptIn(Envelope):
    """发一条消息：协议请求体（``PromptSubmission``）的 ``prompt_id`` 与 ``content``，加上这段会话用哪个
    agent 与这条消息替谁发。

    属主是 ``X-End-User``；``user_name`` 由应用按它的规则定好，这里必填。
    """

    prompt_id: PromptId
    content: PromptParts
    user_name: Annotated[str, Field(min_length=1)]
    agent_id: AgentIdField


class FilesOut(Envelope):
    files: tuple[FileEntry, ...]


class FileWriteIn(Envelope):
    """整份覆盖一份文件。``expected_version`` 给了就按它比对：对不上（含文件已删）是 409；不给照写。"""

    content: str
    expected_version: int | None = None


class AgentEntryOut(Envelope):
    id: str
    name: str


class AgentDirectoryOut(Envelope):
    """上菜单、在用、发布过的 agent，按配置里的先后；``default`` 是第一个，名册空着为空。"""

    items: tuple[AgentEntryOut, ...]
    default: str | None


class TitleIn(Envelope):
    text: str


class TitleOut(Envelope):
    title: str | None


MODEL_CALL_TIMEOUT_SECONDS: Final = 900.0

UPSTREAM_TIMEOUT_CODE: Final = "upstream_timeout"

UPSTREAM_UNREACHABLE_CODE: Final = "upstream_unreachable"


class ModelCallIn(Envelope):
    """经运行时调一个代码里写定的模型：按（``declaration``，``model``）在配置页里找连接，``payload`` 是
    上游接口的请求体，运行时只把它的 ``model`` 换成这个模型名，别的原样转发。"""

    declaration: Annotated[str, Field(min_length=1)]

    model: Annotated[str, Field(min_length=1)]

    payload: dict[str, Any]


MAX_STATS_SESSIONS: Final = 1000

StatsSessionIds = Annotated[
    tuple[uuid.UUID, ...], Field(min_length=1, max_length=MAX_STATS_SESSIONS)
]


class StatsQueryIn(Envelope):
    """按时间窗或按会话取统计行，二选一：给 ``since``（``until`` 可省）按各行自己的时刻落在
    ``[since, until)`` 里取，给 ``session_ids`` 取这几段会话的全部行；都给或都不给是 422。"""

    since: datetime | None = None
    until: datetime | None = None
    session_ids: StatsSessionIds | None = None

    @model_validator(mode="after")
    def _one_mode(self) -> Self:
        if self.session_ids is not None and (self.since is not None or self.until is not None):
            raise ValueError("按时间窗或按会话取，二选一")
        if self.session_ids is None and self.since is None:
            raise ValueError("按时间窗取要给 since，否则给 session_ids")
        return self


class StatsSessionsIn(Envelope):
    session_ids: StatsSessionIds


class PromptStatOut(Envelope):
    """一条消息；时间窗看 ``created_at``。"""

    session_id: uuid.UUID
    prompt_id: str
    user_name: str
    created_at: datetime


class RunStatOut(Envelope):
    """一次跑到终态的顶层运行：运行驱动登记过的运行，有开始事件也有第一条终态事件（完成或失败）；
    子代理的内部运行与没有终态的运行不在里面。时间窗看 ``started_at``。"""

    session_id: uuid.UUID
    run_id: str
    user_name: str
    started_at: datetime
    ended_at: datetime


class UsageStatOut(Envelope):
    """一段会话在一个模型上的累计用量；时间窗看 ``last_at``。"""

    session_id: uuid.UUID
    model_name: str
    requests: int
    input_tokens: int
    cache_read_tokens: int
    cache_write_tokens: int
    output_tokens: int
    last_at: datetime


class SessionStatOut(Envelope):
    """一段跑过的会话：第一条消息的时刻与最近一条消息的 ``user_name``（同一时刻按 ``prompt_id`` 大的算）。"""

    session_id: uuid.UUID
    first_prompt_at: datetime
    latest_user_name: str


class PromptStatsOut(Envelope):
    items: tuple[PromptStatOut, ...]


class RunStatsOut(Envelope):
    items: tuple[RunStatOut, ...]


class UsageStatsOut(Envelope):
    items: tuple[UsageStatOut, ...]


class SessionStatsOut(Envelope):
    items: tuple[SessionStatOut, ...]


__all__ = [
    "END_USER_HEADER",
    "MAX_AGENT_ID_CHARS",
    "MAX_STATS_SESSIONS",
    "MODEL_CALL_TIMEOUT_SECONDS",
    "UPSTREAM_TIMEOUT_CODE",
    "UPSTREAM_UNREACHABLE_CODE",
    "ActivitiesIn",
    "ActivitiesOut",
    "AgentDirectoryOut",
    "AgentEntryOut",
    "AgentIdField",
    "BusyOut",
    "FileWriteIn",
    "FilesCopyIn",
    "FilesCopyOut",
    "FilesOut",
    "ModelCallIn",
    "PreviewTargetIn",
    "PromptStatOut",
    "PromptStatsOut",
    "RunStatOut",
    "RunStatsOut",
    "SessionForkIn",
    "SessionOpenIn",
    "SessionPromptIn",
    "SessionStatOut",
    "SessionStatsOut",
    "StatsQueryIn",
    "StatsSessionIds",
    "StatsSessionsIn",
    "TitleIn",
    "TitleOut",
    "UsageStatOut",
    "UsageStatsOut",
]
