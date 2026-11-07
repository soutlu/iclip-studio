from __future__ import annotations

import uuid
from collections.abc import Awaitable, Callable

from cue.errors import ValidationFailed
from cue.http.errors import validation_error_detail
from iclip_video.shot_video.ports import ImageJob, ImageRequest, InvalidImageRequest
from pydantic import ValidationError

from iclip.domains.generation.models import GenerationJob
from iclip.domains.generation.schemas import ImageGenerationIn
from iclip.domains.generation.service import GenerationService
from iclip.domains.identity.public import Principal


class GenerationsAdapter:
    def __init__(
        self,
        service: GenerationService,
        resolve_principal: Callable[[uuid.UUID], Awaitable[Principal]],
    ) -> None:
        self._service = service
        self._resolve_principal = resolve_principal

    async def submit(self, user_id: uuid.UUID, request: ImageRequest) -> ImageJob:
        principal = await self._resolve_principal(user_id)
        try:
            payload = ImageGenerationIn.model_validate(
                {
                    "prompt": request.prompt,
                    "user_name": request.user_name,
                    "model": request.model,
                    "channel": request.channel,
                    "aspect_ratio": request.aspect_ratio,
                    "resolution": request.resolution,
                    "reference_image_urls": list(request.reference_image_urls),
                    "conversation_id": request.conversation_id,
                }
            )
            return _job_view(await self._service.submit_image(principal, payload))
        except ValidationError as exc:
            raise InvalidImageRequest(validation_error_detail(exc.errors())) from exc
        except ValidationFailed as exc:
            raise InvalidImageRequest(str(exc)) from exc

    async def get(self, user_id: uuid.UUID, job_id: uuid.UUID) -> ImageJob:
        principal = await self._resolve_principal(user_id)
        return _job_view(await self._service.get(principal, job_id))


def _job_view(job: GenerationJob) -> ImageJob:
    request = job.request
    if not isinstance(request, ImageGenerationIn):
        raise TypeError(f"图像任务 {job.id} 的请求是 {job.kind}")
    if request.channel is None:
        raise TypeError(f"图像任务 {job.id} 没有渠道")
    return ImageJob(
        job_id=job.id,
        status=job.status,
        channel=request.channel,
        output_url=job.output.url,
        error_code=job.error_code,
        error_message=job.error_message,
    )


__all__ = ["GenerationsAdapter"]
