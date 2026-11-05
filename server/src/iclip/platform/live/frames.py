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
    type: Literal["session.meta.updated"] = "session.meta.updated"
    session_id: str
    owner_user_id: str
    timestamp: str
    payload: SessionMetaPayload


class GenerationChangedPayload(Envelope):
    id: str
    kind: GenerationKind
    operation: GenerationOperation
    status: GenerationStatus
    shot_index: int | None = None
    metadata: dict[str, Any] | None = None


class GenerationChanged(Envelope):
    type: Literal["event.generation.changed"] = "event.generation.changed"
    session_id: str | None = None
    owner_user_id: str
    timestamp: str
    payload: GenerationChangedPayload


class SessionCreated(Envelope):
    type: Literal["event.session.created"] = "event.session.created"
    session_id: str
    owner_user_id: str
    timestamp: str
    payload: dict[str, Any]


class SessionUpdated(Envelope):
    type: Literal["event.session.updated"] = "event.session.updated"
    session_id: str
    owner_user_id: str
    timestamp: str
    payload: dict[str, Any]


class SessionDeleted(Envelope):
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
