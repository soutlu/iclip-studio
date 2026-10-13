"""出网下载的防护：只连查过的公网 IP，地址、端口、跳转、大小与时长都有上限。

不连外网：解析函数与底层网络后端都注入替身，断言实际连的是哪个 (ip, port)；连本地服务器的
那一条注入放行回环的测试策略。
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncGenerator, Iterable, Mapping, Sequence
from contextlib import asynccontextmanager
from typing import Any

import httpcore
import pytest

from iclip.platform.outbound.fetch import FetchTooLarge, PublicFetcher
from iclip.platform.outbound.guard import (
    FetchFailed,
    FetchRefused,
    IpAddress,
    OutboundPolicy,
)

pytestmark = pytest.mark.unit

PUBLIC_IP = "93.184.216.34"
OTHER_PUBLIC_IP = "93.184.216.35"
PNG = b"\x89PNG-bytes"


def ok(body: bytes = PNG, *, length: bool = True) -> list[bytes]:
    head = b"HTTP/1.1 200 OK\r\n"
    if length:
        head += b"Content-Length: " + str(len(body)).encode() + b"\r\n"
    return [head + b"\r\n" + body]


def redirect(location: str) -> list[bytes]:
    return [
        b"HTTP/1.1 302 Found\r\nLocation: " + location.encode() + b"\r\nContent-Length: 0\r\n\r\n"
    ]


class RecordingBackend(httpcore.AsyncNetworkBackend):
    """按 (ip, port) 回放预设的响应字节，记下每次连的是谁。"""

    def __init__(self, responses: Mapping[tuple[str, int], list[bytes]]) -> None:
        self.responses = responses
        self.connected: list[tuple[str, int]] = []

    async def connect_tcp(
        self,
        host: str,
        port: int,
        timeout: float | None = None,
        local_address: str | None = None,
        socket_options: Iterable[Any] | None = None,
    ) -> httpcore.AsyncNetworkStream:
        self.connected.append((host, port))
        return httpcore.AsyncMockStream(list(self.responses[(host, port)]))

    async def connect_unix_socket(
        self,
        path: str,
        timeout: float | None = None,
        socket_options: Iterable[Any] | None = None,
    ) -> httpcore.AsyncNetworkStream:
        raise AssertionError("不该连本机 socket")

    async def sleep(self, seconds: float) -> None:
        await asyncio.sleep(seconds)


def resolver(table: Mapping[str, Sequence[str]], asked: list[str] | None = None) -> Any:
    async def resolve(host: str, port: int) -> Sequence[str]:
        if asked is not None:
            asked.append(host)
        return table[host]

    return resolve


@asynccontextmanager
async def fetcher(
    backend: httpcore.AsyncNetworkBackend, table: Mapping[str, Sequence[str]], **kwargs: Any
) -> AsyncGenerator[PublicFetcher]:
    instance = PublicFetcher(resolve=resolver(table), network_backend=backend, **kwargs)
    try:
        yield instance
    finally:
        await instance.aclose()


async def test_a_public_host_is_fetched_over_the_ip_that_was_checked() -> None:
    backend = RecordingBackend({(PUBLIC_IP, 443): ok()})
    async with fetcher(backend, {"img.test": [PUBLIC_IP]}) as client:
        body = await client.fetch("https://img.test/a.png", max_bytes=1024)

    assert body == PNG
    assert backend.connected == [(PUBLIC_IP, 443)]


@pytest.mark.parametrize(
    "addresses",
    [
        pytest.param(["10.0.0.5"], id="内网"),
        pytest.param(["127.0.0.1"], id="回环"),
        pytest.param(["::1"], id="IPv6 回环"),
        pytest.param(["169.254.169.254"], id="链路本地（云元数据）"),
        pytest.param(["::ffff:10.0.0.5"], id="IPv4-mapped 内网"),
        pytest.param(["::ffff:127.0.0.1"], id="IPv4-mapped 回环"),
        pytest.param(["fd00::1"], id="IPv6 ULA"),
        pytest.param(["100.64.0.1"], id="运营商共享地址"),
        pytest.param([PUBLIC_IP, "10.0.0.5"], id="混着一个内网"),
    ],
)
async def test_a_host_resolving_to_a_non_public_address_is_refused_before_connecting(
    addresses: list[str],
) -> None:
    backend = RecordingBackend({})
    async with fetcher(backend, {"img.test": addresses}) as client:
        with pytest.raises(FetchRefused, match="非公网地址"):
            await client.fetch("http://img.test/a.png", max_bytes=1024)

    assert backend.connected == []


async def test_a_redirect_to_an_internal_address_is_refused() -> None:
    backend = RecordingBackend({(PUBLIC_IP, 80): redirect("http://internal.test/secret")})
    table = {"img.test": [PUBLIC_IP], "internal.test": ["10.1.2.3"]}
    async with fetcher(backend, table) as client:
        with pytest.raises(FetchRefused, match=r"10\.1\.2\.3"):
            await client.fetch("http://img.test/a.png", max_bytes=1024)

    assert backend.connected == [(PUBLIC_IP, 80)]


async def test_a_redirect_to_a_forbidden_port_is_refused() -> None:
    backend = RecordingBackend({(PUBLIC_IP, 80): redirect("http://img.test:6379/")})
    async with fetcher(backend, {"img.test": [PUBLIC_IP]}) as client:
        with pytest.raises(FetchRefused, match="6379"):
            await client.fetch("http://img.test/a.png", max_bytes=1024)

    assert backend.connected == [(PUBLIC_IP, 80)]


async def test_redirects_to_public_hosts_are_followed_and_rechecked() -> None:
    backend = RecordingBackend(
        {
            (PUBLIC_IP, 80): redirect("https://cdn.test/real.png"),
            (OTHER_PUBLIC_IP, 443): ok(),
        }
    )
    table = {"img.test": [PUBLIC_IP], "cdn.test": [OTHER_PUBLIC_IP]}
    async with fetcher(backend, table) as client:
        body = await client.fetch("http://img.test/a.png", max_bytes=1024)

    assert body == PNG
    assert backend.connected == [(PUBLIC_IP, 80), (OTHER_PUBLIC_IP, 443)]


async def test_more_than_three_redirects_give_up() -> None:
    hosts = [f"h{index}.test" for index in range(5)]
    ips = [f"93.184.216.{40 + index}" for index in range(5)]
    responses = {
        (ip, 80): redirect(f"http://{hosts[index + 1]}/") for index, ip in enumerate(ips[:-1])
    }
    responses[(ips[-1], 80)] = ok()
    backend = RecordingBackend(responses)
    async with fetcher(backend, dict(zip(hosts, [[ip] for ip in ips], strict=True))) as client:
        with pytest.raises(FetchFailed, match="跳转超过 3 次"):
            await client.fetch(f"http://{hosts[0]}/", max_bytes=1024)

    assert len(backend.connected) == 4


@pytest.mark.parametrize(
    ("url", "reason"),
    [
        pytest.param("http://img.test:8080/a.png", "8080", id="别的端口"),
        pytest.param("https://img.test:22/a.png", "22", id="ssh 端口"),
        pytest.param("ftp://img.test/a.png", "http/https", id="ftp"),
        pytest.param("file:///etc/passwd", "http/https", id="file"),
        pytest.param("http://user:secret@img.test/a.png", "用户名密码", id="带用户名密码"),
    ],
)
async def test_a_url_breaking_the_rules_is_refused_without_resolving(url: str, reason: str) -> None:
    backend = RecordingBackend({})
    asked: list[str] = []
    instance = PublicFetcher(resolve=resolver({}, asked), network_backend=backend)
    try:
        with pytest.raises(FetchRefused, match=reason):
            await instance.fetch(url, max_bytes=1024)
    finally:
        await instance.aclose()

    assert asked == []
    assert backend.connected == []


async def test_a_declared_length_over_the_cap_is_refused_before_reading() -> None:
    backend = RecordingBackend({(PUBLIC_IP, 80): ok(b"x" * 100)})
    async with fetcher(backend, {"img.test": [PUBLIC_IP]}) as client:
        with pytest.raises(FetchTooLarge, match="100 字节"):
            await client.fetch("http://img.test/a.png", max_bytes=10)


async def test_a_body_without_a_length_is_cut_off_at_the_cap() -> None:
    chunk = b"x" * 8
    chunked = [
        b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n",
        *[b"8\r\n" + chunk + b"\r\n" for _ in range(4)],
        b"0\r\n\r\n",
    ]
    backend = RecordingBackend({(PUBLIC_IP, 80): chunked})
    async with fetcher(backend, {"img.test": [PUBLIC_IP]}) as client:
        with pytest.raises(FetchTooLarge, match="超过 20 字节"):
            await client.fetch("http://img.test/a.png", max_bytes=20)


async def test_an_error_status_is_a_failure() -> None:
    backend = RecordingBackend(
        {(PUBLIC_IP, 80): [b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n"]}
    )
    async with fetcher(backend, {"img.test": [PUBLIC_IP]}) as client:
        with pytest.raises(FetchFailed, match="404"):
            await client.fetch("http://img.test/a.png", max_bytes=1024)


class _StallingStream(httpcore.AsyncMockStream):
    async def read(self, max_bytes: int, timeout: float | None = None) -> bytes:
        await asyncio.sleep(10)
        return b""


class _StallingBackend(RecordingBackend):
    async def connect_tcp(
        self,
        host: str,
        port: int,
        timeout: float | None = None,
        local_address: str | None = None,
        socket_options: Iterable[Any] | None = None,
    ) -> httpcore.AsyncNetworkStream:
        self.connected.append((host, port))
        return _StallingStream([])


async def test_a_stalled_download_fails_at_the_total_timeout() -> None:
    backend = _StallingBackend({})
    async with fetcher(backend, {"img.test": [PUBLIC_IP]}, total_timeout_seconds=0.05) as client:
        with pytest.raises(FetchFailed, match="秒内没有下载完"):
            await client.fetch("http://img.test/a.png", max_bytes=1024)


async def test_proxy_settings_in_the_environment_are_ignored(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """走代理就绕过了 IP 检查：环境里配了代理也直连查过的 IP。"""

    monkeypatch.setenv("HTTP_PROXY", "http://10.9.9.9:3128")
    monkeypatch.setenv("HTTPS_PROXY", "http://10.9.9.9:3128")
    monkeypatch.setenv("ALL_PROXY", "http://10.9.9.9:3128")
    backend = RecordingBackend({(PUBLIC_IP, 80): ok()})
    async with fetcher(backend, {"img.test": [PUBLIC_IP]}) as client:
        await client.fetch("http://img.test/a.png", max_bytes=1024)

    assert backend.connected == [(PUBLIC_IP, 80)]


async def test_a_real_connection_goes_through_the_checked_address() -> None:
    """不注入网络后端，走真的 anyio 连接与系统解析；测试策略放行回环与这个端口。"""

    async def serve(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        await reader.readuntil(b"\r\n\r\n")
        writer.write(b"".join(ok()))
        await writer.drain()
        writer.close()

    server = await asyncio.start_server(serve, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]

    def loopback(address: IpAddress) -> bool:
        return address.is_loopback

    instance = PublicFetcher(
        policy=OutboundPolicy(ports=frozenset({port}), address_allowed=loopback)
    )
    try:
        async with server:
            body = await instance.fetch(f"http://127.0.0.1:{port}/a.png", max_bytes=1024)
    finally:
        await instance.aclose()

    assert body == PNG


async def test_the_production_policy_refuses_loopback_for_real() -> None:
    """生产策略下 localhost 一个字节都不连：解析出回环就拒。"""

    instance = PublicFetcher()
    try:
        with pytest.raises(FetchRefused):
            await instance.fetch("http://localhost/a.png", max_bytes=1024)
    finally:
        await instance.aclose()
