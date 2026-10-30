"""OSS 上的图片信息查询与下载前的地址换算。"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

import httpx
import pytest
from agent_runtime.plugins.workspace.ports import ImageInfo, MediaProbeFailed

from iclip_video.oss_media import OssMediaProbe, rebased_fetch_url

IMAGE_URL = "https://bucket.oss-ap-southeast-1.aliyuncs.com/style.jpg"


def as_is(url: str) -> str:
    return url


def oss(
    handler: Callable[[httpx.Request], httpx.Response],
    *,
    fetch_url: Callable[[str], str] = as_is,
) -> OssMediaProbe:
    return OssMediaProbe(
        httpx.AsyncClient(transport=httpx.MockTransport(handler)), fetch_url=fetch_url
    )


# OSS image/info 的字段值均为字符串。
INFO_BODY = {
    "FileSize": {"value": "21839"},
    "Format": {"value": "jpg"},
    "ImageHeight": {"value": "267"},
    "ImageWidth": {"value": "400"},
}


async def test_the_probe_reads_the_oss_image_info() -> None:

    asked: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        asked.append(str(request.url))
        return httpx.Response(200, json=INFO_BODY)

    info = await oss(handler).image_info(IMAGE_URL)

    assert asked == [f"{IMAGE_URL}?x-oss-process=image/info"]
    assert info == ImageInfo(media_type="image/jpeg", size_bytes=21839, width=400, height=267)


async def test_the_probe_asks_the_rewritten_address_for_image_info() -> None:
    """本桶地址先换成内网地址，再挂查询参数。"""

    internal = "https://bucket.oss-ap-southeast-1-internal.aliyuncs.com"
    asked: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        asked.append(str(request.url))
        return httpx.Response(200, json=INFO_BODY)

    to_internal = rebased_fetch_url("https://bucket.oss-ap-southeast-1.aliyuncs.com", internal)
    await oss(handler, fetch_url=to_internal).image_info(IMAGE_URL)

    assert asked == [f"{internal}/style.jpg?x-oss-process=image/info"]


async def test_an_unknown_format_keeps_its_own_name() -> None:

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={**INFO_BODY, "Format": {"value": "bmp"}})

    assert (await oss(handler).image_info(IMAGE_URL)).media_type == "image/bmp"


async def test_a_non_success_status_is_a_probe_failure() -> None:

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(404, text="NoSuchKey")

    with pytest.raises(MediaProbeFailed, match="对方返回 404"):
        await oss(handler).image_info(IMAGE_URL)


@pytest.mark.parametrize(
    "body", [{"Format": {"value": "jpg"}}, {**INFO_BODY, "ImageWidth": {"value": "宽"}}]
)
async def test_missing_or_unreadable_fields_are_a_probe_failure(body: dict[str, Any]) -> None:

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=body)

    with pytest.raises(MediaProbeFailed, match="不是图片信息"):
        await oss(handler).image_info(IMAGE_URL)


async def test_a_non_json_body_is_a_probe_failure() -> None:

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"\xff\xd8\xff\xe0")

    with pytest.raises(MediaProbeFailed, match="不是图片信息"):
        await oss(handler).image_info(IMAGE_URL)


@pytest.mark.parametrize(
    "url", ["https://cdn.test/style.jpg", f"{IMAGE_URL}?Expires=1&Signature=abc"]
)
async def test_an_address_that_cannot_carry_the_info_parameter_is_refused_unasked(
    url: str,
) -> None:
    """非 OSS 域名与已带 query 的地址走 agent_runtime.harness.media 的同一道守卫，不发请求、不回显地址。"""

    asked: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        asked.append(str(request.url))
        return httpx.Response(200, json=INFO_BODY)

    with pytest.raises(MediaProbeFailed, match="OSS 处理参数") as caught:
        await oss(handler).image_info(url)
    assert url not in str(caught.value)
    assert asked == []


async def test_a_network_failure_is_a_probe_failure() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused")

    with pytest.raises(MediaProbeFailed, match="地址访问不到"):
        await oss(handler).image_info(IMAGE_URL)


@pytest.mark.parametrize(
    ("url", "fetched"),
    [
        ("https://cdn.test/a/b.jpg?x=1", "https://bucket.internal.test/a/b.jpg?x=1"),
        ("https://cdn.test", "https://cdn.test"),
        ("https://cdn.testing/b.jpg", "https://cdn.testing/b.jpg"),
        ("https://other.test/b.jpg", "https://other.test/b.jpg"),
    ],
)
def test_only_addresses_under_the_public_base_are_rebased(url: str, fetched: str) -> None:
    """前缀按「根地址 + /」比，相似的域名与根地址本身都不换；key 与查询串原样。"""

    fetch_url = rebased_fetch_url("https://cdn.test/", "https://bucket.internal.test")

    assert fetch_url(url) == fetched
