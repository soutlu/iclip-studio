"""用真实 ffmpeg 跑一次启动探测：本机编得了的第一档硬件被选中，一档都编不了就落到软件。

没有硬件的机器（如 CI）上它验证的是另一半：探测正常结束，交回软件。"""

from __future__ import annotations

import pytest

from iclip.platform.media.codec import HARDWARE_CANDIDATES, SOFTWARE, detect_codec
from iclip.platform.media.ffmpeg import ffmpeg_available
from tests.helpers.media import encodes_here

pytestmark = pytest.mark.skipif(not ffmpeg_available(), reason="本机 PATH 上没有 ffmpeg/ffprobe")


def test_the_probe_picks_the_first_hardware_this_machine_can_encode_with() -> None:
    usable = [codec for codec in HARDWARE_CANDIDATES if encodes_here(codec)]

    assert detect_codec() == (usable[0] if usable else SOFTWARE)
