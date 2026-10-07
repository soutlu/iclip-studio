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


def test_a_row_frame_is_an_event_numbered_after_the_rows_own_watermark() -> None:
    """照 Kimi 的 ``event.session.updated``：带整行的帧也发新号，比行内 ``lastSeq`` 大。

    写入之前读库的 HTTP 行带的是同一个旧水位 1。它晚于这一帧到达时，客户端按信封序号 2 记了
    行内事实字段的水位，1 不大于 2 就盖不掉；若帧序号也是 1，两边打平，旧行会盖掉新事实。"""

    owner, conversation = uuid.uuid4(), uuid.uuid4()
    live, connection = _live(owner)
    live.clock.tick(conversation)
    read_before_the_write = live.clock.snapshot().seq_of(conversation)

    live.announce_session_row(
        "updated", owner, conversation, {"id": str(conversation), "lastSeq": read_before_the_write}
    )
    live.announce_title(owner, conversation, "后来的名字")

    row, title = connection.frames
    assert (row["type"], row["payload"]["lastSeq"]) == ("event.session.updated", 1)
    assert row["seq"] == 2 > read_before_the_write
    assert title["seq"] == 3
