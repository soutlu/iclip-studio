"""启动探测怎么选编解码：第一个通过的选中，都不过落到软件，关键帧不守规矩的不要。

ffmpeg 与 ffprobe 由替身代跑：按命令里的编码器名决定编码成不成，按产物文件名交回事先写好的关键帧。"""

from __future__ import annotations

import json
import subprocess
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path

import pytest
from structlog.testing import capture_logs

from iclip.platform.media.codec import (
    HARDWARE_CANDIDATES,
    NVENC,
    SOFTWARE,
    VIDEOTOOLBOX,
    MediaCodec,
    detect_codec,
)

GOOD = (0.0, 17 / 30)
"""守规矩的产物：关键帧恰好在试编强制的第 0、17 帧（30 fps）。"""


@dataclass
class FakeFfmpeg:
    """替身：``broken`` 里的那几档编码失败；``keyframes`` 给每档产物报的关键帧时刻。"""

    keyframes: Mapping[str, Sequence[float]] = field(default_factory=dict)
    broken: frozenset[str] = frozenset()
    ran: list[list[str]] = field(default_factory=list)

    def __call__(self, args: Sequence[str]) -> subprocess.CompletedProcess[bytes]:
        command = list(args)
        self.ran.append(command)
        if command[0] == "ffprobe":
            name = Path(command[-1]).stem
            report = {
                "streams": [{"index": 0}],
                "packets": [
                    {"pts_time": f"{time:.6f}", "flags": "K__"}
                    for time in self.keyframes.get(name, GOOD)
                ],
                "format": {"start_time": "0.000000"},
            }
            return subprocess.CompletedProcess(command, 0, json.dumps(report).encode(), b"")
        codec = _codec_of(command)
        if codec in self.broken:
            return subprocess.CompletedProcess(command, 1, b"", f"{codec} 起不来".encode())
        return subprocess.CompletedProcess(command, 0, b"", b"")


def _codec_of(command: Sequence[str]) -> str:
    """编码那一步按 -c:v 认，解码那一步按输入文件名认。"""

    if "-c:v" in command:
        encoder = command[command.index("-c:v") + 1]
        return next(
            codec.name for codec in (*HARDWARE_CANDIDATES, SOFTWARE) if encoder in codec.encode
        )
    return Path(command[command.index("-i") + 1]).stem


def test_the_first_candidate_that_passes_is_chosen() -> None:
    fake = FakeFfmpeg(broken=frozenset({VIDEOTOOLBOX.name}))

    with capture_logs() as logs:
        chosen = detect_codec(run=fake)

    assert chosen is NVENC
    rejected = [log for log in logs if log["event"] == "硬件编解码不可用"]
    assert [log["codec"] for log in rejected] == [VIDEOTOOLBOX.name]
    assert "videotoolbox 起不来" in rejected[0]["reason"], "原因带上 ffmpeg 的报错"


def test_a_passing_candidate_stops_the_search() -> None:
    fake = FakeFfmpeg()

    assert detect_codec(run=fake) is VIDEOTOOLBOX
    assert not any("h264_nvenc" in command for command in fake.ran), "选中了就不再往下试"


def test_when_every_candidate_fails_software_is_used_with_a_warning() -> None:
    fake = FakeFfmpeg(broken=frozenset({VIDEOTOOLBOX.name, NVENC.name}))

    with capture_logs() as logs:
        chosen = detect_codec(run=fake)

    assert chosen is SOFTWARE
    assert [log["log_level"] for log in logs] == ["info", "info", "warning"]
    assert logs[-1]["tried"] == [VIDEOTOOLBOX.name, NVENC.name]


@pytest.mark.parametrize(
    "keyframes",
    [
        pytest.param((0.0, 12 / 30, 17 / 30, 24 / 30), id="gop-limit-left-on"),
        pytest.param((0.0, 17 / 30, 23 / 30), id="scene-cut-left-on"),
        pytest.param((0.0,), id="forced-keyframe-ignored"),
    ],
)
def test_a_candidate_whose_keyframes_stray_is_rejected(keyframes: tuple[float, ...]) -> None:
    """编码成功不算数：关键帧多了（编码器自己插）或少了（强制的没落下）都不选它。"""

    fake = FakeFfmpeg(keyframes={VIDEOTOOLBOX.name: keyframes})

    with capture_logs() as logs:
        chosen = detect_codec(run=fake)

    assert chosen is NVENC
    rejected = [log for log in logs if log["event"] == "硬件编解码不可用"]
    assert [log["codec"] for log in rejected] == [VIDEOTOOLBOX.name]
    assert "关键帧" in rejected[0]["reason"]


def test_a_candidate_that_cannot_decode_its_own_output_is_rejected() -> None:
    fake = FakeFfmpeg()
    failing_decode = MediaCodec(
        name="no-decode",
        hardware=True,
        decode=("-hwaccel", "none-here"),
        encode=VIDEOTOOLBOX.encode,
        concurrency=4,
    )

    def run(args: Sequence[str]) -> subprocess.CompletedProcess[bytes]:
        if "-hwaccel" in args:
            return subprocess.CompletedProcess(list(args), 1, b"", b"Device creation failed")
        return fake(args)

    assert detect_codec([failing_decode], run=run) is SOFTWARE


@pytest.mark.parametrize(
    "error",
    [FileNotFoundError("ffmpeg"), subprocess.TimeoutExpired("ffmpeg", 30)],
    ids=["missing", "timeout"],
)
def test_a_command_that_cannot_run_rejects_the_candidate_instead_of_crashing(
    error: Exception,
) -> None:
    def run(args: Sequence[str]) -> subprocess.CompletedProcess[bytes]:
        raise error

    assert detect_codec(run=run) is SOFTWARE
