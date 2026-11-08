from __future__ import annotations

import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

import httpx
import pytest

from iclip.domains.generation.processing import FfmpegComposeProvider
from iclip.domains.generation.provider import ProviderError
from iclip.domains.generation.schemas import ClipStage
from iclip.platform.media.codec import SOFTWARE, MediaCodec
from iclip.platform.media.probe import probe_video
from iclip.platform.media.process import ffmpeg_available
from tests.helpers.fetch_url import as_is, rewriting
from tests.helpers.generation import MemoryObjectStore, compose_request, make_job
from tests.helpers.media import (
    BROKEN_DECODE,
    CODECS,
    decode_all,
    duration_ms_of,
    keyframes_of,
    local_codec,
    synthesize_video,
)

pytestmark = [
    pytest.mark.anyio,
    pytest.mark.skipif(not ffmpeg_available(), reason="本机 PATH 上没有 ffmpeg/ffprobe"),
]

BASE_URL = "https://example.test/base.mp4"
EDITED_URL = "https://example.test/edited.mp4"


def _client(payloads: dict[str, bytes]) -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        body = payloads.get(str(request.url))
        if body is None:
            return httpx.Response(404)
        return httpx.Response(200, content=body, headers={"content-type": "video/mp4"})

    return httpx.MockTransport(handler)


@pytest.fixture
def sources() -> dict[str, bytes]:
    with TemporaryDirectory(prefix="clip-fixture-") as tmp:
        root = Path(tmp)
        return {
            BASE_URL: synthesize_video(root / "base.mp4", size="320x240", seconds=4, audio=True),
            EDITED_URL: synthesize_video(
                root / "edited.mp4", size="480x360", seconds=2, audio=False
            ),
        }


@dataclass
class _Stages:
    seen: list[ClipStage] = field(default_factory=list)
    live: bool = True
    broken: bool = False

    async def report(self, job_id: uuid.UUID, stage: ClipStage) -> bool:
        self.seen.append(stage)
        if self.broken:
            raise RuntimeError("数据库连接抖了一下")
        return self.live


@pytest.fixture(params=list(CODECS))
def codec(request: pytest.FixtureRequest) -> MediaCodec:
    return local_codec(request.param)


async def _compose(
    segments: list[dict[str, Any]],
    sources: dict[str, bytes],
    *,
    stages: _Stages | None = None,
    codec: MediaCodec = SOFTWARE,
    fetch_url: Callable[[str], str] = as_is,
) -> tuple[str, bytes]:
    store = MemoryObjectStore()
    provider = FfmpegComposeProvider(
        object_store=store,
        report_stage=(stages or _Stages()).report,
        codec=codec,
        fetch_url=fetch_url,
        transport=_client(sources),
    )
    submission = await provider.submit(
        make_job(compose_request(segments=segments), provider="ffmpeg")
    )

    assert submission.output_url is not None, "本地加工一次出结果，没有轮询阶段"
    key, (content, _) = next(iter(store.objects.items()))
    assert submission.duration_ms == await duration_ms_of(content), "量出来的时长单独交回"
    return key, content


async def _profile(content: bytes) -> tuple[int, int, bool]:
    with TemporaryDirectory(prefix="clip-probe-") as tmp:
        path = Path(tmp) / "out.mp4"
        path.write_bytes(content)
        profile = await probe_video(path)
    return profile.width, profile.height, profile.has_audio


async def test_a_composite_aligns_to_the_original_and_keeps_total_length(
    sources: dict[str, bytes],
) -> None:
    key, content = await _compose(
        [
            {"url": BASE_URL, "start": 0, "end": 1},
            {"url": EDITED_URL, "start": 0.3, "end": 1.7},
            {"url": BASE_URL, "start": 3, "end": 4},
        ],
        sources,
    )

    assert key.startswith("iclip/agent/video-masters/"), "合成长期保留，不进过期规则"
    assert 3100 <= await duration_ms_of(content) <= 3700, "总长是各段之和"
    assert await _profile(content) == (320, 240, True), (
        "对齐到原片；有一段带音轨就出音轨，没音轨的那段补静音"
    )


async def test_sources_are_downloaded_from_the_rewritten_addresses(
    sources: dict[str, bytes],
) -> None:
    to_internal = rewriting("https://example.test", "https://iclip.oss-internal.test")
    internal_only = {to_internal(url): body for url, body in sources.items()}

    _, content = await _compose(
        [
            {"url": BASE_URL, "start": 0, "end": 1},
            {"url": EDITED_URL, "start": 0.3, "end": 1.7},
            {"url": BASE_URL, "start": 3, "end": 4},
        ],
        internal_only,
        fetch_url=to_internal,
    )

    assert 3100 <= await duration_ms_of(content) <= 3700


async def test_a_composite_still_aligns_to_the_original_when_the_edit_covers_most_of_it(
    sources: dict[str, bytes],
) -> None:
    _, content = await _compose(
        [
            {"url": BASE_URL, "start": 0, "end": 0.5},
            {"url": EDITED_URL, "start": 0, "end": 2},
            {"url": BASE_URL, "start": 3.5, "end": 4},
        ],
        sources,
    )

    width, height, _ = await _profile(content)
    assert (width, height) == (320, 240), "按贡献时长认原片会认成 480×360 的编辑片段"


async def test_open_ends_are_filled_from_the_downloaded_sources(
    sources: dict[str, bytes],
) -> None:
    _, content = await _compose(
        [
            {"url": BASE_URL, "start": 0, "end": 1},
            {"url": EDITED_URL, "start": 0},
            {"url": BASE_URL, "start": 3},
        ],
        sources,
    )

    assert 3800 <= await duration_ms_of(content) <= 4200, "1 秒前段 + 2 秒编辑段 + 1 秒后段"


async def test_a_tail_that_starts_at_the_end_of_the_base_is_skipped(
    sources: dict[str, bytes],
) -> None:
    base_ms = await duration_ms_of(sources[BASE_URL])
    _, content = await _compose(
        [
            {"url": BASE_URL, "start": 0, "end": 2},
            {"url": EDITED_URL, "start": 0},
            {"url": BASE_URL, "start": base_ms / 1000},
        ],
        sources,
    )

    assert 3800 <= await duration_ms_of(content) <= 4200, "2 秒前段 + 2 秒编辑段"


_FRAME = 0.1


def _assert_keyframes(actual: list[float], expected: list[float]) -> None:
    assert len(actual) == len(expected), f"关键帧 {actual}，应为 {expected}"
    for got, want in zip(actual, expected, strict=True):
        assert abs(got - want) <= _FRAME + 1e-6, f"关键帧 {actual}，应为 {expected}"


async def test_keyframes_sit_only_at_segment_starts_and_where_the_sources_had_them(
    codec: MediaCodec,
) -> None:
    with TemporaryDirectory(prefix="clip-fixture-") as tmp:
        root = Path(tmp)
        sources = {
            BASE_URL: synthesize_video(
                root / "base.mp4",
                size="320x240",
                seconds=4,
                audio=True,
                keyframes=[0, 0.6, 1.3, 2.2, 3.4],
            ),
            EDITED_URL: synthesize_video(
                root / "edited.mp4",
                size="480x360",
                seconds=2,
                audio=False,
                keyframes=[0, 1.6],
                flip_at=1.25,
            ),
        }
    _, content = await _compose(
        [
            {"url": BASE_URL, "start": 0, "end": 1},
            {"url": EDITED_URL, "start": 0},
            {"url": BASE_URL, "start": 3},
        ],
        sources,
        codec=codec,
    )

    _assert_keyframes(
        await keyframes_of(content),
        [0, 0.6, 1.0, 2.6, 3.0, 3.4],
    )
    assert (await _profile(content))[2], "静音段配了静音，合成照原片带音轨"
    await decode_all(content, codec)


async def test_a_long_stretch_without_source_keyframes_gets_none(codec: MediaCodec) -> None:
    with TemporaryDirectory(prefix="clip-fixture-") as tmp:
        root = Path(tmp)
        sources = {
            BASE_URL: synthesize_video(
                root / "base.mp4", size="160x120", seconds=28, audio=False, keyframes=[0]
            ),
            EDITED_URL: synthesize_video(
                root / "edited.mp4", size="160x120", seconds=2, audio=False, keyframes=[0]
            ),
        }
    _, content = await _compose(
        [{"url": BASE_URL, "start": 0, "end": 27}, {"url": EDITED_URL, "start": 0}],
        sources,
        codec=codec,
    )

    _assert_keyframes(await keyframes_of(content), [0, 27.0])


async def test_the_decode_options_go_on_the_video_inputs(sources: dict[str, bytes]) -> None:
    with pytest.raises(ProviderError) as caught:
        await _compose(
            [{"url": BASE_URL, "start": 0, "end": 1}, {"url": EDITED_URL, "start": 0}],
            sources,
            codec=BROKEN_DECODE,
        )

    assert caught.value.code == "MEDIA_PROCESS_FAILED"
    assert "no-such-accel" in str(caught.value)


async def test_a_composite_reports_fetching_then_processing_then_uploading(
    sources: dict[str, bytes],
) -> None:
    stages = _Stages()
    await _compose(
        [{"url": BASE_URL, "start": 0, "end": 1}, {"url": EDITED_URL, "start": 0}],
        sources,
        stages=stages,
    )

    assert stages.seen == ["fetching", "processing", "uploading"]


async def test_stops_reporting_once_the_job_has_a_conclusion_but_still_finishes(
    sources: dict[str, bytes],
) -> None:
    stages = _Stages(live=False)
    key, content = await _compose(
        [{"url": BASE_URL, "start": 0, "end": 1}, {"url": EDITED_URL, "start": 0}],
        sources,
        stages=stages,
    )

    assert stages.seen == ["fetching"], "第一次就被拒，后面不再报"
    assert key.startswith("iclip/agent/video-masters/")
    assert await duration_ms_of(content) > 0


async def test_a_broken_stage_report_does_not_fail_the_job(sources: dict[str, bytes]) -> None:
    stages = _Stages(broken=True)
    _, content = await _compose(
        [{"url": BASE_URL, "start": 0, "end": 1}, {"url": EDITED_URL, "start": 0}],
        sources,
        stages=stages,
    )

    assert stages.seen == ["fetching"], "第一次就炸，后面不再报"
    assert await duration_ms_of(content) > 0


async def test_a_source_that_cannot_be_fetched_fails_without_retry() -> None:
    provider = FfmpegComposeProvider(
        object_store=MemoryObjectStore(),
        report_stage=_Stages().report,
        codec=SOFTWARE,
        fetch_url=as_is,
        transport=_client({}),
    )
    job = make_job(
        compose_request(
            segments=[{"url": BASE_URL, "start": 0, "end": 1}, {"url": EDITED_URL, "start": 0}]
        ),
        provider="ffmpeg",
    )

    with pytest.raises(ProviderError) as caught:
        await provider.submit(job)

    assert caught.value.code == "MEDIA_SOURCE_UNREACHABLE"
    assert not caught.value.retryable, "取不到素材是这次请求的问题，重排也还是取不到"
