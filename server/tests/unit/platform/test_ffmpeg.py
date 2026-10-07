"""验证 ffmpeg 子进程封装对部署缺失的翻译，以及远程探测的地址门槛。"""

from __future__ import annotations

import pytest

from iclip.platform.media.ffmpeg import MediaError, probe_remote_duration_ms, run


async def test_a_missing_binary_is_reported_as_a_media_error() -> None:
    """二进制不在 PATH 上要翻成 MediaError，否则裸 FileNotFoundError 会逃出队列。"""

    with pytest.raises(MediaError, match="PATH 上找不到 /nonexistent/ffmpeg"):
        await run(["/nonexistent/ffmpeg", "-version"], timeout=5.0)


@pytest.mark.parametrize("url", ["file:///etc/passwd", "http://"])
async def test_remote_probe_refuses_a_non_http_address_before_spawning(url: str) -> None:
    with pytest.raises(MediaError, match="不是 http"):
        await probe_remote_duration_ms(url)
