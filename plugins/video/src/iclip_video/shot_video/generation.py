from __future__ import annotations

import asyncio
import uuid
from dataclasses import dataclass, replace
from typing import Final, NoReturn

import structlog
from pydantic_ai import ModelRetry, ToolFailed

from iclip_video.shot_video.ports import (
    AnchorSheets,
    GridCutFailed,
    GridCuts,
    ImageChannel,
    ImageGenerations,
    ImageJob,
    ImageJobUnavailable,
    ImageRequest,
    InvalidImageRequest,
    ShotCells,
)

_logger = structlog.stdlib.get_logger(__name__)

IMAGE_MODEL: Final = "nano_banana_pro"

GRID_RESOLUTION: Final = "4k"

ANCHOR_ASPECT: Final = "1:1"


@dataclass(frozen=True, slots=True)
class GenerationPolicy:
    poll_interval_seconds: float
    dev_attempts: int
    pro_attempts: int
    backoff_seconds: float
    backoff_factor: float
    total_timeout_seconds: float

    def channels(self) -> tuple[ImageChannel, ...]:
        dev: tuple[ImageChannel, ...] = ("dev",) * self.dev_attempts
        pro: tuple[ImageChannel, ...] = ("pro",) * self.pro_attempts
        return (*dev, *pro)


@dataclass(frozen=True, slots=True)
class CellCut:
    grid_url: str
    urls: tuple[str, ...]


class FrameGenerator:
    def __init__(
        self,
        *,
        generations: ImageGenerations,
        cuts: GridCuts,
        policy: GenerationPolicy,
    ) -> None:
        self._generations = generations
        self._cuts = cuts
        self._policy = policy

    async def generate(self, user_id: uuid.UUID, request: ImageRequest) -> ImageJob:
        loop = asyncio.get_running_loop()
        deadline = loop.time() + self._policy.total_timeout_seconds
        channels = self._policy.channels()
        job: ImageJob | None = None
        for index, channel in enumerate(channels):
            try:
                job = await self._run_one(
                    user_id, replace(request, channel=channel), deadline=deadline
                )
            except InvalidImageRequest as exc:
                raise ModelRetry(str(exc)) from exc
            if job.status == "completed" and job.output_url:
                return job
            if index == len(channels) - 1 or loop.time() >= deadline:
                return job
            await asyncio.sleep(self._policy.backoff_seconds * self._policy.backoff_factor**index)
        raise AssertionError("重试策略至少要有一个渠道")

    async def cut(
        self,
        user_id: uuid.UUID,
        job: ImageJob,
        *,
        cells: ShotCells | AnchorSheets,
        aspect: str | None,
        failure_message: str,
    ) -> CellCut:
        grid_url = job.output_url
        if not grid_url:
            job_failure(job, message=failure_message, reason="生成记录未携带结果 URL")
        try:
            urls = await self._cuts.cut(
                user_id, job.job_id, grid_url=grid_url, cells=cells, aspect=aspect
            )
        except GridCutFailed as exc:
            job_failure(job, message=failure_message, reason=str(exc))
        return CellCut(grid_url=grid_url, urls=urls)

    async def _run_one(
        self, user_id: uuid.UUID, request: ImageRequest, *, deadline: float
    ) -> ImageJob:

        job = await self._generations.submit(user_id, request)
        loop = asyncio.get_running_loop()
        while not job.finished:
            if loop.time() >= deadline:
                return ImageJob(
                    job_id=job.job_id,
                    status="failed",
                    channel=request.channel,
                    error_code="TOOL_WAIT_TIMEOUT",
                    error_message="等这次生成等超时了；它可能还在后台跑",
                )
            await asyncio.sleep(self._policy.poll_interval_seconds)
            try:
                job = await self._generations.get(user_id, job.job_id)
            except ImageJobUnavailable as exc:
                _logger.warning("查出图任务暂时失败", job_id=str(job.job_id), reason=str(exc))
        return job


def job_failure(job: ImageJob, *, message: str, reason: str | None = None) -> NoReturn:
    _logger.warning(
        "图像工具失败",
        job_id=str(job.job_id),
        channel=job.channel,
        error_code=job.error_code,
        reason=reason if reason is not None else job.error_message,
    )
    if job.error_code is None:
        raise ToolFailed(message)
    raise ToolFailed(f"{message.rstrip('。')}（{job.error_code}）。")


__all__ = [
    "ANCHOR_ASPECT",
    "GRID_RESOLUTION",
    "IMAGE_MODEL",
    "CellCut",
    "FrameGenerator",
    "GenerationPolicy",
    "job_failure",
]
