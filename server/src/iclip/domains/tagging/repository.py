"""资料库标签的端口：自有表的仓储，以及由组合根接上的取文字与打标。"""

from __future__ import annotations

import uuid
from collections.abc import Collection, Mapping, Sequence
from contextlib import AbstractAsyncContextManager
from typing import Protocol

from iclip.domains.tagging.models import (
    AutoFill,
    Claim,
    EntryKey,
    TagCounts,
    TagErrorCode,
    TagNode,
)


class TagTreeWriter(Protocol):
    """一次改树：同一时刻只有一个改树的事务在跑，块正常结束提交、出错回滚；同一上级下撞名在这里就是
    ``ValidationFailed``。"""

    async def tree(self) -> tuple[TagNode, ...]:
        """拿到写锁之后的整棵树，同 ``TagStore.tree``。"""
        ...

    async def insert(
        self,
        tag_id: uuid.UUID,
        *,
        parent_id: uuid.UUID | None,
        name: str,
        guide: str | None,
        auto_fill: AutoFill | None,
        position: int,
    ) -> None: ...

    async def update(
        self, tag_id: uuid.UUID, *, name: str, guide: str | None, auto_fill: AutoFill | None
    ) -> None:
        """三项都按给的写。"""
        ...

    async def place(self, ordered: Sequence[uuid.UUID]) -> None:
        """一组同级按给的先后重新编成 0..n-1。"""
        ...

    async def delete(self, tag_id: uuid.UUID) -> bool:
        """删掉它；下级与条目上的它由外键级联删掉。没有这个标签给 ``False``。"""
        ...


class TagStore(Protocol):
    """``library_tags``、``library_entries``、``library_entry_tags`` 的数据访问。状态跳转都是带条件的
    更新。"""

    async def tree(self) -> tuple[TagNode, ...]:
        """全部维度，各带下级，同级按 ``position``、再按 id 排。"""
        ...

    def edit(self) -> AbstractAsyncContextManager[TagTreeWriter]:
        """开一次改树，见 ``TagTreeWriter``。"""
        ...

    async def counts(self) -> Mapping[uuid.UUID, TagCounts]:
        """每个用到的标签的条目数，含带它任一下级的；没用到的不在里面。"""
        ...

    async def ensure(self, key: EntryKey, *, created_by: uuid.UUID | None) -> None:
        """没有这一条就建，打标状态为空；已有的不动。"""
        ...

    async def mark_pending(self, key: EntryKey, *, created_by: uuid.UUID | None) -> uuid.UUID:
        """这一条改成 ``pending``（没有就建），不看原来的状态；交回条目 id。"""
        ...

    async def request(self, key: EntryKey) -> uuid.UUID | None:
        """不在 ``pending`` / ``running`` 的这一条改成 ``pending``，交回条目 id；正在打标或没有这一条
        给 ``None``。"""
        ...

    async def abandon_pending(self, entry_id: uuid.UUID) -> None:
        """排队没排上：还在 ``pending`` 的这一条改成 ``failed / model_call_failed``，并清掉 AI 维度的
        标签。"""
        ...

    async def replace(self, key: EntryKey, tag_ids: Collection[uuid.UUID]) -> bool:
        """整份替换这一条的全部标签；正在打标给 ``False``，不写。``tag_ids`` 里此刻已不存在的跳过。"""
        ...

    async def claim(self, entry_id: uuid.UUID) -> Claim | None:
        """``pending`` 改成 ``running`` 并记开始时刻；不在 ``pending`` 给 ``None``。"""
        ...

    async def finish(self, claim: Claim, tag_ids: Collection[uuid.UUID]) -> bool:
        """这一次打完：删掉这一条在 AI 维度的标签，写上 ``tag_ids`` 里此刻仍在 AI 维度的，改成
        ``completed``。这一次已被收尾（不在打标中，或开始时刻对不上）给 ``False``，不写。"""
        ...

    async def fail(self, claim: Claim, *, error_code: TagErrorCode) -> bool:
        """这一次没打成：记失败原因并清掉 AI 维度的标签，人工维度不动。已被收尾给 ``False``。"""
        ...

    async def time_out_stalled(self, *, older_than_seconds: int) -> int:
        """开始超过这么久还在打标中的条目改成 ``failed / timeout``、清掉 AI 维度的标签，交回几条。"""
        ...


class SourceText(Protocol):
    """打标读的文字：按条目的种类取，由组合根接上。"""

    async def text(self, key: EntryKey) -> str | None:
        """这一条现在的文字；取不到给 ``None``。"""
        ...


class Tagger(Protocol):
    """按一段文字在 AI 维度里选标签；每次调用都是一次付费模型调用。"""

    async def tag(self, text: str, dimensions: Sequence[TagNode]) -> tuple[uuid.UUID, ...]:
        """``dimensions`` 是当前 ``auto_fill = ai`` 的维度连同下级；交回选中的取值 id，选了下级就不含
        它的上级。给不出可用的标签抛 ``TaggingFailed``。"""
        ...


class TaggingQueuePort(Protocol):
    """把一条交给后台打标。"""

    async def enqueue_tagging(self, entry_id: uuid.UUID) -> None:
        """排一次打标；排不上就抛出。"""
        ...


__all__ = ["SourceText", "TagStore", "TagTreeWriter", "Tagger", "TaggingQueuePort"]
