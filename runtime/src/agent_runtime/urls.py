"""地址形状的共用判定。"""

from __future__ import annotations

from typing import Final
from urllib.parse import urlsplit

_HTTP_SCHEMES: Final = frozenset({"http", "https"})


def is_http_url(value: str) -> bool:
    """是否为带主机名、不含空白的 http(s) 地址；纯判定，不抛异常。"""

    # urlsplit 会先剥掉首尾空白与 \t\r\n，只能在原串上查。
    if any(ch.isspace() for ch in value):
        return False
    try:
        parsed = urlsplit(value)
    except ValueError:  # 方括号不配对之类的畸形 netloc，urlsplit 直接抛
        return False
    return parsed.scheme in _HTTP_SCHEMES and bool(parsed.hostname)


_OSS_HOST_SUFFIX: Final = ".aliyuncs.com"


def is_oss_processable(value: str) -> bool:
    """能不能在地址后面挂 OSS 图片处理参数：阿里云 OSS 域名，且地址自己不带 query。纯判定，不抛异常。

    给模型的缩图、查图片信息、缩放与裁切都靠挂参数；不满足的图片地址在发消息入口转存进本桶。"""

    try:
        parsed = urlsplit(value)
    except ValueError:
        return False
    return (parsed.hostname or "").endswith(_OSS_HOST_SUFFIX) and not parsed.query


__all__ = ["is_http_url", "is_oss_processable"]
