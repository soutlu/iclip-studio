"""给应用的 ``/v1`` 接口的请求体与答复体：会话、工作区与素材台账、agent 名册与起标题、运行统计。

路由（``agent_runtime.http``）与应用用的客户端库（``agent_runtime.client``）共用这一份，只依赖 pydantic
与 transcript、文件存储、素材台账的形状，不碰 Web 框架。transcript 的消息与读页信封在
``agent_runtime.transcript.wire``。
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Final, Self

from pydantic import Field, model_validator

from agent_runtime.file_store.store import FileEntry
from agent_runtime.material_ledger.store import Material
from agent_runtime.transcript.wire import Envelope, PromptId, PromptParts, SessionActivityOut

END_USER_HEADER: Final = "X-End-User"
"""代办用户的请求头：管理接口里是操作人，会话接口里是会话的属主，值都是用户 id。"""

MAX_AGENT_ID_CHARS = 128
"""agent 标识的长度上限，与后端建对话的请求体一致。"""

AgentIdField = Annotated[str, Field(min_length=1, max_length=MAX_AGENT_ID_CHARS)]


# --- 会话 ---------------------------------------------------------------------


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
    """源会话的属主。"""
    turn: Annotated[int, Field(ge=1)]
    """从第几轮分叉，从 1 数，这一轮包含在副本里。"""
    agent_id: AgentIdField | None = None
    """不给照抄源会话固定的版本；给了按开会话的规矩固定那个 agent 的当前版本。"""


class FilesCopyIn(Envelope):
    """按清单把源会话的几份文件拷进 ``target_id``，连同整份素材台账；目标的属主是 ``X-End-User``。"""

    target_id: uuid.UUID
    source_user: uuid.UUID
    """源会话的属主。"""
    files: tuple[tuple[str, str], ...]
    """（源路径，目标路径）；源里没有的跳过。"""
    require_any: tuple[str, ...] = ()
    """这些源路径一个都不在时什么都不写，答 ``copied: false``；空着即没有这个前提，照拷。"""


class FilesCopyOut(Envelope):
    copied: bool


class ActivitiesIn(Envelope):
    ids: tuple[uuid.UUID, ...]


class ActivitiesOut(Envelope):
    items: dict[uuid.UUID, SessionActivityOut]
    """按会话 id；只有调用方应用自己的会话，不存在的与别的应用的都不在，没跑过的是空闲。"""


class BusyOut(Envelope):
    ids: tuple[uuid.UUID, ...]


# --- 消息 ---------------------------------------------------------------------


class SessionPromptIn(Envelope):
    """发一条消息：协议请求体（``PromptSubmission``）的 ``prompt_id`` 与 ``content``，加上这段会话用哪个
    agent 与这条消息替谁发。

    属主是 ``X-End-User``；``user_name`` 由应用按它的规则定好，这里必填。
    """

    prompt_id: PromptId
    content: PromptParts
    user_name: Annotated[str, Field(min_length=1)]
    agent_id: AgentIdField


# --- 工作区与素材台账 -----------------------------------------------------------


class FilesOut(Envelope):
    files: tuple[FileEntry, ...]


class FileWriteIn(Envelope):
    """整份覆盖一份文件。``expected_version`` 给了就按它比对：对不上（含文件已删）是 409；不给照写。"""

    content: str
    expected_version: int | None = None


class MaterialsIn(Envelope):
    materials: tuple[Material, ...]
    """同一地址重复登记保留首条。"""


MAX_MATERIAL_LOOKUP_URLS: Final = 1000
"""一次批量查素材最多带多少个地址；更多的由应用分批查。"""


class MaterialsLookupIn(Envelope):
    urls: Annotated[
        tuple[Annotated[str, Field(min_length=1)], ...],
        Field(min_length=1, max_length=MAX_MATERIAL_LOOKUP_URLS),
    ]
    """素材地址，按原始字符串精确匹配；可以重复。"""


class MaterialsLookupOut(Envelope):
    materials: tuple[Material, ...]
    """登记过的那些，每个地址一条；没登记过的不在里面。"""


# --- agent 名册与起标题 ----------------------------------------------------------


class AgentEntryOut(Envelope):
    id: str
    name: str
    """给人看的名字。"""


class AgentDirectoryOut(Envelope):
    """上菜单、在用、发布过的 agent，按配置里的先后；``default`` 是第一个，名册空着为空。"""

    items: tuple[AgentEntryOut, ...]
    default: str | None


class TitleIn(Envelope):
    text: str
    """这一轮的用户消息。"""


class TitleOut(Envelope):
    title: str | None
    """没设默认对话模型、建不出模型或模型没给出标题时为空，应用照旧用默认名。"""


# --- 运行统计 -------------------------------------------------------------------

MAX_STATS_SESSIONS: Final = 1000
"""统计接口一次按会话取时最多列多少段会话；更多的由应用分批取。"""

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
    """这次运行所属消息的 ``user_name``。"""
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
    """只有跑过的会话；没有消息的不在里面。"""


__all__ = [
    "END_USER_HEADER",
    "MAX_AGENT_ID_CHARS",
    "MAX_STATS_SESSIONS",
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
    "MaterialsIn",
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
