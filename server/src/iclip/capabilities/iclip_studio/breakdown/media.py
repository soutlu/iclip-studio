"""用 ffmpeg 为拆解模型准备素材：读时长，抽帧，取音轨。"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Final

import httpx

from iclip.capabilities.iclip_studio.ports import SampledVideo
from iclip.platform.media.codec import MediaCodec
from iclip.platform.media.ffmpeg import (
    ENCODE_TIMEOUT_SECONDS,
    MAX_VIDEO_BYTES,
    PROBE_TIMEOUT_SECONDS,
    MediaError,
    fetched,
    probe_remote_duration_ms,
    run,
)

FRAME_FPS: Final = 10
"""每秒抽几帧。时间戳带一位小数，正好一帧一个。"""

FRAME_MAX_PIXELS: Final = 677_376
"""单帧像素上限，与发给模型的 ``image_pixel_limit`` 同值；超过的在抽帧时就缩小，只为减小请求体。"""

_SCALE: Final = (
    f"scale='if(gt(iw*ih,{FRAME_MAX_PIXELS}),trunc(iw*sqrt({FRAME_MAX_PIXELS}/(iw*ih))/2)*2,iw)':-2"
)


class FfmpegVideoSampler:
    """``VideoSampler`` 的 ffmpeg 实现，HTTP 客户端与编解码由组合根注入。"""

    def __init__(self, client: httpx.AsyncClient, codec: MediaCodec) -> None:
        self._client = client
        self._codec = codec

    async def duration_seconds(self, video_url: str) -> float:
        return await probe_remote_duration_ms(video_url) / 1000

    async def sample(self, video_url: str) -> SampledVideo:
        async with fetched(
            self._client, video_url, max_bytes=MAX_VIDEO_BYTES, suffix=".mp4"
        ) as source:
            return await sample_file(source, codec=self._codec)


async def sample_file(source: Path, *, codec: MediaCodec) -> SampledVideo:
    """一次解码同时抽帧与取音轨，解码用 ``codec`` 的选项；产物写在源文件旁边，随源文件的临时
    目录一起清理。"""

    out_dir = source.parent
    audio_path = out_dir / "audio.mp3"
    args = [
        "ffmpeg",
        "-v",
        "error",
        *codec.decode,
        "-i",
        str(source),
        "-vf",
        f"fps={FRAME_FPS},{_SCALE}",
        "-q:v",
        "4",
        "-f",
        "image2",
        str(out_dir / "f%06d.jpg"),
    ]
    has_audio = await _has_audio(source)
    if has_audio:
        # 没有音轨时再要一路音频输出，ffmpeg 会整条命令失败。
        args += ["-vn", "-c:a", "libmp3lame", "-b:a", "64k", str(audio_path)]
    await run(args, timeout=ENCODE_TIMEOUT_SECONDS)
    return await asyncio.to_thread(_read, out_dir, audio_path if has_audio else None)


async def _has_audio(source: Path) -> bool:
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
            "csv=p=0",
            str(source),
        ],
        timeout=PROBE_TIMEOUT_SECONDS,
    )
    return bool(stdout.strip())


def _read(out_dir: Path, audio_path: Path | None) -> SampledVideo:
    frames = tuple(path.read_bytes() for path in sorted(out_dir.glob("f*.jpg")))
    if not frames:
        raise MediaError("抽帧没产出任何帧")
    return SampledVideo(
        frames=frames, audio=audio_path.read_bytes() if audio_path is not None else None
    )


__all__ = ["FRAME_FPS", "FRAME_MAX_PIXELS", "FfmpegVideoSampler", "sample_file"]
