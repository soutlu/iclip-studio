from __future__ import annotations

import asyncio
import uuid
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass, replace
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
    VideoTransitionRequest,
)
from iclip.platform.media.codec import MediaCodec
from iclip.platform.media.errors import MediaError
from iclip.platform.media.fetch import MAX_VIDEO_BYTES, download
from iclip.platform.media.frames import first_frame_from, last_frame_before
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
_FRAME_CONTENT_TYPE: Final = "image/jpeg"

ReportStage = Callable[[uuid.UUID, ClipStage], Awaitable[bool]]

RecordOf = Callable[[uuid.UUID], Awaitable[GenerationJob]]

_Report = Callable[[ClipStage], Awaitable[None]]


@dataclass(frozen=True, slots=True)
class FrameAt:
    """要从 ``url`` 那条视频的 ``seconds`` 秒附近抽的一帧，存到 ``object_key``。"""

    url: str
    seconds: float
    object_key: str


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

    合成、编辑段切参考片段与衔接段准备素材共用这一个实例，同时在跑的加工（下载、编码或抽帧、
    读产物、上传）不超过 ``concurrency``。
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

    async def capture_frames(
        self, last_before: FrameAt, first_from: FrameAt, *, report: _Report
    ) -> None:
        """从 ``last_before`` 那条视频取早于其时间点的最后一帧、从 ``first_from`` 那条取不早于其
        时间点的第一帧，各存成 JPEG 到各自的 ``object_key``；时间点越过结尾时取最后一帧。

        与 ``render`` 共用并发上限、阶段上报与错误码。
        """

        async with self._slots:
            with TemporaryDirectory(prefix="iclip-frames-") as tmp:
                root = Path(tmp)
                await report(CLIP_FETCHING)
                sources = await self._fetch([last_before.url, first_from.url], root)
                first, last = root / "first.jpg", root / "last.jpg"
                try:
                    await report(CLIP_PROCESSING)
                    await last_frame_before(sources[last_before.url], last_before.seconds, first)
                    await first_frame_from(sources[first_from.url], first_from.seconds, last)
                except MediaError as exc:
                    raise ProviderError(
                        f"视频抽帧失败: {exc}", code="MEDIA_PROCESS_FAILED", retryable=False
                    ) from exc
                frames = [
                    (last_before.object_key, first.read_bytes()),
                    (first_from.object_key, last.read_bytes()),
                ]
            await report(CLIP_UPLOADING)
            for key, content in frames:
                await self._store(key, content, content_type=_FRAME_CONTENT_TYPE)

    async def _probe(self, url: str) -> VideoProfile:
        try:
            return await probe_remote_video(self._fetch_url(url))
        except MediaError as exc:
            raise ProviderError(
                f"取不到要加工的素材: {exc}",
                code="MEDIA_SOURCE_UNREACHABLE",
                retryable=False,
            ) from exc

    async def _store(self, key: str, content: bytes, *, content_type: str = _CONTENT_TYPE) -> str:
        try:
            return await self._object_store.put_public_object(
                object_key=key, content=content, content_type=content_type
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
        base_ms = await _duration_ms_of(base, url, self._media_probe)
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


class TransitionInputs:
    """衔接段交上游之前，按记录里的左右两条素材片准备素材，存到这条衔接段固定的地址。

    ``first_last_frame`` 抽 A 在 ``left_end_ms`` 之前的最后一帧与 B 不早于 ``right_start_ms`` 的第一帧；
    ``video_edit`` 把 A 的 ``[left_end_ms, 结尾)`` 与 B 的 ``[0, right_start_ms)`` 按 A 的画幅帧率拼成
    参考片段，长度为 0 的那段跳过。
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

    async def prepare(self, job: GenerationJob, request: VideoTransitionRequest) -> None:
        left, left_url = await _output_of(request.left_job_id, self._record_of)
        right, right_url = await _output_of(request.right_job_id, self._record_of)
        report = _stage_reporter(self._report_stage, job.id)
        if request.mode == "first_last_frame":
            await self._processor.capture_frames(
                FrameAt(
                    url=left_url,
                    seconds=request.left_end_ms / 1000,
                    object_key=MEDIA_PATHS.transition_first_frame(job_id=job.id),
                ),
                FrameAt(
                    url=right_url,
                    seconds=request.right_start_ms / 1000,
                    object_key=MEDIA_PATHS.transition_last_frame(job_id=job.id),
                ),
                report=report,
            )
            return
        segments = [
            ComposeSegment(source_job_id=left.id, url=left_url, start=request.left_end_ms / 1000)
        ]
        if request.right_start_ms > 0:
            right_ms = await _duration_ms_of(right, right_url, self._media_probe)
            segments.append(
                ComposeSegment(
                    source_job_id=right.id,
                    url=right_url,
                    start=0,
                    end=min(request.right_start_ms, right_ms) / 1000,
                )
            )
        await self._processor.render(
            segments,
            profile_url=left_url,
            object_key=MEDIA_PATHS.transition_clip(job_id=job.id),
            report=report,
        )


async def _base_of(job: GenerationJob, record_of: RecordOf) -> tuple[GenerationJob, str]:
    if job.source_job_id is None:
        raise RuntimeError(f"生成记录 {job.id} 没有基底")
    return await _output_of(job.source_job_id, record_of)


async def _output_of(job_id: uuid.UUID, record_of: RecordOf) -> tuple[GenerationJob, str]:
    record = await record_of(job_id)
    if record.output.url is None:
        raise ProviderError(
            f"素材片 {record.id} 没有产物地址，取不到要加工的素材",
            code="MEDIA_SOURCE_UNREACHABLE",
            retryable=False,
        )
    return record, record.output.url


async def _duration_ms_of(record: GenerationJob, url: str, media_probe: RemoteMediaProbe) -> int:
    if record.output.duration_ms is not None:
        return record.output.duration_ms
    try:
        return await media_probe.duration_ms(url)
    except MediaError as exc:
        raise ProviderError(
            f"取不到要加工的素材: {exc}",
            code="MEDIA_SOURCE_UNREACHABLE",
            retryable=False,
        ) from exc


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
    "FrameAt",
    "LocalClipProcessor",
    "ReportStage",
    "TransitionInputs",
]
