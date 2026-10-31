"""全局帧的信封：带属主、不带序号；运行时的活动帧原样转发。"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from typing import Any, cast

from agent_runtime.live.frames import SessionWorkChanged
from agent_runtime.transcript.wire import SessionActivityOut

from iclip.domains.agents.transcript_api import LiveConnections

RUNTIME_AT = "2026-10-30T08:00:00+00:00"
"""运行时出帧的时刻；活动帧照用它，不重盖。"""

ENVELOPE = {"type", "session_id", "owner_user_id", "timestamp", "payload"}
"""全局帧外层的全部字段（合同 §5「全局帧」）。"""


@dataclass(eq=False)
class Listening:
    """只认属主的一条连接替身，记下收到的帧。"""

    owner: uuid.UUID
    frames: list[Any] = field(default_factory=list)

    def receives(self, owner: uuid.UUID) -> bool:
        return owner == self.owner

    def offer(self, frame: Any) -> None:
        self.frames.append(frame.model_dump(exclude_none=True, by_alias=True))


def _live(owner: uuid.UUID) -> tuple[LiveConnections, Listening]:
    live = LiveConnections()
    connection = Listening(owner)
    live.add(cast("Any", connection))
    return live, connection


def test_event_frames_carry_the_owner_and_no_event_number() -> None:
    owner, conversation = uuid.uuid4(), uuid.uuid4()
    live, connection = _live(owner)

    live.announce_title(owner, conversation, "片名")
    live.announce_generation_changed(
        owner,
        conversation,
        job_id=uuid.uuid4(),
        kind="video",
        operation="generate",
        status="pending",
        shot_index=None,
        metadata=None,
    )
    live.announce_session_row("updated", owner, conversation, {"id": str(conversation)})
    live.announce_session_deleted(owner, conversation)

    title, generation, row, deleted = connection.frames
    assert [frame["type"] for frame in connection.frames] == [
        "session.meta.updated",
        "event.generation.changed",
        "event.session.updated",
        "event.session.deleted",
    ]
    assert set(title) == set(generation) == set(row) == ENVELOPE
    # 删除帧的对话 id 只在外层，没有 payload。
    assert set(deleted) == ENVELOPE - {"payload"}
    assert {frame["owner_user_id"] for frame in connection.frames} == {str(owner)}
    assert {frame["session_id"] for frame in connection.frames} == {str(conversation)}


def test_an_activity_frame_is_the_runtimes_frame_verbatim() -> None:
    owner, conversation = uuid.uuid4(), uuid.uuid4()
    live, connection = _live(owner)
    runtime_frame = SessionWorkChanged(
        session_id=str(conversation),
        owner_user_id=str(owner),
        timestamp=RUNTIME_AT,
        payload=SessionActivityOut(
            busy=False, pending_interaction="none", last_turn_reason="aborted"
        ),
    )

    live.announce_activity(runtime_frame)

    assert connection.frames == [runtime_frame.model_dump(exclude_none=True, by_alias=True)]


def test_a_generation_without_a_conversation_omits_the_session_id() -> None:
    owner = uuid.uuid4()
    live, connection = _live(owner)

    live.announce_generation_changed(
        owner,
        None,
        job_id=uuid.uuid4(),
        kind="image",
        operation="upload",
        status="completed",
        shot_index=None,
        metadata=None,
    )

    [frame] = connection.frames
    assert set(frame) == ENVELOPE - {"session_id"}
    assert frame["owner_user_id"] == str(owner)
