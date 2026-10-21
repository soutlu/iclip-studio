"""tagging 装配单元：组合根只调用 ``build_tagging_module``。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import procrastinate

from iclip.domains.tagging.api import create_tagging_router
from iclip.domains.tagging.queue import TaggingQueue
from iclip.domains.tagging.repository import SourceText, Tagger, TagStore
from iclip.domains.tagging.service import TaggingService


@dataclass(frozen=True, slots=True)
class TaggingSetup:
    """打标配好时才有的那一组：打标与队列连接器。"""

    tagger: Tagger
    connector: procrastinate.BaseConnector


@dataclass(frozen=True)
class TaggingModule:
    routers: tuple[Any, ...]
    """使用 Any 隔离 Web 框架类型。"""

    service: TaggingService
    queue: TaggingQueue | None
    """打标没配置时为 ``None``；有的话由组合根在 lifespan 里起停 worker。"""


def build_tagging_module(
    store: TagStore, *, source_text: SourceText, setup: TaggingSetup | None
) -> TaggingModule:
    """``setup`` 为 ``None`` 即打标没配置：标签树照读、标签照改，排打标不可用。"""

    queue = (
        TaggingQueue(store, source_text=source_text, tagger=setup.tagger, connector=setup.connector)
        if setup is not None
        else None
    )
    service = TaggingService(store, queue=queue)
    return TaggingModule(routers=(create_tagging_router(service),), service=service, queue=queue)


__all__ = ["TaggingModule", "TaggingSetup", "build_tagging_module"]
