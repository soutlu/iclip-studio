"""验证方舟视频拆解适配器的请求形状（写定的模型、思考档位与帧率，每次现查的连接）、模型没启用、响应校验与
拆解文档路径。"""

from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any

import httpx
import pytest
from agent_runtime.model_connections import ModelConnection

from iclip_video.video_document import video_doc_path
from iclip_video.video_understanding import (
    DECLARATION,
    MODEL,
    SYSTEM_PROMPT,
    ArkVideoUnderstanding,
    VideoUnderstandingError,
    VideoUnderstandingUnavailable,
)
from tests.helpers.model_connections import FakeModelConnections

VIDEO = "https://cdn.test/ref.mp4"


def test_document_path_survives_two_videos_of_the_same_name() -> None:

    assert video_doc_path("https://a.test/ref.mp4") != video_doc_path("https://b.test/ref.mp4")


RELAY = ModelConnection(
    responses_url="https://relay.example/api/v3/responses", api_key="sk-test-ark"
)


def ark(
    handler: Callable[[httpx.Request], httpx.Response],
    connections: FakeModelConnections | None = None,
) -> ArkVideoUnderstanding:
    return ArkVideoUnderstanding(
        httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        connection=connections or FakeModelConnections({(DECLARATION, MODEL): RELAY}),
    )


def responses_body(status: str = "completed", text: str = "## 4、逐镜拉片表\n……") -> dict[str, Any]:
    """包含 reasoning 和 message 的成功响应。"""

    return {
        "status": status,
        "output": [
            {"type": "reasoning", "content": []},
            {"type": "message", "content": [{"type": "output_text", "text": text}]},
        ],
    }


async def test_parser_takes_the_output_text_and_skips_reasoning() -> None:
    understanding = ark(lambda _: httpx.Response(200, json=responses_body()))
    assert await understanding.parse(VIDEO) == "## 4、逐镜拉片表\n……"


@pytest.mark.parametrize("status", ["incomplete", "in_progress", "failed"])
async def test_parser_refuses_a_response_that_did_not_finish(status: str) -> None:
    """输出被截断时接口仍可能返回 200，需校验完成状态以避免交付残缺镜头表。"""

    understanding = ark(lambda _: httpx.Response(200, json=responses_body(status=status)))
    with pytest.raises(VideoUnderstandingError, match=status):
        await understanding.parse(VIDEO)


async def test_parser_refuses_an_empty_document() -> None:
    understanding = ark(lambda _: httpx.Response(200, json={"status": "completed", "output": []}))
    with pytest.raises(VideoUnderstandingError, match="没给出正文"):
        await understanding.parse(VIDEO)


async def test_parser_reports_the_upstream_error_body() -> None:
    understanding = ark(
        lambda _: httpx.Response(400, json={"error": {"message": "video_url 取不到"}})
    )
    with pytest.raises(VideoUnderstandingError, match="400"):
        await understanding.parse(VIDEO)


async def test_parser_refuses_a_non_json_body() -> None:
    understanding = ark(lambda _: httpx.Response(200, text="<html>502</html>"))
    with pytest.raises(VideoUnderstandingError, match="不是 JSON"):
        await understanding.parse(VIDEO)


async def test_parser_sends_the_written_model_thinking_and_fps_to_the_resolved_connection() -> None:
    sent: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        sent.append(request)
        return httpx.Response(200, json=responses_body())

    connections = FakeModelConnections({(DECLARATION, MODEL): RELAY})
    await ark(handler, connections).parse(VIDEO)

    assert connections.asked == [("volcengine", "doubao-seed-2-0-lite-260428")]
    (request,) = sent
    assert str(request.url) == RELAY.responses_url
    assert request.headers["Authorization"] == "Bearer sk-test-ark"
    body = json.loads(request.content)
    assert body["model"] == "doubao-seed-2-0-lite-260428"
    assert body["reasoning"] == {"effort": "medium"}
    assert [message["role"] for message in body["input"]] == ["system", "user"]
    assert body["input"][0]["content"][0]["text"] == SYSTEM_PROMPT
    assert body["input"][1]["content"][0] == {"type": "input_video", "video_url": VIDEO, "fps": 5}


async def test_the_connection_is_looked_up_on_every_call() -> None:
    """配置页里改了连接，下一次拆解就用新的；不在启动时记下一份。"""

    urls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        urls.append(str(request.url))
        return httpx.Response(200, json=responses_body())

    connections = FakeModelConnections({(DECLARATION, MODEL): RELAY})
    understanding = ark(handler, connections)
    await understanding.parse(VIDEO)
    moved = ModelConnection(responses_url="https://relay2.example/responses", api_key="sk-test-2")
    connections.connections[(DECLARATION, MODEL)] = moved
    await understanding.parse(VIDEO)

    assert urls == [RELAY.responses_url, moved.responses_url]


async def test_an_unavailable_model_is_its_own_failure_and_nothing_is_sent() -> None:
    sent: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        sent.append(request)
        return httpx.Response(200, json=responses_body())

    with pytest.raises(VideoUnderstandingUnavailable, match=MODEL):
        await ark(handler, FakeModelConnections()).parse(VIDEO)
    assert sent == []
