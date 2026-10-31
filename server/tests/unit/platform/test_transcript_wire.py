"""连接级帧的序列化契约：外层照 Kimi 的 ``{type, session_id, timestamp, payload}``，空字段整个省略，客户端
schema 按可选处理。"""

from __future__ import annotations

import json

from agent_runtime.transcript.wire import Envelope

from iclip.platform.live.frames import (
    GenerationChanged,
    GenerationChangedPayload,
    ServerHello,
    ServerHelloPayload,
    SessionDeleted,
    SessionMetaPayload,
    SessionMetaUpdated,
)

AT = "2026-10-30T08:00:00+00:00"


def _sent(frame: Envelope) -> object:
    return json.loads(frame.model_dump_json(exclude_none=True, by_alias=True))


def test_the_hello_carries_its_capabilities_inside_the_payload() -> None:
    hello = ServerHello(
        timestamp=AT, payload=ServerHelloPayload(ws_connection_id="w1", heartbeat_ms=1)
    )

    assert _sent(hello) == {
        "type": "server_hello",
        "timestamp": AT,
        "payload": {
            "ws_connection_id": "w1",
            "protocol_version": 2,
            "heartbeat_ms": 1,
            "capabilities": {"event_batching": False, "compression": False},
        },
    }


def test_title_and_deletion_frames_name_the_conversation_on_the_envelope_only() -> None:
    title = SessionMetaUpdated(
        session_id="c-1",
        owner_user_id="u-1",
        timestamp=AT,
        payload=SessionMetaPayload(title="片名"),
    )
    deleted = SessionDeleted(session_id="c-1", owner_user_id="u-1", timestamp=AT)

    assert _sent(title) == {
        "type": "session.meta.updated",
        "session_id": "c-1",
        "owner_user_id": "u-1",
        "timestamp": AT,
        "payload": {"title": "片名"},
    }
    assert _sent(deleted) == {
        "type": "event.session.deleted",
        "session_id": "c-1",
        "owner_user_id": "u-1",
        "timestamp": AT,
    }


def test_a_generation_frame_omits_empty_origin_fields_on_the_wire() -> None:
    frame = GenerationChanged(
        owner_user_id="u-1",
        session_id=None,
        timestamp=AT,
        payload=GenerationChangedPayload(
            id="job-1", kind="video", operation="compose", status="pending"
        ),
    )

    sent = json.loads(frame.model_dump_json(exclude_none=True, by_alias=True))

    assert sent == {
        "type": "event.generation.changed",
        "owner_user_id": "u-1",
        "timestamp": AT,
        "payload": {"id": "job-1", "kind": "video", "operation": "compose", "status": "pending"},
    }


def test_a_video_frame_carries_its_shot_index_under_the_envelopes_own_name() -> None:
    frame = GenerationChanged(
        owner_user_id="u-1",
        session_id="c-1",
        timestamp=AT,
        payload=GenerationChangedPayload(
            id="job-3", kind="video", operation="generate", status="submitted", shot_index=2
        ),
    )

    sent = json.loads(frame.model_dump_json(exclude_none=True, by_alias=True))

    assert sent["payload"] == {
        "id": "job-3",
        "kind": "video",
        "operation": "generate",
        "status": "submitted",
        "shot_index": 2,
    }


def test_a_generation_frame_carries_the_callers_metadata_verbatim() -> None:
    coordinate = {"path": "video_shot.json", "shot": 1, "frame": 3}
    frame = GenerationChanged(
        owner_user_id="u-1",
        session_id="c-1",
        timestamp=AT,
        payload=GenerationChangedPayload(
            id="job-2", kind="image", operation="generate", status="completed", metadata=coordinate
        ),
    )

    sent = json.loads(frame.model_dump_json(exclude_none=True, by_alias=True))

    assert sent["session_id"] == "c-1"
    assert sent["payload"] == {
        "id": "job-2",
        "kind": "image",
        "operation": "generate",
        "status": "completed",
        "metadata": coordinate,
    }
