from __future__ import annotations

import subprocess
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Final

import structlog

_logger = structlog.stdlib.get_logger(__name__)

_STDERR_LIMIT = 400


@dataclass(frozen=True, slots=True)
class MediaCodec:
    name: str
    hardware: bool
    decode: tuple[str, ...]

    encode: tuple[str, ...]

    concurrency: int


SOFTWARE: Final = MediaCodec(
    name="software",
    hardware=False,
    decode=(),
    encode=(
        "-c:v", "libx264", "-preset", "medium", "-crf", "16", "-pix_fmt", "yuv420p",
        "-forced-idr", "1",
        # FFmpeg -g 仅接受有限整数，需通过 -x264-params keyint=infinite:scenecut=0 禁用自动关键帧。
        "-x264-params", "scenecut=0:keyint=infinite",
    ),
    concurrency=2,
)  # fmt: skip

VIDEOTOOLBOX: Final = MediaCodec(
    name="videotoolbox",
    hardware=True,
    decode=("-hwaccel", "videotoolbox"),
    # VideoToolbox -q:v 仅支持 Apple Silicon（Intel Mac 会报错回退）；-g 设为 INT32_MAX 以关闭默认 12 帧的 GOP 上限。
    encode=(
        "-c:v", "h264_videotoolbox", "-q:v", "80", "-g", "2147483647", "-pix_fmt", "yuv420p",
    ),
    concurrency=4,
)  # fmt: skip

NVENC: Final = MediaCodec(
    name="nvenc",
    hardware=True,
    # 不设置 -hwaccel_output_format cuda，使解码帧自动拷回内存以供后续 CPU 滤镜处理。
    decode=("-hwaccel", "cuda"),
    encode=(
        "-c:v", "h264_nvenc", "-preset", "p5", "-tune", "hq", "-rc", "vbr", "-cq", "16",
        "-b:v", "0", "-profile:v", "high", "-g", "2147483647", "-forced-idr", "1",
        "-no-scenecut", "1", "-pix_fmt", "yuv420p",
    ),
    concurrency=4,
)  # fmt: skip

HARDWARE_CANDIDATES: Final = (VIDEOTOOLBOX, NVENC)


Runner = Callable[[Sequence[str]], subprocess.CompletedProcess[bytes]]

TRIAL_TIMEOUT_SECONDS: Final = 30.0

_TRIAL_FRAMES: Final = 30


def _run(args: Sequence[str]) -> subprocess.CompletedProcess[bytes]:
    # FFmpeg 默认读取标准输入，后台运行时会触发 SIGTTIN 挂起进程组，须将 stdin 重定向至 DEVNULL。
    return subprocess.run(
        list(args),
        stdin=subprocess.DEVNULL,
        capture_output=True,
        timeout=TRIAL_TIMEOUT_SECONDS,
        check=False,
    )


def detect_codec(
    candidates: Sequence[MediaCodec] = HARDWARE_CANDIDATES, *, run: Runner = _run
) -> MediaCodec:
    for codec in candidates:
        reason = _trial(codec, run)
        if reason is None:
            return codec
        _logger.info("硬件编解码不可用", codec=codec.name, reason=reason)
    _logger.warning(
        "没有可用的硬件编解码，本地视频加工用软件",
        tried=[codec.name for codec in candidates],
        codec=SOFTWARE.name,
    )
    return SOFTWARE


def _trial(codec: MediaCodec, run: Runner) -> str | None:
    with TemporaryDirectory(prefix="iclip-codec-") as tmp:
        dest = Path(tmp) / f"{codec.name}.mp4"
        reason = _step(
            "编码",
            [
                "ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=256x256:rate=30",
                "-frames:v", str(_TRIAL_FRAMES), *codec.encode, str(dest),
            ],
            run,
        )  # fmt: skip
        if reason is not None:
            return reason
        return _step(
            "解码",
            ["ffmpeg", "-v", "error", *codec.decode, "-i", str(dest), "-f", "null", "-"],
            run,
        )


def _step(step: str, args: Sequence[str], run: Runner) -> str | None:
    try:
        result = run(args)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return f"{step}: {type(exc).__name__}: {exc}"
    if result.returncode != 0:
        detail = result.stderr.decode(errors="replace").strip()[:_STDERR_LIMIT]
        return f"{step}失败（退出码 {result.returncode}）: {detail}"
    return None


__all__ = [
    "HARDWARE_CANDIDATES",
    "NVENC",
    "SOFTWARE",
    "TRIAL_TIMEOUT_SECONDS",
    "VIDEOTOOLBOX",
    "MediaCodec",
    "Runner",
    "detect_codec",
]
