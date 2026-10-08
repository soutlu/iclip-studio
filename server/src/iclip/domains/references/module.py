"""references 装配单元：组合根只调用 ``build_references_module``。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import procrastinate

from iclip.domains.references.api import create_references_router
from iclip.domains.references.queue import ReferenceQueue, ReferenceQueueSettings
from iclip.domains.references.repository import (
    OwnVideoUpload,
    ReferenceStore,
    Tagger,
    VideoBreakdowns,
)
from iclip.domains.references.service import ReferenceService


@dataclass(frozen=True, slots=True)
class BreakdownSetup:
    """拆解配好时才有的那一组：拆解、打标、队列连接器与并发。"""

    breakdowns: VideoBreakdowns
    tagger: Tagger
    connector: procrastinate.BaseConnector
    concurrency: int


@dataclass(frozen=True)
class ReferencesModule:
    routers: tuple[Any, ...]
    """使用 Any 隔离 Web 框架类型。"""

    service: ReferenceService
    queue: ReferenceQueue | None
    """拆解没配置时为 ``None``；有的话由组合根在 lifespan 里起停 worker。"""


def build_references_module(
    store: ReferenceStore,
    *,
    own_video_upload: OwnVideoUpload,
    breakdown: BreakdownSetup | None,
) -> ReferencesModule:
    """``breakdown`` 为 ``None`` 即拆解没配置：只挂读端点，列表的 ``canUpload`` 恒为假。"""

    queue = (
        ReferenceQueue(
            store,
            breakdowns=breakdown.breakdowns,
            tagger=breakdown.tagger,
            connector=breakdown.connector,
            settings=ReferenceQueueSettings(concurrency=breakdown.concurrency),
        )
        if breakdown is not None
        else None
    )
    service = ReferenceService(store, own_video_upload=own_video_upload, queue=queue)
    return ReferencesModule(
        routers=(create_references_router(service, writable=queue is not None),),
        service=service,
        queue=queue,
    )


__all__ = ["BreakdownSetup", "ReferencesModule", "build_references_module"]
