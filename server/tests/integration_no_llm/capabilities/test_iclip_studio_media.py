"""用 ffmpeg 合成视频，验证拆解前的抽帧与取音轨。"""

from __future__ import annotations

from pathlib import Path

import pytest

from iclip.capabilities.iclip_studio.breakdown.media import FRAME_MAX_PIXELS, sample_file
from iclip.platform.media.ffmpeg import ffmpeg_available, run
from tests.helpers.media import synthesize_video

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


async def test_two_seconds_give_twenty_frames_and_the_audio_track(tmp_path: Path) -> None:
    source = tmp_path / "source.mp4"
    synthesize_video(source, size="320x240", seconds=2, audio=True)

    sample = await sample_file(source)

    assert len(sample.frames) == 20, "每秒 10 帧，第 i 帧对应 i/10 秒"
    assert sample.audio is not None
    assert await frame_size(sample.frames[0], tmp_path) == (320, 240), "不超上限的不缩"


async def test_a_silent_video_is_sampled_without_audio(tmp_path: Path) -> None:
    source = tmp_path / "source.mp4"
    synthesize_video(source, size="320x240", seconds=1, audio=False)

    sample = await sample_file(source)

    assert len(sample.frames) == 10
    assert sample.audio is None


async def test_frames_over_the_pixel_limit_are_scaled_down_keeping_the_aspect(
    tmp_path: Path,
) -> None:
    source = tmp_path / "source.mp4"
    synthesize_video(source, size="1080x1920", seconds=1, audio=False)

    sample = await sample_file(source)

    width, height = await frame_size(sample.frames[0], tmp_path)
    assert width * height <= FRAME_MAX_PIXELS
    assert (width, height) == (616, 1096)
