"""用 ffmpeg 合成视频，验证拆解前的读时长与下载选路、抽帧与取音轨。"""

from __future__ import annotations

from pathlib import Path

import httpx
import pytest

from iclip.platform.media.codec import SOFTWARE
from iclip.platform.media.errors import MediaError
from iclip.platform.media.fetch import MediaDownloads
from iclip.platform.media.process import ffmpeg_available, run
from iclip.platform.video_breakdown.media import (
    FRAME_MAX_PIXELS,
    FfmpegVideoSampler,
    sample_file,
)
from tests.helpers.fetch_url import rewriting
from tests.helpers.media import BROKEN_DECODE, CODECS, local_codec, synthesize_video
from tests.helpers.media_server import serving

pytestmark = pytest.mark.skipif(not ffmpeg_available(), reason="本机 PATH 上没有 ffmpeg/ffprobe")


async def frame_size(frame: bytes, tmp_path: Path) -> tuple[int, int]:
    path = tmp_path / "frame.jpg"
    path.write_bytes(frame)
    stdout = await run(
        [
            "ffprobe", "-v", "error", "-select_streams", "v:0",
            "-show_entries", "stream=width,height", "-of", "csv=p=0", str(path),
        ],
        timeout=30,
    )  # fmt: skip
    width, height = stdout.decode().strip().split(",")
    return int(width), int(height)


@pytest.mark.parametrize("codec_name", list(CODECS))
async def test_two_seconds_give_twenty_frames_and_the_audio_track(
    codec_name: str, tmp_path: Path
) -> None:
    """每一档解码抽出来的都一样；本机用不了的硬件档跳过。"""

    source = tmp_path / "source.mp4"
    synthesize_video(source, size="320x240", seconds=2, audio=True)

    sample = await sample_file(source, codec=local_codec(codec_name))

    assert len(sample.frames) == 20, "每秒 10 帧，第 i 帧对应 i/10 秒"
    assert sample.audio is not None
    assert await frame_size(sample.frames[0], tmp_path) == (320, 240), "不超上限的不缩"


async def test_a_silent_video_is_sampled_without_audio(tmp_path: Path) -> None:
    source = tmp_path / "source.mp4"
    synthesize_video(source, size="320x240", seconds=1, audio=False)

    sample = await sample_file(source, codec=SOFTWARE)

    assert len(sample.frames) == 10
    assert sample.audio is None


async def test_frames_over_the_pixel_limit_are_scaled_down_keeping_the_aspect(
    tmp_path: Path,
) -> None:
    source = tmp_path / "source.mp4"
    synthesize_video(source, size="1080x1920", seconds=1, audio=False)

    sample = await sample_file(source, codec=SOFTWARE)

    width, height = await frame_size(sample.frames[0], tmp_path)
    assert width * height <= FRAME_MAX_PIXELS
    assert (width, height) == (616, 1096)


async def test_the_decode_options_go_on_the_input(tmp_path: Path) -> None:
    source = tmp_path / "source.mp4"
    synthesize_video(source, size="320x240", seconds=1, audio=False)

    with pytest.raises(MediaError, match="no-such-accel"):
        await sample_file(source, codec=BROKEN_DECODE)


OWN_BASE = "https://cdn.test"


def unused_client() -> httpx.AsyncClient:
    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError(f"这条路不该下载 {request.url}")

    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def own_bucket_downloads(
    internal: httpx.AsyncClient, public: httpx.AsyncClient, fetch_base: str
) -> MediaDownloads:
    return MediaDownloads(
        internal=internal,
        public=public,
        fetch_url=rewriting(OWN_BASE, fetch_base),
        owns=lambda url: url.startswith(f"{OWN_BASE}/"),
    )


@pytest.mark.parametrize(("max_seconds", "sampled"), [(60.0, True), (1.0, False)])
async def test_an_own_object_is_probed_and_downloaded_at_the_rewritten_address(
    tmp_path: Path, max_seconds: float, sampled: bool
) -> None:
    """拿到的是本桶公网地址，视频只在换过的地址上读得到：探时长与下载都走换过的那个，不经出网防护。"""

    video = synthesize_video(tmp_path / "ref.mp4", size="320x240", seconds=2, audio=True)
    async with (
        serving({"iclip/agent/ref.mp4": video}) as server,
        httpx.AsyncClient() as client,
        unused_client() as public,
    ):
        sampler = FfmpegVideoSampler(
            own_bucket_downloads(client, public, server.base_url), SOFTWARE
        )
        sample = await sampler.sample_up_to(
            f"{OWN_BASE}/iclip/agent/ref.mp4", max_seconds=max_seconds
        )

    if sampled:
        assert sample is not None
        assert len(sample.frames) == 20
    else:
        assert sample is None
    assert {delivery.target for delivery in server.deliveries} == {"iclip/agent/ref.mp4"}


@pytest.mark.parametrize(("max_seconds", "sampled"), [(60.0, True), (1.0, False)])
async def test_another_address_is_downloaded_once_through_the_public_client_then_probed_locally(
    tmp_path: Path, max_seconds: float, sampled: bool
) -> None:
    """别处的地址不交给 ffprobe/ffmpeg：经只连公网的客户端原样下载一次，时长在本地文件上探，短的就抽
    这一份。这个主机名解析不了，ffprobe 若拿到远程地址就会失败。"""

    video = synthesize_video(tmp_path / "ref.mp4", size="320x240", seconds=2, audio=True)
    asked: list[str] = []

    def outside(request: httpx.Request) -> httpx.Response:
        asked.append(str(request.url))
        return httpx.Response(200, content=video)

    url = "https://elsewhere.invalid/ref.mp4?sig=1"
    async with (
        unused_client() as internal,
        httpx.AsyncClient(transport=httpx.MockTransport(outside)) as public,
    ):
        sampler = FfmpegVideoSampler(
            own_bucket_downloads(internal, public, "http://127.0.0.1:9"), SOFTWARE
        )
        sample = await sampler.sample_up_to(url, max_seconds=max_seconds)

    assert asked == [url]
    if sampled:
        assert sample is not None
        assert len(sample.frames) == 20
        assert sample.audio is not None
    else:
        assert sample is None
