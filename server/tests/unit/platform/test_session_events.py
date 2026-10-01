"""会话事件时钟：按对话连续发号，水位快照不随之后的发号变化。"""

from __future__ import annotations

import uuid

from iclip.platform.transcript.session_events import SessionEventClock


def test_each_conversation_counts_its_own_events_from_one() -> None:
    clock = SessionEventClock()
    first, second = uuid.uuid4(), uuid.uuid4()

    assert [clock.tick(first), clock.tick(first), clock.tick(second)] == [1, 2, 1]
    assert (clock.current(first), clock.current(second)) == (2, 1)
    assert clock.current(uuid.uuid4()) == 0


def test_a_snapshot_is_the_watermark_at_the_moment_it_was_taken() -> None:
    """列表在读库之前取水位：之后发出的号比行新，快照不能跟着涨。"""

    clock = SessionEventClock()
    conversation = uuid.uuid4()
    clock.tick(conversation)

    taken = clock.snapshot()
    clock.tick(conversation)

    assert taken.seq_of(conversation) == 1
    assert taken.seq_of(str(conversation)) == 1
    assert taken.epoch == clock.epoch


def test_every_clock_is_its_own_epoch() -> None:
    """进程重启即换一个时钟，序号从头编；epoch 不同的序号不可比。"""

    assert SessionEventClock().epoch != SessionEventClock().epoch
