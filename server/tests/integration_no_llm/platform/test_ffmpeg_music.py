"""用真实 ffmpeg 验证规整背景音乐：去掉首尾静音、统一响度、编成 48 kHz 双声道 AAC 的 m4a，交回
量出来的时长；没有声音、没有音轨与读不了的素材明确报错。"""

from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path

import pytest

from iclip.platform.media.ffmpeg import (
    MUSIC_LOUDNESS_LUFS,
    MediaError,
    ffmpeg_available,
    normalize_music,
)
from tests.helpers.media import synthesize_padded_music, synthesize_video

pytestmark = [
    pytest.mark.anyio,
    pytest.mark.skipif(not ffmpeg_available(), reason="本机 PATH 上没有 ffmpeg/ffprobe"),
]


def _streams(path: Path) -> list[dict[str, object]]:
    probe = subprocess.run(
        [
            "ffprobe", "-v", "error", "-show_entries",
            "stream=codec_type,codec_name,channels,sample_rate:format=format_name",
            "-of", "json", str(path),
        ],
        check=True,
        capture_output=True,
    )  # fmt: skip
    return json.loads(probe.stdout)["streams"]


def _loudness(path: Path) -> float:
    """量一个文件的综合响度（LUFS），用 ebur128 滤镜，与被测的 loudnorm 是两套实现。"""

    run = subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-nostats", "-i", str(path),
            "-af", "ebur128", "-f", "null", "-",
        ],
        check=True,
        capture_output=True,
    )  # fmt: skip
    found = re.findall(r"I:\s+(-?[\d.]+) LUFS", run.stderr.decode())
    return float(found[-1])


def _edge_volume(path: Path, *, at_end: bool) -> float:
    """开头或结尾 50 毫秒的平均电平（dB）；那里是静音时是 -91 左右。"""

    position = ["-sseof", "-0.05"] if at_end else []
    run = subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-nostats", *position, "-i", str(path),
            "-t", "0.05", "-af", "volumedetect", "-f", "null", "-",
        ],
        check=True,
        capture_output=True,
    )  # fmt: skip
    return float(re.findall(r"mean_volume: (-?[\d.]+) dB", run.stderr.decode())[-1])


async def test_leading_and_trailing_silence_is_cut_and_loudness_is_unified(tmp_path: Path) -> None:
    source = tmp_path / "generated.wav"
    synthesize_padded_music(source, lead=1.5, body=3.0, tail=2.0)
    dest = tmp_path / "music.m4a"

    duration_ms = await normalize_music(source, dest=dest)

    assert abs(duration_ms - 3000) <= 50, f"前 1.5 秒、后 2 秒的静音应该去掉，剩 {duration_ms} 毫秒"
    (stream,) = _streams(dest)
    assert (stream["codec_type"], stream["codec_name"]) == ("audio", "aac")
    assert (stream["channels"], stream["sample_rate"]) == (2, "48000")
    assert _edge_volume(dest, at_end=False) > -40, "开头就是音乐"
    assert _edge_volume(dest, at_end=True) > -40, "结尾就是音乐"
    assert abs(_loudness(dest) - MUSIC_LOUDNESS_LUFS) <= 1.0


async def test_quiet_and_loud_music_end_up_equally_loud(tmp_path: Path) -> None:
    quiet, loud = tmp_path / "quiet.wav", tmp_path / "loud.wav"
    synthesize_padded_music(quiet, lead=0.5, body=3.0, tail=0.5, volume=0.05)
    synthesize_padded_music(loud, lead=0.5, body=3.0, tail=0.5, volume=0.9)

    await normalize_music(quiet, dest=tmp_path / "quiet.m4a")
    await normalize_music(loud, dest=tmp_path / "loud.m4a")

    assert abs(_loudness(tmp_path / "quiet.m4a") - _loudness(tmp_path / "loud.m4a")) <= 1.0


async def test_music_without_silence_keeps_its_length(tmp_path: Path) -> None:
    source = tmp_path / "generated.wav"
    synthesize_padded_music(source, lead=0, body=2.0, tail=0)

    duration_ms = await normalize_music(source, dest=tmp_path / "music.m4a")

    assert abs(duration_ms - 2000) <= 50


async def test_all_silence_is_a_media_error(tmp_path: Path) -> None:
    """模型给回一段全是静音的音频：没有可以规整的声音，这次生成算失败。"""

    source = tmp_path / "silent.wav"
    synthesize_padded_music(source, lead=1.0, body=1.0, tail=1.0, volume=0)

    with pytest.raises(MediaError, match="没有声音"):
        await normalize_music(source, dest=tmp_path / "music.m4a")


async def test_a_file_without_an_audio_track_is_a_media_error(tmp_path: Path) -> None:
    source = tmp_path / "picture.mp4"
    synthesize_video(source, size="160x120", seconds=1, audio=False)

    with pytest.raises(MediaError, match="没有音轨"):
        await normalize_music(source, dest=tmp_path / "music.m4a")


async def test_a_file_that_is_not_media_is_a_media_error(tmp_path: Path) -> None:
    source = tmp_path / "broken.wav"
    source.write_bytes(b"not audio")

    with pytest.raises(MediaError, match="ffprobe 失败"):
        await normalize_music(source, dest=tmp_path / "music.m4a")


async def test_a_missing_source_is_a_media_error(tmp_path: Path) -> None:
    with pytest.raises(MediaError, match="不在"):
        await normalize_music(tmp_path / "gone.wav", dest=tmp_path / "music.m4a")
