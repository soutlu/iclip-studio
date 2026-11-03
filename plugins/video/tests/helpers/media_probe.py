"""提交点探地址的替身：顶替检查每次自己建的 ``public_client``，按地址答预设的状态与类型，或抛预设的
连接错误，不连网；记下探过哪些。

出网防护本身由运行时包的行为测试覆盖；这里只看插件按位置报出打不开与类型不对的地址。没预设的地址答
200、不给类型（按扩展名认）；预设的答案每次探都一样，所以检查的再探一次也是同样结果。测试树的 ``media``
夹具对每个用例都装上一份。
"""

from __future__ import annotations

from collections.abc import Mapping

import httpx
import pytest

Answer = tuple[int, str | None] | httpx.HTTPError


class ScriptedMedia:
    def __init__(self, answers: Mapping[str, Answer] | None = None) -> None:
        self.answers = {str(httpx.URL(url)): answer for url, answer in (answers or {}).items()}
        self.asked: list[str] = []

    def set(self, url: str, answer: Answer) -> None:
        self.answers[str(httpx.URL(url))] = answer

    def install(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """把检查用的 ``agent_runtime.harness.media_check.public_client`` 换成这份替身；探不通后不等，
        直接再探一次。"""

        monkeypatch.setattr("agent_runtime.harness.media_check.public_client", self._client)
        monkeypatch.setattr("agent_runtime.harness.media_check.RETRY_DELAY_SECONDS", 0.0)

    def _client(self, **_: object) -> httpx.AsyncClient:
        # 检查每次建一个客户端、用完就关，所以每次给新的；答案与记录留在这个对象上。
        return httpx.AsyncClient(transport=httpx.MockTransport(self._answer))

    def _answer(self, request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        self.asked.append(url)
        answer = self.answers.get(url, (200, None))
        if isinstance(answer, httpx.HTTPError):
            raise answer
        status, media_type = answer
        headers = {} if media_type is None else {"Content-Type": media_type}
        return httpx.Response(status, headers=headers)


__all__ = ["Answer", "ScriptedMedia"]
