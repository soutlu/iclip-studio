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
        monkeypatch.setattr("agent_runtime.harness.media_check.public_client", self._client)
        monkeypatch.setattr("agent_runtime.harness.media_check.RETRY_DELAY_SECONDS", 0.0)

    def _client(self, **_: object) -> httpx.AsyncClient:
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
