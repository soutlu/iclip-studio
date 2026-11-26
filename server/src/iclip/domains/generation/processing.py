from __future__ import annotations

import asyncio
import uuid
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import replace
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Final

import httpx
import structlog

from iclip.domains.generation.models import GenerationJob
from iclip.domains.generation.ports import RemoteMediaProbe
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
    VideoEditRequest,
)
from iclip.platform.media.codec import MediaCodec
from iclip.platform.media.errors import MediaError
from iclip.platform.media.fetch import MAX_VIDEO_BYTES, download
from iclip.platform.media.probe import (
    VideoProfile,
    has_audio_stream,
    probe_duration_ms,
    probe_remote_video,
    probe_video,
)
from iclip.platform.media.video import MediaCut, cut_concat
from iclip.platform.object_store.layout import MEDIA_PATHS
from iclip.platform.object_store.store import ObjectStoreUnavailable, PublicObjectStore

_logger = structlog.stdlib.get_logger(__name__)

PROVIDER_NAME: Final = "ffmpeg"

_EXT: Final = "mp4"
_CONTENT_TYPE: Final = "video/mp4"

ReportStage = Callable[[uuid.UUID, ClipStage], Awaitable[bool]]

RecordOf = Callable[[uuid.UUID], Awaitable[GenerationJob]]

_Report = Callable[[ClipStage], Awaitable[None]]


def _stage_reporter(report_stage: ReportStage, job_id: uuid.UUID) -> _Report:
    live = True

    async def report(stage: ClipStage) -> None:
        nonlocal live
        if not live:
            return
        try:
            live = await report_stage(job_id, stage)
        except Exception as exc:
            live = False
            _logger.warning("阶段上报失败，这次加工不再上报", job_id=job_id, error=str(exc))
            return
        if not live:
            _logger.info("加工任务已有结论，不再上报阶段", job_id=job_id, stage=stage)

    return report


class LocalClipProcessor:
    """本机视频加工：按片段列表取素材、按指定那条视频的画幅帧率切拼重编码、存进桶里。

    合成与编辑段切参考片段共用这一个实例，同时在跑的加工（下载、编码、读产物、上传整段）
    不超过 ``concurrency``。
    """

    def __init__(
        self,
        *,
        object_store: PublicObjectStore,
        codec: MediaCodec,
        fetch_url: Callable[[str], str],
        concurrency: int,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._object_store = object_store
        self._codec = codec
        self._fetch_url = fetch_url
        self._transport = transport
        self._slots = asyncio.Semaphore(concurrency)

    async def render(
        self,
        segments: Sequence[ComposeSegment],
        *,
        profile_url: str,
        object_key: str,
        report: _Report,
    ) -> tuple[str, int]:
        """把 ``segments`` 依次切拼成一条视频存到 ``object_key``，返回公网地址与实测时长（毫秒）。

        宽高与帧率取 ``profile_url`` 那条视频的规格（它不在片段里时远程探，不下载）；参与的片段里
        有一段带音轨就出音轨。取不到素材报 ``MEDIA_SOURCE_UNREACHABLE``，加工失败报
        ``MEDIA_PROCESS_FAILED``，存不进桶报 ``OUTPUT_STORE_FAILED``，都不可重试。
        """

        async with self._slots:
            with TemporaryDirectory(prefix="iclip-clip-") as tmp:
                root = Path(tmp)
                dest = root / f"out.{_EXT}"
                await report(CLIP_FETCHING)
                sources = await self._fetch([segment.url for segment in segments], root)
                remote = None if profile_url in sources else await self._probe(profile_url)
                try:
                    target = remote or await probe_video(sources[profile_url])
                    cuts = await _cuts(segments, sources)
                    profile = await _aligned_to(target, cuts)
                    await report(CLIP_PROCESSING)
                    await cut_concat(cuts, profile=profile, dest=dest, codec=self._codec)
                    duration_ms = await probe_duration_ms(dest)
                except MediaError as exc:
                    raise ProviderError(
                        f"视频加工失败: {exc}", code="MEDIA_PROCESS_FAILED", retryable=False
                    ) from exc
                content = dest.read_bytes()
            await report(CLIP_UPLOADING)
            return await self._store(object_key, content), duration_ms

    async def _fetch(self, urls: Sequence[str], root: Path) -> dict[str, Path]:
        fetched: dict[str, Path] = {}
        async with httpx.AsyncClient(transport=self._transport) as client:
            for url in urls:
                if url in fetched:
                    continue
                target = root / f"src-{uuid.uuid4().hex}.{_EXT}"
                try:
                    await download(client, self._fetch_url(url), target, max_bytes=MAX_VIDEO_BYTES)
                except MediaError as exc:
                    raise ProviderError(
                        f"取不到要加工的素材: {exc}",
                        code="MEDIA_SOURCE_UNREACHABLE",
                        retryable=False,
                    ) from exc
                fetched[url] = target
        return fetched

    async def _probe(self, url: str) -> VideoProfile:
        try:
            return await probe_remote_video(self._fetch_url(url))
        except MediaError as exc:
            raise ProviderError(
                f"取不到要加工的素材: {exc}",
                code="MEDIA_SOURCE_UNREACHABLE",
                retryable=False,
            ) from exc

    async def _store(self, key: str, content: bytes) -> str:
        try:
            return await self._object_store.put_public_object(
                object_key=key, content=content, content_type=_CONTENT_TYPE
            )
        except ObjectStoreUnavailable as exc:
            raise ProviderError(
                f"视频加工完了但存不进桶: {exc}",
                code="OUTPUT_STORE_FAILED",
                retryable=False,
            ) from exc


class FfmpegComposeProvider:
    def __init__(
        self,
        processor: LocalClipProcessor,
        *,
        report_stage: ReportStage,
        record_of: RecordOf,
    ) -> None:
        self._processor = processor
        self._report_stage = report_stage
        self._record_of = record_of

    @property
    def name(self) -> str:
        return PROVIDER_NAME

    async def submit(self, job: GenerationJob) -> ProviderSubmission:
        request = request_of(job, VideoComposeRequest, provider=PROVIDER_NAME)
        _, base_url = await _base_of(job, self._record_of)
        url, duration_ms = await self._processor.render(
            request.segments,
            profile_url=base_url,
            object_key=MEDIA_PATHS.video_master(job_id=job.id, ext=_EXT),
            report=_stage_reporter(self._report_stage, job.id),
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


class EditReferenceCutter:
    """编辑段交上游之前，从基底产物上按替换区间精确切出参考片段，存到这条编辑段固定的地址。

    切的是 ``[range_start_ms, min(range_end_ms, 基底时长))``，画幅帧率沿用基底。
    """

    def __init__(
        self,
        processor: LocalClipProcessor,
        *,
        report_stage: ReportStage,
        record_of: RecordOf,
        media_probe: RemoteMediaProbe,
    ) -> None:
        self._processor = processor
        self._report_stage = report_stage
        self._record_of = record_of
        self._media_probe = media_probe

    async def cut(self, job: GenerationJob, request: VideoEditRequest) -> None:
        base, url = await _base_of(job, self._record_of)
        base_ms = base.output.duration_ms
        if base_ms is None:
            try:
                base_ms = await self._media_probe.duration_ms(url)
            except MediaError as exc:
                raise ProviderError(
                    f"取不到要加工的素材: {exc}",
                    code="MEDIA_SOURCE_UNREACHABLE",
                    retryable=False,
                ) from exc
        segment = ComposeSegment(
            source_job_id=base.id,
            url=url,
            start=request.range_start_ms / 1000,
            end=min(request.range_end_ms, base_ms) / 1000,
        )
        await self._processor.render(
            [segment],
            profile_url=url,
            object_key=MEDIA_PATHS.edit_reference(job_id=job.id),
            report=_stage_reporter(self._report_stage, job.id),
        )


async def _base_of(job: GenerationJob, record_of: RecordOf) -> tuple[GenerationJob, str]:
    if job.source_job_id is None:
        raise RuntimeError(f"生成记录 {job.id} 没有基底")
    base = await record_of(job.source_job_id)
    if base.output.url is None:
        raise ProviderError(
            f"基底 {base.id} 没有产物地址，取不到要加工的素材",
            code="MEDIA_SOURCE_UNREACHABLE",
            retryable=False,
        )
    return base, base.output.url


async def _cuts(segments: Sequence[ComposeSegment], sources: Mapping[str, Path]) -> list[MediaCut]:
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


async def _aligned_to(target: VideoProfile, cuts: Sequence[MediaCut]) -> VideoProfile:
    for source in dict.fromkeys(cut.source for cut in cuts):
        if await has_audio_stream(source):
            return replace(target, has_audio=True)
    return replace(target, has_audio=False)


__all__ = [
    "PROVIDER_NAME",
    "EditReferenceCutter",
    "FfmpegComposeProvider",
    "LocalClipProcessor",
    "ReportStage",
]
