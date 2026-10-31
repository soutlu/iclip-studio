"""两条 WebSocket 的应用一侧：对话内容流 ``/v1/ws`` 的通道与应用事件流 ``/v1/events`` 的迭代器。

帧的形状在 ``agent_runtime.live.frames``，协议见 conventions §20。两边都自动回心跳：收到 ``ping`` 就回同
``nonce`` 的 ``pong``、不交给调用方。所以只有调用方一直在收，连接才算活着：连着 20 秒不收，运行时以
``1001`` 关闭。

运行时关连接、网络中断都抛 ``StreamClosed``（带关闭码），不以迭代结束收场；帧解析不了抛
``RuntimeUnavailable``。调用方自己退出上下文是正常关闭，不抛。
"""

from __future__ import annotations

from typing import Self

from httpx_ws import (
    AsyncWebSocketSession,
    WebSocketDisconnect,
    WebSocketInvalidTypeReceived,
    WebSocketNetworkError,
)
from pydantic import TypeAdapter, ValidationError
from wsproto.utilities import LocalProtocolError

from agent_runtime.client.errors import RuntimeUnavailable, StreamClosed
from agent_runtime.live.frames import (
    Ack,
    EventServerFrame,
    FsChanged,
    Ping,
    Pong,
    SessionWorkChanged,
    TranscriptOpsFrame,
    TranscriptResetFrame,
    TranscriptServerFrame,
)
from agent_runtime.transcript.wire import Envelope, Subscribe, Unsubscribe

TranscriptFrame = TranscriptResetFrame | TranscriptOpsFrame | FsChanged | Ack
"""对话内容流上交给调用方的帧（心跳已经回掉了）。"""

AppEventFrame = SessionWorkChanged
"""应用事件流上交给调用方的事件，只有会话活动（心跳已经回掉了）。"""

_TRANSCRIPT_FRAME = TypeAdapter[TranscriptResetFrame | TranscriptOpsFrame | FsChanged | Ack | Ping](
    TranscriptServerFrame
)
_EVENT_FRAME = TypeAdapter[SessionWorkChanged | Ping](EventServerFrame)

_NETWORK_CLOSE = 1006
"""没有收到关闭帧就断了（RFC 6455 的 abnormal closure）。"""


class _Socket:
    """一条已经握手的连接：发帧、收一帧并解析、遇到 ``ping`` 回 ``pong``。"""

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

    async def receive[T: Envelope](self, adapter: TypeAdapter[T | Ping]) -> T:
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
                frame = adapter.validate_json(raw)
            except ValidationError as exc:
                raise RuntimeUnavailable("实时连接上的帧解析不了") from exc
            if isinstance(frame, Ping):
                await self.send(Pong(payload=frame.payload))
                continue
            return frame


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

    async def receive(self) -> TranscriptFrame:
        """等下一帧回执、reset、ops 或文件变化；期间的心跳自动回掉。"""

        return await self._socket.receive(_TRANSCRIPT_FRAME)


class EventStream:
    """应用事件流：``async for`` 依次交出这个应用所有会话的活动，期间的心跳自动回掉。"""

    def __init__(self, ws: AsyncWebSocketSession) -> None:
        self._socket = _Socket(ws)

    def __aiter__(self) -> Self:
        return self

    async def __anext__(self) -> AppEventFrame:
        return await self._socket.receive(_EVENT_FRAME)


__all__ = ["AppEventFrame", "EventStream", "TranscriptChannel", "TranscriptFrame"]
