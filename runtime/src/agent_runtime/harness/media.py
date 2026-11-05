from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Final, Literal
from urllib.parse import urlsplit

from agent_runtime.urls import is_http_url, is_oss_processable

MediaKind = Literal["image", "video", "audio", "file"]

_LABEL_BY_KIND: Final[Mapping[MediaKind, str]] = {
    "image": "图片",
    "video": "视频",
    "audio": "音频",
    "file": "文件",
}

IMAGE_CONTEXT_MAX_EDGE: Final = 1024

_URL_ATTR = r'[^"<>\s]+'
_OPEN = rf'<(image|video|audio|file) url="({_URL_ATTR})">'
_TAG_RE: Final = re.compile(rf"{_OPEN}</\1>")

_OPEN_RE: Final = re.compile(_OPEN)

_CLOSE_RE: Final = re.compile(r"</(image|video|audio|file)>")


def _escape_attr(value: str) -> str:
    return (
        value.replace("&", "&amp;").replace('"', "&quot;").replace("<", "&lt;").replace(">", "&gt;")
    )


def _unescape_attr(value: str) -> str:
    return (
        value.replace("&gt;", ">").replace("&lt;", "<").replace("&quot;", '"').replace("&amp;", "&")
    )


def media_tag_open(kind: MediaKind, url: str) -> str:
    if not is_http_url(url):
        raise ValueError(f"媒体 tag 的地址只接受不含空白的 HTTP/HTTPS URL: {url!r}")
    return f'<{kind} url="{_escape_attr(url)}">'


def media_kind_label(kind: MediaKind) -> str:
    return _LABEL_BY_KIND[kind]


def media_tag_close(kind: MediaKind) -> str:
    return f"</{kind}>"


def media_tag(kind: MediaKind, url: str) -> str:
    return media_tag_open(kind, url) + media_tag_close(kind)


@dataclass(frozen=True, slots=True)
class MediaTag:
    kind: MediaKind
    url: str
    wraps: bool = False


def parse_media_tag(text: str) -> MediaTag | None:
    match = _TAG_RE.fullmatch(text)
    wraps = match is None
    if match is None:
        match = _OPEN_RE.fullmatch(text)
    if match is None:
        return None
    kind, url = match.group(1), match.group(2)
    return MediaTag(
        kind=kind,  # pyright: ignore[reportArgumentType]
        url=_unescape_attr(url),
        wraps=wraps,
    )


def is_media_tag_close(text: str) -> bool:
    return _CLOSE_RE.fullmatch(text) is not None


def resized_image_url(url: str, *, max_edge: int) -> str:
    _require_oss_processable(url, what=f"图片没法缩到长边 {max_edge}")
    return f"{url}?x-oss-process=image/resize,l_{max_edge}"


def cropped_image_url(
    url: str, *, x: int, y: int, width: int, height: int, max_edge: int | None
) -> str:
    _require_oss_processable(url, what="图片没法按区域裁切")
    process = f"image/crop,x_{x},y_{y},w_{width},h_{height}"
    if max_edge is not None:
        process += f"/resize,l_{max_edge}"
    return f"{url}?x-oss-process={process}"


def image_info_url(url: str) -> str:
    _require_oss_processable(url, what="查不了图片信息")
    return f"{url}?x-oss-process=image/info"


def _require_oss_processable(url: str, *, what: str) -> None:
    if is_oss_processable(url):
        return
    if is_oss_processable(urlsplit(url)._replace(query="").geturl()):
        raise ValueError(f"地址已经带了 query，没法再挂 OSS 处理参数: {url!r}")
    raise ValueError(f"这个域名不支持 OSS 处理参数，{what}: {url!r}")


__all__ = [
    "IMAGE_CONTEXT_MAX_EDGE",
    "MediaKind",
    "MediaTag",
    "cropped_image_url",
    "image_info_url",
    "is_media_tag_close",
    "media_kind_label",
    "media_tag",
    "media_tag_close",
    "media_tag_open",
    "parse_media_tag",
    "resized_image_url",
]
