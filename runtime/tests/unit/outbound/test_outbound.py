"""出网防护的行为：只连公网的 80 / 443，跳转后照查，不带用户名密码、不走代理；探地址只看响应头，
取不到的一律报 ``FetchFailed``。

连的是本机回环上的测试服务器：放行回环与它端口的策略连得上，生产策略连它就该被拒。不碰外网。
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncGenerator

import httpx
import pytest

from agent_runtime.outbound.guard import (
    PUBLIC_INTERNET,
    FetchFailed,
    OutboundPolicy,
    public_client,
)
from agent_runtime.outbound.probe import probe
from tests.helpers.loopback import LoopbackServer, Route, loopback_client, loopback_server

pytestmark = pytest.mark.unit

ROUTES = {
    "/a.png": Route(headers={"Content-Type": "image/png; charset=binary"}, body=b"png"),
    "/plain": Route(),
    "/gone": Route(status="404 Not Found"),
    "/to-private": Route(status="302 Found", headers={"Location": "http://10.0.0.5/secret"}),
    "/loop": Route(status="302 Found", headers={"Location": "/loop"}),
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


async def probe_with(client: httpx.AsyncClient, url: str) -> str | None:
    async with client:
        return await probe(client, url)


@pytest.mark.parametrize("host", ["127.0.0.1", "localhost"])
async def test_an_allowed_address_answers_its_media_type(server: LoopbackServer, host: str) -> None:
    url = server.url("/a.png", host=host)
    assert await probe_with(loopback_client(server), url) == "image/png"


async def test_a_response_without_a_type_answers_none(server: LoopbackServer) -> None:
    assert await probe_with(loopback_client(server), server.url("/plain")) is None


@pytest.mark.parametrize("host", ["127.0.0.1", "localhost"])
async def test_loopback_is_refused_by_the_public_rule(server: LoopbackServer, host: str) -> None:
    # 端口放行，只剩「公网地址」这一条把它拦下。
    client = public_client(timeout=2, policy=OutboundPolicy(ports=frozenset({server.port})))

    with pytest.raises(FetchFailed):
        await probe_with(client, server.url("/a.png", host=host))

    assert server.paths == []


async def test_a_private_address_is_refused() -> None:
    with pytest.raises(FetchFailed):
        await probe_with(public_client(timeout=2), "http://10.0.0.5/a.png")


async def test_a_redirect_to_a_private_address_is_refused(server: LoopbackServer) -> None:
    with pytest.raises(FetchFailed):
        await probe_with(loopback_client(server), server.url("/to-private"))

    assert server.paths == ["/to-private"]


@pytest.mark.parametrize("host", ["127.0.0.1", "localhost"])
async def test_a_port_outside_the_rule_is_refused_without_connecting(
    server: LoopbackServer, host: str
) -> None:
    # 主机名也不连：httpx-secure 按主机名选 IP 时会先连一次 TCP，端口要在那之前拒。
    other = OutboundPolicy(ports=frozenset({server.port + 1}), loopback=True)

    with pytest.raises(FetchFailed, match=f"不连 {server.port} 端口"):
        await probe_with(public_client(timeout=2, policy=other), server.url("/a.png", host=host))

    assert server.connections == 0


async def test_the_production_rule_refuses_other_ports_without_connecting(
    server: LoopbackServer,
) -> None:
    """内网主机的端口开没开，结果都一样：不连，答取不到。"""

    with pytest.raises(FetchFailed):
        await probe_with(public_client(timeout=2), server.url("/a.png", host="localhost"))

    assert server.connections == 0


def test_production_allows_only_80_and_443() -> None:
    assert PUBLIC_INTERNET.ports == frozenset({80, 443})
    assert not PUBLIC_INTERNET.loopback


async def test_an_address_with_credentials_is_refused_without_connecting(
    server: LoopbackServer,
) -> None:
    with pytest.raises(FetchFailed, match="用户名密码"):
        await probe_with(
            loopback_client(server), f"http://user:secret@127.0.0.1:{server.port}/a.png"
        )

    assert server.connections == 0


@pytest.mark.parametrize(
    "url",
    [
        "ftp://127.0.0.1/a.png",
        "file:///etc/passwd",
        "ref.png",
        "http://a.test:abc/a.png",
    ],
)
async def test_an_address_httpx_cannot_send_is_a_failure(server: LoopbackServer, url: str) -> None:
    with pytest.raises(FetchFailed):
        await probe_with(loopback_client(server), url)


@pytest.mark.parametrize("path", ["/gone", "/loop", "/slow"], ids=["404", "跳转太多", "超时"])
async def test_anything_but_a_final_200_is_a_failure(server: LoopbackServer, path: str) -> None:
    with pytest.raises(FetchFailed):
        await probe_with(loopback_client(server, timeout=0.2), server.url(path))


async def test_probe_does_not_wait_for_the_body(server: LoopbackServer) -> None:
    async with asyncio.timeout(1):
        found = await probe_with(loopback_client(server), server.url("/huge.mp4"))

    assert found == "video/mp4"


async def test_proxy_settings_in_the_environment_are_ignored(
    server: LoopbackServer, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("HTTP_PROXY", "http://10.0.0.1:3128")
    monkeypatch.setenv("ALL_PROXY", "http://10.0.0.1:3128")

    assert await probe_with(loopback_client(server), server.url("/a.png")) == "image/png"
