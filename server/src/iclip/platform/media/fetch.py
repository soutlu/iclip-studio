from __future__ import annotations

from collections.abc import AsyncGenerator, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Final

import httpx
from agent_runtime.outbound.guard import FetchFailed

from iclip.platform.media.errors import MediaError

_DOWNLOAD_CHUNK: Final = 256 * 1024

DOWNLOAD_TIMEOUT_SECONDS: Final = 300.0
REMOTE_READ_TIMEOUT_SECONDS: Final = 30.0

MAX_VIDEO_BYTES: Final = 512 * 1024 * 1024
MAX_IMAGE_BYTES: Final = 64 * 1024 * 1024
MAX_AUDIO_BYTES: Final = 64 * 1024 * 1024

REMOTE_INPUT: Final = (
    # ffmpeg 按内容探测格式，一份伪装成 mp4 的播放列表会让 HLS 解复用器去跟里面的地址。
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
    """下载模型交来的地址时，选用哪个客户端、连哪个地址。

    本桶对象（``owns`` 为真）走 ``internal`` 客户端，地址经 ``fetch_url`` 换成内网的；别的地址走只连
    公网的 ``public`` 客户端（``agent_runtime.outbound.fetch.public_client``），用原地址。本桶的内网
    地址解析出的是内网 IP，过不了出网防护，所以分两条路。"""

    internal: httpx.AsyncClient
    public: httpx.AsyncClient
    fetch_url: Callable[[str], str]
    owns: Callable[[str], bool]

    def target(self, url: str) -> tuple[httpx.AsyncClient, str]:
        """下载 ``url`` 用的客户端与实际连的地址。"""

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
    except httpx.HTTPError as exc:
        raise MediaError(f"取不到素材（{type(exc).__name__}）: {url}") from exc
    except FetchFailed as exc:
        # 出网防护的客户端拒绝或解析不了时抛的不是 httpx 的错误。
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
