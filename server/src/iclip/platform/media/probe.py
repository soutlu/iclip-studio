from __future__ import annotations

import json
from array import array
from dataclasses import dataclass
from pathlib import Path
from typing import Final

from iclip.common.urls import is_http_url
from iclip.platform.media.errors import MediaError
from iclip.platform.media.fetch import REMOTE_INPUT, without_query
from iclip.platform.media.process import PROBE_TIMEOUT_SECONDS, run

_PROBE_DURATION: Final = (
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
)
_PROBE_STREAMS: Final = (
    "-show_entries",
    "stream=codec_type,width,height,r_frame_rate",
    "-of",
    "json",
)


# 量音频要下载并解码整个文件，比只读文件头的探测慢；调用方的请求在等它，所以给个有限的上限。
_MEASURE_TIMEOUT_SECONDS: Final = 120.0

# 波形只看包络，解成 8 kHz 单声道 16 位采样就够；十分钟的音频解出来约 9.6 MB。
_LEVELS_SAMPLE_RATE: Final = 8000


@dataclass(frozen=True, slots=True)
class AudioLevels:
    duration_ms: int
    peaks: tuple[float, ...]


@dataclass(frozen=True, slots=True)
class VideoProfile:
    width: int
    height: int
    frame_rate: str

    has_audio: bool


async def probe_duration_ms(path: Path) -> int:
    stdout = await run(
        ["ffprobe", "-v", "error", *_PROBE_DURATION, str(path)], timeout=PROBE_TIMEOUT_SECONDS
    )
    return _duration_ms(stdout)


async def probe_remote_duration_ms(url: str) -> int:
    command = ["ffprobe", "-v", "error", *REMOTE_INPUT, *_PROBE_DURATION, url]
    return _duration_ms(await _run_remote(command, url, timeout=PROBE_TIMEOUT_SECONDS))


async def measure_remote_audio(url: str, *, buckets: int) -> AudioLevels:
    """把地址上的音频解码一遍，量出时长（按解出的采样数算）与 ``buckets`` 个波形峰值：每段取采样
    绝对值的最大值，按最响的一段归一到 1，保留 3 位小数；全程静音时全是 0。不是音频、没有音轨或解
    不出采样抛 ``MediaError``。"""

    command = [
        "ffmpeg", "-v", "error", *REMOTE_INPUT, "-i", url,
        "-map", "0:a:0", "-vn", "-ac", "1", "-ar", str(_LEVELS_SAMPLE_RATE), "-f", "s16le", "-",
    ]  # fmt: skip
    pcm = await _run_remote(command, url, timeout=_MEASURE_TIMEOUT_SECONDS)
    samples = array("h")
    samples.frombytes(pcm[: len(pcm) - len(pcm) % samples.itemsize])
    if not samples:
        raise MediaError(f"音频解不出采样：{without_query(url)}")
    return AudioLevels(
        duration_ms=round(len(samples) * 1000 / _LEVELS_SAMPLE_RATE),
        peaks=_peaks(samples, buckets),
    )


def _peaks(samples: array[int], buckets: int) -> tuple[float, ...]:
    count = len(samples)
    levels: list[int] = []
    for index in range(buckets):
        chunk = samples[index * count // buckets : (index + 1) * count // buckets]
        levels.append(max(max(chunk), -min(chunk)) if chunk else 0)
    loudest = max(levels)
    if loudest == 0:
        return (0.0,) * buckets
    return tuple(round(level / loudest, 3) for level in levels)


async def _run_remote(command: list[str], url: str, *, timeout: float) -> bytes:
    """跑一条读 ``url`` 的 ffmpeg / ffprobe 命令：先核对地址，报错里的地址去掉查询串（签名）。"""

    if not is_http_url(url):
        raise MediaError(f"待探测的地址不是有效的 http(s) URL：{without_query(url)}")
    try:
        return await run(command, timeout=timeout)
    except MediaError as exc:
        raise MediaError(str(exc).replace(url, without_query(url))) from exc


def _duration_ms(stdout: bytes) -> int:
    text = stdout.decode(errors="replace").strip()
    try:
        seconds = float(text)
    except ValueError as exc:
        raise MediaError(f"无法解析媒体时长：{text!r}") from exc
    if seconds <= 0:
        raise MediaError(f"媒体时长无效：{seconds}")
    return round(seconds * 1000)


async def probe_video(path: Path) -> VideoProfile:
    stdout = await run(
        ["ffprobe", "-v", "error", *_PROBE_STREAMS, str(path)], timeout=PROBE_TIMEOUT_SECONDS
    )
    return _video_profile(stdout, path.name)


def _video_profile(stdout: bytes, name: str) -> VideoProfile:
    try:
        streams = json.loads(stdout)["streams"]
    except (ValueError, KeyError, TypeError) as exc:
        raise MediaError("无法解析媒体流信息") from exc
    video = next((item for item in streams if item.get("codec_type") == "video"), None)
    if video is None:
        raise MediaError(f"该素材不包含视频流：{name}")
    width, height = video.get("width"), video.get("height")
    if not isinstance(width, int) or not isinstance(height, int) or width <= 0 or height <= 0:
        raise MediaError(f"无法解析媒体分辨率：{width!r}×{height!r}")
    rate = video.get("r_frame_rate")
    if not isinstance(rate, str) or not _positive_fraction(rate):
        raise MediaError(f"无法解析媒体帧率：{rate!r}")
    return VideoProfile(
        width=width,
        height=height,
        frame_rate=rate,
        has_audio=any(item.get("codec_type") == "audio" for item in streams),
    )


def _positive_fraction(value: str) -> bool:
    numerator, _, denominator = value.partition("/")
    try:
        return float(numerator) > 0 and float(denominator or 1) > 0
    except ValueError:
        return False


async def probe_keyframes(path: Path) -> list[float]:
    stdout = await run(
        [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=index:packet=pts_time,flags:format=start_time",
            "-of",
            "json",
            str(path),
        ],
        timeout=PROBE_TIMEOUT_SECONDS,
    )
    try:
        report = json.loads(stdout)
        streams = report["streams"]
        packets = report["packets"]
        start = float(report["format"].get("start_time", 0))
        keyframes = sorted(
            float(packet["pts_time"]) - start
            for packet in packets
            if "K" in packet.get("flags", "")
        )
    except (ValueError, KeyError, TypeError, AttributeError) as exc:
        raise MediaError("无法解析视频关键帧信息") from exc
    if not streams:
        raise MediaError(f"该素材不包含视频流：{path.name}")
    if not keyframes:
        raise MediaError(f"该素材的视频流不包含关键帧：{path.name}")
    return keyframes


async def has_audio_stream(path: Path) -> bool:
    stdout = await run(
        [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "a",
            "-show_entries",
            "stream=index",
            "-of",
            "json",
            str(path),
        ],
        timeout=PROBE_TIMEOUT_SECONDS,
    )
    try:
        streams = json.loads(stdout)["streams"]
    except (ValueError, KeyError, TypeError) as exc:
        raise MediaError("无法解析媒体音轨信息") from exc
    return isinstance(streams, list) and len(streams) > 0


__all__ = [
    "AudioLevels",
    "VideoProfile",
    "has_audio_stream",
    "measure_remote_audio",
    "probe_duration_ms",
    "probe_keyframes",
    "probe_remote_duration_ms",
    "probe_video",
]
