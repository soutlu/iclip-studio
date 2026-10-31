"""出图插件的生成端口在后端的实现：经内部接口给运行时里的 ``shot_video`` 用（见 ``app/runtime_internal.py``）。"""

from __future__ import annotations

import uuid
from collections.abc import Awaitable, Callable

from agent_runtime.errors import ValidationFailed
from iclip_video.shot_video.ports import ImageJob, ImageRequest, InvalidImageRequest
from pydantic import ValidationError

from iclip.domains.generation.models import GenerationJob
from iclip.domains.generation.schemas import ImageGenerationIn
from iclip.domains.generation.service import GenerationService
from iclip.domains.identity.public import Principal
from iclip.platform.http import validation_error_detail


class GenerationsAdapter:
    """将能力请求转换为生成域的统一请求模型，并将任务记录收窄为能力协议字段。每次调用都用
    ``resolve_principal`` 按运行属主 id 重建主体，它的错误原样抛出。"""

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
            # 模型输入为自由字符串，由生成域请求模型统一校验枚举。
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
            # 受理层按所选模型的能力拒绝，收成能力协议错误，工具才能让模型改参数。
            raise InvalidImageRequest(str(exc)) from exc

    async def get(self, user_id: uuid.UUID, job_id: uuid.UUID) -> ImageJob:
        principal = await self._resolve_principal(user_id)
        return _job_view(await self._service.get(principal, job_id))


def _job_view(job: GenerationJob) -> ImageJob:
    """生成任务到能力结果的投影，渠道取实际请求快照。"""

    request = job.request
    if not isinstance(request, ImageGenerationIn):
        # 出图适配器只提交图片请求；拿回视频请求说明装配串了，不替它编一个渠道。
        raise TypeError(f"图像任务 {job.id} 的请求是 {job.kind}")
    if request.channel is None:
        # 出图钉死的那家有渠道轴（装配期校验过），为空同样说明装配串了。
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
