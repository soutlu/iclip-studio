from __future__ import annotations

from cue.errors import NotFound, ValidationFailed

from iclip.domains.identity.public import Principal
from iclip.domains.tracking.models import TrackingEvent
from iclip.domains.tracking.repository import TrackingRepository
from iclip.domains.tracking.schemas import TrackingEventIn


class TrackingService:
    def __init__(self, repository: TrackingRepository) -> None:
        self._repository = repository

    async def record(self, principal: Principal, event: TrackingEventIn) -> None:
        match event.name:
            case "video.downloaded":
                await self._check_download(event)
        await self._repository.record(
            TrackingEvent(
                name=event.name,
                job_id=event.job_id,
                conversation_id=event.conversation_id,
                user_id=principal.user_id,
                api_key_id=principal.api_key_id,
            )
        )

    async def _check_download(self, event: TrackingEventIn) -> None:
        if event.job_id is None:
            raise ValidationFailed("video.downloaded 必须带 jobId")
        if event.conversation_id is not None:
            raise ValidationFailed("video.downloaded 不带 conversationId")
        if not await self._repository.downloadable(event.job_id):
            raise NotFound("没有这条可下载的视频")


__all__ = ["TrackingService"]
