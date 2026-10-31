"""两条 WebSocket 的应用一侧：对话内容流 ``/v1/ws`` 的通道与应用事件流 ``/v1/events`` 的迭代器。

帧的形状在 ``agent_runtime.live.frames``，协议见 conventions §20。两边都自动回心跳：收到 ``ping`` 就回同
``nonce`` 的 ``pong``、不交给调用方。所以只有调用方一直在收，连接才算活着：连着 20 秒不收，运行时以
``1001`` 关闭。

对话内容流的帧不逐帧校验，交出帧头里的 ``type`` 与原文，应用原样转给浏览器；事件流上认得的事件交出解析
结果（多出的字段忽略）与原文，认不出的 ``type`` 只交出原文，由调用方决定怎么办。两边都容忍运行时先于应用加字段、
加帧，两个服务不必严格同版本上线。

运行时关连接、网络中断都抛 ``StreamClosed``（带关闭码），不以迭代结束收场；帧不是带 ``type`` 的 JSON、
或认得的帧解析不了抛 ``RuntimeUnavailable``。调用方自己退出上下文是正常关闭，不抛。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Self

from httpx_ws import (
    AsyncWebSocketSession,
    WebSocketDisconnect,
    WebSocketInvalidTypeReceived,
    WebSocketNetworkError,
)
from pydantic import BaseModel, ConfigDict, ValidationError
from wsproto.utilities import LocalProtocolError

from agent_runtime.client.errors import RuntimeUnavailable, StreamClosed
from agent_runtime.live.frames import Ping, Pong, SessionWorkChanged
from agent_runtime.transcript.wire import Envelope, Subscribe, Unsubscribe


@dataclass(frozen=True, slots=True)
class RawFrame:
    """运行时发来的一帧：帧头里的 ``type`` 加原文。原文没有校验，转发时原样发出。"""

    type: str
    text: str


@dataclass(frozen=True, slots=True)
class WorkChangedFrame:
    """事件流上的一帧会话活动：``event`` 是解析出的事件（多出的字段忽略），供应用找该通知的人；``text`` 是
    运行时发来的原文，转发时原样发出，运行时新加的字段也就带到了浏览器。"""

    event: SessionWorkChanged
    text: str


AppEventFrame = WorkChangedFrame | RawFrame
"""应用事件流上交给调用方的帧：会话活动带着解析结果与原文，认不出的 ``type`` 只有原文（心跳已经回掉了）。"""


class _FrameHead(BaseModel):
    """帧头：只认 ``type``，其余字段不看。"""

    model_config = ConfigDict(extra="ignore", frozen=True)

    type: str


_WORK_CHANGED: str = SessionWorkChanged.model_fields["type"].default

_NETWORK_CLOSE = 1006
"""没有收到关闭帧就断了（RFC 6455 的 abnormal closure）。"""


class _Socket:
    """一条已经握手的连接：发帧、收一帧读出帧头、遇到 ``ping`` 回 ``pong``。"""

    def __init__(self, ws: AsyncWebSocketSession) -> None:
        self._ws = ws

    async def send(self, frame: Envelope) -> None:
        try:
            await self._ws.send_text(frame.model_dump_json(exclude_none=True, by_alias=True))
        except WebSocketNetworkError as exc:
            raise StreamClosed(_NETWORK_CLOSE, "网络中断") from exc
        except LocalProtocolError as exc:
            # 运行时的关闭帧已经到了、调用方还没收到它：真正的关闭码由下一次收帧给出。
            raise StreamClosed(_NETWORK_CLOSE, "连接已在关闭") from exc

    async def receive(self) -> RawFrame:
        while True:
            try:
                raw = await self._ws.receive_text()
            except WebSocketDisconnect as exc:
                raise StreamClosed(exc.code, exc.reason) from exc
            except WebSocketNetworkError as exc:
                raise StreamClosed(_NETWORK_CLOSE, "网络中断") from exc
            except WebSocketInvalidTypeReceived as exc:
                raise RuntimeUnavailable("实时连接上收到了不是文本的帧") from exc
            try:
                head = _FrameHead.model_validate_json(raw)
            except ValidationError as exc:
                raise RuntimeUnavailable("实时连接上的帧读不出类型") from exc
            if head.type == "ping":
                ping = _parsed(Ping, raw)
                await self.send(Pong(payload=ping.payload))
                continue
            return RawFrame(type=head.type, text=raw)


def _parsed[T: Envelope](model: type[T], raw: str) -> T:
    """按 ``model`` 解析一帧认得的帧，多出的字段忽略。"""

    try:
        return model.model_validate_json(raw, extra="ignore")
    except ValidationError as exc:
        raise RuntimeUnavailable("实时连接上的帧解析不了") from exc


class TranscriptChannel:
    """对话内容流的一条连接：每段会话发一帧 ``subscribe_v2``，收回执、reset / ops 与订着的会话的文件变化。

    帧按 ``session_id`` 分流由调用方做；一条连接只该有一个任务在 ``receive``，订阅可以从别的任务发。
    """

    def __init__(self, ws: AsyncWebSocketSession) -> None:
        self._socket = _Socket(ws)

    async def subscribe(self, frame: Subscribe) -> None:
        await self._socket.send(frame)

    async def unsubscribe(self, frame: Unsubscribe) -> None:
        await self._socket.send(frame)

    async def receive(self) -> RawFrame:
        """等下一帧（回执、reset、ops、文件变化，或运行时新加的帧）的原文；期间的心跳自动回掉。"""

        return await self._socket.receive()


class EventStream:
    """应用事件流：``async for`` 依次交出这个应用所有会话的活动，期间的心跳自动回掉。"""

    def __init__(self, ws: AsyncWebSocketSession) -> None:
        self._socket = _Socket(ws)

    def __aiter__(self) -> Self:
        return self

    async def __anext__(self) -> AppEventFrame:
        frame = await self._socket.receive()
        if frame.type == _WORK_CHANGED:
            return WorkChangedFrame(event=_parsed(SessionWorkChanged, frame.text), text=frame.text)
        return frame


__all__ = ["AppEventFrame", "EventStream", "RawFrame", "TranscriptChannel", "WorkChangedFrame"]
