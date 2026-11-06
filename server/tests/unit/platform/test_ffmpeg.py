from __future__ import annotations

import pytest

from iclip.platform.media.errors import MediaError
from iclip.platform.media.probe import probe_remote_duration_ms
from iclip.platform.media.process import run


async def test_a_missing_binary_is_reported_as_a_media_error() -> None:
    with pytest.raises(MediaError, match="PATH 上找不到 /nonexistent/ffmpeg"):
        await run(["/nonexistent/ffmpeg", "-version"], timeout=5.0)


@pytest.mark.parametrize("url", ["file:///etc/passwd", "http://"])
async def test_remote_probe_refuses_a_non_http_address_before_spawning(url: str) -> None:
    with pytest.raises(MediaError, match="不是 http"):
        await probe_remote_duration_ms(url)
