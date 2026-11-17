from __future__ import annotations

import io
import math
import re
import subprocess
import uuid
import wave
from array import array
from dataclasses import dataclass, replace
from pathlib import Path
from tempfile import TemporaryDirectory

import httpx
import pytest
from procrastinate.testing import InMemoryConnector

from iclip.common.final_cut import TargetLocale
from iclip.domains.generation.dubbing import (
    MAX_REFERENCE_MS,
    PROVIDER_NAME,
    DubbingProvider,
    reference_window,
)
from iclip.domains.generation.model_groups import UNGROUPED, ModelGroup, ModelGroups
from iclip.domains.generation.models import (
    STATUS_COMPLETED,
    STATUS_FAILED,
    GenerationJob,
    GenerationOutput,
)
from iclip.domains.generation.provider import ProviderError
from iclip.domains.generation.queue import GenerationQueue, ProviderLane
from iclip.domains.generation.schemas import (
    DubbedLine,
    DubbingAudioReference,
    DubbingLine,
)
from iclip.platform.media.process import ffmpeg_available
from tests.helpers.fetch_url import as_is
from tests.helpers.generation import (
    QUEUE_SETTINGS,
    InMemoryGenerationRepository,
    MemoryObjectStore,
    make_dubbing,
    make_job,
)
from tests.helpers.media import synthesize_video

pytestmark = [
    pytest.mark.anyio,
    pytest.mark.skipif(not ffmpeg_available(), reason="本机 PATH 上没有 ffmpeg/ffprobe"),
]

VIDEO_URL = "https://cdn.example.test/iclip/agent/video-masters/take.mp4"
VOICE_URL = "https://cdn.example.test/iclip/agent/uploads/voice.wav"
RATE = 48_000
MS_PER_CHAR = 100
# 假合成在音后面带一段静音：加速了的句子结尾会留下这段静音，截掉的句子就没有。
TAIL_MS = 400
# AAC 按 1024 个采样点分帧，成品长度和要求的差几十毫秒以内。
LENGTH_TOLERANCE_MS = 50
AUDIBLE_DB = -40.0
SILENT_DB = -60.0


def tone(ms: int, *, frequency: int = 440, silence_ms: int = 0) -> bytes:
    samples = array(
        "h",
        (
            int(12_000 * math.sin(2 * math.pi * frequency * i / RATE))
            for i in range(RATE * ms // 1000)
        ),
    )
    samples.extend([0] * (RATE * silence_ms // 1000))
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(RATE)
        out.writeframes(samples.tobytes())
    return buffer.getvalue()


@dataclass(frozen=True, slots=True)
class WavShape:
    channels: int
    rate: int
    duration_ms: int


def wav_shape(content: bytes) -> WavShape:
    with wave.open(io.BytesIO(content), "rb") as source:
        return WavShape(
            channels=source.getnchannels(),
            rate=source.getframerate(),
            duration_ms=round(source.getnframes() * 1000 / source.getframerate()),
        )


@dataclass(frozen=True, slots=True)
class Synthesis:
    text: str
    reference: bytes
    locale: TargetLocale
    api_key: str | None


class CharTimedSynthesizer:
    """每个字念 ``MS_PER_CHAR`` 毫秒的假合成：一段 440 Hz 的音，后面跟 ``TAIL_MS`` 毫秒静音。"""

    def __init__(self) -> None:
        self.calls: list[Synthesis] = []

    async def synthesize(
        self, text: str, *, reference: bytes, locale: TargetLocale, api_key: str | None
    ) -> bytes:
        self.calls.append(Synthesis(text=text, reference=reference, locale=locale, api_key=api_key))
        return tone(len(text) * MS_PER_CHAR, silence_ms=TAIL_MS)


class Files:
    def __init__(self, files: dict[str, bytes]) -> None:
        self.files = files
        self.requested: list[str] = []

    def transport(self) -> httpx.MockTransport:
        def handler(request: httpx.Request) -> httpx.Response:
            url = str(request.url)
            self.requested.append(url)
            if url not in self.files:
                return httpx.Response(404)
            return httpx.Response(200, content=self.files[url])

        return httpx.MockTransport(handler)


def video(*, seconds: int, audio: bool = True) -> bytes:
    with TemporaryDirectory(prefix="dubbing-fixture-") as tmp:
        return synthesize_video(
            Path(tmp) / "take.mp4", size="160x120", seconds=seconds, audio=audio
        )


def take() -> GenerationJob:
    return make_job(status=STATUS_COMPLETED, output=GenerationOutput(url=VIDEO_URL))


def provider(
    files: Files,
    synthesizer: CharTimedSynthesizer,
    store: MemoryObjectStore,
    *,
    model_groups: ModelGroups = UNGROUPED,
) -> DubbingProvider:
    return DubbingProvider(
        synthesizer,
        object_store=store,
        fetch_url=as_is,
        model_groups=model_groups,
        transport=files.transport(),
    )


def line(start_ms: int, end_ms: int, chars: int) -> DubbingLine:
    return DubbingLine(start_ms=start_ms, end_ms=end_ms, text="a" * chars)


def mean_volume_db(path: Path, start_ms: int, end_ms: int) -> float:
    run = subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-nostats",
            "-ss", f"{start_ms / 1000:.3f}", "-t", f"{(end_ms - start_ms) / 1000:.3f}",
            "-i", str(path), "-af", "volumedetect", "-f", "null", "-",
        ],
        check=True,
        capture_output=True,
    )  # fmt: skip
    return float(re.findall(r"mean_volume: (-?[\d.]+) dB", run.stderr.decode())[-1])


def duration_ms(path: Path) -> int:
    probe = subprocess.run(
        [
            "ffprobe", "-v", "error", "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1", str(path),
        ],
        check=True,
        capture_output=True,
    )  # fmt: skip
    return round(float(probe.stdout) * 1000)


async def test_each_line_is_fitted_into_its_place_on_a_track_as_long_as_the_take(
    tmp_path: Path,
) -> None:
    # 合成出来的长度是 字数 × 100 + 400 毫秒；位置是到下一句开始，最后一句到 8 秒。
    lines = [
        line(500, 1_500, 10),  # 1400 放进 2000：原速，音在 0.5–1.5 秒
        line(2_500, 3_500, 20),  # 2400 放进 2000：1.2 倍，音在 2.5–4.17 秒，之后是带来的静音
        line(4_500, 5_000, 30),  # 3400 放进 1500：1.25 倍也放不下，截到 6 秒、末尾淡出
        line(6_000, 6_500, 5),  # 900 放进 2000：原速，音在 6–6.5 秒
    ]
    job = make_dubbing(
        take(),
        lines,
        duration_ms=8_000,
        reference=DubbingAudioReference(kind="audio", url=VOICE_URL),
    )
    files = Files({VOICE_URL: tone(15_000, frequency=220)})
    synthesizer = CharTimedSynthesizer()
    store = MemoryObjectStore()

    submission = await provider(files, synthesizer, store).submit(job)

    assert submission.dubbed_lines == (
        DubbedLine(index=0, speed=1.0, trimmed=False),
        DubbedLine(index=1, speed=1.2, trimmed=False),
        DubbedLine(index=2, speed=1.25, trimmed=True),
        DubbedLine(index=3, speed=1.0, trimmed=False),
    )
    key = f"iclip/agent/generated-dubbing/{job.id}.m4a"
    assert submission.output_url == store.public_url(key)
    content, content_type = store.objects[key]
    assert content_type == "audio/mp4"
    track = tmp_path / "dubbing.m4a"
    track.write_bytes(content)
    assert abs(duration_ms(track) - 8_000) <= LENGTH_TOLERANCE_MS
    assert submission.duration_ms is not None
    assert abs(submission.duration_ms - 8_000) <= LENGTH_TOLERANCE_MS
    heard = {
        span: mean_volume_db(track, *span)
        for span in [
            (100, 400),
            (700, 1_300),
            (1_700, 2_400),
            (2_600, 4_000),
            (4_250, 4_450),
            (4_600, 5_400),
            (5_700, 5_900),
            (6_100, 6_400),
            (6_700, 7_900),
        ]
    }
    assert [span for span, db in heard.items() if db > AUDIBLE_DB] == [
        (700, 1_300),
        (2_600, 4_000),
        (4_600, 5_400),
        (5_700, 5_900),
        (6_100, 6_400),
    ], heard
    assert [span for span, db in heard.items() if db < SILENT_DB] == [
        (100, 400),
        (1_700, 2_400),
        (4_250, 4_450),
        (6_700, 7_900),
    ], heard
    assert mean_volume_db(track, 5_960, 6_000) < heard[(5_700, 5_900)] - 6, "截掉的那句末尾淡出"
    assert [call.text for call in synthesizer.calls] == [item.text for item in lines]
    assert {call.locale for call in synthesizer.calls} == {"en"}
    assert {call.api_key for call in synthesizer.calls} == {None}, "默认组用合成服务自己的 key"
    assert wav_shape(synthesizer.calls[0].reference) == WavShape(
        channels=1, rate=RATE, duration_ms=MAX_REFERENCE_MS
    ), "参考音频只取前 10 秒"
    assert files.requested == [VOICE_URL], "参考音频给了地址就不取视频"


async def test_the_original_voice_is_cut_from_the_stretch_with_the_most_speech() -> None:
    lines = [line(500, 1_500, 5), line(6_000, 9_000, 5), line(9_200, 11_800, 5)]
    job = make_dubbing(take(), lines, duration_ms=12_000)
    files = Files({VIDEO_URL: video(seconds=12)})
    synthesizer = CharTimedSynthesizer()

    submission = await provider(files, synthesizer, MemoryObjectStore()).submit(job)

    window = reference_window(lines, 12_000)
    assert (window.start_ms, window.end_ms) == (6_000, 11_800)
    shape = wav_shape(synthesizer.calls[0].reference)
    assert (shape.channels, shape.rate) == (1, RATE)
    assert abs(shape.duration_ms - (window.end_ms - window.start_ms)) <= LENGTH_TOLERANCE_MS
    assert submission.dubbed_lines is not None and len(submission.dubbed_lines) == 3


async def test_too_little_speech_in_the_original_fails_the_record_without_synthesizing() -> None:
    job = make_dubbing(
        take(),
        [line(0, 1_000, 5), line(5_000, 6_500, 5)],
        duration_ms=12_000,
        provider=PROVIDER_NAME,
    )
    files = Files({VIDEO_URL: video(seconds=12)})
    synthesizer = CharTimedSynthesizer()
    repo = InMemoryGenerationRepository([job])
    queue = GenerationQueue(
        repo,
        lanes=(ProviderLane(provider(files, synthesizer, MemoryObjectStore()), 1),),
        connector=InMemoryConnector(),
        settings=QUEUE_SETTINGS,
    )

    await queue.run_submit(str(job.id))

    stored = repo.jobs[job.id]
    assert (stored.status, stored.error_code) == (STATUS_FAILED, "DUBBING_REFERENCE_TOO_SHORT")
    assert synthesizer.calls == []
    assert files.requested == [], "说话不够就不去取视频"


async def test_an_original_without_an_audio_track_fails_on_the_reference() -> None:
    job = make_dubbing(take(), [line(0, 4_000, 5)], duration_ms=6_000)
    files = Files({VIDEO_URL: video(seconds=6, audio=False)})
    synthesizer = CharTimedSynthesizer()

    with pytest.raises(ProviderError) as raised:
        await provider(files, synthesizer, MemoryObjectStore()).submit(job)

    assert raised.value.code == "DUBBING_REFERENCE_SILENT"
    assert synthesizer.calls == []


async def _nobody_is_grouped(_user_id: uuid.UUID) -> str | None:
    return None


async def test_every_line_is_synthesized_with_the_records_group_key() -> None:
    groups = ModelGroups(
        (
            ModelGroup(
                name="mkt", video_api_key="vk-mkt", video_models={}, dubbing_api_key="dub-mkt"
            ),
        ),
        group_of=_nobody_is_grouped,
    )
    job = replace(
        make_dubbing(
            take(),
            [line(0, 1_000, 3), line(1_500, 2_500, 3)],
            duration_ms=3_000,
            reference=DubbingAudioReference(kind="audio", url=VOICE_URL),
        ),
        model_group="mkt",
    )
    files = Files({VOICE_URL: tone(5_000, frequency=220)})
    synthesizer = CharTimedSynthesizer()

    await provider(files, synthesizer, MemoryObjectStore(), model_groups=groups).submit(job)

    assert [call.api_key for call in synthesizer.calls] == ["dub-mkt", "dub-mkt"]
