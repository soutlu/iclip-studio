"""资料库标签用例：读标签树与条数、建条目、排打标、整份改标签、把筛选选中的标签展开成组。

谁能改哪一条由所属的库判断；这里只管条目与标签本身。"""

from __future__ import annotations

import uuid
from collections.abc import Collection, Mapping, Sequence

import structlog

from iclip.common.errors import Conflict, ValidationFailed
from iclip.domains.tagging.models import EntryKey, TagCounts, TagNode
from iclip.domains.tagging.repository import TaggingQueuePort, TagStore
from iclip.domains.tagging.schemas import LibraryTagOut, LibraryTagsOut, TagCountsOut

_logger = structlog.stdlib.get_logger(__name__)


def _index(tree: Sequence[TagNode]) -> dict[uuid.UUID, TagNode]:
    found: dict[uuid.UUID, TagNode] = {}
    for dimension in tree:
        found[dimension.id] = dimension
        for node in dimension.descendants():
            found[node.id] = node
    return found


def _dimension_of(tree: Sequence[TagNode]) -> dict[uuid.UUID, uuid.UUID]:
    """每个节点（含维度自己）所在维度的 id。"""

    found: dict[uuid.UUID, uuid.UUID] = {}
    for dimension in tree:
        found[dimension.id] = dimension.id
        for node in dimension.descendants():
            found[node.id] = dimension.id
    return found


def expand_filter(
    tree: Sequence[TagNode], tag_ids: Sequence[uuid.UUID]
) -> tuple[tuple[uuid.UUID, ...], ...]:
    """把筛选选中的标签按维度分组，每个标签连同它的全部下级；组按维度在树里的先后排。选中维度本身
    即这一维度的全部取值。不认识的 id 是 ``ValidationFailed``。"""

    nodes = _index(tree)
    dimension_of = _dimension_of(tree)
    groups: dict[uuid.UUID, dict[uuid.UUID, None]] = {}
    for tag_id in tag_ids:
        node = nodes.get(tag_id)
        if node is None:
            raise ValidationFailed(f"标签 {tag_id} 不存在")
        expanded = groups.setdefault(dimension_of[tag_id], {})
        if node.parent_id is not None:
            expanded[node.id] = None
        for descendant in node.descendants():
            expanded[descendant.id] = None
    return tuple(tuple(groups[dimension.id]) for dimension in tree if dimension.id in groups)


def _tag_out(node: TagNode, counts: Mapping[uuid.UUID, TagCounts]) -> LibraryTagOut:
    found = counts.get(node.id, TagCounts())
    return LibraryTagOut(
        id=node.id,
        name=node.name,
        auto_fill=node.auto_fill,
        guide=node.guide,
        position=node.position,
        counts=TagCountsOut(references=found.references, hit_cases=found.hit_cases),
        children=[_tag_out(child, counts) for child in node.children],
    )


class TaggingService:
    """``queue`` 为 ``None`` 即打标没配置：读树、建条目、改标签照常，排打标不可用。"""

    def __init__(self, store: TagStore, *, queue: TaggingQueuePort | None) -> None:
        self._store = store
        self._queue = queue

    @property
    def can_tag(self) -> bool:
        """能不能排打标：打标已配置。"""

        return self._queue is not None

    async def tree(self) -> LibraryTagsOut:
        """全部维度连同下级与各自的条目数。"""

        tree = await self._store.tree()
        counts = await self._store.counts()
        return LibraryTagsOut(dimensions=[_tag_out(dimension, counts) for dimension in tree])

    async def filter_groups(
        self, tag_ids: Sequence[uuid.UUID]
    ) -> tuple[tuple[uuid.UUID, ...], ...]:
        """列表筛选用：见 ``expand_filter``；没选标签就是空。"""

        if not tag_ids:
            return ()
        return expand_filter(await self._store.tree(), tag_ids)

    async def ensure(self, key: EntryKey, *, created_by: uuid.UUID | None) -> None:
        """这一条在标签里有一行；已有的不动。"""

        await self._store.ensure(key, created_by=created_by)

    async def enqueue(self, key: EntryKey, *, created_by: uuid.UUID | None) -> None:
        """打标事件（如拆解完成）：不看原来的状态改成 ``pending`` 并排一次打标；正在打的那一次写回时
        会发现状态变了，不再写。"""

        queue = self._require_queue()
        entry_id = await self._store.mark_pending(key, created_by=created_by)
        await self._defer(queue, entry_id)

    async def retag(self, key: EntryKey, *, created_by: uuid.UUID | None) -> None:
        """人要求重新打标：正在排队或打标是 ``Conflict``。"""

        queue = self._require_queue()
        await self._store.ensure(key, created_by=created_by)
        entry_id = await self._store.request(key)
        if entry_id is None:
            raise Conflict("正在打标，打完再重新打标")
        await self._defer(queue, entry_id)

    async def replace(
        self, key: EntryKey, tag_ids: Collection[uuid.UUID], *, created_by: uuid.UUID | None
    ) -> None:
        """整份替换这一条的全部标签，各维度都按给的存。不存在的标签、维度本身是 ``ValidationFailed``；
        正在排队或打标是 ``Conflict``。"""

        nodes = _index(await self._store.tree())
        for tag_id in tag_ids:
            node = nodes.get(tag_id)
            if node is None:
                raise ValidationFailed(f"标签 {tag_id} 不存在")
            if node.parent_id is None:
                raise ValidationFailed(f"「{node.name}」是维度，不能当标签打")
        await self._store.ensure(key, created_by=created_by)
        if not await self._store.replace(key, set(tag_ids)):
            raise Conflict("正在打标，打完再改标签")

    async def _defer(self, queue: TaggingQueuePort, entry_id: uuid.UUID) -> None:
        """排不上就把这一条收成 ``failed / model_call_failed``，免得它一直停在排队中；再抛给调用方。"""

        try:
            await queue.enqueue_tagging(entry_id)
        except Exception:
            _logger.exception("打标没排上队", entry_id=entry_id)
            await self._store.abandon_pending(entry_id)
            raise

    def _require_queue(self) -> TaggingQueuePort:
        if self._queue is None:
            raise RuntimeError("打标没配置，排打标的入口不该被调到")
        return self._queue


__all__ = ["TaggingService", "expand_filter"]
