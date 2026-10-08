"""验证组合根的依赖完整性和路由挂载条件。"""

from __future__ import annotations

import uuid
from pathlib import Path
from typing import Literal

import httpx
import pytest
from pydantic_ai.models.test import TestModel
from sqlalchemy.ext.asyncio import create_async_engine
from structlog.testing import capture_logs
from structlog.typing import EventDict

from iclip.app.agent_layer import CurrentAgentLayer
from iclip.app.bootstrap import AnnouncingFileStore, build_app
from iclip.config import (
    AppSection,
    DbSection,
    ImageGenerationSection,
    ImageModelSection,
    MediaGenerationSection,
    OpsSection,
    RuntimeConfig,
    SecuritySection,
    SsoSection,
    VideoGenerationSection,
    VideoSection,
)
from iclip.config.models import IclipStudioSection
from iclip.domains.agents.transcript_api import LiveConnections
from iclip.platform.media.codec import SOFTWARE, VIDEOTOOLBOX, MediaCodec
from tests.helpers.agents import declared_agent
from tests.helpers.file_store import FakeFileStore
from tests.helpers.generation import MemoryObjectStore


def minimal_config() -> RuntimeConfig:
    return RuntimeConfig(
        app=AppSection(name="t"),
        db=DbSection(schema="iclip"),
        security=SecuritySection(),
        sso=SsoSection(app_name="iclip"),
        ops=OpsSection(log_level="WARNING"),
    )


@pytest.fixture
def base_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DATABASE_URL", "postgresql+asyncpg://iclip:iclip@localhost:5432/nowhere")
    monkeypatch.setenv("AUTH_SECRET", "s" * 32)
    monkeypatch.delenv("SSO_BASE_URL", raising=False)
    monkeypatch.setenv("OSS_BUCKET", "iclip")
    monkeypatch.setenv("OSS_ENDPOINT", "https://oss.test")
    monkeypatch.setenv("OSS_ACCESS_KEY_ID", "ak")
    monkeypatch.setenv("OSS_ACCESS_KEY_SECRET", "sk")
    monkeypatch.setenv("OSS_PUBLIC_URL_BASE", "https://cdn.test")
    for name in (*MEDIA_ENVS, *STUDIO_ENVS):
        monkeypatch.delenv(name, raising=False)


def engine():
    """仅构造 engine，不连接数据库；测试只覆盖装配。"""

    return create_async_engine("postgresql+asyncpg://iclip:iclip@localhost:5432/nowhere")


async def test_transcript_endpoints_are_always_mounted(base_env: None) -> None:

    app = build_app(minimal_config(), engine=engine(), models={})
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post(
            "/conversations/00000000-0000-0000-0000-000000000000/prompts",
            json={"prompt_id": "prm_1", "content": [{"type": "text", "text": "走"}]},
        )

    assert response.status_code == 401


MEDIA_ENVS = {
    "VIDEO_SUBMIT_URL": "https://video.test/generate",
    "VIDEO_STATUS_BASE_URL": "https://video.test/tasks",
    "VIDEO_API_KEY": "vk",
    "IMAGE_API_BASE": "https://image.test/gateway",
}


def config_with_media() -> RuntimeConfig:
    return minimal_config().model_copy(
        update={
            "media_generation": MediaGenerationSection(
                video=VideoGenerationSection(model="seedance", allowed_models=("seedance",)),
                image=ImageGenerationSection(
                    env="test",
                    text_to_image_task="text-to-image",
                    image_edit_task="image-edit",
                    default="nano_banana_pro",
                    models={
                        "nano_banana_pro": ImageModelSection(route="nano-banana-pro", concurrency=4)
                    },
                ),
            ),
        }
    )


async def test_without_media_generation_the_routes_are_absent(base_env: None) -> None:

    app = build_app(minimal_config(), engine=engine(), models={})
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        assert (await client.post("/generations", json={})).status_code == 404


def test_media_generation_without_ffmpeg_fails_at_startup(
    base_env: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    """视频裁剪拼接跟着媒体生成一起装，缺 ffmpeg 要在启动时就报，不留到队列里才发现。"""

    for name, value in MEDIA_ENVS.items():
        monkeypatch.setenv(name, value)
    monkeypatch.setattr("iclip.app.bootstrap.ffmpeg_available", lambda: False)

    with pytest.raises(RuntimeError, match="ffmpeg"):
        build_app(config_with_media(), engine=engine(), models={}, object_store=MemoryObjectStore())


STUDIO_ENVS = {
    "VIDEO_UNDERSTANDING_URL": "https://vision.test/responses",
    "VIDEO_UNDERSTANDING_API_KEY": "test-key",
}


def _keep_logging(_level: str, _fmt: str) -> None:
    """替换 ``configure_logging``：不动 structlog 的配置，``capture_logs`` 才截得到。"""


@pytest.fixture
def local_media_env(base_env: None, monkeypatch: pytest.MonkeyPatch) -> None:
    """开媒体生成与拆解两条本地加工队列的环境。

    unit 门禁的机器不一定装 ffmpeg，这里只看装配。``configure_logging`` 会整个换掉 structlog
    的配置，要先让它不动，才截得到启动日志。"""

    for name, value in {**MEDIA_ENVS, **STUDIO_ENVS}.items():
        monkeypatch.setenv(name, value)
    monkeypatch.setattr("iclip.app.bootstrap.ffmpeg_available", lambda: True)
    monkeypatch.setattr("iclip.app.bootstrap.configure_logging", _keep_logging)


def build_local_media(
    *,
    compose: int | None = None,
    breakdown: int | None = None,
    media_codec: MediaCodec | None = None,
) -> list[EventDict]:
    """装配一次，交回「编解码已选定」那几条日志。"""

    config = config_with_media()
    assert config.media_generation is not None
    config = config.model_copy(
        update={
            "media_generation": config.media_generation.model_copy(
                update={"compose_concurrency": compose}
            ),
            "iclip_studio": IclipStudioSection(
                breakdown_model="seed", breakdown_concurrency=breakdown
            ),
        }
    )
    with capture_logs() as logs:
        build_app(
            config,
            engine=engine(),
            models={},
            object_store=MemoryObjectStore(),
            media_codec=media_codec,
        )
    return [log for log in logs if log["event"] == "本地视频编解码已选定"]


@pytest.mark.parametrize(
    ("codec", "compose", "breakdown", "expected"),
    [
        pytest.param(VIDEOTOOLBOX, None, None, (4, 4), id="hardware-unwritten"),
        pytest.param(SOFTWARE, None, None, (2, 2), id="software-unwritten"),
        pytest.param(VIDEOTOOLBOX, 1, 3, (1, 3), id="written-wins"),
    ],
)
def test_local_queues_take_the_written_concurrency_or_the_codec_default(
    local_media_env: None,
    codec: MediaCodec,
    compose: int | None,
    breakdown: int | None,
    expected: tuple[int, int],
) -> None:
    chosen = build_local_media(compose=compose, breakdown=breakdown, media_codec=codec)

    assert [
        (log["codec"], log["hardware"], log["compose_concurrency"], log["breakdown_concurrency"])
        for log in chosen
    ] == [(codec.name, codec.hardware, *expected)]


def test_without_an_injected_codec_the_startup_probe_chooses(
    local_media_env: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    probes: list[None] = []

    def probe() -> MediaCodec:
        probes.append(None)
        return VIDEOTOOLBOX

    monkeypatch.setattr("iclip.app.bootstrap.detect_codec", probe)

    chosen = build_local_media()

    assert len(probes) == 1
    assert [(log["codec"], log["compose_concurrency"]) for log in chosen] == [("videotoolbox", 4)]


def test_nothing_is_probed_when_no_feature_needs_ffmpeg(
    base_env: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    def probe() -> MediaCodec:
        raise AssertionError("不用 ffmpeg 的部署不该跑编解码探测")

    monkeypatch.setattr("iclip.app.bootstrap.detect_codec", probe)

    build_app(minimal_config(), engine=engine(), models={})


class _RecordingConnections(LiveConnections):
    """记录文件变更帧，不创建 WS 连接。"""

    def __init__(self) -> None:
        super().__init__()
        self.announced: list[tuple[uuid.UUID, uuid.UUID, str, str]] = []

    def announce_fs_changed(
        self,
        owner: uuid.UUID,
        conversation_id: uuid.UUID,
        *,
        path: str,
        change: Literal["created", "modified", "deleted"] = "modified",
    ) -> None:
        self.announced.append((owner, conversation_id, path, change))


async def test_tool_writes_announce_created_then_modified_then_deleted() -> None:

    live = _RecordingConnections()
    owner, conversation_id = uuid.uuid4(), uuid.uuid4()
    store = AnnouncingFileStore(FakeFileStore(), live)

    await store.write(f"{owner}/{conversation_id}", "video_shot.json", "{}")
    await store.write(f"{owner}/{conversation_id}", "video_shot.json", "{ }")
    await store.delete(f"{owner}/{conversation_id}", "video_shot.json")

    assert live.announced == [
        (owner, conversation_id, "video_shot.json", "created"),
        (owner, conversation_id, "video_shot.json", "modified"),
        (owner, conversation_id, "video_shot.json", "deleted"),
    ]


async def test_a_namespace_without_a_conversation_id_announces_nothing() -> None:
    """无法解析对话 id 的命名空间不发送会话事件，但写入仍须成功。"""

    live = _RecordingConnections()
    store = AnnouncingFileStore(FakeFileStore(), live)

    written = await store.write("logan/thread-1", "提纲.md", "三幕")

    assert written.version == 1, "文件照样写下去了"
    assert live.announced == []


def test_video_agent_builds_without_generation_oss_or_ffmpeg(
    base_env: None, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("OSS_BUCKET", "")
    monkeypatch.setenv("VIDEO_SUBMIT_URL", "")
    monkeypatch.setenv("VIDEO_UNDERSTANDING_URL", "https://vision.test/responses")
    monkeypatch.setenv("VIDEO_UNDERSTANDING_API_KEY", "test-key")
    monkeypatch.setattr("iclip.app.bootstrap.ffmpeg_available", lambda: False)
    config = minimal_config().model_copy(
        update={"video": VideoSection(understanding_model="vision")}
    )
    declaration = declared_agent(
        tmp_path, "video-only", model="m", capabilities=("workspace", "video")
    )
    app = build_app(config, agents=(declaration,), engine=engine(), models={"m": TestModel()})
    layer: CurrentAgentLayer = app.state.agent_layer
    assert layer.current.registry.ids == ("video-only",)
