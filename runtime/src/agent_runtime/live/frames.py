"""运行时服务两条 WebSocket 的帧：应用事件流 ``/v1/events`` 与对话内容流 ``/v1/ws``。

只给应用（BFF）用，不直达浏览器：信封上没有会话事件的 ``epoch`` / ``seq``，那是应用转给浏览器时自己盖的。
信封字段名原样（snake_case），嵌套的 transcript 实体与操作照用 camelCase 别名；序列化用
``model_dump_json(exclude_none=True, by_alias=True)``。
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import Field

from agent_runtime.transcript.wire import (
    Envelope,
    OpsPayload,
    ResetPayload,
    SessionActivityOut,
    Subscribe,
    Unsubscribe,
)

# --- 应用事件流 ---------------------------------------------------------------


class SessionActivity(Envelope):
    """一段会话的活动变了。写入提交后同步入队，同一条连接上先到的先发：一条跑完接着起下一条时先 idle 后
    busy。"""

    type: Literal["session.activity"] = "session.activity"
    session_id: str
    owner_user_id: str
    """会话的属主，应用据此找该通知的人，不必回查。"""
    activity: SessionActivityOut


class FsChangeEntry(Envelope):
    path: str
    change: Literal["created", "modified", "deleted"]


class FsChanged(Envelope):
    """会话工作区里的文件变了：插件的工作区写入与 ``PUT /v1/sessions/{id}/files/...`` 都会发；分叉与按
    清单拷文件不发。帧上不带版本，收到的一方按需重读。"""

    type: Literal["fs.changed"] = "fs.changed"
    session_id: str
    owner_user_id: str
    entries: tuple[FsChangeEntry, ...]


AppEvent = Annotated[SessionActivity | FsChanged, Field(discriminator="type")]
"""应用事件流上的事件；每条连接收到的是这个应用所有会话的全部事件。"""


# --- 对话内容流 ---------------------------------------------------------------


class TranscriptResetFrame(Envelope):
    """订阅一个 agent 流时的第一帧（或水位接不上时的那一帧）；``stream_epoch`` 与 ``payload.seq`` 无条件
    覆写订阅方的水位。"""

    type: Literal["transcript.reset"] = "transcript.reset"
    session_id: str
    stream_epoch: str
    payload: ResetPayload


class TranscriptOpsFrame(Envelope):
    """一个 agent 流的一批操作；``stream_epoch`` 标出 ``payload.seq`` 属于哪一条实时流。"""

    type: Literal["transcript.ops"] = "transcript.ops"
    session_id: str
    stream_epoch: str
    payload: OpsPayload


class SubscribeAckPayload(Envelope):
    accepted: tuple[str, ...] = ()
    not_found: tuple[str, ...] = ()


class Ack(Envelope):
    """``subscribe_v2`` / ``unsubscribe_v2`` 的回执；``code`` 为 0 即成功。"""

    type: Literal["ack"] = "ack"
    id: str
    code: int = 0
    msg: str = ""
    payload: SubscribeAckPayload | None = None


# --- 两条流共用 ---------------------------------------------------------------


class PingPayload(Envelope):
    nonce: str


class Ping(Envelope):
    """心跳。对方回任意一帧（通常是 ``pong``）就算活着。"""

    type: Literal["ping"] = "ping"
    payload: PingPayload


class Pong(Envelope):
    type: Literal["pong"] = "pong"
    payload: PingPayload | None = None


EventServerFrame = Annotated[SessionActivity | FsChanged | Ping, Field(discriminator="type")]
"""``/v1/events`` 上服务端发的帧。"""

TranscriptServerFrame = Annotated[
    TranscriptResetFrame | TranscriptOpsFrame | Ack | Ping, Field(discriminator="type")
]
"""``/v1/ws`` 上服务端发的帧。"""

TranscriptClientFrame = Annotated[Subscribe | Unsubscribe | Pong, Field(discriminator="type")]
"""``/v1/ws`` 上应用发的帧；``/v1/events`` 上应用只发 ``Pong``。认不出的帧忽略。"""


__all__ = [
    "Ack",
    "AppEvent",
    "EventServerFrame",
    "FsChangeEntry",
    "FsChanged",
    "Ping",
    "PingPayload",
    "Pong",
    "SessionActivity",
    "SubscribeAckPayload",
    "TranscriptClientFrame",
    "TranscriptOpsFrame",
    "TranscriptResetFrame",
    "TranscriptServerFrame",
]
