"""全局帧的信封：带属主、带这段对话的事件序号；没有对话的生成任务不占序号（ADR-0004）。"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from typing import Any, cast

from iclip.domains.agents.transcript_api import LiveConnections


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


def test_event_frames_carry_the_owner_and_count_up_per_conversation() -> None:
    owner, conversation = uuid.uuid4(), uuid.uuid4()
    live, connection = _live(owner)

    live.announce_activity(
        owner, conversation, busy=True, pending_interaction="none", last_turn_reason=None
    )
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
    live.announce_session_deleted(owner, conversation)

    assert [frame["seq"] for frame in connection.frames] == [1, 2, 3, 4]
    assert {frame["owner_user_id"] for frame in connection.frames} == {str(owner)}
    assert {frame["epoch"] for frame in connection.frames} == {live.clock.epoch}


def test_a_generation_without_a_conversation_takes_no_event_number() -> None:
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
    assert "seq" not in frame
    assert "session_id" not in frame
    assert frame["owner_user_id"] == str(owner)


def test_a_row_frame_reuses_the_watermark_it_was_read_under() -> None:
    """带整行的帧不发新号：信封序号就是行上的水位，之后的事件帧号更大。"""

    owner, conversation = uuid.uuid4(), uuid.uuid4()
    live, connection = _live(owner)
    live.clock.tick(conversation)

    live.announce_session_row(
        "updated", owner, conversation, {"id": str(conversation), "lastSeq": 1}, 1
    )
    live.announce_title(owner, conversation, "后来的名字")

    row, title = connection.frames
    assert (row["type"], row["seq"], row["payload"]) == (
        "event.session.updated",
        1,
        {"id": str(conversation), "lastSeq": 1},
    )
    assert title["seq"] == 2
