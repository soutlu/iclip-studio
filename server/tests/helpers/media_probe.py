"""探媒体地址的替身，不连网。

- ``ScriptedProbe``：制作页用的 ``UrlProber``，按地址答预设的类型或失败；没预设的答取得到、不给类型（按扩展名认）。
- ``offline_media_checks``：插件提交点的检查每次自己建 ``public_client``，把它换成一律答 200、不给类型的
  替身；``integration_no_llm`` 的每个用例都装上。

出网防护本身由 ``platform/outbound`` 与运行时包的行为测试覆盖。
"""

from __future__ import annotations

from collections.abc import Mapping

import httpx
import pytest

from iclip.platform.outbound.guard import FetchFailed


class ScriptedProbe:
    """答案是媒体类型（None 为不给类型）或要抛的 ``FetchFailed``。"""

    def __init__(self, answers: Mapping[str, str | FetchFailed | None] | None = None) -> None:
        self.answers = dict(answers or {})
        self.asked: list[str] = []

    async def __call__(self, url: str) -> str | None:
        self.asked.append(url)
        answer = self.answers.get(url)
        if isinstance(answer, FetchFailed):
            raise answer
        return answer


class NoProbing:
    """不该探任何地址的地方用它：一探就让用例失败。"""

    async def __call__(self, url: str) -> str | None:
        raise AssertionError(f"这里不该探地址：{url}")


def offline_media_checks(monkeypatch: pytest.MonkeyPatch) -> None:
    """把 ``agent_runtime.harness.media_check.public_client`` 换成不连网的替身。"""

    def build(**_: object) -> httpx.AsyncClient:
        # 检查每次建一个客户端、用完就关，所以每次给新的。
        return httpx.AsyncClient(
            transport=httpx.MockTransport(lambda _request: httpx.Response(200))
        )

    monkeypatch.setattr("agent_runtime.harness.media_check.public_client", build)


__all__ = ["NoProbing", "ScriptedProbe", "offline_media_checks"]
