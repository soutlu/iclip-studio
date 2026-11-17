from __future__ import annotations

import uuid
from typing import Final

from pydantic import ValidationError

from iclip.common.errors import NotFound, ValidationFailed, validation_error_detail
from iclip.domains.generation.models import GenerationJob
from iclip.domains.generation.repository import GenerationRepository
from iclip.domains.generation.schemas import (
    MAX_PROMPT_CHARS,
    STATUS_COMPLETED,
    STATUS_FAILED,
    VideoGenerationIn,
    VideoTrialRequest,
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

TEST_VIDEO_MODEL: Final = "wan3.0-video-prime"
TEST_VIDEO_RESOLUTION: Final = "480p"


class GenerationTestVideos:
    """试生成接到生成域上：提交一条 ``operation=trial`` 的视频生成，按记录 id 读它的进展。"""

    def __init__(self, repo: GenerationRepository, generation: GenerationService | None) -> None:
        self._repo = repo
        self._generation = generation

    async def job(self, job_id: uuid.UUID) -> TestVideoJob | None:
        try:
            job = await self._repo.get(job_id, owner=None)
        except NotFound:
            return None
        return TestVideoJob(
            job_id=job.id,
            status=_status(job),
            url=job.output.url,
            error_message=job.error_message,
            prompt=job.request.prompt if isinstance(job.request, VideoGenerationIn) else None,
            created_at=job.created_at,
        )

    async def submit(
        self,
        principal: Principal,
        prompt: TestPrompt,
        aspect_ratio: str,
        *,
        user_name: str,
    ) -> uuid.UUID:
        if self._generation is None:
            raise RuntimeError("媒体生成没开，试生成的入口不该挂上")
        if len(prompt.text) > MAX_PROMPT_CHARS:
            raise ValidationFailed(f"拆解超过 {MAX_PROMPT_CHARS} 字，无法试生成")
        try:
            request = VideoTrialRequest(
                model=TEST_VIDEO_MODEL,
                resolution=TEST_VIDEO_RESOLUTION,
                prompt=prompt.text,
                seconds=prompt.seconds,
                aspect_ratio=aspect_ratio,
                generate_audio=True,
                user_name=user_name,
            )
        except ValidationError as exc:
            raise ValidationFailed(validation_error_detail(exc.errors())) from exc
        job = await self._generation.submit_video(principal, request)
        return job.id


def _status(job: GenerationJob) -> TestVideoStatus:
    if job.status == STATUS_COMPLETED:
        return TEST_VIDEO_COMPLETED
    if job.status == STATUS_FAILED:
        return TEST_VIDEO_FAILED
    return TEST_VIDEO_RUNNING


__all__ = [
    "TEST_VIDEO_MODEL",
    "TEST_VIDEO_RESOLUTION",
    "GenerationTestVideos",
]
