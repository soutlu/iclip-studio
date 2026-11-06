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


_OSS_HOST_SUFFIX: Final = ".aliyuncs.com"


def is_oss_processable(value: str) -> bool:
    try:
        parsed = urlsplit(value)
    except ValueError:
        return False
    return (parsed.hostname or "").endswith(_OSS_HOST_SUFFIX) and not parsed.query


__all__ = ["is_http_url", "is_oss_processable"]
