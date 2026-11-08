from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Final

from iclip.platform.media.errors import MediaError, NoAudioStream
from iclip.platform.media.fetch import MAX_AUDIO_BYTES, MAX_VIDEO_BYTES
from iclip.platform.media.probe import has_audio_stream, probe_duration_ms
from iclip.platform.media.process import ENCODE_TIMEOUT_SECONDS, check_output, communicate, run

AUDIO_CODEC: Final = ("-c:a", "aac", "-b:a", "192k")
AUDIO_RATE: Final = 48000
AUDIO_LAYOUT: Final = "stereo"

SPEECH_SAMPLE_RATE: Final = 16000
SPEECH_BITRATE: Final = "64k"

MUSIC_SILENCE_THRESHOLD_DB: Final = -50
MUSIC_LOUDNESS_LUFS: Final = -16.0
MUSIC_TRUE_PEAK_DBTP: Final = -1.5
MUSIC_LOUDNESS_RANGE: Final = 11.0

# FFmpeg silenceremove 的 stop_periods 会误删曲中停顿，故通过反转音频再次裁剪头部来去除尾部静音。
_TRIM_MUSIC_SILENCE: Final = (
    f"silenceremove=start_periods=1:start_threshold={MUSIC_SILENCE_THRESHOLD_DB}dB,"
    "areverse,"
    f"silenceremove=start_periods=1:start_threshold={MUSIC_SILENCE_THRESHOLD_DB}dB,"
    "areverse"
)

_LOUDNESS_KEYS: Final = ("input_i", "input_tp", "input_lra", "input_thresh", "target_offset")


async def extract_speech_audio(source: Path, *, dest: Path) -> None:
    if not source.is_file():
        raise MediaError(f"要抽音频的素材不在: {source.name}")
    if not await has_audio_stream(source):
        raise NoAudioStream(f"这条素材里没有音轨: {source.name}")
    await run(
        [
            "ffmpeg", "-v", "error", "-y", "-i", str(source),
            "-map", "0:a:0", "-vn", "-ac", "1", "-ar", str(SPEECH_SAMPLE_RATE),
            "-c:a", "libmp3lame", "-b:a", SPEECH_BITRATE, "-f", "mp3", str(dest),
        ],
        timeout=ENCODE_TIMEOUT_SECONDS,
    )  # fmt: skip
    check_output(dest, max_bytes=MAX_VIDEO_BYTES)


async def normalize_music(source: Path, *, dest: Path) -> int:
    if not source.is_file():
        raise MediaError(f"要规整的音频不在: {source.name}")
    if not await has_audio_stream(source):
        raise NoAudioStream(f"这段素材里没有音轨: {source.name}")
    measured = await _measure_music_loudness(source)
    loudnorm = (
        f"loudnorm=I={MUSIC_LOUDNESS_LUFS}:TP={MUSIC_TRUE_PEAK_DBTP}:LRA={MUSIC_LOUDNESS_RANGE}"
        f":measured_I={measured['input_i']}:measured_TP={measured['input_tp']}"
        f":measured_LRA={measured['input_lra']}:measured_thresh={measured['input_thresh']}"
        f":offset={measured['target_offset']}:linear=true"
    )
    # FFmpeg loudnorm 滤镜会将采样率升至 192 kHz，需显式重采样回 48 kHz；输出 AAC 以避免 MP3 编码器头部延迟导致音画偏移。
    await run(
        [
            "ffmpeg", "-v", "error", "-y", "-i", str(source), "-map", "0:a:0", "-vn",
            "-af", f"{_TRIM_MUSIC_SILENCE},{loudnorm},aresample={AUDIO_RATE}",
            "-ac", "2", "-ar", str(AUDIO_RATE), *AUDIO_CODEC,
            "-movflags", "+faststart", str(dest),
        ],
        timeout=ENCODE_TIMEOUT_SECONDS,
    )  # fmt: skip
    check_output(dest, max_bytes=MAX_AUDIO_BYTES)
    return await probe_duration_ms(dest)


async def _measure_music_loudness(source: Path) -> dict[str, float]:
    measured = await _loudnorm_measure(
        source,
        f"{_TRIM_MUSIC_SILENCE},loudnorm=I={MUSIC_LOUDNESS_LUFS}"
        f":TP={MUSIC_TRUE_PEAK_DBTP}:LRA={MUSIC_LOUDNESS_RANGE}:print_format=json",
    )
    if not all(math.isfinite(value) for value in measured.values()):
        raise MediaError("这段音频去掉首尾静音后没有声音")
    return measured


async def _loudnorm_measure(source: Path, audio_filter: str) -> dict[str, float]:
    _, stderr = await communicate(
        [
            "ffmpeg", "-hide_banner", "-nostats", "-i", str(source), "-map", "0:a:0", "-vn",
            "-af", audio_filter, "-f", "null", "-",
        ],
        timeout=ENCODE_TIMEOUT_SECONDS,
    )  # fmt: skip
    text = stderr.decode(errors="replace")
    start, end = text.rfind("{"), text.rfind("}")
    try:
        report = json.loads(text[start : end + 1]) if 0 <= start < end else None
        measured = {key: float(report[key]) for key in _LOUDNESS_KEYS} if report else None
    except (ValueError, KeyError, TypeError) as exc:
        raise MediaError("loudnorm 的测量结果看不懂") from exc
    if measured is None:
        raise MediaError("loudnorm 没有给出测量结果")
    return measured


__all__ = [
    "AUDIO_CODEC",
    "AUDIO_LAYOUT",
    "AUDIO_RATE",
    "MUSIC_LOUDNESS_LUFS",
    "MUSIC_LOUDNESS_RANGE",
    "MUSIC_SILENCE_THRESHOLD_DB",
    "MUSIC_TRUE_PEAK_DBTP",
    "SPEECH_BITRATE",
    "SPEECH_SAMPLE_RATE",
    "extract_speech_audio",
    "normalize_music",
]
