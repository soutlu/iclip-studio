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
    TestVideos,
    VideoBreakdowns,
)
from iclip.domains.references.service import ReferenceService
from iclip.domains.tagging.public import TaggingService


@dataclass(frozen=True, slots=True)
class BreakdownSetup:
    breakdowns: VideoBreakdowns
    connector: procrastinate.BaseConnector
    concurrency: int


@dataclass(frozen=True)
class ReferencesModule:
    routers: tuple[Any, ...]

    service: ReferenceService
    queue: ReferenceQueue | None


def build_references_module(
    store: ReferenceStore,
    *,
    act_as: ActAs,
    own_video_upload: OwnVideoUpload,
    breakdown: BreakdownSetup | None,
    tagging: TaggingService,
    uploads_available: bool,
    test_videos: TestVideos,
    testable: bool,
) -> ReferencesModule:
    if breakdown is not None and not tagging.can_tag:
        raise RuntimeError("拆解配好了却不能打标；拆完要排打标")
    queue = (
        ReferenceQueue(
            store,
            breakdowns=breakdown.breakdowns,
            tagging=tagging,
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
        tagging=tagging,
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
                retaggable=service.can_retag,
                testable=testable,
            ),
        ),
        service=service,
        queue=queue,
    )


__all__ = ["BreakdownSetup", "ReferencesModule", "build_references_module"]
