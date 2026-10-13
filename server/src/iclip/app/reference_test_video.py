"""参考视频的试生成：把 references 声明的 ``TestVideos`` 端口接到生成域上。

一次试生成就是属主名下一条普通的视频生成：模型与分辨率固定，时长与正文由拆解拼出，画幅由调用方给，
带声音；``metadata`` 记 ``referenceId``，读最新一次就按它筛。读只要生成仓储，媒体生成没开也读得到；
提交要生成服务，没开时试生成的入口不挂。"""

from __future__ import annotations

import uuid
from typing import Final

from pydantic import ValidationError

from iclip.common.errors import ValidationFailed
from iclip.domains.generation.models import GenerationJob
from iclip.domains.generation.repository import GenerationRepository
from iclip.domains.generation.schemas import (
    KIND_VIDEO,
    MAX_PROMPT_CHARS,
    OPERATION_GENERATE,
    STATUS_COMPLETED,
    STATUS_FAILED,
    VideoGenerationIn,
)
from iclip.domains.generation.service import GenerationService
from iclip.domains.identity.public import Principal
from iclip.domains.references.models import (
    TEST_VIDEO_COMPLETED,
    TEST_VIDEO_FAILED,
    TEST_VIDEO_RUNNING,
    TestVideoJob,
    TestVideoStatus,
)
from iclip.domains.references.test_prompt import TestPrompt
from iclip.platform.http import validation_error_detail

TEST_VIDEO_MODEL: Final = "wan3.0-video-prime"
TEST_VIDEO_RESOLUTION: Final = "480p"
REFERENCE_KEY: Final = "referenceId"
"""试生成记录的 ``metadata`` 里记参考视频 id 的键；资料库的成片按它把试生成排除在外。"""


class GenerationTestVideos:
    """``generation`` 为 ``None`` 即媒体生成没开：只能读，提交是装配错误。"""

    def __init__(self, repo: GenerationRepository, generation: GenerationService | None) -> None:
        self._repo = repo
        self._generation = generation

    async def latest(self, owner: uuid.UUID, reference_id: uuid.UUID) -> TestVideoJob | None:
        found = await self._repo.list_for_owner(
            owner=owner,
            kind=KIND_VIDEO,
            operation=OPERATION_GENERATE,
            metadata={REFERENCE_KEY: str(reference_id)},
            limit=1,
        )
        if not found:
            return None
        job = found[0]
        return TestVideoJob(
            status=_status(job),
            url=job.output_url,
            error_message=job.error_message,
            prompt=job.request.prompt if isinstance(job.request, VideoGenerationIn) else None,
            created_at=job.created_at,
        )

    async def submit(
        self,
        principal: Principal,
        reference_id: uuid.UUID,
        prompt: TestPrompt,
        aspect_ratio: str,
        *,
        user_name: str,
    ) -> None:
        if self._generation is None:
            raise RuntimeError("媒体生成没开，试生成的入口不该挂上")
        # 上限只在生成域定义一处；先查，报出给人看的原因，而不是请求校验的字段报错。
        if len(prompt.text) > MAX_PROMPT_CHARS:
            raise ValidationFailed(f"拆解超过 {MAX_PROMPT_CHARS} 字，无法试生成")
        try:
            request = VideoGenerationIn(
                model=TEST_VIDEO_MODEL,
                resolution=TEST_VIDEO_RESOLUTION,
                prompt=prompt.text,
                seconds=prompt.seconds,
                aspect_ratio=aspect_ratio,
                generate_audio=True,
                user_name=user_name,
                metadata={REFERENCE_KEY: str(reference_id)},
            )
        except ValidationError as exc:
            raise ValidationFailed(validation_error_detail(exc.errors())) from exc
        await self._generation.submit_video(principal, request)


def _status(job: GenerationJob) -> TestVideoStatus:
    """排队、提交中与等上游都算还没结束。"""

    if job.status == STATUS_COMPLETED:
        return TEST_VIDEO_COMPLETED
    if job.status == STATUS_FAILED:
        return TEST_VIDEO_FAILED
    return TEST_VIDEO_RUNNING


__all__ = [
    "REFERENCE_KEY",
    "TEST_VIDEO_MODEL",
    "TEST_VIDEO_RESOLUTION",
    "GenerationTestVideos",
]
