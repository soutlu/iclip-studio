"""服务端下载本桶对象前的地址换算替身，供各下载点的装配与断言共用。"""

from __future__ import annotations

from collections.abc import Callable

import httpx

from iclip.platform.media.fetch import MediaDownloads


def as_is(url: str) -> str:
    """不换地址：没配内网 endpoint 时组合根注入的就是这种。"""

    return url


def rewriting(public_base: str, fetch_base: str) -> Callable[[str], str]:
    """把 ``public_base`` 开头的地址换到 ``fetch_base`` 下，其余原样；断言看得出换没换过。"""

    def fetch_url(url: str) -> str:
        if url.startswith(public_base):
            return fetch_base + url[len(public_base) :]
        return url

    return fetch_url


def all_own(client: httpx.AsyncClient, fetch_url: Callable[[str], str] = as_is) -> MediaDownloads:
    """把每个地址都当本桶对象：下载一律经 ``client`` 连 ``fetch_url`` 换过的地址，不经出网防护。"""

    return MediaDownloads(internal=client, public=client, fetch_url=fetch_url, owns=_always)


def _always(url: str) -> bool:
    return True
