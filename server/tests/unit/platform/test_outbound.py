"""出网防护的行为：只连公网的 80 / 443，跳转后照查，不带用户名密码、不走代理；下载有大小与时长上限，
探地址只看响应头；失败分得出规则拒绝、超过大小上限与其余。

连的是本机回环上的测试服务器：放行回环与它端口的策略连得上，生产策略连它就该被拒。不碰外网。
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncGenerator

import pytest

from iclip.platform.outbound.fetch import FetchTooLarge, PublicFetcher
from iclip.platform.outbound.guard import (
    PUBLIC_INTERNET,
    FetchFailed,
    OutboundPolicy,
    public_client,
)
from tests.helpers.loopback import LoopbackServer, Route, loopback_policy, loopback_server

pytestmark = pytest.mark.unit

PNG = b"\x89PNG-bytes"

ROUTES = {
    "/a.png": Route(headers={"Content-Type": "image/png; charset=binary"}, body=PNG),
    "/big.png": Route(body=b"x" * 100),
    "/chunked.png": Route(body=b"x" * 100, declare_length=False),
    "/gone": Route(status="404 Not Found"),
    "/down": Route(status="503 Service Unavailable"),
    "/loop": Route(status="302 Found", headers={"Location": "/loop"}),
    "/to-a": Route(status="302 Found", headers={"Location": "/a.png"}),
    "/to-private": Route(status="302 Found", headers={"Location": "http://10.0.0.5/secret"}),
    "/slow": Route(stall_before_head=True),
    "/huge.mp4": Route(
        headers={"Content-Type": "video/mp4", "Content-Length": "100000000"},
        stall_after_head=True,
    ),
}


@pytest.fixture
async def server() -> AsyncGenerator[LoopbackServer]:
    async with loopback_server(ROUTES) as running:
        yield running


@pytest.fixture
async def fetcher(server: LoopbackServer) -> AsyncGenerator[PublicFetcher]:
    instance = PublicFetcher(policy=loopback_policy(server), total_timeout_seconds=0.5)
    yield instance
    await instance.aclose()


async def test_an_allowed_address_is_fetched_and_probed(
    server: LoopbackServer, fetcher: PublicFetcher
) -> None:
    assert await fetcher.fetch(server.url("/a.png"), max_bytes=1024) == PNG
    assert await fetcher.probe(server.url("/a.png")) == "image/png"


async def test_redirects_are_followed(server: LoopbackServer, fetcher: PublicFetcher) -> None:
    assert await fetcher.fetch(server.url("/to-a"), max_bytes=1024) == PNG
    assert server.paths == ["/to-a", "/a.png"]


@pytest.mark.parametrize("host", ["127.0.0.1", "localhost"])
async def test_loopback_is_refused_by_the_public_rule(server: LoopbackServer, host: str) -> None:
    # 端口放行，只剩「公网地址」这一条把它拦下。
    refusing = PublicFetcher(policy=OutboundPolicy(ports=frozenset({server.port})))
    try:
        with pytest.raises(FetchFailed):
            await refusing.probe(server.url("/a.png", host=host))
    finally:
        await refusing.aclose()

    assert server.paths == []


async def test_a_private_address_is_refused_without_connecting() -> None:
    refusing = PublicFetcher()
    try:
        with pytest.raises(FetchFailed, match="不是允许的公网地址"):
            await refusing.fetch("http://10.0.0.5/a.png", max_bytes=1024)
    finally:
        await refusing.aclose()


async def test_a_redirect_to_a_private_address_is_refused(
    server: LoopbackServer, fetcher: PublicFetcher
) -> None:
    with pytest.raises(FetchFailed):
        await fetcher.probe(server.url("/to-private"))

    assert server.paths == ["/to-private"]


@pytest.mark.parametrize("host", ["127.0.0.1", "localhost"])
async def test_a_port_outside_the_rule_is_refused_without_connecting(
    server: LoopbackServer, host: str
) -> None:
    # 主机名也不连：httpx-secure 按主机名选 IP 时会先连一次 TCP，端口要在那之前拒。
    other = PublicFetcher(policy=OutboundPolicy(ports=frozenset({server.port + 1}), loopback=True))
    try:
        with pytest.raises(FetchFailed, match=f"不连 {server.port} 端口"):
            await other.probe(server.url("/a.png", host=host))
    finally:
        await other.aclose()

    assert server.connections == 0


async def test_the_production_rule_refuses_other_ports_without_connecting(
    server: LoopbackServer,
) -> None:
    """内网主机的端口开没开，结果都一样：不连，答规则拒绝。"""

    refusing = PublicFetcher()
    try:
        with pytest.raises(FetchFailed):
            await refusing.probe(server.url("/a.png", host="localhost"))
    finally:
        await refusing.aclose()

    assert server.connections == 0


def test_production_allows_only_80_and_443() -> None:
    assert PUBLIC_INTERNET.ports == frozenset({80, 443})
    assert not PUBLIC_INTERNET.loopback


async def test_an_address_with_credentials_is_refused_without_connecting(
    server: LoopbackServer, fetcher: PublicFetcher
) -> None:
    with pytest.raises(FetchFailed, match="用户名密码"):
        await fetcher.fetch(f"http://user:secret@127.0.0.1:{server.port}/a.png", max_bytes=1024)

    assert server.connections == 0


@pytest.mark.parametrize(
    ("path", "says"),
    [("/gone", "对方回了 404"), ("/down", "对方回了 503"), ("/loop", "TooManyRedirects")],
)
async def test_anything_but_a_final_200_fails_with_its_reason(
    server: LoopbackServer, fetcher: PublicFetcher, path: str, says: str
) -> None:
    with pytest.raises(FetchFailed, match=says):
        await fetcher.probe(server.url(path))


@pytest.mark.parametrize("path", ["/big.png", "/chunked.png"])
async def test_a_body_over_the_cap_is_refused(
    server: LoopbackServer, fetcher: PublicFetcher, path: str
) -> None:
    with pytest.raises(FetchTooLarge):
        await fetcher.fetch(server.url(path), max_bytes=10)


async def test_a_server_that_does_not_answer_fails_at_the_timeout(
    server: LoopbackServer, fetcher: PublicFetcher
) -> None:
    with pytest.raises(FetchFailed) as raised:
        await fetcher.probe(server.url("/slow"))

    assert type(raised.value) is FetchFailed


async def test_probe_does_not_wait_for_the_body(
    server: LoopbackServer, fetcher: PublicFetcher
) -> None:
    async with asyncio.timeout(1):
        assert await fetcher.probe(server.url("/huge.mp4")) == "video/mp4"


async def test_proxy_settings_in_the_environment_are_ignored(
    server: LoopbackServer, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("HTTP_PROXY", "http://10.0.0.1:3128")
    monkeypatch.setenv("ALL_PROXY", "http://10.0.0.1:3128")
    instance = PublicFetcher(policy=loopback_policy(server))
    try:
        assert await instance.fetch(server.url("/a.png"), max_bytes=1024) == PNG
    finally:
        await instance.aclose()


async def test_the_streaming_client_follows_the_same_rules(server: LoopbackServer) -> None:
    async with public_client(timeout=2, policy=loopback_policy(server)) as client:
        response = await client.get(server.url("/to-a"))
        assert response.content == PNG
    async with public_client(timeout=2) as client:
        with pytest.raises(FetchFailed):
            await client.get(server.url("/a.png"))
    assert server.paths == ["/to-a", "/a.png"]
