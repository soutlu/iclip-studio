"""工程文件的生图节点与生成域之间的适配：AI 导演的工具和制作页共用。"""

from __future__ import annotations

import uuid
from collections.abc import Awaitable, Callable

from agent_runtime.errors import ValidationFailed
from pydantic import ValidationError

from iclip.domains.generation.models import GenerationJob
from iclip.domains.generation.schemas import ImageGenerationIn
from iclip.domains.generation.service import GenerationService
from iclip.domains.identity.public import Principal
from iclip.platform.http import validation_error_detail
from iclip.plugins.iclip_studio.ports import (
    InvalidNodeImageRequest,
    NodeImageJob,
    NodeImageRequest,
)

FILM_NODE_KEY = "film_node"
"""生图节点的生成记录在 ``metadata`` 里用这个键记节点名，制作页按它列这个节点的版本。"""


class FilmImagesAdapter:
    """工程文件的生图节点与生成域之间的往来：出图时给记录标上节点名，查进度；制作页选用时认一个
    地址是不是这段对话里出过的图。"""

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

    async def belongs(self, principal: Principal, conversation_id: str, url: str) -> bool:
        """这个地址是不是这段对话里一张已完成的图片：生成、编辑或切出来的，含继承来的。制作页上
        刚生成或编辑出的版本选用前还不在素材台账里，靠这里认。"""

        job = await self._service.find_conversation_image(
            principal, url, _conversation_uuid(conversation_id)
        )
        return job is not None


class RunFilmImagesAdapter:
    """AI 导演工具用的 ``NodeImages``：每次调用都用 ``resolve_principal`` 按运行属主 id 重建主体，再交给
    ``FilmImagesAdapter``，它的错误原样抛出。制作页拿着路由上的主体，直接用 ``FilmImagesAdapter``。"""

    def __init__(
        self,
        images: FilmImagesAdapter,
        resolve_principal: Callable[[uuid.UUID], Awaitable[Principal]],
    ) -> None:
        self._images = images
        self._resolve_principal = resolve_principal

    async def submit(self, user_id: uuid.UUID, request: NodeImageRequest) -> NodeImageJob:
        return await self._images.submit(await self._resolve_principal(user_id), request)

    async def get(self, user_id: uuid.UUID, job_id: uuid.UUID) -> NodeImageJob:
        return await self._images.get(await self._resolve_principal(user_id), job_id)


def _node_job(job: GenerationJob) -> NodeImageJob:
    return NodeImageJob(
        job_id=job.id,
        status=job.status,
        output_url=job.output.url,
        error_message=job.error_message,
    )


def _conversation_uuid(conversation_id: str) -> uuid.UUID:
    """入口已把对话 id 规范成 UUID；这里不是 UUID 说明运行状态损坏。"""

    try:
        return uuid.UUID(conversation_id)
    except ValueError as exc:
        raise RuntimeError("这次运行的对话 id 不是 UUID——运行状态已损坏。") from exc


__all__ = ["FILM_NODE_KEY", "FilmImagesAdapter", "RunFilmImagesAdapter"]
