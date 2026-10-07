"""本地加工：合成时把各段拼接成片。在本机 ffmpeg 完成，不经外部服务。"""

from __future__ import annotations

import uuid
from collections.abc import Awaitable, Callable, Mapping, Sequence
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Final

import httpx
import structlog

from iclip.domains.generation.models import GenerationJob
from iclip.domains.generation.provider import (
    ProviderError,
    ProviderProgress,
    ProviderSubmission,
    request_of,
)
from iclip.domains.generation.schemas import (
    CLIP_FETCHING,
    CLIP_PROCESSING,
    CLIP_UPLOADING,
    ClipStage,
    ComposeSegment,
    VideoComposeRequest,
)
from iclip.platform.media.ffmpeg import (
    MAX_VIDEO_BYTES,
    MediaCut,
    MediaError,
    VideoProfile,
    cut_concat,
    download,
    probe_duration_ms,
    probe_video,
)
from iclip.platform.object_store.layout import MEDIA_PATHS
from iclip.platform.object_store.store import ObjectStoreUnavailable, PublicObjectStore

_logger = structlog.stdlib.get_logger(__name__)

PROVIDER_NAME: Final = "ffmpeg"

_EXT: Final = "mp4"
_CONTENT_TYPE: Final = "video/mp4"

ReportStage = Callable[[uuid.UUID, ClipStage], Awaitable[bool]]
"""上报一次阶段。返回 False 表示这条任务已经不在提交中，调用方不必再报。"""

_Report = Callable[[ClipStage], Awaitable[None]]
"""只服务一次加工的上报器，由 ``_stage_reporter`` 造。"""


def _stage_reporter(report_stage: ReportStage, job_id: uuid.UUID) -> _Report:
    """造一个只服务这一次加工的上报器。

    合成器的实例被多个任务共享，所以「还在途」这个标记留在闭包里。上报被拒之后就
    不再报，但活照样干完——产物按任务 id 落在固定的 key 上，同 key 已存在则保留先到的那份。"""

    live = True

    async def report(stage: ClipStage) -> None:
        nonlocal live
        if not live:
            return
        try:
            live = await report_stage(job_id, stage)
        except Exception as exc:
            # 阶段词只是给人看的：写不进去就不写了，不能让它把一条能出结果的加工判成失败。
            live = False
            _logger.warning("阶段上报失败，这次加工不再上报", job_id=job_id, error=str(exc))
            return
        if not live:
            _logger.info("加工任务已有结论，不再上报阶段", job_id=job_id, stage=stage)

    return report


async def _store(object_store: PublicObjectStore, key: str, content: bytes) -> str:
    """存进桶，交回公开地址；存不进去是 ``OUTPUT_STORE_FAILED``，不重试。"""

    try:
        return await object_store.put_public_object(
            object_key=key, content=content, content_type=_CONTENT_TYPE
        )
    except ObjectStoreUnavailable as exc:
        raise ProviderError(
            f"视频加工完了但存不进桶: {exc}",
            code="OUTPUT_STORE_FAILED",
            retryable=False,
        ) from exc


class FfmpegComposeProvider:
    """按 ``VideoComposeRequest`` 合成成片。同步出结果，``submit`` 直接带回 output_url。"""

    def __init__(
        self,
        *,
        object_store: PublicObjectStore,
        report_stage: ReportStage,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        """``transport`` 给下载素材用，测试替身从这里进；``report_stage`` 由装配注入，provider
        自己不碰数据库。"""

        self._object_store = object_store
        self._report_stage = report_stage
        self._transport = transport

    @property
    def name(self) -> str:
        return PROVIDER_NAME

    async def submit(self, job: GenerationJob) -> ProviderSubmission:
        request = request_of(job, VideoComposeRequest, provider=PROVIDER_NAME)
        report = _stage_reporter(self._report_stage, job.id)
        content, duration_ms = await self._render_composite(request, report)
        await report(CLIP_UPLOADING)
        url = await _store(
            self._object_store, MEDIA_PATHS.video_master(job_id=job.id, ext=_EXT), content
        )
        return ProviderSubmission(
            provider_task_id=str(job.id),
            provider_status="completed",
            output_url=url,
            duration_ms=duration_ms,
        )

    async def poll(self, job: GenerationJob) -> ProviderProgress:
        raise ProviderError(
            "本地视频加工是同步的，没有轮询阶段",
            code="PROVIDER_POLL_UNSUPPORTED",
            retryable=False,
        )

    async def _render_composite(
        self, request: VideoComposeRequest, report: _Report
    ) -> tuple[bytes, int]:
        """取齐各段素材，按顺序裁出来拼成一条，一次重编码对齐到原片；返回字节与实际时长（毫秒）。

        取到结尾的段按下载下来的素材时长补齐，补出来是空的段（编辑区间一直改到基底结尾）跳过。
        时长在这里量：产物是我们造的，这里就是权威。临时目录在退出时清掉。"""

        with TemporaryDirectory(prefix="iclip-clip-") as tmp:
            root = Path(tmp)
            dest = root / f"out.{_EXT}"
            await report(CLIP_FETCHING)
            sources = await self._fetch_sources(request.segments, root)
            try:
                cuts = await _cuts(request.segments, sources)
                # 探规格也算取素材：它读的是刚下来的那几条源，还没开始编码。
                profile = await _target_profile(cuts)
                await report(CLIP_PROCESSING)
                await cut_concat(cuts, profile=profile, dest=dest)
                duration_ms = await probe_duration_ms(dest)
            except MediaError as exc:
                raise ProviderError(
                    f"视频加工失败: {exc}", code="MEDIA_PROCESS_FAILED", retryable=False
                ) from exc
            return dest.read_bytes(), duration_ms

    async def _fetch_sources(
        self, segments: Sequence[ComposeSegment], root: Path
    ) -> dict[str, Path]:
        """同一个地址只下一遍：合成里基底的前后两段来自同一条视频。"""

        sources: dict[str, Path] = {}
        async with httpx.AsyncClient(transport=self._transport) as client:
            for segment in segments:
                if segment.url in sources:
                    continue
                target = root / f"src-{uuid.uuid4().hex}.{_EXT}"
                try:
                    await download(client, segment.url, target, max_bytes=MAX_VIDEO_BYTES)
                except MediaError as exc:
                    raise ProviderError(
                        f"取不到要加工的素材: {exc}",
                        code="MEDIA_SOURCE_UNREACHABLE",
                        retryable=False,
                    ) from exc
                sources[segment.url] = target
        return sources


async def _cuts(segments: Sequence[ComposeSegment], sources: Mapping[str, Path]) -> list[MediaCut]:
    """各段落成本地素材上的一刀：取到结尾的按素材时长补齐，补出来不成区间的跳过。"""

    lengths: dict[Path, float] = {}
    cuts: list[MediaCut] = []
    for segment in segments:
        source = sources[segment.url]
        end = segment.end
        if end is None:
            if source not in lengths:
                lengths[source] = await probe_duration_ms(source) / 1000
            end = lengths[source]
        if end > segment.start:
            cuts.append(MediaCut(source=source, start=segment.start, end=end))
    if not cuts:
        raise MediaError("各段都是空的，没有要拼的片段")
    return cuts


async def _target_profile(cuts: Sequence[MediaCut]) -> VideoProfile:
    """成片对齐到原片：画幅与帧率照整条最长的那条素材，有一条带音轨就出音轨。

    模型还回来的片段与原片同比例，但分辨率档位与帧率不保证相同（实测 720×960 25fps 的输入
    还回来是 834×1112 24fps）。成片该保持原片的规格，插进去的片段缩放去适配它。哪条是原片
    按素材整条时长认：原片是完整的一条，模型还回来的只有被编辑那一段的长度，所以不管编辑
    区间选了多长，原片都更长——按各段在成片里贡献的时长认不行，区间超过一半就会认反。
    整条一样长（整片都被编辑）再看贡献时长。这样不用调用方多传一个字段。"""

    contributed: dict[Path, float] = {}
    for cut in cuts:
        contributed[cut.source] = contributed.get(cut.source, 0.0) + cut.duration
    lengths = {source: await probe_duration_ms(source) for source in contributed}
    profiles = {source: await probe_video(source) for source in contributed}
    original = profiles[max(contributed, key=lambda source: (lengths[source], contributed[source]))]
    return VideoProfile(
        width=original.width,
        height=original.height,
        frame_rate=original.frame_rate,
        has_audio=any(profile.has_audio for profile in profiles.values()),
    )


__all__ = [
    "PROVIDER_NAME",
    "FfmpegComposeProvider",
    "ReportStage",
]
