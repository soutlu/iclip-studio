from __future__ import annotations

from typing import Final
from urllib.parse import urlsplit

_HTTP_SCHEMES: Final = frozenset({"http", "https"})


def is_http_url(value: str) -> bool:
    if any(ch.isspace() for ch in value):
        return False
    try:
        parsed = urlsplit(value)
    except ValueError:
        return False
    return parsed.scheme in _HTTP_SCHEMES and bool(parsed.hostname)


def is_http_origin(value: str) -> bool:
    """``value`` 是不是 ``http(s)://主机[:端口]`` 这种来源：不带路径、查询串、片段和用户信息。"""

    if not is_http_url(value):
        return False
    parsed = urlsplit(value)
    try:
        _ = parsed.port
    except ValueError:
        return False
    return not (parsed.path or parsed.query or parsed.fragment or "@" in parsed.netloc)


_OSS_HOST_SUFFIX: Final = ".aliyuncs.com"


def is_oss_processable(value: str) -> bool:
    try:
        parsed = urlsplit(value)
    except ValueError:
        return False
    return (parsed.hostname or "").endswith(_OSS_HOST_SUFFIX) and not parsed.query


__all__ = ["is_http_origin", "is_http_url", "is_oss_processable"]
