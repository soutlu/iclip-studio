from __future__ import annotations

import uuid
from typing import Final

from cue.errors import ValidationFailed
from cue.http.errors import validation_error_detail
from pydantic import ValidationError

from iclip.domains.generation.models import REFERENCE_TRIAL_KEY, GenerationJob
from iclip.domains.generation.repository import GenerationRepository
from iclip.domains.generation.schemas import (
    MAX_PROMPT_CHARS,
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

TEST_VIDEO_MODEL: Final = "wan3.0-video-prime"
TEST_VIDEO_RESOLUTION: Final = "480p"


class GenerationTestVideos:
    def __init__(self, repo: GenerationRepository, generation: GenerationService | None) -> None:
        self._repo = repo
        self._generation = generation

    async def latest(self, owner: uuid.UUID, reference_id: uuid.UUID) -> TestVideoJob | None:
        job = await self._repo.latest_reference_trial(reference_id, owner=owner)
        if job is None:
            return None
        return TestVideoJob(
            status=_status(job),
            url=job.output.url,
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
                metadata={REFERENCE_TRIAL_KEY: str(reference_id)},
            )
        except ValidationError as exc:
            raise ValidationFailed(validation_error_detail(exc.errors())) from exc
        await self._generation.submit_video(principal, request)


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
