"""references 装配单元：组合根只调用 ``build_references_module``。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import procrastinate

from iclip.domains.identity.public import ActAs
from iclip.domains.references.api import create_references_router
from iclip.domains.references.queue import ReferenceQueue, ReferenceQueueSettings
from iclip.domains.references.repository import (
    OwnVideoUpload,
    ReferenceStore,
    Tagger,
    TestVideos,
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
    act_as: ActAs,
    own_video_upload: OwnVideoUpload,
    breakdown: BreakdownSetup | None,
    uploads_available: bool,
    test_videos: TestVideos,
    testable: bool,
) -> ReferencesModule:
    """``breakdown`` 为 ``None`` 即拆解没配置：只挂读端点，列表的 ``canUpload`` 恒为假。
    ``uploads_available`` 为假即上传模块没装配：不挂建行，``canUpload`` 同样恒为假，重拆照挂。
    ``testable`` 为假即媒体生成没开、``test_videos`` 提交不了：不挂试生成，详情照样带最新的一次。"""

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
    service = ReferenceService(
        store,
        own_video_upload=own_video_upload,
        queue=queue,
        uploads_available=uploads_available,
        test_videos=test_videos,
    )
    return ReferencesModule(
        routers=(
            create_references_router(
                service,
                act_as=act_as,
                uploadable=service.accepts_uploads,
                rerunnable=queue is not None,
                testable=testable,
            ),
        ),
        service=service,
        queue=queue,
    )


__all__ = ["BreakdownSetup", "ReferencesModule", "build_references_module"]
