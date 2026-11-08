from __future__ import annotations

from datetime import UTC, datetime
from typing import Literal

from iclip.platform.runtime_api.transcript.wire import (
    Envelope,
    OpsPayload,
    ResetPayload,
    SessionActivityOut,
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


__all__ = [
    "Ack",
    "FsChangeEntry",
    "FsChanged",
    "FsChangesPayload",
    "Ping",
    "PingPayload",
    "Pong",
    "SessionWorkChanged",
    "SubscribeAckPayload",
    "TranscriptOpsFrame",
    "TranscriptResetFrame",
    "timestamp_now",
]
