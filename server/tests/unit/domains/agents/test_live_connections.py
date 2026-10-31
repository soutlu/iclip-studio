"""不挂对话的生成记录也能发全局帧，信封只带属主。"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from typing import Any, cast

from iclip.domains.agents.transcript_api import LiveConnections

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
