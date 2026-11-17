from __future__ import annotations

import json
import math
from collections.abc import Sequence
from dataclasses import dataclass
from itertools import pairwise
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

# concat 要求各段的采样格式一致；静音段和变速段统一到同一种浮点格式。
_UNIFORM: Final = (
    f"aformat=sample_fmts=fltp:sample_rates={AUDIO_RATE}:channel_layouts={AUDIO_LAYOUT}"
)


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


async def extract_audio_clip(source: Path, *, dest: Path, start_ms: int, duration_ms: int) -> None:
    """从 ``source`` 的第一条音轨截 ``[start_ms, start_ms + duration_ms)`` 一段，存成单声道 16 位
    PCM 的 WAV（``AUDIO_RATE``）。没有音轨抛 ``NoAudioStream``。"""

    if not source.is_file():
        raise MediaError(f"要截音频的素材不在: {source.name}")
    if not await has_audio_stream(source):
        raise NoAudioStream(f"这条素材里没有音轨: {source.name}")
    await run(
        [
            "ffmpeg", "-v", "error", "-y",
            "-ss", f"{start_ms / 1000:.3f}", "-t", f"{duration_ms / 1000:.3f}", "-i", str(source),
            "-map", "0:a:0", "-vn", "-ac", "1", "-ar", str(AUDIO_RATE),
            "-c:a", "pcm_s16le", "-f", "wav", str(dest),
        ],
        timeout=ENCODE_TIMEOUT_SECONDS,
    )  # fmt: skip
    check_output(dest, max_bytes=MAX_AUDIO_BYTES)


async def decode_audio(source: Path, *, dest: Path) -> int:
    """把一段任意格式的音频解码成立体声 16 位 PCM 的 WAV（``AUDIO_RATE``），返回解码后的时长（毫秒）。
    不是音频、没有音轨抛 ``MediaError``。"""

    if not source.is_file():
        raise MediaError(f"要解码的音频不在: {source.name}")
    if not await has_audio_stream(source):
        raise NoAudioStream(f"这段音频里没有音轨: {source.name}")
    await run(
        [
            "ffmpeg", "-v", "error", "-y", "-i", str(source), "-map", "0:a:0", "-vn",
            "-ac", "2", "-ar", str(AUDIO_RATE), "-c:a", "pcm_s16le", "-f", "wav", str(dest),
        ],
        timeout=ENCODE_TIMEOUT_SECONDS,
    )  # fmt: skip
    check_output(dest, max_bytes=MAX_AUDIO_BYTES)
    return await probe_duration_ms(dest)


@dataclass(frozen=True, slots=True)
class AudioPlacement:
    """音轨上的一段：``clip`` 放在 ``start_ms``，占到 ``start_ms + length_ms``；先按 ``speed`` 变速，
    长出的截掉、短的补静音；``fade_out_ms`` 大于 0 时在这一段的结尾淡出。"""

    clip: Path
    start_ms: int
    length_ms: int
    speed: float = 1.0
    fade_out_ms: int = 0


async def lay_audio_track(
    placements: Sequence[AudioPlacement], *, total_ms: int, dest: Path
) -> int:
    """把几段音频按位置铺成一条 ``total_ms`` 长的音轨（没铺到的地方是静音），编码同背景音乐（AAC、
    立体声、``AUDIO_RATE``），返回成品的时长（毫秒）。

    ``placements`` 要按 ``start_ms`` 排好、互不重叠，都在 ``total_ms`` 以内；段与段之间、最后一段
    之后补静音。长度按采样点数截、补，所以成品的长度只差 AAC 编码的分帧。"""

    if not placements:
        raise ValueError("没有要铺的音频")
    for current, following in pairwise(placements):
        if current.start_ms + current.length_ms > following.start_ms:
            raise ValueError("要铺的音频重叠或没按开始排好")
    end_ms = placements[-1].start_ms + placements[-1].length_ms
    if end_ms > total_ms:
        raise ValueError("要铺的音频超出了音轨结尾")
    chains: list[str] = []
    labels: list[str] = []

    def silence(ms: int, name: str) -> None:
        samples = _samples(ms)
        if samples > 0:
            source = f"anullsrc=r={AUDIO_RATE}:cl={AUDIO_LAYOUT},atrim=end_sample={samples}"
            chains.append(f"{source},{_UNIFORM}[{name}]")
            labels.append(f"[{name}]")

    inputs: list[str] = []
    cursor_ms = 0
    for index, placement in enumerate(placements):
        silence(placement.start_ms - cursor_ms, f"gap{index}")
        cursor_ms = placement.start_ms + placement.length_ms
        length = _samples(placement.length_ms)
        steps = [_UNIFORM]
        if placement.speed != 1.0:
            steps.append(f"atempo={placement.speed:.4f}")
        steps.append(f"atrim=end_sample={length}")
        fade = min(_samples(placement.fade_out_ms), length)
        if fade > 0:
            steps.append(f"afade=t=out:start_sample={length - fade}:nb_samples={fade}")
        steps += [f"apad=whole_len={length}", _UNIFORM]
        chains.append(f"[{index}:a]{','.join(steps)}[c{index}]")
        labels.append(f"[c{index}]")
        inputs += ["-i", str(placement.clip)]
    silence(total_ms - end_ms, "tail")
    chains.append(f"{''.join(labels)}concat=n={len(labels)}:v=0:a=1[out]")
    await run(
        [
            "ffmpeg", "-v", "error", "-y", *inputs,
            "-filter_complex", ";".join(chains), "-map", "[out]",
            "-ac", "2", "-ar", str(AUDIO_RATE), *AUDIO_CODEC, "-movflags", "+faststart", str(dest),
        ],
        timeout=ENCODE_TIMEOUT_SECONDS,
    )  # fmt: skip
    check_output(dest, max_bytes=MAX_AUDIO_BYTES)
    return await probe_duration_ms(dest)


def _samples(ms: int) -> int:
    return ms * AUDIO_RATE // 1000


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
    "AudioPlacement",
    "decode_audio",
    "extract_audio_clip",
    "extract_speech_audio",
    "lay_audio_track",
    "normalize_music",
]
