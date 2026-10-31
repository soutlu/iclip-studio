"""后端自己发给浏览器的连接级 WS 帧：握手与全局事件。

外层照 Kimi 是 ``{type, session_id, timestamp, payload}``，回执以外每帧都带 ``timestamp``。从运行时转来的
会话活动、Transcript 帧、文件变化、回执与心跳就是运行时的帧，定义在 ``agent_runtime.live.frames``，这里只
引用、原样转发。信封基类在 ``agent_runtime.transcript.wire``。

信封使用 snake_case，嵌套实体与操作使用 camelCase，与客户端 schema.ts 保持一致。
"""

from __future__ import annotations

from typing import Annotated, Any, Literal

from agent_runtime.live.frames import (
    Ack,
    FsChanged,
    Ping,
    Pong,
    SessionWorkChanged,
    TranscriptOpsFrame,
    TranscriptResetFrame,
)
from agent_runtime.transcript.wire import Envelope, Subscribe, Unsubscribe
from pydantic import Field

from iclip.common.generation_vocab import GenerationKind, GenerationOperation, GenerationStatus


class ServerHelloCapabilities(Envelope):
    event_batching: bool = False
    compression: bool = False


class ServerHelloPayload(Envelope):
    ws_connection_id: str
    protocol_version: int = 2
    heartbeat_ms: int
    capabilities: ServerHelloCapabilities = ServerHelloCapabilities()


class ServerHello(Envelope):
    type: Literal["server_hello"] = "server_hello"
    timestamp: str
    payload: ServerHelloPayload


class SessionMetaPayload(Envelope):
    title: str


class SessionMetaUpdated(Envelope):
    """某段对话的标题变了。

    **这一帧不看订阅，发给属主与治理者连着的每一条连接**（协议里它属于全局事件那一类）。侧栏列着几十段
    对话却一段都没订，按订阅发的话它永远收不到改名。
    """

    type: Literal["session.meta.updated"] = "session.meta.updated"
    session_id: str
    owner_user_id: str
    timestamp: str
    payload: SessionMetaPayload


class GenerationChangedPayload(Envelope):
    """``kind``、``operation`` 与 ``status`` 取 common 的生成词表，与列表接口 ``GenerationOut`` 是同一份。"""

    id: str
    kind: GenerationKind
    operation: GenerationOperation
    status: GenerationStatus
    shot_index: int | None = None
    """镜头组编号，只有视频有；没有就整项省略。"""
    metadata: dict[str, Any] | None = None


class GenerationChanged(Envelope):
    """某条生成任务的业务状态跳了一格。

    与 ``event.session.work_changed`` 同一类：**不看订阅，发给属主与治理者连着的每一条连接**。
    分镜页与参考帧编辑器都按对话查列表，帧只说「哪条、跳到哪」，不带结果地址——收到就重拉列表。
    ``session_id`` 在信封上，与其余 ``event.*`` 一致；没有来源对话的任务这一项省略。

    **易失**：掉了就是掉了。列表接口是事实源，客户端保留轮询兜底，帧只负责「不必等下一次重拉」。
    """

    type: Literal["event.generation.changed"] = "event.generation.changed"
    session_id: str | None = None
    owner_user_id: str
    timestamp: str
    payload: GenerationChangedPayload


class SessionCreated(Envelope):
    """新出现了一段对话：新建（含替人办事）或分叉出的副本。照 Kimi 的 ``event.session.created``。

    ``payload`` 是整行 ``ConversationOut``（camelCase）。投递范围与其余全局帧相同，易失，重连后重拉列表对账。
    """

    type: Literal["event.session.created"] = "event.session.created"
    session_id: str
    owner_user_id: str
    timestamp: str
    payload: dict[str, Any]


class SessionUpdated(Envelope):
    """一段对话的行变了：改名、换合集、换需求单、标或取消收尾。照 Kimi 的 ``event.session.updated``。

    ``payload`` 是变化后的整行 ``ConversationOut``。行里的 ``activity`` 是写库时读的，可能比随后从运行时
    来的 ``work_changed`` 旧，客户端已有这一行时不拿它改活动。
    """

    type: Literal["event.session.updated"] = "event.session.updated"
    session_id: str
    owner_user_id: str
    timestamp: str
    payload: dict[str, Any]


class SessionDeleted(Envelope):
    """属主删掉了一段对话。照 Kimi 的 ``event.session.deleted``，但对话 id 只在外层、没有 ``payload``，与
    其余对话帧一致。"""

    type: Literal["event.session.deleted"] = "event.session.deleted"
    session_id: str
    owner_user_id: str
    timestamp: str


ServerFrame = Annotated[
    ServerHello
    | TranscriptResetFrame
    | TranscriptOpsFrame
    | SessionMetaUpdated
    | SessionWorkChanged
    | GenerationChanged
    | SessionCreated
    | SessionUpdated
    | SessionDeleted
    | FsChanged
    | Ack
    | Ping,
    Field(discriminator="type"),
]


ClientFrame = Annotated[Subscribe | Unsubscribe | Pong, Field(discriminator="type")]


__all__ = [
    "ClientFrame",
    "GenerationChanged",
    "GenerationChangedPayload",
    "ServerFrame",
    "ServerHello",
    "ServerHelloCapabilities",
    "ServerHelloPayload",
    "SessionCreated",
    "SessionDeleted",
    "SessionMetaPayload",
    "SessionMetaUpdated",
    "SessionUpdated",
]
