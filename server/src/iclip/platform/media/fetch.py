from __future__ import annotations

from collections.abc import AsyncGenerator, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Final

import httpx

from iclip.platform.media.errors import MediaError
from iclip.platform.outbound.guard import FetchFailed, failure_of

_DOWNLOAD_CHUNK: Final = 256 * 1024

DOWNLOAD_TIMEOUT_SECONDS: Final = 300.0
REMOTE_READ_TIMEOUT_SECONDS: Final = 30.0

MAX_VIDEO_BYTES: Final = 512 * 1024 * 1024
MAX_IMAGE_BYTES: Final = 64 * 1024 * 1024
MAX_AUDIO_BYTES: Final = 64 * 1024 * 1024

REMOTE_INPUT: Final = (
    # FFmpeg 按内容探测容器格式，禁用网络协议与播放列表解复用器以防伪装成 MP4 的 M3U8 触发 SSRF。
    "-protocol_whitelist",
    "http,https,tcp,tls",
    "-rw_timeout",
    str(int(REMOTE_READ_TIMEOUT_SECONDS * 1_000_000)),
    "-reconnect",
    "1",
    "-reconnect_on_network_error",
    "1",
    "-reconnect_delay_max",
    "5",
)


@dataclass(frozen=True, slots=True)
class MediaDownloads:
    internal: httpx.AsyncClient
    public: httpx.AsyncClient
    fetch_url: Callable[[str], str]
    owns: Callable[[str], bool]

    def target(self, url: str) -> tuple[httpx.AsyncClient, str]:
        if self.owns(url):
            return self.internal, self.fetch_url(url)
        return self.public, url


@asynccontextmanager
async def fetched(
    client: httpx.AsyncClient, url: str, *, max_bytes: int, suffix: str = ""
) -> AsyncGenerator[Path]:
    with TemporaryDirectory(prefix="iclip-media-") as tmp:
        target = Path(tmp) / f"source{suffix}"
        await download(client, url, target, max_bytes=max_bytes)
        yield target


async def download(client: httpx.AsyncClient, url: str, dest: Path, *, max_bytes: int) -> None:
    written = 0
    try:
        async with client.stream("GET", url, timeout=DOWNLOAD_TIMEOUT_SECONDS) as response:
            response.raise_for_status()
            with dest.open("wb") as handle:
                async for chunk in response.aiter_bytes(_DOWNLOAD_CHUNK):
                    written += len(chunk)
                    if written > max_bytes:
                        raise MediaError(f"素材超过 {max_bytes} 字节的上限: {url}")
                    handle.write(chunk)
    except (httpx.HTTPError, httpx.InvalidURL, UnicodeError) as exc:
        raise MediaError(f"取不到素材（{failure_of(exc)}）: {url}") from exc
    except FetchFailed as exc:
        raise MediaError(f"取不到素材（{exc}）: {url}") from exc
    if written == 0:
        raise MediaError(f"取到的素材是空的: {url}")


def without_query(url: str) -> str:
    return url.split("?", 1)[0]


__all__ = [
    "DOWNLOAD_TIMEOUT_SECONDS",
    "MAX_AUDIO_BYTES",
    "MAX_IMAGE_BYTES",
    "MAX_VIDEO_BYTES",
    "REMOTE_INPUT",
    "REMOTE_READ_TIMEOUT_SECONDS",
    "MediaDownloads",
    "download",
    "fetched",
    "without_query",
]
