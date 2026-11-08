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

FRAME_MAX_PIXELS: Final = 677_376

_SCALE: Final = (
    f"scale='if(gt(iw*ih,{FRAME_MAX_PIXELS}),trunc(iw*sqrt({FRAME_MAX_PIXELS}/(iw*ih))/2)*2,iw)':-2"
)


class FfmpegVideoSampler:
    def __init__(self, downloads: MediaDownloads, codec: MediaCodec) -> None:
        self._downloads = downloads
        self._codec = codec

    async def sample_up_to(self, video_url: str, *, max_seconds: float) -> SampledVideo | None:
        client, url = self._downloads.target(video_url)
        if self._downloads.owns(video_url):
            if await probe_remote_duration_ms(url) > max_seconds * 1000:
                return None
            async with fetched(client, url, max_bytes=MAX_VIDEO_BYTES, suffix=".mp4") as source:
                return await sample_file(source, codec=self._codec)
        # ffprobe 会自行跟随 HTTP 重定向而绕过出网防护，非本桶地址须先经防护下载至本地再探测时长。
        async with fetched(client, url, max_bytes=MAX_VIDEO_BYTES, suffix=".mp4") as source:
            if await probe_duration_ms(source) > max_seconds * 1000:
                return None
            return await sample_file(source, codec=self._codec)


async def sample_file(source: Path, *, codec: MediaCodec) -> SampledVideo:
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
