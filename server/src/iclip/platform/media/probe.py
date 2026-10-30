from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Final

from agent_runtime.urls import is_http_url

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


@dataclass(frozen=True, slots=True)
class VideoProfile:
    width: int
    height: int
    frame_rate: str
    """ffprobe 的分数写法，如 ``30000/1001``，fps 滤镜原样收。"""

    has_audio: bool


async def probe_duration_ms(path: Path) -> int:
    stdout = await run(
        ["ffprobe", "-v", "error", *_PROBE_DURATION, str(path)], timeout=PROBE_TIMEOUT_SECONDS
    )
    return _duration_ms(stdout)


async def probe_remote_duration_ms(url: str) -> int:
    return _duration_ms(await _run_remote(_PROBE_DURATION, url))


async def _run_remote(entries: tuple[str, ...], url: str) -> bytes:
    if not is_http_url(url):
        raise MediaError(f"要探的地址不是 http(s): {without_query(url)}")
    try:
        return await run(
            ["ffprobe", "-v", "error", *REMOTE_INPUT, *entries, url],
            timeout=PROBE_TIMEOUT_SECONDS,
        )
    except MediaError as exc:
        raise MediaError(str(exc).replace(url, without_query(url))) from exc


def _duration_ms(stdout: bytes) -> int:
    text = stdout.decode(errors="replace").strip()
    try:
        seconds = float(text)
    except ValueError as exc:
        raise MediaError(f"ffprobe 报的时长看不懂: {text!r}") from exc
    if seconds <= 0:
        raise MediaError(f"ffprobe 报的时长不是正数: {seconds}")
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
        raise MediaError("ffprobe 的流信息看不懂") from exc
    video = next((item for item in streams if item.get("codec_type") == "video"), None)
    if video is None:
        raise MediaError(f"这条素材里没有视频流: {name}")
    width, height = video.get("width"), video.get("height")
    if not isinstance(width, int) or not isinstance(height, int) or width <= 0 or height <= 0:
        raise MediaError(f"ffprobe 报的画幅看不懂: {width!r}×{height!r}")
    rate = video.get("r_frame_rate")
    if not isinstance(rate, str) or not _positive_fraction(rate):
        raise MediaError(f"ffprobe 报的帧率看不懂: {rate!r}")
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
    # 时刻减去了容器的 start_time：ffmpeg 的 trim 与 -ss 也从那里算起。
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
        raise MediaError("ffprobe 的关键帧信息看不懂") from exc
    if not streams:
        raise MediaError(f"这条素材里没有视频流: {path.name}")
    if not keyframes:
        raise MediaError(f"这条素材的视频流里没有关键帧: {path.name}")
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
        raise MediaError("ffprobe 的音轨信息看不懂") from exc
    return isinstance(streams, list) and len(streams) > 0


__all__ = [
    "VideoProfile",
    "has_audio_stream",
    "probe_duration_ms",
    "probe_keyframes",
    "probe_remote_duration_ms",
    "probe_video",
]
