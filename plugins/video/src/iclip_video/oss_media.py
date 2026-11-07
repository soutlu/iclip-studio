from __future__ import annotations

from collections.abc import Callable, Mapping

import httpx
from cue.harness.media import image_info_url
from cue.plugins.workspace.ports import ImageInfo, MediaProbeFailed

_IMAGE_MEDIA_TYPES: Mapping[str, str] = {
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "png": "image/png",
    "webp": "image/webp",
    "gif": "image/gif",
}


class OssMediaProbe:
    def __init__(self, client: httpx.AsyncClient, *, fetch_url: Callable[[str], str]) -> None:
        self._client = client
        self._fetch_url = fetch_url

    async def image_info(self, url: str) -> ImageInfo:
        try:
            info_url = image_info_url(self._fetch_url(url))
        except ValueError as exc:
            raise MediaProbeFailed("不是能挂 OSS 处理参数的地址") from exc
        try:
            response = await self._client.get(info_url)
        except httpx.HTTPError as exc:
            raise MediaProbeFailed("地址访问不到") from exc
        if response.status_code >= 400:
            raise MediaProbeFailed(f"对方返回 {response.status_code}")
        try:
            info = response.json()
            image_format = str(info["Format"]["value"]).lower()
            return ImageInfo(
                media_type=_IMAGE_MEDIA_TYPES.get(image_format, f"image/{image_format}"),
                size_bytes=int(info["FileSize"]["value"]),
                width=int(info["ImageWidth"]["value"]),
                height=int(info["ImageHeight"]["value"]),
            )
        except (ValueError, TypeError, KeyError, IndexError) as exc:
            raise MediaProbeFailed("对方给的不是图片信息") from exc


def rebased_fetch_url(public_url_base: str, internal_url_base: str) -> Callable[[str], str]:
    public_prefix = f"{public_url_base.rstrip('/')}/"
    internal_prefix = f"{internal_url_base.rstrip('/')}/"

    def fetch_url(url: str) -> str:
        if url.startswith(public_prefix):
            return internal_prefix + url[len(public_prefix) :]
        return url

    return fetch_url


__all__ = ["OssMediaProbe", "rebased_fetch_url"]
