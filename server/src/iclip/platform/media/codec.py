"""本地视频加工的编解码：三档配置，以及启动时选用哪一档的探测。

硬件优先：先试 VideoToolbox（macOS），再试 NVENC（NVIDIA），都不行用软件 libx264。每一档都要满足
同一个约束：产物的关键帧只出现在 ``-force_key_frames`` 给的时刻，编码器自己不插（ADR-0010）。
「编码器认得」不等于「有硬件、关键帧守规矩」，所以探测不看 ``ffmpeg -encoders``，而是真编一小段、
读回关键帧、再解一遍。

关键帧的读法（ffprobe 报告的参数与解析）和「往前半帧」的写法也放在这里，拼接与探测共用一份。"""

from __future__ import annotations

import json
import subprocess
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass
from fractions import Fraction
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
    # 没有关场景切换的开关，实测配 -force_key_frames 时不按场景插，这一点靠启动探测把关。
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
    # 是否守规矩由启动探测在真机上把关。
    encode=(
        "-c:v", "h264_nvenc", "-preset", "p5", "-tune", "hq", "-rc", "vbr", "-cq", "16",
        "-b:v", "0", "-profile:v", "high", "-g", "2147483647", "-forced-idr", "1",
        "-no-scenecut", "1", "-pix_fmt", "yuv420p",
    ),
    concurrency=4,
)  # fmt: skip

HARDWARE_CANDIDATES: Final = (VIDEOTOOLBOX, NVENC)
"""探测按这个顺序试，第一个通过的选中。"""


def force_key_frames(frames: Iterable[int], *, frame_rate: Fraction) -> str:
    """把要做关键帧的帧号写成 ``-force_key_frames`` 收的逗号分隔串，从小到大、去重。

    写的是每帧往前半帧的时刻：ffmpeg 把第一个时间戳不早于给定时刻的帧编成关键帧，给帧的正点
    时刻会因为写成十进制时向上舍入而落到下一帧；同一帧给两个时刻，它会把后一帧也编成关键帧。"""

    return ",".join(
        f"{max(Fraction(0), (frame - Fraction(1, 2)) / frame_rate):.6f}"
        for frame in sorted(set(frames))
    )


def keyframe_report_args(path: Path) -> list[str]:
    """读第一条视频流各包关键帧标记的 ffprobe 命令；输出交给 ``parse_keyframe_report``。"""

    return [
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
    ]


def parse_keyframe_report(stdout: bytes, *, name: str) -> list[float]:
    """解析 ``keyframe_report_args`` 的输出：关键帧时刻（秒），从文件起始时间算起，从小到大。

    报告看不懂、没有视频流、一个关键帧都没有都抛 ValueError，消息里带 ``name``（素材的文件名）。"""

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
        raise ValueError("ffprobe 的关键帧信息看不懂") from exc
    if not streams:
        raise ValueError(f"这条素材里没有视频流: {name}")
    if not keyframes:
        raise ValueError(f"这条素材的视频流里没有关键帧: {name}")
    return keyframes


Runner = Callable[[Sequence[str]], subprocess.CompletedProcess[bytes]]
"""跑一条命令并交回结果；起不来抛 OSError，超时抛 subprocess.TimeoutExpired。"""

TRIAL_TIMEOUT_SECONDS: Final = 30.0
"""探测里每条命令的超时。正常一条不到一秒，卡住的硬件驱动不能拖住启动。"""

_TRIAL_RATE: Final = Fraction(30)
_TRIAL_FRAMES: Final = 30
_TRIAL_KEYFRAMES: Final = (0, 17)
_TRIAL_FLIP: Final = 23
"""试编 30 帧，在第 0、17 帧强制关键帧，第 23 帧画面整体反相（编码器会当成场景切换）。

几个帧号都避开 12 的倍数：ffmpeg 默认的 GOP 是 12 帧，撞上了就分不出关键帧是强制的还是 GOP
插的。产物的关键帧必须恰好是 0 与 17：多了 12、24、29 是 GOP 上限没关，多了 23 是场景切换没关。"""


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

    同步执行，只在启动时调一次。每个不通过的候选记一条日志带原因；落到软件记 warning。
    选中谁由调用方记（它知道这一档最终给了各队列多少并发）。"""

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
    """用这一档编一小段、读回关键帧、再解一遍；通过交回 None，不通过交回原因。"""

    with TemporaryDirectory(prefix="iclip-codec-") as tmp:
        dest = Path(tmp) / f"{codec.name}.mp4"
        pattern = f"testsrc2=size=256x256:rate={_TRIAL_RATE},negate=enable='gte(n,{_TRIAL_FLIP})'"
        encoded = _step(
            "编码",
            [
                "ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", pattern,
                "-frames:v", str(_TRIAL_FRAMES), *codec.encode,
                "-force_key_frames", force_key_frames(_TRIAL_KEYFRAMES, frame_rate=_TRIAL_RATE),
                str(dest),
            ],
            run,
        )  # fmt: skip
        if isinstance(encoded, str):
            return encoded
        report = _step("读关键帧", keyframe_report_args(dest), run)
        if isinstance(report, str):
            return report
        try:
            times = parse_keyframe_report(report.stdout, name=dest.name)
        except ValueError as exc:
            return f"读关键帧: {exc}"
        frames = sorted({round(Fraction(time) * _TRIAL_RATE) for time in times})
        if frames != list(_TRIAL_KEYFRAMES):
            return f"关键帧落在第 {frames} 帧，应只在第 {list(_TRIAL_KEYFRAMES)} 帧"
        decoded = _step(
            "解码",
            ["ffmpeg", "-v", "error", *codec.decode, "-i", str(dest), "-f", "null", "-"],
            run,
        )
        return decoded if isinstance(decoded, str) else None


def _step(step: str, args: Sequence[str], run: Runner) -> subprocess.CompletedProcess[bytes] | str:
    """跑探测的一步：成功交回结果，起不来、超时或退出码非 0 交回带步骤名的原因。"""

    try:
        result = run(args)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return f"{step}: {type(exc).__name__}: {exc}"
    if result.returncode != 0:
        detail = result.stderr.decode(errors="replace").strip()[:_STDERR_LIMIT]
        return f"{step}失败（退出码 {result.returncode}）: {detail}"
    return result


__all__ = [
    "HARDWARE_CANDIDATES",
    "NVENC",
    "SOFTWARE",
    "TRIAL_TIMEOUT_SECONDS",
    "VIDEOTOOLBOX",
    "MediaCodec",
    "Runner",
    "detect_codec",
    "force_key_frames",
    "keyframe_report_args",
    "parse_keyframe_report",
]
