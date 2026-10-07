"""用真实 ffprobe 验证读关键帧：读得出素材原有的关键帧，读不了的素材报 MediaError。"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from iclip.platform.media.ffmpeg import MediaError, ffmpeg_available, probe_keyframes
from tests.helpers.media import synthesize_video

pytestmark = [
    pytest.mark.anyio,
    pytest.mark.skipif(not ffmpeg_available(), reason="本机 PATH 上没有 ffmpeg/ffprobe"),
]


async def test_reads_the_keyframes_a_video_was_encoded_with(tmp_path: Path) -> None:
    """带音轨的素材也一样：时刻与裁剪用的是同一条时间轴，从 0 起。"""

    path = tmp_path / "keyed.mp4"
    synthesize_video(path, size="160x120", seconds=3, audio=True, keyframes=[0, 0.7, 2.1])

    assert await probe_keyframes(path) == pytest.approx([0, 0.7, 2.1], abs=1e-6)


async def test_a_file_without_a_video_stream_is_a_media_error(tmp_path: Path) -> None:
    path = tmp_path / "sound.m4a"
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "sine", "-t", "1", str(path)],
        check=True,
        capture_output=True,
    )

    with pytest.raises(MediaError, match="没有视频流"):
        await probe_keyframes(path)


async def test_a_file_that_is_not_media_is_a_media_error(tmp_path: Path) -> None:
    path = tmp_path / "broken.mp4"
    path.write_bytes(b"not a video")

    with pytest.raises(MediaError, match="ffprobe 失败"):
        await probe_keyframes(path)
