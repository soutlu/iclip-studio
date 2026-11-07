from __future__ import annotations

from collections.abc import Mapping

import httpx
import pytest

from iclip.platform.outbound.guard import FetchFailed


class ScriptedProbe:
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
    async def __call__(self, url: str) -> str | None:
        raise AssertionError(f"这里不该探地址：{url}")


def offline_media_checks(monkeypatch: pytest.MonkeyPatch) -> None:
    def build(**_: object) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            transport=httpx.MockTransport(lambda _request: httpx.Response(200))
        )

    monkeypatch.setattr("cue.harness.media_check.public_client", build)


__all__ = ["NoProbing", "ScriptedProbe", "offline_media_checks"]
