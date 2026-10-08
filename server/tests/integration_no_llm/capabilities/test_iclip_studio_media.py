"""用 ffmpeg 合成视频，验证拆解前的读时长、抽帧与取音轨。"""

from __future__ import annotations

from pathlib import Path

import httpx
import pytest

from iclip.capabilities.iclip_studio.breakdown.media import (
    FRAME_MAX_PIXELS,
    FfmpegVideoSampler,
    sample_file,
)
from iclip.platform.media.codec import SOFTWARE
from iclip.platform.media.ffmpeg import MediaError, ffmpeg_available, run
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


async def test_the_sampler_probes_and_downloads_the_rewritten_address(tmp_path: Path) -> None:
    """拿到的是本桶公网地址，视频只在换过的地址上读得到：探时长与下载都走换过的那个。"""

    public = "https://cdn.test"
    video = synthesize_video(tmp_path / "ref.mp4", size="320x240", seconds=2, audio=True)
    async with serving({"iclip/agent/ref.mp4": video}) as server, httpx.AsyncClient() as client:
        sampler = FfmpegVideoSampler(client, SOFTWARE, fetch_url=rewriting(public, server.base_url))
        seconds = await sampler.duration_seconds(f"{public}/iclip/agent/ref.mp4")
        sample = await sampler.sample(f"{public}/iclip/agent/ref.mp4")

    assert 1.9 <= seconds <= 2.1
    assert len(sample.frames) == 20
    assert {delivery.target for delivery in server.deliveries} == {"iclip/agent/ref.mp4"}
