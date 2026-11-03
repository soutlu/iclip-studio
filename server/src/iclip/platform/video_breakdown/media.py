"""用 ffmpeg 为拆解模型准备素材：读时长，抽帧，取音轨。"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Final

from iclip.platform.media.codec import MediaCodec
from iclip.platform.media.errors import MediaError
from iclip.platform.media.fetch import MAX_VIDEO_BYTES, MediaDownloads, fetched
from iclip.platform.media.probe import (
    has_audio_stream,
    probe_duration_ms,
    probe_remote_duration_ms,
)
from iclip.platform.media.process import ENCODE_TIMEOUT_SECONDS, run
from iclip.platform.video_breakdown.ports import SampledVideo

FRAME_FPS: Final = 10
"""每秒抽几帧。时间戳带一位小数，正好一帧一个。"""

FRAME_MAX_PIXELS: Final = 677_376
"""单帧像素上限，与发给模型的 ``image_pixel_limit`` 同值；超过的在抽帧时就缩小，只为减小请求体。"""

_SCALE: Final = (
    f"scale='if(gt(iw*ih,{FRAME_MAX_PIXELS}),trunc(iw*sqrt({FRAME_MAX_PIXELS}/(iw*ih))/2)*2,iw)':-2"
)


class FfmpegVideoSampler:
    """``VideoSampler`` 的 ffmpeg 实现，下载选路与编解码由组合根注入。

    ``downloads`` 只用在本服务自己探时长与下载的那一刻；交给拆解模型的地址不经过这里，仍是原地址。"""

    def __init__(self, downloads: MediaDownloads, codec: MediaCodec) -> None:
        self._downloads = downloads
        self._codec = codec

    async def sample_up_to(self, video_url: str, *, max_seconds: float) -> SampledVideo | None:
        client, url = self._downloads.target(video_url)
        if self._downloads.owns(video_url):
            # 本桶对象：ffprobe 在换过的地址上直接探时长、不下载整片，短的才下载抽帧。
            if await probe_remote_duration_ms(url) > max_seconds * 1000:
                return None
            async with fetched(client, url, max_bytes=MAX_VIDEO_BYTES, suffix=".mp4") as source:
                return await sample_file(source, codec=self._codec)
        # 别的地址不交给 ffprobe：它自己跟跳转，绕得过出网防护。先经防护下载，时长在本地文件上探。
        async with fetched(client, url, max_bytes=MAX_VIDEO_BYTES, suffix=".mp4") as source:
            if await probe_duration_ms(source) > max_seconds * 1000:
                return None
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
    has_audio = await has_audio_stream(source)
    if has_audio:
        # 没有音轨时再要一路音频输出，ffmpeg 会整条命令失败。
        args += ["-vn", "-c:a", "libmp3lame", "-b:a", "64k", str(audio_path)]
    await run(args, timeout=ENCODE_TIMEOUT_SECONDS)
    return await asyncio.to_thread(_read, out_dir, audio_path if has_audio else None)


def _read(out_dir: Path, audio_path: Path | None) -> SampledVideo:
    frames = tuple(path.read_bytes() for path in sorted(out_dir.glob("f*.jpg")))
    if not frames:
        raise MediaError("抽帧没产出任何帧")
    return SampledVideo(
        frames=frames, audio=audio_path.read_bytes() if audio_path is not None else None
    )


__all__ = ["FRAME_FPS", "FRAME_MAX_PIXELS", "FfmpegVideoSampler", "sample_file"]
