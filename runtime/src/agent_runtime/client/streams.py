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
    type: str
    text: str


@dataclass(frozen=True, slots=True)
class WorkChangedFrame:
    event: SessionWorkChanged
    text: str


AppEventFrame = WorkChangedFrame | RawFrame


class _FrameHead(BaseModel):
    model_config = ConfigDict(extra="ignore", frozen=True)

    type: str


_WORK_CHANGED: str = SessionWorkChanged.model_fields["type"].default

_NETWORK_CLOSE = 1006


class _Socket:
    def __init__(self, ws: AsyncWebSocketSession) -> None:
        self._ws = ws

    async def send(self, frame: Envelope) -> None:
        try:
            await self._ws.send_text(frame.model_dump_json(exclude_none=True, by_alias=True))
        except WebSocketNetworkError as exc:
            raise StreamClosed(_NETWORK_CLOSE, "网络中断") from exc
        except LocalProtocolError as exc:
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
    try:
        return model.model_validate_json(raw, extra="ignore")
    except ValidationError as exc:
        raise RuntimeUnavailable("实时连接上的帧解析不了") from exc


class TranscriptChannel:
    def __init__(self, ws: AsyncWebSocketSession) -> None:
        self._socket = _Socket(ws)

    async def subscribe(self, frame: Subscribe) -> None:
        await self._socket.send(frame)

    async def unsubscribe(self, frame: Unsubscribe) -> None:
        await self._socket.send(frame)

    async def receive(self) -> RawFrame:
        return await self._socket.receive()


class EventStream:
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
