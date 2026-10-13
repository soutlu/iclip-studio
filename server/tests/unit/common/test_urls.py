"""地址形状判定：只认带主机名、不含空白的 http(s)，畸形输入答否而不抛。"""

from __future__ import annotations

import pytest

from iclip.common.urls import is_http_url, is_oss_processable


@pytest.mark.parametrize(
    "url",
    [
        "http://a.b/c?x=1",
        "https://host",
        "https://bucket.oss-ap-southeast-1.aliyuncs.com/a.jpg?sig=1",
        "HTTP://a.b",  # urlsplit 把 scheme 归一成小写
    ],
)
def test_http_urls_with_a_host_are_accepted(url: str) -> None:
    assert is_http_url(url)


@pytest.mark.parametrize(
    "url",
    [
        pytest.param("http://", id="光秃 scheme"),
        pytest.param("https:///path", id="空主机名"),
        pytest.param("http://:80/x", id="只有端口"),
        pytest.param("http://a b/c", id="中间有空格"),
        pytest.param("http://a.b\n", id="尾部换行"),
        pytest.param(" http://a.b", id="首部空格"),
        pytest.param("file:///etc/passwd", id="file"),
        pytest.param("data:image/png;base64,iVBORw0KGgo=", id="data"),
        pytest.param("ftp://x", id="ftp"),
        pytest.param("a.b/c.png", id="无 scheme"),
        pytest.param("", id="空串"),
        pytest.param("http://[::1", id="方括号不配对"),
    ],
)
def test_everything_else_is_refused_without_raising(url: str) -> None:
    assert not is_http_url(url)


@pytest.mark.parametrize(
    "url",
    [
        "https://bucket.oss-ap-southeast-1.aliyuncs.com/iclip/agent/uploads/a.jpg",
        "http://bucket.oss-cn-hangzhou-internal.aliyuncs.com/a.png",
    ],
)
def test_an_oss_address_without_a_query_can_carry_processing_parameters(url: str) -> None:
    assert is_oss_processable(url)


@pytest.mark.parametrize(
    "url",
    [
        pytest.param("https://cdn.test/a.jpg", id="非 OSS 域名"),
        pytest.param("https://aliyuncs.com.evil.test/a.jpg", id="后缀不在末尾"),
        pytest.param(
            "https://bucket.oss-ap-southeast-1.aliyuncs.com/a.jpg?Signature=abc", id="带签名 query"
        ),
        pytest.param(
            "https://bucket.oss-ap-southeast-1.aliyuncs.com/a.jpg?x-oss-process=image/info",
            id="已经挂了处理参数",
        ),
        pytest.param("http://[::1", id="畸形地址"),
    ],
)
def test_other_addresses_cannot_carry_processing_parameters(url: str) -> None:
    assert not is_oss_processable(url)
