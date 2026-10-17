"""用真实 ffmpeg 验证给语音识别抽音频：多声道混成单声道 16 kHz mp3，没有音轨与读不了的素材明确报错。"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

from iclip.platform.media.audio import extract_speech_audio
from iclip.platform.media.errors import MediaError, NoAudioStream
from iclip.platform.media.process import ffmpeg_available
from tests.helpers.media import synthesize_video

pytestmark = [
    pytest.mark.anyio,
    pytest.mark.skipif(not ffmpeg_available(), reason="本机 PATH 上没有 ffmpeg/ffprobe"),
]


def _stereo_video(path: Path) -> None:
    """一段带双声道音轨（左右声道频率不同）的 2 秒视频，采样率 48 kHz。"""

    subprocess.run(
        [
            "ffmpeg", "-v", "error", "-y",
            "-f", "lavfi", "-i", "testsrc=size=160x120:rate=10",
            "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
            "-f", "lavfi", "-i", "sine=frequency=660:sample_rate=48000",
            "-filter_complex", "[1:a][2:a]join=inputs=2:channel_layout=stereo[a]",
            "-map", "0:v", "-map", "[a]", "-c:a", "aac",
            "-t", "2", "-pix_fmt", "yuv420p", str(path),
        ],
        check=True,
        capture_output=True,
    )  # fmt: skip


def _audio_streams(path: Path) -> list[dict[str, object]]:
    probe = subprocess.run(
        [
            "ffprobe", "-v", "error", "-show_entries",
            "stream=codec_type,codec_name,channels,sample_rate", "-of", "json", str(path),
        ],
        check=True,
        capture_output=True,
    )  # fmt: skip
    return json.loads(probe.stdout)["streams"]


async def test_a_stereo_track_comes_out_as_mono_16k_mp3(tmp_path: Path) -> None:
    source = tmp_path / "stereo.mp4"
    _stereo_video(source)
    assert _audio_streams(source)[-1]["channels"] == 2, "样本自己得是双声道，否则测不出混音"
    dest = tmp_path / "speech.mp3"

    await extract_speech_audio(source, dest=dest)

    (stream,) = _audio_streams(dest)
    assert (stream["codec_type"], stream["codec_name"]) == ("audio", "mp3")
    assert (stream["channels"], stream["sample_rate"]) == (1, "16000")


async def test_a_video_without_audio_is_reported_as_no_audio_stream(tmp_path: Path) -> None:
    """没有音轨单独一种错：调用方要据此记「没有口播」，不能和处理失败混在一起。"""

    source = tmp_path / "silent.mp4"
    synthesize_video(source, size="160x120", seconds=1, audio=False)
    dest = tmp_path / "speech.mp3"

    with pytest.raises(NoAudioStream):
        await extract_speech_audio(source, dest=dest)
    assert not dest.exists()


async def test_a_file_that_is_not_media_is_a_media_error(tmp_path: Path) -> None:
    source = tmp_path / "broken.mp4"
    source.write_bytes(b"not a video")

    with pytest.raises(MediaError, match="ffprobe 失败") as raised:
        await extract_speech_audio(source, dest=tmp_path / "speech.mp3")
    assert not isinstance(raised.value, NoAudioStream), "读不了不是「没有音轨」"


async def test_a_missing_source_is_a_media_error(tmp_path: Path) -> None:
    with pytest.raises(MediaError, match="不在"):
        await extract_speech_audio(tmp_path / "gone.mp4", dest=tmp_path / "speech.mp3")
