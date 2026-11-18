from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import procrastinate

from iclip.domains.identity.public import ActAs, ModelGroupOf
from iclip.domains.references.api import (
    create_reference_audios_router,
    create_reference_videos_router,
)
from iclip.domains.references.queue import ReferenceQueue, ReferenceQueueSettings
from iclip.domains.references.repository import (
    MediaDuration,
    MediaSources,
    ReferenceAudioStore,
    ReferenceStore,
    TestVideos,
    VideoBreakdowns,
)
from iclip.domains.references.service import ReferenceAudioService, ReferenceService
from iclip.domains.tagging.public import TaggingService


@dataclass(frozen=True, slots=True)
class BreakdownSetup:
    breakdowns: VideoBreakdowns
    model_group_of: ModelGroupOf
    connector: procrastinate.BaseConnector
    concurrency: int


@dataclass(frozen=True)
class ReferencesModule:
    routers: tuple[Any, ...]

    service: ReferenceService
    audios: ReferenceAudioService
    queue: ReferenceQueue | None


def build_references_module(
    store: ReferenceStore,
    audio_store: ReferenceAudioStore,
    *,
    act_as: ActAs,
    sources: MediaSources,
    duration: MediaDuration,
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
            model_group_of=breakdown.model_group_of,
            connector=breakdown.connector,
            settings=ReferenceQueueSettings(concurrency=breakdown.concurrency),
        )
        if breakdown is not None
        else None
    )
    service = ReferenceService(
        store,
        sources=sources,
        queue=queue,
        tagging=tagging,
        uploads_available=uploads_available,
        test_videos=test_videos,
    )
    audios = ReferenceAudioService(
        audio_store, sources=sources, duration=duration, uploads_available=uploads_available
    )
    return ReferencesModule(
        routers=(
            create_reference_videos_router(
                service,
                act_as=act_as,
                uploadable=service.accepts_uploads,
                rerunnable=queue is not None,
                retaggable=service.can_retag,
                testable=testable,
            ),
            create_reference_audios_router(
                audios, act_as=act_as, uploadable=audios.accepts_uploads
            ),
        ),
        service=service,
        audios=audios,
        queue=queue,
    )


__all__ = ["BreakdownSetup", "ReferencesModule", "build_references_module"]
