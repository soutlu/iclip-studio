"""工程文件的生图节点与生成域之间的适配，制作页用。"""

from __future__ import annotations

import uuid

from agent_runtime.errors import ValidationFailed
from agent_runtime.http.errors import validation_error_detail
from iclip_video.iclip_studio.ports import (
    InvalidNodeImageRequest,
    NodeImageJob,
    NodeImageRequest,
)
from pydantic import ValidationError

from iclip.domains.generation.models import GenerationJob
from iclip.domains.generation.schemas import ImageGenerationIn
from iclip.domains.generation.service import GenerationService
from iclip.domains.identity.public import Principal

FILM_NODE_KEY = "film_node"
"""生图节点的生成记录在 ``metadata`` 里用这个键记节点名，制作页按它列这个节点的版本。"""


class FilmImagesAdapter:
    """工程文件的生图节点与生成域之间的往来：出图时给记录标上节点名，查进度。"""

    def __init__(self, service: GenerationService) -> None:
        self._service = service

    async def submit(self, principal: Principal, request: NodeImageRequest) -> NodeImageJob:
        try:
            payload = ImageGenerationIn.model_validate(
                {
                    "prompt": request.prompt,
                    "user_name": request.user_name,
                    "model": request.model,
                    "aspect_ratio": request.aspect_ratio,
                    "resolution": request.resolution,
                    "reference_image_urls": list(request.reference_image_urls),
                    "conversation_id": request.conversation_id,
                    "metadata": {FILM_NODE_KEY: request.node},
                }
            )
            return _node_job(await self._service.submit_image(principal, payload))
        except ValidationError as exc:
            raise InvalidNodeImageRequest(validation_error_detail(exc.errors())) from exc
        except ValidationFailed as exc:
            raise InvalidNodeImageRequest(str(exc)) from exc

    async def get(self, principal: Principal, job_id: uuid.UUID) -> NodeImageJob:
        return _node_job(await self._service.get(principal, job_id))


def _node_job(job: GenerationJob) -> NodeImageJob:
    return NodeImageJob(
        job_id=job.id,
        status=job.status,
        output_url=job.output.url,
        error_message=job.error_message,
    )


__all__ = ["FILM_NODE_KEY", "FilmImagesAdapter"]
