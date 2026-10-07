"""会话事件水位：每段对话一条单调递增的事件序号，加一个进程级 epoch。

照 Kimi 会话事件日志的 ``epoch + seq``：全局帧与文件变更帧逐帧递增这段对话的序号，列表行带上
「读库之前」这段对话的序号作水位，客户端按「帧序号大于行水位才比行新」合并两路数据。

序号只在进程内存里，不落库：我们不做事件重放，序号只用来给帧与 REST 行排先后（ADR-0004）。
进程重启后序号从头编，epoch 随之换新，客户端只在 epoch 相同时比较序号。

所有方法同步：分配序号与入队出站帧之间不能被 await 打断，否则同一段对话的帧会乱序。
"""

from __future__ import annotations

import uuid
from collections.abc import Mapping
from dataclasses import dataclass, field
from types import MappingProxyType


@dataclass(frozen=True, slots=True)
class EventSnapshot:
    """某一刻各段对话的事件水位。读库之前取一份，行上的 ``lastSeq`` 就按它填。"""

    epoch: str
    seqs: Mapping[str, int] = field(default_factory=dict)

    def seq_of(self, conversation_id: uuid.UUID | str) -> int:
        """这段对话在快照时刻的序号；还没发过帧的对话是 0。"""

        return self.seqs.get(str(conversation_id), 0)


class SessionEventClock:
    """按对话发事件序号。

    一段对话的序号从 1 起连续递增；``epoch`` 在构造时生成，进程内不变。
    """

    def __init__(self) -> None:
        self.epoch = str(uuid.uuid4())
        self._seqs: dict[str, int] = {}

    def tick(self, conversation_id: uuid.UUID | str) -> int:
        """给这段对话的下一帧事件发号。调用方须在事务提交之后调用，并紧接着入队这一帧。"""

        key = str(conversation_id)
        seq = self._seqs.get(key, 0) + 1
        self._seqs[key] = seq
        return seq

    def current(self, conversation_id: uuid.UUID | str) -> int:
        """这段对话已发出的最大序号，不递增；Transcript 帧的信封用它。"""

        return self._seqs.get(str(conversation_id), 0)

    def snapshot(self) -> EventSnapshot:
        """复制一份当前水位。ids 在读库之前未知，只能整份复制。"""

        return EventSnapshot(epoch=self.epoch, seqs=MappingProxyType(dict(self._seqs)))


__all__ = ["EventSnapshot", "SessionEventClock"]
