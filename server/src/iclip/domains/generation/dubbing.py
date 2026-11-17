"""配音：用参考音频的声音把每句译文合成出来，按原字幕的时间放好，拼成一条和素材片等长的音轨。

合成那一步交给 ``SpeechSynthesizer``；截参考音频、对齐、拼音轨都在本地用 ffmpeg 做。"""

from __future__ import annotations

import math
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Final, Protocol

import httpx
import structlog

from iclip.common.final_cut import TargetLocale
from iclip.domains.generation.model_groups import UNGROUPED, ModelGroups, group_key
from iclip.domains.generation.models import GenerationJob
from iclip.domains.generation.provider import (
    ProviderError,
    ProviderProgress,
    ProviderSubmission,
    request_of,
)
from iclip.domains.generation.schemas import (
    DubbedLine,
    DubbingLine,
    DubbingOriginalReference,
    DubbingRequest,
)
from iclip.platform.media.audio import (
    AudioPlacement,
    decode_audio,
    extract_audio_clip,
    lay_audio_track,
)
from iclip.platform.media.errors import MediaError, NoAudioStream
from iclip.platform.media.fetch import MAX_AUDIO_BYTES, MAX_VIDEO_BYTES, download
from iclip.platform.object_store.layout import MEDIA_PATHS
from iclip.platform.object_store.store import ObjectStoreUnavailable, PublicObjectStore

_logger = structlog.stdlib.get_logger(__name__)

PROVIDER_NAME: Final = "dubbing"

MAX_REFERENCE_MS: Final = 10_000

MIN_REFERENCE_SPEECH_MS: Final = 3_000

MAX_SPEED: Final = 1.25

TRIM_FADE_MS: Final = 80

_EXT: Final = "m4a"
_CONTENT_TYPE: Final = "audio/mp4"


class SpeechSynthesizer(Protocol):
    async def synthesize(
        self, text: str, *, reference: bytes, locale: TargetLocale, api_key: str | None
    ) -> bytes:
        """用 ``reference`` 的声音把 ``text`` 用 ``locale`` 这种语言念出来，返回一段音频。

        ``reference`` 是不超过 10 秒的 WAV（单声道、16 位 PCM、48 kHz）。``api_key`` 是这条记录所在
        配置组的配音 key，默认组为 ``None``，即用合成服务自己装配的 key。返回的音频格式不限，ffmpeg
        解得开就行；多长都可以，变速、截断由调用方按这句的位置做。合成失败抛 ``ProviderError``，
        这条配音记录随之失败、不自动重来。
        """
        ...


@dataclass(frozen=True, slots=True)
class ReferenceWindow:
    """原声里截作参考音频的一段：``[start_ms, end_ms)``，其中 ``speech_ms`` 毫秒被字幕覆盖。"""

    start_ms: int
    end_ms: int
    speech_ms: int


class Timed(Protocol):
    """有起止（毫秒）的一段：要配的一句，或一段说话时段。"""

    @property
    def start_ms(self) -> int: ...

    @property
    def end_ms(self) -> int: ...


def reference_window(lines: Sequence[Timed], duration_ms: int) -> ReferenceWindow:
    """在 ``[0, duration_ms)`` 里找一段不超过 ``MAX_REFERENCE_MS``、被 ``lines``（按开始排好、互不
    重叠）覆盖得最多的连续时段，覆盖一样多取最早的；再把两头没被覆盖的部分收掉。一段都碰不到时
    ``speech_ms`` 为 0。"""

    span = min(MAX_REFERENCE_MS, duration_ms)
    latest = duration_ms - span
    # 覆盖量随窗口起点分段线性变化，最大值落在窗口左边对齐某句开头、或右边对齐某句结尾的位置。
    candidates = sorted(
        {min(max(at, 0), latest) for line in lines for at in (line.start_ms, line.end_ms - span)}
    )
    best_start, best_speech = 0, -1
    for start in candidates:
        speech = _covered(lines, start, start + span)
        if speech > best_speech:
            best_start, best_speech = start, speech
    end = best_start + span
    touched = [line for line in lines if line.start_ms < end and line.end_ms > best_start]
    if not touched:
        return ReferenceWindow(start_ms=best_start, end_ms=best_start, speech_ms=0)
    return ReferenceWindow(
        start_ms=max(best_start, touched[0].start_ms),
        end_ms=min(end, touched[-1].end_ms),
        speech_ms=best_speech,
    )


def _covered(lines: Sequence[Timed], start: int, end: int) -> int:
    return sum(max(0, min(line.end_ms, end) - max(line.start_ms, start)) for line in lines)


def line_slots(lines: Sequence[DubbingLine], duration_ms: int) -> tuple[int, ...]:
    """每句能占的长度（毫秒）：从它开始到下一句开始，最后一句到视频结尾；写了 ``slot_end_ms`` 的
    不超过它。"""

    ends = [*(line.start_ms for line in lines[1:]), duration_ms]
    return tuple(
        (end if line.slot_end_ms is None else min(end, line.slot_end_ms)) - line.start_ms
        for line, end in zip(lines, ends, strict=True)
    )


def fit_line(index: int, clip_ms: int, slot_ms: int) -> DubbedLine:
    """一句合成出来 ``clip_ms`` 长、位置只有 ``slot_ms`` 时怎么放：放得下原速；放不下取能放下的最小
    倍数（向上取到千分之一），最多 ``MAX_SPEED``；加速到上限还放不下就记 ``trimmed``。"""

    if clip_ms <= slot_ms:
        return DubbedLine(index=index, speed=1.0, trimmed=False)
    needed = math.ceil(round(clip_ms / slot_ms * 1000, 6)) / 1000
    if needed <= MAX_SPEED:
        return DubbedLine(index=index, speed=needed, trimmed=False)
    return DubbedLine(index=index, speed=MAX_SPEED, trimmed=True)


class DubbingProvider:
    def __init__(
        self,
        synthesizer: SpeechSynthesizer,
        *,
        object_store: PublicObjectStore,
        fetch_url: Callable[[str], str],
        model_groups: ModelGroups = UNGROUPED,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._synthesizer = synthesizer
        self._object_store = object_store
        self._fetch_url = fetch_url
        self._model_groups = model_groups
        self._transport = transport

    @property
    def name(self) -> str:
        return PROVIDER_NAME

    def _api_key(self, job: GenerationJob) -> str | None:
        group = self._model_groups.of(job)
        if group is None:
            return None
        return group_key(group, group.speech_api_key, what="配音")

    async def submit(self, job: GenerationJob) -> ProviderSubmission:
        request = request_of(job, DubbingRequest, provider=PROVIDER_NAME)
        # 先定 key 再下载素材：组配错了不白下整条视频。
        api_key = self._api_key(job)
        with TemporaryDirectory(prefix="iclip-dubbing-") as tmp:
            root = Path(tmp)
            reference = await self._reference(request, root)
            slots = line_slots(request.lines, request.video_duration_ms)
            placements: list[AudioPlacement] = []
            dubbed: list[DubbedLine] = []
            for index, (line, slot_ms) in enumerate(zip(request.lines, slots, strict=True)):
                clip = root / f"line-{index}.wav"
                clip_ms = await self._synthesized(
                    index, line.text, reference, request, clip, api_key=api_key
                )
                fitted = fit_line(index, clip_ms, slot_ms)
                dubbed.append(fitted)
                placements.append(
                    AudioPlacement(
                        clip=clip,
                        start_ms=line.start_ms,
                        length_ms=slot_ms,
                        speed=fitted.speed,
                        fade_out_ms=TRIM_FADE_MS if fitted.trimmed else 0,
                    )
                )
            track = root / f"dubbing.{_EXT}"
            try:
                duration_ms = await lay_audio_track(
                    placements, total_ms=request.video_duration_ms, dest=track
                )
            except MediaError as exc:
                raise ProviderError(
                    f"配音拼成音轨失败: {exc}", code="MEDIA_PROCESS_FAILED", retryable=False
                ) from exc
            content = track.read_bytes()
        try:
            stored = await self._object_store.put_public_object(
                object_key=MEDIA_PATHS.generated_dubbing(job_id=job.id, ext=_EXT),
                content=content,
                content_type=_CONTENT_TYPE,
            )
        except ObjectStoreUnavailable as exc:
            raise ProviderError(
                f"配音已合成但存不进桶: {exc}", code="OUTPUT_STORE_FAILED", retryable=False
            ) from exc
        _logger.info(
            "配音已合成",
            job_id=job.id,
            lines=len(dubbed),
            sped_up=sum(1 for line in dubbed if line.speed > 1),
            trimmed=sum(1 for line in dubbed if line.trimmed),
        )
        return ProviderSubmission(
            provider_task_id=str(job.id),
            provider_status="succeeded",
            output_url=stored,
            duration_ms=duration_ms,
            dubbed_lines=tuple(dubbed),
        )

    async def poll(self, job: GenerationJob) -> ProviderProgress:
        raise ProviderError(
            "配音是同步的，没有轮询阶段",
            code="PROVIDER_POLL_UNSUPPORTED",
            retryable=False,
        )

    async def _reference(self, request: DubbingRequest, root: Path) -> bytes:
        dest = root / "reference.wav"
        if not isinstance(request.reference, DubbingOriginalReference):
            source = root / "reference-source"
            await self._download(request.reference.url, source, max_bytes=MAX_AUDIO_BYTES)
            start_ms, length_ms = 0, MAX_REFERENCE_MS
            silent = "参考音频里没有声音，换一段参考音频"
        else:
            speech = request.reference.spans or request.lines
            window = reference_window(speech, request.video_duration_ms)
            if window.speech_ms < MIN_REFERENCE_SPEECH_MS:
                raise ProviderError(
                    "原声里说话太少，换一段参考音频",
                    code="DUBBING_REFERENCE_TOO_SHORT",
                    retryable=False,
                )
            source = root / "source.mp4"
            await self._download(request.video_url, source, max_bytes=MAX_VIDEO_BYTES)
            start_ms, length_ms = window.start_ms, window.end_ms - window.start_ms
            silent = "素材片没有音轨，换一段参考音频"
        try:
            await extract_audio_clip(source, dest=dest, start_ms=start_ms, duration_ms=length_ms)
        except NoAudioStream as exc:
            raise ProviderError(silent, code="DUBBING_REFERENCE_SILENT", retryable=False) from exc
        except MediaError as exc:
            raise ProviderError(
                f"截参考音频失败: {exc}", code="MEDIA_PROCESS_FAILED", retryable=False
            ) from exc
        return dest.read_bytes()

    async def _download(self, url: str, dest: Path, *, max_bytes: int) -> None:
        try:
            async with httpx.AsyncClient(transport=self._transport) as client:
                await download(client, self._fetch_url(url), dest, max_bytes=max_bytes)
        except MediaError as exc:
            raise ProviderError(
                f"取不到配音要用的素材: {exc}", code="MEDIA_SOURCE_UNREACHABLE", retryable=False
            ) from exc

    async def _synthesized(
        self,
        index: int,
        text: str,
        reference: bytes,
        request: DubbingRequest,
        dest: Path,
        *,
        api_key: str | None,
    ) -> int:
        audio = await self._synthesizer.synthesize(
            text, reference=reference, locale=request.locale, api_key=api_key
        )
        raw = dest.with_suffix(".synthesized")
        raw.write_bytes(audio)
        try:
            return await decode_audio(raw, dest=dest)
        except MediaError as exc:
            raise ProviderError(
                f"第 {index + 1} 句合成出来的音频解不开: {exc}",
                code="MEDIA_PROCESS_FAILED",
                retryable=False,
            ) from exc


__all__ = [
    "MAX_REFERENCE_MS",
    "MAX_SPEED",
    "MIN_REFERENCE_SPEECH_MS",
    "PROVIDER_NAME",
    "TRIM_FADE_MS",
    "DubbingProvider",
    "ReferenceWindow",
    "SpeechSynthesizer",
    "fit_line",
    "line_slots",
    "reference_window",
]
