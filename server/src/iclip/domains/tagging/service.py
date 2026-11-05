from __future__ import annotations

import uuid
from collections.abc import Collection, Mapping, Sequence

import structlog
from agent_runtime.errors import Conflict, NotFound, ValidationFailed

from iclip.domains.tagging.models import EntryKey, TagCounts, TagNode
from iclip.domains.tagging.repository import TaggingQueuePort, TagStore
from iclip.domains.tagging.rules import check_change, check_new, clean_guide, clean_name, reorder
from iclip.domains.tagging.schemas import (
    LibraryTagCreateIn,
    LibraryTagOut,
    LibraryTagsOut,
    LibraryTagUpdateIn,
    TagCountsOut,
)

_logger = structlog.stdlib.get_logger(__name__)


def _index(tree: Sequence[TagNode]) -> dict[uuid.UUID, TagNode]:
    found: dict[uuid.UUID, TagNode] = {}
    for dimension in tree:
        found[dimension.id] = dimension
        for node in dimension.descendants():
            found[node.id] = node
    return found


def _dimension_of(tree: Sequence[TagNode]) -> dict[uuid.UUID, uuid.UUID]:
    found: dict[uuid.UUID, uuid.UUID] = {}
    for dimension in tree:
        found[dimension.id] = dimension.id
        for node in dimension.descendants():
            found[node.id] = dimension.id
    return found


def expand_filter(
    tree: Sequence[TagNode], tag_ids: Sequence[uuid.UUID]
) -> tuple[tuple[uuid.UUID, ...], ...]:
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
    def __init__(self, store: TagStore, *, queue: TaggingQueuePort | None) -> None:
        self._store = store
        self._queue = queue

    @property
    def can_tag(self) -> bool:
        return self._queue is not None

    async def tree(self) -> LibraryTagsOut:
        tree = await self._store.tree()
        counts = await self._store.counts()
        return LibraryTagsOut(dimensions=[_tag_out(dimension, counts) for dimension in tree])

    async def create(self, body: LibraryTagCreateIn) -> LibraryTagOut:
        name = clean_name(body.name)
        guide = clean_guide(body.guide)
        tag_id = uuid.uuid4()
        async with self._store.edit() as tree_writer:
            siblings = check_new(
                await tree_writer.tree(),
                parent_id=body.parent_id,
                name=name,
                auto_fill=body.auto_fill,
            )
            ids = [sibling.id for sibling in siblings]
            order = reorder(ids, tag_id, len(ids) if body.position is None else body.position)
            await tree_writer.insert(
                tag_id,
                parent_id=body.parent_id,
                name=name,
                guide=guide,
                auto_fill=body.auto_fill,
                position=order.index(tag_id),
            )
            await tree_writer.place(order)
        return await self._node_out(tag_id)

    async def update(self, tag_id: uuid.UUID, body: LibraryTagUpdateIn) -> LibraryTagOut:
        given = body.model_fields_set
        name = None if body.name is None else clean_name(body.name)
        guide = clean_guide(body.guide)
        async with self._store.edit() as tree_writer:
            node, siblings = check_change(
                await tree_writer.tree(),
                tag_id,
                name=name,
                auto_fill=body.auto_fill,
                sets_auto_fill="auto_fill" in given,
            )
            await tree_writer.update(
                tag_id,
                name=node.name if name is None else name,
                guide=guide if "guide" in given else node.guide,
                auto_fill=body.auto_fill if "auto_fill" in given else node.auto_fill,
            )
            if body.position is not None:
                ids = [sibling.id for sibling in siblings]
                await tree_writer.place(reorder(ids, tag_id, body.position))
        return await self._node_out(tag_id)

    async def delete(self, tag_id: uuid.UUID) -> None:
        async with self._store.edit() as tree_writer:
            if not await tree_writer.delete(tag_id):
                raise NotFound("标签不存在")

    async def _node_out(self, tag_id: uuid.UUID) -> LibraryTagOut:
        node = _index(await self._store.tree()).get(tag_id)
        if node is None:
            raise NotFound("标签不存在")
        return _tag_out(node, await self._store.counts())

    async def filter_groups(
        self, tag_ids: Sequence[uuid.UUID]
    ) -> tuple[tuple[uuid.UUID, ...], ...]:
        if not tag_ids:
            return ()
        return expand_filter(await self._store.tree(), tag_ids)

    async def ensure(self, key: EntryKey, *, created_by: uuid.UUID | None) -> None:
        await self._store.ensure(key, created_by=created_by)

    async def enqueue(self, key: EntryKey, *, created_by: uuid.UUID | None) -> None:
        queue = self._require_queue()
        entry_id = await self._store.mark_pending(key, created_by=created_by)
        await self._defer(queue, entry_id)

    async def retag(self, key: EntryKey, *, created_by: uuid.UUID | None) -> None:
        queue = self._require_queue()
        await self._store.ensure(key, created_by=created_by)
        entry_id = await self._store.request(key)
        if entry_id is None:
            raise Conflict("正在打标，打完再重新打标")
        await self._defer(queue, entry_id)

    async def replace(
        self, key: EntryKey, tag_ids: Collection[uuid.UUID], *, created_by: uuid.UUID | None
    ) -> None:
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

    async def remove(self, key: EntryKey) -> None:
        await self._store.remove(key)

    async def _defer(self, queue: TaggingQueuePort, entry_id: uuid.UUID) -> None:
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
