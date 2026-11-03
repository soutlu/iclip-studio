"""提交点的媒体地址检查：链接能打开、类型对算能用，探不通的再探一次；不行的只说「打不开」或「不是图片/视频」，
给模型的话按称呼列出、叫它换地址。

探的是本机回环上的测试服务器：``reach_server`` 把检查自己建的客户端换成放行回环与它端口的那份；不换时
检查用的是生产规则，连回环就该被拒。不碰外网。
"""

from __future__ import annotations

from collections.abc import AsyncGenerator

import httpx
import pytest
from pydantic_ai import ModelRetry

from agent_runtime.harness.materials import require_media
from agent_runtime.harness.media_check import MediaKind, bad_urls
from tests.helpers.loopback import LoopbackServer, Route, checks_reach, loopback_server

pytestmark = pytest.mark.unit

ROUTES = {
    "/png": Route(headers={"Content-Type": "image/png; charset=binary"}),
    "/mp4": Route(headers={"Content-Type": "video/mp4"}),
    "/octet.JPG": Route(headers={"Content-Type": "application/octet-stream"}),
    "/clip.mov": Route(),
    "/octet.txt": Route(headers={"Content-Type": "binary/octet-stream"}),
    "/page.png": Route(headers={"Content-Type": "text/html"}),
    "/down.png": Route(status="503 Service Unavailable"),
    "/slow.png": Route(stall_before_head=True),
}


@pytest.fixture
async def server() -> AsyncGenerator[LoopbackServer]:
    async with loopback_server(ROUTES) as running:
        yield running


@pytest.fixture(autouse=True)
def retry_at_once(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("agent_runtime.harness.media_check.RETRY_DELAY_SECONDS", 0.0)


@pytest.fixture
def reach_server(server: LoopbackServer, monkeypatch: pytest.MonkeyPatch) -> None:
    checks_reach(server, monkeypatch, timeout=0.3)


def answering(
    monkeypatch: pytest.MonkeyPatch, *answers: httpx.Response | httpx.HTTPError
) -> list[str]:
    """检查用的客户端按先后答 ``answers``；交回每次探的地址。"""

    asked: list[str] = []
    queue = list(answers)

    def answer(request: httpx.Request) -> httpx.Response:
        asked.append(str(request.url))
        next_answer = queue.pop(0)
        if isinstance(next_answer, httpx.HTTPError):
            raise next_answer
        return next_answer

    def build(**_: object) -> httpx.AsyncClient:
        return httpx.AsyncClient(transport=httpx.MockTransport(answer))

    monkeypatch.setattr("agent_runtime.harness.media_check.public_client", build)
    return asked


async def reason_for(url: str, kind: MediaKind = "image") -> str | None:
    return (await bad_urls([url], kind=kind)).get(url)


@pytest.mark.usefixtures("reach_server")
@pytest.mark.parametrize(
    ("path", "kind"),
    [
        pytest.param("/png", "image", id="图片按类型"),
        pytest.param("/mp4", "video", id="视频按类型"),
        pytest.param("/octet.JPG?x-oss-process=image/info", "image", id="二进制流按扩展名"),
        pytest.param("/clip.mov", "video", id="没给类型按扩展名"),
    ],
)
async def test_a_reachable_address_of_the_right_kind_passes(
    server: LoopbackServer, path: str, kind: MediaKind
) -> None:
    assert await bad_urls([server.url(path)], kind=kind) == {}


@pytest.mark.usefixtures("reach_server")
@pytest.mark.parametrize(
    ("path", "kind", "reason"),
    [
        pytest.param("/page.png", "image", "不是图片", id="类型不对"),
        pytest.param("/png", "video", "不是视频", id="图片当视频"),
        pytest.param("/octet.txt", "image", "不是图片", id="扩展名也不对"),
        pytest.param("/missing.png", "image", "打不开", id="404"),
        pytest.param("/down.png", "image", "打不开", id="5xx"),
        pytest.param("/slow.png", "image", "打不开", id="超时"),
    ],
)
async def test_an_address_that_does_not_work_says_which_of_the_two(
    server: LoopbackServer, path: str, kind: MediaKind, reason: str
) -> None:
    assert await reason_for(server.url(path), kind) == reason


@pytest.mark.usefixtures("reach_server")
@pytest.mark.parametrize(
    "url",
    [
        pytest.param("http://10.0.0.5/a.png", id="内网地址"),
        pytest.param("ftp://127.0.0.1/a.png", id="不是 http"),
        pytest.param("ref.png", id="不是地址"),
        pytest.param("http://a.test:abc/a.png", id="httpx 认不了的端口"),
    ],
)
async def test_an_address_outside_the_rules_does_not_open(url: str) -> None:
    assert await reason_for(url) == "打不开"


@pytest.mark.parametrize("host", ["127.0.0.1", "localhost"])
async def test_the_default_client_does_not_open_loopback(server: LoopbackServer, host: str) -> None:
    """不换客户端时用生产规则：本机地址打不开，端口不在 80 / 443 里也不去连。"""

    assert await reason_for(server.url("/png", host=host)) == "打不开"
    assert server.connections == 0


@pytest.mark.usefixtures("reach_server")
async def test_a_repeated_address_is_checked_once(server: LoopbackServer) -> None:
    same, other = server.url("/png"), server.url("/mp4")

    bad = await bad_urls([same, server.url("/missing.png"), same, other], kind="image")

    # 打不开的那个再探了一次。
    assert sorted(server.paths) == ["/missing.png", "/missing.png", "/mp4", "/png"]
    assert bad == {server.url("/missing.png"): "打不开", other: "不是图片"}


PICTURE = "https://cdn.test/a.png"


@pytest.mark.parametrize(
    "first",
    [
        pytest.param(httpx.Response(404), id="404"),
        pytest.param(httpx.Response(503), id="5xx"),
        pytest.param(httpx.ConnectError("连不上"), id="连不上"),
    ],
)
async def test_a_failed_probe_is_tried_once_more(
    monkeypatch: pytest.MonkeyPatch, first: httpx.Response | httpx.HTTPError
) -> None:
    asked = answering(
        monkeypatch, first, httpx.Response(200, headers={"Content-Type": "image/png"})
    )

    assert await bad_urls([PICTURE], kind="image") == {}
    assert asked == [PICTURE, PICTURE]


async def test_two_failed_probes_do_not_open(monkeypatch: pytest.MonkeyPatch) -> None:
    asked = answering(monkeypatch, httpx.Response(404), httpx.ConnectError("连不上"))

    assert await bad_urls([PICTURE], kind="image") == {PICTURE: "打不开"}
    assert asked == [PICTURE, PICTURE]


async def test_a_wrong_type_is_probed_only_once(monkeypatch: pytest.MonkeyPatch) -> None:
    asked = answering(monkeypatch, httpx.Response(200, headers={"Content-Type": "text/html"}))

    assert await bad_urls([PICTURE], kind="image") == {PICTURE: "不是图片"}
    assert asked == [PICTURE]


@pytest.mark.usefixtures("reach_server")
async def test_bad_addresses_are_listed_by_label_for_the_model_without_the_address(
    server: LoopbackServer,
) -> None:
    items = [
        ("第 1 组第 1 张", server.url("/png")),
        ("第 1 组第 2 张", server.url("/secret-name.png")),
        ("第 2 组第 1 张", server.url("/page.png")),
        ("第 2 组第 2 张", server.url("/secret-name.png")),
    ]

    with pytest.raises(ModelRetry) as raised:
        await require_media(items, kind="image", what="镜头帧地址")

    assert str(raised.value).splitlines() == [
        "以下镜头帧地址不能用，换成能打开的地址再调用：",
        "第 1 组第 2 张：打不开",
        "第 2 组第 1 张：不是图片",
        "第 2 组第 2 张：打不开",
    ]


@pytest.mark.usefixtures("reach_server")
async def test_good_addresses_pass_the_tool_check(server: LoopbackServer) -> None:
    await require_media([("参考图 1", server.url("/png"))], kind="image", what="参考图地址")


async def test_nothing_to_check_builds_no_client(monkeypatch: pytest.MonkeyPatch) -> None:
    def build(**_: object) -> None:
        raise AssertionError("没有地址时不该建客户端")

    monkeypatch.setattr("agent_runtime.harness.media_check.public_client", build)

    assert await bad_urls([], kind="image") == {}
