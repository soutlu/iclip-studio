"""本地视频加工的编解码：三档配置，以及启动时选用哪一档的探测。

硬件优先：先试 VideoToolbox（macOS），再试 NVENC（NVIDIA），都不行用软件 libx264。每一档的编码
参数都要让产物的关键帧只出现在 ``-force_key_frames`` 给的时刻，编码器自己不插。
「编码器认得」不等于「有这块硬件、驱动认这些参数」，所以探测不看 ``ffmpeg -encoders``，而是用这一档
真编一小段、再解一遍，两步都成功就选中。"""

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
    """一档编解码：解码选项、H.264 编码参数，以及这一档下本地加工队列的默认并发。"""

    name: str
    hardware: bool
    decode: tuple[str, ...]
    """加在每个视频输入的 ``-i`` 之前。帧解完回到内存，后面的 CPU 滤镜照常用。"""

    encode: tuple[str, ...]
    """H.264 编码参数，含让关键帧只出在 ``-force_key_frames`` 时刻的那几项；调用方另给时刻表。"""

    concurrency: int
    """合成与拆解两个队列不写并发时取它：编解码不占 CPU 时可以多跑几条。"""


SOFTWARE: Final = MediaCodec(
    name="software",
    hardware=False,
    decode=(),
    # 比视觉无损档多留一档（crf 18 → 16，体积涨约四分之一）：编辑链上每出一版都要把整条
    # 重编一遍，下一版是在上一版的产物上再编，损失会累积。
    encode=(
        "-c:v", "libx264", "-preset", "medium", "-crf", "16", "-pix_fmt", "yuv420p",
        "-forced-idr", "1",
        # x264 自己会在两处插关键帧：场景切换，和默认 250 帧的 keyint 上限。两处都用 x264 的参数
        # 关：「不设上限」只有 keyint=infinite 写得出来，ffmpeg 的 -g 只收一个有限的数。
        "-x264-params", "scenecut=0:keyint=infinite",
    ),
    concurrency=2,
)  # fmt: skip

VIDEOTOOLBOX: Final = MediaCodec(
    name="videotoolbox",
    hardware=True,
    decode=("-hwaccel", "videotoolbox"),
    # -q:v 80 实测与 x264 crf 16 画质（VMAF）、体积相当；只有 Apple Silicon 收 -q:v，Intel Mac
    # 上编码直接失败，由探测落到下一档。-g 取最大值关掉默认 12 帧的 GOP 上限；VideoToolbox
    # 没有关场景切换的开关，实测配 -force_key_frames 时不按场景插。
    encode=(
        "-c:v", "h264_videotoolbox", "-q:v", "80", "-g", "2147483647", "-pix_fmt", "yuv420p",
    ),
    concurrency=4,
)  # fmt: skip

NVENC: Final = MediaCodec(
    name="nvenc",
    hardware=True,
    # 不设 -hwaccel_output_format：设成 cuda 帧就留在显存里，后面的 CPU 滤镜（trim、scale、pad、fps）
    # 接不上；不设时解完自动拷回内存。
    decode=("-hwaccel", "cuda"),
    # 画质参数（p5 + hq + 恒定质量 cq 16）按 x264 crf 16 的档位估的，没在真卡上核对过。
    # 关键帧：-g 取最大值关 GOP 上限，-no-scenecut 关场景切换，-forced-idr 让强制的关键帧是 IDR；
    # 这几项同样没在真卡上核对过。
    encode=(
        "-c:v", "h264_nvenc", "-preset", "p5", "-tune", "hq", "-rc", "vbr", "-cq", "16",
        "-b:v", "0", "-profile:v", "high", "-g", "2147483647", "-forced-idr", "1",
        "-no-scenecut", "1", "-pix_fmt", "yuv420p",
    ),
    concurrency=4,
)  # fmt: skip

HARDWARE_CANDIDATES: Final = (VIDEOTOOLBOX, NVENC)
"""探测按这个顺序试，第一个通过的选中。"""


Runner = Callable[[Sequence[str]], subprocess.CompletedProcess[bytes]]
"""跑一条命令并交回结果；起不来抛 OSError，超时抛 subprocess.TimeoutExpired。"""

TRIAL_TIMEOUT_SECONDS: Final = 30.0
"""探测里每条命令的超时。正常一条不到一秒，卡住的硬件驱动不能拖住启动。"""

_TRIAL_FRAMES: Final = 30
"""试编的帧数：ffmpeg 的测试图样，30 fps 下一秒。"""


def _run(args: Sequence[str]) -> subprocess.CompletedProcess[bytes]:
    # 禁止读取终端输入，避免后台进程组收到 SIGTTIN 后连同后端一起暂停。
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
    """按顺序试 ``candidates``，交回第一个通过的；都不通过交回 ``SOFTWARE``。

    每一档用它真编一小段、再解一遍，两步都成功算通过。同步执行，只在启动时调一次。每个不通过的
    候选记一条日志带原因；落到软件记 warning。选中谁由调用方记（它知道这一档最终给了各队列多少
    并发）。"""

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
    """用这一档的编码参数把一小段测试图样编成 mp4，再用它的解码选项解一遍；通过交回 None，
    不通过交回原因。"""

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
    """跑探测的一步：成功交回 None，起不来、超时或退出码非 0 交回带步骤名的原因。"""

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
