"""服务端下载本桶对象前的地址换算替身，供各下载点的装配与断言共用。"""

from __future__ import annotations

from collections.abc import Callable


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
