"""用真实 ffmpeg 合成测试素材、按档取编解码，供切片、合成与抽帧的集成测试共用；另有用 Pillow
生成的特殊格式图片。"""

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
from iclip.platform.media.ffmpeg import (
    PROBE_TIMEOUT_SECONDS,
    probe_duration_ms,
    probe_keyframes,
    run,
)

BROKEN_DECODE = MediaCodec(
    name="broken-decode",
    hardware=False,
    decode=("-hwaccel", "no-such-accel"),
    encode=SOFTWARE.encode,
    concurrency=1,
)
"""解码选项 ffmpeg 不认的一档：哪个视频输入带上了它，那条命令就失败。用来证明解码选项真交给了 ffmpeg。"""


CODECS = {codec.name: codec for codec in (SOFTWARE, *HARDWARE_CANDIDATES)}
"""每一档的名字，供测试按档参数化。"""


@functools.cache
def encodes_here(codec: MediaCodec) -> bool:
    """这一档的编码参数在本机编得出东西：有这块硬件、驱动认这些参数。

    只问「编不编得了」，不看关键帧：编得了的档就该守关键帧的规矩，由按档参数化的合成测试核对。"""

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
    """按名字取一档；硬件档在本机编不了就跳过这条测试。"""

    codec = CODECS[name]
    if codec.hardware and not encodes_here(codec):
        pytest.skip(f"本机用不了 {codec.name}")
    return codec


async def decode_all(content: bytes, codec: MediaCodec) -> None:
    """用 ``codec`` 的解码选项把一段视频字节整条解一遍；解不了抛 MediaError。"""

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
    """合成一段 10 fps 的图样视频。关键帧默认每秒一个，裁剪落到的边界才可预期。

    ``keyframes`` 给了就只在这些时刻放关键帧，编码器自己不再插。``flip_at`` 让画面从这一刻
    起整体反相：一次编码器会当成场景切换的突变。默认照 ffmpeg 的缺省把 moov 写在尾部，和
    不少上传素材一样；``faststart`` 把它挪到头部。"""

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
    """合成一段随机噪声视频。压不动，所以几十兆，按需读省下多少一眼能看出来。"""

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
    """合成一段前后带静音的 48 kHz 双声道 wav：``lead`` 秒静音、``body`` 秒 440 Hz 的音、``tail``
    秒静音，像音乐模型给回来的那种。``volume`` 是那段音的线性音量，用来造一段偏轻的音乐。"""

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


async def duration_ms_of(content: bytes) -> int:
    """量一段视频字节的时长（毫秒），与服务端用的是同一个探测。"""

    with TemporaryDirectory(prefix="media-probe-") as tmp:
        path = Path(tmp) / "out.mp4"
        path.write_bytes(content)
        return await probe_duration_ms(path)


async def keyframes_of(content: bytes) -> list[float]:
    """读一段视频字节的关键帧时刻（秒），与服务端用的是同一个探测。"""

    with TemporaryDirectory(prefix="media-probe-") as tmp:
        path = Path(tmp) / "out.mp4"
        path.write_bytes(content)
        return await probe_keyframes(path)


def multi_picture_jpeg(width: int = 1200, height: int = 1600) -> bytes:
    """两帧的 MPO：手机、相机拍的 JPEG 常带这种多帧扩展，Pillow 认成 MPO。"""

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
    "keyframes_of",
    "local_codec",
    "multi_picture_jpeg",
    "synthesize_noise",
    "synthesize_padded_music",
    "synthesize_video",
]
