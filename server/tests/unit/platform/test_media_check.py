"""制作页用的图片地址检查：链接能打开、是图片算能用，探不通的再探一次；不行的只说「打不开」或「不是图片」。

探地址走真的 ``PublicFetcher.probe``，连本机回环上的测试服务器（放行回环的策略）；不连外网。
"""

from __future__ import annotations

from collections.abc import AsyncGenerator

import pytest

from iclip.platform.outbound.fetch import PublicFetcher
from iclip.platform.outbound.guard import FetchFailed
from iclip.platform.outbound.media_check import UrlProber, bad_images
from tests.helpers.loopback import LoopbackServer, Route, loopback_policy, loopback_server

pytestmark = pytest.mark.unit

ROUTES = {
    "/png": Route(headers={"Content-Type": "image/png"}),
    "/octet.JPG": Route(headers={"Content-Type": "application/octet-stream"}),
    "/page.png": Route(headers={"Content-Type": "text/html"}),
    "/down.png": Route(status="503 Service Unavailable"),
    "/loop.png": Route(status="302 Found", headers={"Location": "/loop.png"}),
    "/slow.png": Route(stall_before_head=True),
}


@pytest.fixture(autouse=True)
def retry_at_once(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("iclip.platform.outbound.media_check.RETRY_DELAY_SECONDS", 0.0)


@pytest.fixture
async def server() -> AsyncGenerator[LoopbackServer]:
    async with loopback_server(ROUTES) as running:
        yield running


@pytest.fixture
async def fetcher(server: LoopbackServer) -> AsyncGenerator[PublicFetcher]:
    instance = PublicFetcher(policy=loopback_policy(server), total_timeout_seconds=0.3)
    yield instance
    await instance.aclose()


async def reason_for(fetcher: PublicFetcher, url: str) -> str | None:
    return (await bad_images(fetcher.probe, [url])).get(url)


@pytest.mark.parametrize(
    "path",
    [
        pytest.param("/png", id="按类型"),
        pytest.param("/octet.JPG?x-oss-process=image/info", id="二进制流按扩展名"),
    ],
)
async def test_a_reachable_image_passes(
    server: LoopbackServer, fetcher: PublicFetcher, path: str
) -> None:
    assert await bad_images(fetcher.probe, [server.url(path)]) == {}


@pytest.mark.parametrize(
    ("path", "reason"),
    [
        pytest.param("/page.png", "不是图片", id="类型不对"),
        pytest.param("/missing.png", "打不开", id="404"),
        pytest.param("/down.png", "打不开", id="5xx"),
        pytest.param("/loop.png", "打不开", id="跳转太多"),
        pytest.param("/slow.png", "打不开", id="超时"),
    ],
)
async def test_an_address_that_does_not_work_says_which_of_the_two(
    server: LoopbackServer, fetcher: PublicFetcher, path: str, reason: str
) -> None:
    assert await reason_for(fetcher, server.url(path)) == reason


@pytest.mark.parametrize(
    "url",
    [
        pytest.param("http://10.0.0.5/a.png", id="内网地址"),
        pytest.param("ftp://127.0.0.1/a.png", id="不是 http"),
        pytest.param("http://[::1/a.png", id="方括号不配对"),
        pytest.param("http://a.test:abc/a.png", id="httpx 认不了的端口"),
    ],
)
async def test_an_address_outside_the_rules_does_not_open(fetcher: PublicFetcher, url: str) -> None:
    assert await reason_for(fetcher, url) == "打不开"


def answering(*answers: str | FetchFailed | None) -> tuple[UrlProber, list[str]]:
    """按先后答 ``answers``（媒体类型或要抛的失败）的探地址替身，连同记下每次探的地址的列表。"""

    asked: list[str] = []
    queue = list(answers)

    async def probe(url: str) -> str | None:
        asked.append(url)
        answer = queue.pop(0)
        if isinstance(answer, FetchFailed):
            raise answer
        return answer

    return probe, asked


PICTURE = "https://a.test/x"


async def test_a_repeated_address_is_probed_once() -> None:
    probe, asked = answering("image/png", "image/png")

    assert await bad_images(probe, [PICTURE, "https://b.test/y", PICTURE]) == {}
    assert sorted(asked) == [PICTURE, "https://b.test/y"]


async def test_a_failed_probe_is_tried_once_more() -> None:
    probe, asked = answering(FetchFailed("对方回了 404"), "image/png")

    assert await bad_images(probe, [PICTURE]) == {}
    assert asked == [PICTURE, PICTURE]


async def test_two_failed_probes_do_not_open() -> None:
    probe, asked = answering(FetchFailed("对方回了 404"), FetchFailed("连不上"))

    assert await bad_images(probe, [PICTURE]) == {PICTURE: "打不开"}
    assert asked == [PICTURE, PICTURE]


async def test_a_wrong_type_is_probed_only_once() -> None:
    probe, asked = answering("text/html")

    assert await bad_images(probe, [PICTURE]) == {PICTURE: "不是图片"}
    assert asked == [PICTURE]
