from __future__ import annotations

from datetime import UTC, datetime
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


def timestamp_now() -> str:
    return datetime.now(UTC).isoformat()


class SessionWorkChanged(Envelope):
    type: Literal["event.session.work_changed"] = "event.session.work_changed"
    session_id: str
    owner_user_id: str
    preview: bool = False
    timestamp: str
    payload: SessionActivityOut


AppEvent = SessionWorkChanged


class TranscriptResetFrame(Envelope):
    type: Literal["transcript.reset"] = "transcript.reset"
    session_id: str
    timestamp: str
    stream_epoch: str
    payload: ResetPayload


class TranscriptOpsFrame(Envelope):
    type: Literal["transcript.ops"] = "transcript.ops"
    session_id: str
    timestamp: str
    stream_epoch: str
    payload: OpsPayload


class FsChangeEntry(Envelope):
    path: str
    change: Literal["created", "modified", "deleted"]


class FsChangesPayload(Envelope):
    changes: tuple[FsChangeEntry, ...]


class FsChanged(Envelope):
    type: Literal["event.fs.changed"] = "event.fs.changed"
    session_id: str
    timestamp: str
    payload: FsChangesPayload


class SubscribeAckPayload(Envelope):
    accepted: tuple[str, ...] = ()
    not_found: tuple[str, ...] = ()


class Ack(Envelope):
    type: Literal["ack"] = "ack"
    id: str
    code: int = 0
    msg: str = ""
    payload: SubscribeAckPayload | None = None


class PingPayload(Envelope):
    nonce: str


class Ping(Envelope):
    type: Literal["ping"] = "ping"
    timestamp: str
    payload: PingPayload


class Pong(Envelope):
    type: Literal["pong"] = "pong"
    payload: PingPayload | None = None


EventServerFrame = Annotated[SessionWorkChanged | Ping, Field(discriminator="type")]

TranscriptServerFrame = Annotated[
    TranscriptResetFrame | TranscriptOpsFrame | FsChanged | Ack | Ping,
    Field(discriminator="type"),
]

TranscriptClientFrame = Annotated[Subscribe | Unsubscribe | Pong, Field(discriminator="type")]


__all__ = [
    "Ack",
    "AppEvent",
    "EventServerFrame",
    "FsChangeEntry",
    "FsChanged",
    "FsChangesPayload",
    "Ping",
    "PingPayload",
    "Pong",
    "SessionWorkChanged",
    "SubscribeAckPayload",
    "TranscriptClientFrame",
    "TranscriptOpsFrame",
    "TranscriptResetFrame",
    "TranscriptServerFrame",
    "timestamp_now",
]
