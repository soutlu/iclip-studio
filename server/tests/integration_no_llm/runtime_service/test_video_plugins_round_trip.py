"""运行时服务挂上视频插件包、经 HTTP 调后端的内部接口跑一次真工具调用：运行时 → 内部接口 → 后端真实的
取帧拼板适配器（ffmpeg 抽帧、拼板、存进对象存储）→ 答回运行时，结果进 transcript。

后端这一侧只挂内部接口的路由与错误信封，接的是进程内同一个 ``FrameBoardsAdapter``；运行时的插件登记表
由 ``iclip_video.registry.open_video_plugins`` 按配置建，它的内部接口客户端经 ``ASGITransport`` 进程内连到
后端，不走网络。"""

from __future__ import annotations

import json
import subprocess
import uuid
from collections.abc import AsyncGenerator, AsyncIterator, Mapping
from pathlib import Path
from typing import Any, cast

import httpx
import pytest
from agent_runtime.http.app import create_app
from agent_runtime.settings import (
    AgentRunsSection,
    CompactionSection,
    ResolvedApp,
    RuntimeSettings,
)
from fastapi import FastAPI
from iclip_video.registry import open_video_plugins
from iclip_video.shot_video.extraction import EXTRACTION_PATH
from iclip_video.shot_video.generation import IMAGE_MODEL
from iclip_video.video_document import video_doc_path
from pydantic_ai.messages import ModelMessage
from pydantic_ai.models import Model
from pydantic_ai.models.function import AgentInfo, DeltaToolCall, DeltaToolCalls, FunctionModel
from sqlalchemy.ext.asyncio import AsyncEngine

from iclip.app.errors import install_error_handlers
from iclip.app.runtime_internal import (
    RuntimePluginServices,
    TurnNaming,
    create_runtime_internal_router,
)
from iclip.app.shot_media import FrameBoardsAdapter
from iclip.domains.conversations.service import ConversationService
from iclip.platform.media.codec import SOFTWARE
from iclip.platform.media.process import ffmpeg_available
from tests.helpers.agents import model_builder
from tests.helpers.app import TEST_CREDENTIAL_KEY, TEST_MODEL_NAME
from tests.helpers.fetch_url import as_is
from tests.helpers.identity import FakePrincipals
from tests.helpers.model_providers import GOOD_KEY, KeyCheckingProbe
from tests.helpers.runtime_service import (
    ADMIN_KEY,
    READER_KEY,
    add_model,
    connect_provider,
    publish_agent,
    settled,
)
from tests.helpers.shot_video import FakeObjects

pytestmark = pytest.mark.skipif(not ffmpeg_available(), reason="本机 PATH 上没有 ffmpeg/ffprobe")

TOKEN = "runtime-internal-test-token-0123456789"
VIDEO_URL = "https://cdn.test/clip.mp4"
AGENT = "director"
DOCUMENT = (
    "| 结构层级 | Storyline |\n"
    "| :--- | :--- |\n"
    "| Rain-Step Hook | **[00:00.000-00:01.500]** 中景……<br><br>"
    "**[00:01.500-00:03.000]** 特写…… |\n"
)
PLUGINS_CONFIG: dict[str, Any] = {
    "internal_api": {"base_url": "http://iclip.test", "token_env": "RUNTIME_INTERNAL_TOKEN"},
    "video": {
        "understanding_url": "https://ark.test/responses",
        "api_key_env": "VIDEO_UNDERSTANDING_API_KEY",
        "model": "seed-vision",
    },
    "shot_video": {},
}


def make_clip_mp4(path: Path) -> bytes:
    """三秒动态图样视频，抽帧拼板用。"""

    result = subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "testsrc=size=320x240:rate=10:duration=3",
            "-pix_fmt",
            "yuv420p",
            str(path),
        ],
        capture_output=True,
    )
    assert result.returncode == 0, result.stderr.decode(errors="replace")
    return path.read_bytes()


def plans_frames() -> FunctionModel:
    """第一次请求对参考视频调 ``plan_shot_frames``，拿到结果后收尾。"""

    async def stream(
        messages: list[ModelMessage], _info: AgentInfo
    ) -> AsyncIterator[str | DeltaToolCalls]:
        if len(messages) == 1:
            yield {
                0: DeltaToolCall(
                    name="plan_shot_frames",
                    json_args=json.dumps({"video_url": VIDEO_URL}),
                    tool_call_id="call_plan",
                )
            }
        else:
            yield "取帧好了"

    return FunctionModel(stream_function=stream)


@pytest.fixture
def models() -> Mapping[str, Model]:
    return {TEST_MODEL_NAME: plans_frames()}


@pytest.fixture
def objects() -> FakeObjects:
    """后端的对象存储替身，预览板存在这里。"""

    return FakeObjects()


def backend_app(boards: FrameBoardsAdapter) -> FastAPI:
    """后端的内部接口：真实的取帧拼板适配器与接入的图片模型，回调用不到对话服务。"""

    app = FastAPI()
    install_error_handlers(app)
    conversations = cast("ConversationService", object())
    app.include_router(
        create_runtime_internal_router(
            token=TOKEN,
            user_principal=FakePrincipals(),
            conversations=conversations,
            naming=TurnNaming(conversations),
            plugins=RuntimePluginServices(
                generations=None,
                boards=boards,
                cuts=None,
                breakdowns=None,
                image_models=frozenset({IMAGE_MODEL}),
            ),
        )
    )
    return app


@pytest.fixture
async def runtime_app(
    engine: AsyncEngine,
    migrated_pg: str,
    tmp_path: Path,
    models: Mapping[str, Model],
    objects: FakeObjects,
    monkeypatch: pytest.MonkeyPatch,
) -> AsyncGenerator[FastAPI]:
    """覆写夹具里的运行时服务：插件登记表由视频插件包按配置建，内部接口进程内连到后端。"""

    monkeypatch.setenv("RUNTIME_INTERNAL_TOKEN", TOKEN)
    monkeypatch.setenv("VIDEO_UNDERSTANDING_API_KEY", "ark-test-key")
    clip = make_clip_mp4(tmp_path / "clip.mp4")

    def outside(request: httpx.Request) -> httpx.Response:
        if str(request.url) == VIDEO_URL:
            return httpx.Response(200, content=clip)
        return httpx.Response(404)

    settings = RuntimeSettings(
        database_url=migrated_pg,
        credential_encryption_keys=(TEST_CREDENTIAL_KEY,),
        apps=(
            ResolvedApp(id="bff", key=ADMIN_KEY, admin=True),
            ResolvedApp(id="reader", key=READER_KEY, admin=False),
        ),
        agent_runs=AgentRunsSection(skill_cache_dir=tmp_path / "skills"),
        compaction=CompactionSection(),
        log_level="WARNING",
        log_format="console",
    )
    async with httpx.AsyncClient(transport=httpx.MockTransport(outside)) as fetcher:
        backend = backend_app(
            FrameBoardsAdapter(fetcher, fetch_url=as_is, objects=objects, codec=SOFTWARE)
        )
        async with open_video_plugins(
            PLUGINS_CONFIG, internal_transport=httpx.ASGITransport(app=backend)
        ) as bind:
            yield create_app(
                settings,
                plugins=bind,
                credential_probe=KeyCheckingProbe({GOOD_KEY}),
                engine=engine,
                build_model=model_builder(models),
            )


def tool_frames(node: object, name: str) -> list[dict[str, Any]]:
    """transcript 里叫 ``name`` 的工具帧。"""

    if isinstance(node, dict):
        found: list[dict[str, Any]] = []
        mapping = cast("dict[str, Any]", node)
        if mapping.get("kind") == "tool" and mapping.get("name") == name:
            found.append(mapping)
        for value in mapping.values():
            found.extend(tool_frames(value, name))
        return found
    if isinstance(node, list):
        return [frame for item in cast("list[object]", node) for frame in tool_frames(item, name)]
    return []


async def test_a_tool_call_goes_through_the_backend_and_its_result_reaches_the_transcript(
    running: None,
    admin: httpx.AsyncClient,
    app_client: httpx.AsyncClient,
    objects: FakeObjects,
) -> None:
    provider_id = await connect_provider(admin)
    await add_model(admin, provider_id, TEST_MODEL_NAME)
    await publish_agent(admin, AGENT, plugins=("workspace", "video", "shot_video"))
    session = str(uuid.uuid4())
    opened = await app_client.post("/sessions", json={"id": session, "agent_id": AGENT})
    assert opened.status_code == 204, opened.text
    written = await app_client.put(
        f"/sessions/{session}/files/{video_doc_path(VIDEO_URL)}", json={"content": DOCUMENT}
    )
    assert written.status_code == 200, written.text

    sent = await app_client.post(
        f"/sessions/{session}/prompts",
        json={
            "prompt_id": "prm_plan",
            "content": [
                {"type": "text", "text": "按这条视频取帧"},
                {"type": "video", "source": {"kind": "url", "url": VIDEO_URL}},
            ],
            "user_name": "logan",
            "agent_id": AGENT,
        },
    )
    assert sent.status_code == 200, sent.text
    await settled(app_client, session)

    status = await app_client.get(f"/sessions/{session}/status")
    assert status.json() == {"status": "completed"}
    page = await app_client.get(f"/sessions/{session}/transcript", params={"session_agent": AGENT})
    assert page.status_code == 200, page.text
    (frame,) = tool_frames(page.json(), "plan_shot_frames")
    assert frame["state"] == "done", frame

    # 预览板是后端的适配器经 ffmpeg 拼出来、存进后端对象存储的那几块。
    (board_key,) = objects.written
    board_url = objects.public_url(board_key)
    assert frame["output"]["boards"] == [{"board": 1, "shots": [1, 2], "url": board_url}]
    ledger = await app_client.get(f"/sessions/{session}/files/{EXTRACTION_PATH}")
    assert ledger.status_code == 200, ledger.text
    assert json.loads(ledger.json()["content"])["boards"] == [{"board": 1, "url": board_url}]
