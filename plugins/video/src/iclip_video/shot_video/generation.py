"""镜头图生成与渠道重试，切格转存交给 ``GridCuts`` 端口。版记录与工具返回值由调用方拼装。"""

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
    ImageRequest,
    InvalidImageRequest,
    ShotCells,
)

_logger = structlog.stdlib.get_logger(__name__)

IMAGE_MODEL: Final = "nano_banana_pro"
"""出图用哪家。写在这里而不是配置里：这条链路的 4k 整图与 dev/pro 重试只有这一家给得了，
产品接口的默认模型换成别家不该带着它一起换。"""

GRID_RESOLUTION: Final = "4k"
"""使用最高分辨率，保证整图裁成多格后仍有足够细节。"""

ANCHOR_ASPECT: Final = "1:1"
"""设定图使用方形网格；裁切后不再收缩到目标画幅，避免裁掉主体。"""


@dataclass(frozen=True, slots=True)
class GenerationPolicy:
    """按配置的 dev、pro 顺序重试失败生成；已有成功结果时不自动升级渠道。

    重试不分错误码：结果未知、已出图后转存失败也照样另起新任务，接受可能的重复计费
    （见 CONTEXT 不变量 10）。

    各字段的默认值与校验只在 ``shot_video`` 配置段一处，这里全部由组合根显式传入。"""

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
    """一次切格转存的结果：未切的整图，与逐格转存后的地址。"""

    grid_url: str
    urls: tuple[str, ...]


class FrameGenerator:
    """生成与裁剪服务，工作区记录由调用方持久化。"""

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
        """生成没成功就按配置渠道顺序另起一次，不分错误码；提交前校验失败直接让模型改参数，
        到了总时限就停。返回成功结果或最后一次结果。"""

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
                # 提交前校验失败，不产生付费调用，可要求模型修正参数。
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
        """经 ``GridCuts`` 切格转存，逐格地址与 ``cells`` 同序；转存成功的每一格各记一条切图。

        整图恒为 GRID_CELLS 格，``cells`` 只给实际请求的那几格，多出来的是补位格，
        不转存也不记。切格、下载、转存失败时向模型报告简短错误，诊断信息留日志；记录落不下是
        数据库的事，原样抛出，不让模型重出一张付费宫格。"""

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
            job = await self._generations.get(user_id, job.job_id)
        return job


def job_failure(job: ImageJob, *, message: str, reason: str | None = None) -> NoReturn:
    """记录诊断信息并报告失败。模型收到短句加错误码，供它判断重试是否有用；网关原文只留日志。"""

    _logger.warning(
        "图像工具失败",
        job_id=str(job.job_id),
        channel=job.channel,
        error_code=job.error_code,
        reason=reason if reason is not None else job.error_message,
    )
    # 切格、下载、转存阶段的失败没有错误码，调用方给的短句本身已写明阶段。
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
