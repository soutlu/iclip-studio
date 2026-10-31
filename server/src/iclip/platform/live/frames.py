"""后端自己发给浏览器的连接级 WS 帧：握手、全局事件与盖了会话事件水位的转发帧。

外层照 Kimi 是 ``{type, session_id, timestamp, payload}``，回执以外每帧都带 ``timestamp``。从运行时转来的
文件变化、回执与心跳就是运行时的帧，定义在 ``agent_runtime.live.frames``，这里只引用；会话活动与 Transcript
帧是运行时的帧加上本进程的会话事件水位。信封基类与 transcript 帧在 ``agent_runtime.transcript.wire``。

信封使用 snake_case，嵌套实体与操作使用 camelCase，与客户端 schema.ts 保持一致。
每帧 reset 必须携带 seq 以覆盖客户端水位，支持进程重启后从 1 重新编号；``stream_epoch`` 标出
这条实时流的身份，客户端带着它续订，对不上就回 reset。

信封上有两种水位，互不相干：

- ``stream_epoch`` + ``payload.seq``：某个 agent 的 Transcript 批次号，续订补批用。
- ``epoch`` + ``seq``：这段对话的会话事件序号（见 ``session_events``），给列表行与帧排先后。
  事件帧（标题、活动、生成任务、会话生命周期）各发一个新号；created / updated 帧里整行的 ``lastSeq``
  是写入之前的水位，比信封序号小；Transcript 帧带当前序号，不发新号；文件变化帧不带序号。
"""

from __future__ import annotations

from typing import Annotated, Any, Literal

from agent_runtime.live.frames import Ack, FsChanged, Ping, Pong, SessionActivity
from agent_runtime.transcript.wire import (
    Envelope,
    Subscribe,
    TranscriptOps,
    TranscriptReset,
    Unsubscribe,
)
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
    seq: int
    epoch: str
    session_id: str
    owner_user_id: str
    timestamp: str
    payload: SessionMetaPayload


class SessionWorkChanged(SessionActivity):
    """某段对话「在忙什么」变了：运行时的 ``event.session.work_changed`` 原样，加上本进程的会话事件水位。

    与 ``session.meta.updated`` 同一类：**不看订阅，发给属主与治理者连着的每一条连接**。侧栏列着几十段
    对话却一段都没订，按订阅发的话它永远收不到角标。

    **易失**：这一帧不进任何日志，掉了就是掉了。所以列表行上也带着同一份事实（见
    ``ConversationOut.activity``），断线重连后重拉列表即可对齐——帧只负责「不必等下一次重拉」。
    """

    seq: int
    epoch: str


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
    seq: int | None = None
    """挂在对话上的任务才有会话事件序号；没有来源对话时与 ``session_id`` 一起省略。"""
    epoch: str
    session_id: str | None = None
    owner_user_id: str
    timestamp: str
    payload: GenerationChangedPayload


class SessionCreated(Envelope):
    """新出现了一段对话：新建（含替人办事）或分叉出的副本。照 Kimi 的 ``event.session.created``。

    ``payload`` 是整行 ``ConversationOut``（camelCase）。信封 ``seq`` 是提交之后为这一帧发的新号；
    行内 ``lastSeq`` 是写入之前的水位，比信封序号小。客户端按信封序号记行内事实字段的水位，
    按 ``lastSeq`` 合并 ``activity``（与 HTTP 行同一口径）。投递范围与其余全局帧相同，易失，重连后
    重拉列表对账。
    """

    type: Literal["event.session.created"] = "event.session.created"
    seq: int
    epoch: str
    session_id: str
    owner_user_id: str
    timestamp: str
    payload: dict[str, Any]


class SessionUpdated(Envelope):
    """一段对话的行变了：改名、换合集、换需求单、标或取消收尾。照 Kimi 的 ``event.session.updated``。

    ``payload`` 是变化后的整行 ``ConversationOut``，序号语义同 ``SessionCreated``：写入之前读库的
    HTTP 行 ``lastSeq`` 小于这一帧的信封序号，晚到也盖不掉这一帧带来的事实字段。
    """

    type: Literal["event.session.updated"] = "event.session.updated"
    seq: int
    epoch: str
    session_id: str
    owner_user_id: str
    timestamp: str
    payload: dict[str, Any]


class SessionDeleted(Envelope):
    """属主删掉了一段对话。照 Kimi 的 ``event.session.deleted``，但对话 id 只在外层、没有 ``payload``，与
    其余对话帧一致；是事件帧，发新序号。"""

    type: Literal["event.session.deleted"] = "event.session.deleted"
    seq: int
    epoch: str
    session_id: str
    owner_user_id: str
    timestamp: str


ServerFrame = Annotated[
    ServerHello
    | TranscriptReset
    | TranscriptOps
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
    "SessionWorkChanged",
]
