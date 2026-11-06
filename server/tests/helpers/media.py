from __future__ import annotations

import functools
import subprocess
from collections.abc import Sequence
from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory

import pytest
from PIL import Image

from iclip.platform.media.codec import (
    HARDWARE_CANDIDATES,
    SOFTWARE,
    TRIAL_TIMEOUT_SECONDS,
    MediaCodec,
)
from iclip.platform.media.probe import probe_duration_ms, probe_keyframes
from iclip.platform.media.process import PROBE_TIMEOUT_SECONDS, run

BROKEN_DECODE = MediaCodec(
    name="broken-decode",
    hardware=False,
    decode=("-hwaccel", "no-such-accel"),
    encode=SOFTWARE.encode,
    concurrency=1,
)


CODECS = {codec.name: codec for codec in (SOFTWARE, *HARDWARE_CANDIDATES)}


@functools.cache
def encodes_here(codec: MediaCodec) -> bool:
    result = subprocess.run(
        [
            "ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=256x256:rate=30",
            "-frames:v", "5", *codec.encode, "-f", "null", "-",
        ],
        stdin=subprocess.DEVNULL,
        capture_output=True,
        check=False,
        timeout=TRIAL_TIMEOUT_SECONDS,
    )  # fmt: skip
    return result.returncode == 0


def local_codec(name: str) -> MediaCodec:
    codec = CODECS[name]
    if codec.hardware and not encodes_here(codec):
        pytest.skip(f"本机用不了 {codec.name}")
    return codec


async def decode_all(content: bytes, codec: MediaCodec) -> None:
    with TemporaryDirectory(prefix="media-decode-") as tmp:
        path = Path(tmp) / "out.mp4"
        path.write_bytes(content)
        await run(
            ["ffmpeg", "-v", "error", *codec.decode, "-i", str(path), "-f", "null", "-"],
            timeout=PROBE_TIMEOUT_SECONDS,
        )


def synthesize_video(
    path: Path,
    *,
    size: str,
    seconds: int,
    audio: bool,
    faststart: bool = False,
    keyframes: Sequence[float] | None = None,
    flip_at: float | None = None,
) -> bytes:
    pattern = f"testsrc=size={size}:rate=10"
    if flip_at is not None:
        pattern += f",negate=enable='gte(t,{flip_at})'"
    args = ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", pattern]
    if audio:
        args += ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-c:a", "aac"]
    args += ["-t", str(seconds), "-pix_fmt", "yuv420p"]
    if keyframes is None:
        args += ["-g", "10"]
    else:
        args += ["-force_key_frames", ",".join(f"{time:.3f}" for time in keyframes)]
        args += ["-x264-params", "scenecut=0:keyint=infinite"]
    if faststart:
        args += ["-movflags", "+faststart"]
    args.append(str(path))
    subprocess.run(args, check=True, capture_output=True)
    return path.read_bytes()


def synthesize_noise(path: Path, *, seconds: int) -> bytes:
    subprocess.run(
        [
            "ffmpeg", "-v", "error", "-y",
            "-f", "rawvideo", "-pix_fmt", "yuv420p", "-s", "480x854", "-r", "25",
            "-i", "/dev/urandom", "-t", str(seconds),
            "-c:v", "libx264", "-preset", "ultrafast", "-g", "25", "-crf", "26",
            "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(path),
        ],
        check=True,
        capture_output=True,
    )  # fmt: skip
    return path.read_bytes()


def synthesize_padded_music(
    path: Path, *, lead: float, body: float, tail: float, volume: float = 0.3
) -> bytes:
    subprocess.run(
        [
            "ffmpeg", "-v", "error", "-y",
            "-f", "lavfi", "-i", f"anullsrc=r=48000:cl=stereo:d={lead}",
            "-f", "lavfi", "-i", f"sine=frequency=440:sample_rate=48000:duration={body}",
            "-f", "lavfi", "-i", f"anullsrc=r=48000:cl=stereo:d={tail}",
            "-filter_complex",
            f"[1:a]aformat=channel_layouts=stereo,volume={volume}[tone];"
            "[0:a][tone][2:a]concat=n=3:v=0:a=1",
            "-c:a", "pcm_s16le", str(path),
        ],
        check=True,
        capture_output=True,
    )  # fmt: skip
    return path.read_bytes()


@functools.cache
def has_subtitles_filter() -> bool:
    listing = subprocess.run(
        ["ffmpeg", "-hide_banner", "-filters"],
        stdin=subprocess.DEVNULL,
        capture_output=True,
        check=False,
        timeout=TRIAL_TIMEOUT_SECONDS,
    )
    return any(line.split()[1:2] == ["subtitles"] for line in listing.stdout.decode().splitlines())


async def duration_ms_of(content: bytes) -> int:
    with TemporaryDirectory(prefix="media-probe-") as tmp:
        path = Path(tmp) / "out.mp4"
        path.write_bytes(content)
        return await probe_duration_ms(path)


async def keyframes_of(content: bytes) -> list[float]:
    with TemporaryDirectory(prefix="media-probe-") as tmp:
        path = Path(tmp) / "out.mp4"
        path.write_bytes(content)
        return await probe_keyframes(path)


def multi_picture_jpeg(width: int = 1200, height: int = 1600) -> bytes:
    out = BytesIO()
    first = Image.new("RGB", (width, height), "white")
    first.save(out, format="MPO", save_all=True, append_images=[Image.new("RGB", (width, height))])
    return out.getvalue()


__all__ = [
    "BROKEN_DECODE",
    "CODECS",
    "decode_all",
    "duration_ms_of",
    "encodes_here",
    "has_subtitles_filter",
    "keyframes_of",
    "local_codec",
    "multi_picture_jpeg",
    "synthesize_noise",
    "synthesize_padded_music",
    "synthesize_video",
]
