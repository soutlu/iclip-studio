"""验证工程文件的生图节点与生成域之间的适配：出图时标上节点名，按地址认图。"""

from __future__ import annotations

import re
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any, cast

import httpx
import pytest
from agent_runtime.errors import NotFound
from iclip_video.iclip_studio.capability import IclipStudio
from iclip_video.iclip_studio.ports import InvalidNodeImageRequest, NodeImageRequest

from iclip.app.film_images import FILM_NODE_KEY, FilmImagesAdapter, RunFilmImagesAdapter
from iclip.app.plugin_registry import build_plugin_registry
from iclip.domains.generation.models import STATUS_COMPLETED, GenerationJob, GenerationOutput
from iclip.domains.generation.schemas import KIND_IMAGE, OPERATION_UPLOAD, ImageGenerationIn
from iclip.domains.generation.service import GenerationService
from iclip.domains.identity.models import Principal
from tests.helpers.fetch_url import as_is
from tests.helpers.file_store import FakeFileStore
from tests.helpers.generation import (
    FixedLineage,
    InMemoryGenerationRepository,
    MemoryObjectStore,
    film_image_service,
    image_request,
    make_job,
)
from tests.helpers.identity import FakePrincipals
from tests.helpers.material_ledger import FakeMaterialLedger

OWNER = uuid.UUID("77777777-7777-7777-7777-777777777777")
PRINCIPAL = Principal(
    kind="user",
    user_id=OWNER,
    permissions=frozenset({"generation:submit"}),
    audit_label="tester",
    username="tester",
)
CONVERSATION = uuid.uuid4()
OTHER_CONVERSATION = uuid.uuid4()
START = datetime(2026, 10, 6, 12, 0, tzinfo=UTC)


def node_request(**overrides: Any) -> NodeImageRequest:
    fields: dict[str, Any] = {
        "node": "镜01机位图",
        "prompt": "低机位，脚部特写。",
        "model": "gpt-image-2.5",
        "aspect_ratio": "9:16",
        "resolution": "2k",
        "reference_image_urls": ("https://cdn.test/person.png",),
        "user_name": "designer-zhang",
        "conversation_id": str(CONVERSATION),
    }
    fields.update(overrides)
    return NodeImageRequest(**fields)


def image_row(
    node: str | None,
    *,
    minutes: int,
    url: str | None,
    conversation: uuid.UUID = CONVERSATION,
) -> GenerationJob:
    moment = START + timedelta(minutes=minutes)
    return make_job(
        image_request(),
        status=STATUS_COMPLETED,
        owner_user_id=OWNER,
        conversation_id=conversation,
        metadata=None if node is None else {FILM_NODE_KEY: node},
        output=GenerationOutput(url=url),
        created_at=moment,
        finished_at=moment,
    )


async def test_an_image_is_filed_under_its_node_and_conversation() -> None:
    repo = InMemoryGenerationRepository()
    adapter = FilmImagesAdapter(film_image_service(repo))

    job = await adapter.submit(PRINCIPAL, node_request())

    (row,) = repo.jobs.values()
    assert (job.job_id, job.status) == (row.id, "pending")
    assert (row.kind, row.provider) == (KIND_IMAGE, "gpt-image-2.5")
    assert row.metadata == {FILM_NODE_KEY: "镜01机位图"}
    assert row.conversation_id == CONVERSATION
    assert (await adapter.get(PRINCIPAL, job.job_id)).status == "pending"


async def test_a_request_the_model_cannot_serve_is_refused_before_anything_is_queued() -> None:
    repo = InMemoryGenerationRepository()
    adapter = FilmImagesAdapter(film_image_service(repo))

    with pytest.raises(InvalidNodeImageRequest, match=re.escape("gpt-image-2.5 不支持分辨率 1k")):
        await adapter.submit(PRINCIPAL, node_request(resolution="1k"))
    with pytest.raises(InvalidNodeImageRequest, match="aspect_ratio"):
        await adapter.submit(PRINCIPAL, node_request(aspect_ratio="17:9"))

    assert repo.jobs == {}


async def test_an_address_belongs_when_the_conversation_has_a_finished_image_at_it() -> None:
    edited = image_row(None, minutes=1, url="https://cdn.test/edited.png")
    elsewhere = image_row(
        None, minutes=2, url="https://cdn.test/elsewhere.png", conversation=OTHER_CONVERSATION
    )
    uploaded = make_job(
        kind=KIND_IMAGE,
        operation=OPERATION_UPLOAD,
        status=STATUS_COMPLETED,
        owner_user_id=OWNER,
        output=GenerationOutput(url="https://cdn.test/upload.png"),
    )
    adapter = FilmImagesAdapter(
        film_image_service(InMemoryGenerationRepository([edited, elsewhere, uploaded]))
    )

    async def belongs(url: str) -> bool:
        return await adapter.belongs(PRINCIPAL, str(CONVERSATION), url)

    assert await belongs("https://cdn.test/edited.png")
    assert not await belongs("https://cdn.test/elsewhere.png")
    assert not await belongs("https://cdn.test/upload.png"), "上传不属于任何对话，由素材台账认"
    assert not await belongs("https://cdn.test/never.png")


async def test_a_fork_keeps_the_images_its_source_had_at_the_fork() -> None:
    """分叉出来的对话带着工程文件，也按血缘继承源对话分叉前生成的图。"""

    fork = uuid.uuid4()
    forked_at = START + timedelta(minutes=10)
    someone_else = uuid.uuid4()
    before = make_job(
        image_request(),
        status=STATUS_COMPLETED,
        owner_user_id=someone_else,
        conversation_id=CONVERSATION,
        metadata={FILM_NODE_KEY: "短发女生参考图"},
        output=GenerationOutput(url="https://cdn.test/before-fork.png"),
        created_at=START,
        finished_at=START + timedelta(minutes=1),
    )
    after = make_job(
        image_request(),
        status=STATUS_COMPLETED,
        owner_user_id=someone_else,
        conversation_id=CONVERSATION,
        metadata={FILM_NODE_KEY: "短发女生参考图"},
        output=GenerationOutput(url="https://cdn.test/after-fork.png"),
        created_at=START + timedelta(minutes=20),
        finished_at=START + timedelta(minutes=21),
    )
    adapter = FilmImagesAdapter(
        film_image_service(
            InMemoryGenerationRepository([before, after]),
            FixedLineage({fork: ((CONVERSATION, forked_at),)}),
        )
    )

    assert await adapter.belongs(PRINCIPAL, str(fork), "https://cdn.test/before-fork.png")
    assert not await adapter.belongs(PRINCIPAL, str(fork), "https://cdn.test/after-fork.png")


class _RecordingImages:
    """生成域的替身：记下每次收到的主体，查询按受理时的那一行答。"""

    def __init__(self) -> None:
        self.principals: list[Principal] = []
        self._jobs: dict[uuid.UUID, GenerationJob] = {}

    async def submit_image(self, principal: Principal, request: ImageGenerationIn) -> GenerationJob:
        self.principals.append(principal)
        job = make_job(request)
        self._jobs[job.id] = job
        return job

    async def get(self, principal: Principal, job_id: uuid.UUID) -> GenerationJob:
        self.principals.append(principal)
        return self._jobs[job_id]


def run_images(principals: FakePrincipals) -> tuple[RunFilmImagesAdapter, _RecordingImages]:
    service = _RecordingImages()
    images = FilmImagesAdapter(cast("GenerationService", service))
    return RunFilmImagesAdapter(images, principals), service


async def test_the_director_tool_rebuilds_the_owner_principal_on_every_call() -> None:
    """AI 导演的工具只给属主 id：每次调用都按它重建一次主体，生成域收到的就是重建出的那一个。"""

    principals = FakePrincipals(PRINCIPAL)
    adapter, service = run_images(principals)

    job = await adapter.submit(OWNER, node_request())
    await adapter.get(OWNER, job.job_id)

    assert principals.asked == [OWNER, OWNER]
    assert service.principals == [PRINCIPAL, PRINCIPAL]


async def test_the_director_tool_lets_a_resolver_failure_through() -> None:
    """属主账号不在了：重建主体的错误原样抛出，生成域一次都不调。"""

    adapter, service = run_images(FakePrincipals())

    with pytest.raises(NotFound, match="用户不存在"):
        await adapter.submit(OWNER, node_request())
    with pytest.raises(NotFound, match="用户不存在"):
        await adapter.get(OWNER, uuid.uuid4())
    assert service.principals == []


async def test_a_conversation_id_that_is_not_a_uuid_is_a_broken_run() -> None:
    adapter = FilmImagesAdapter(film_image_service(InMemoryGenerationRepository()))

    with pytest.raises(RuntimeError, match="对话 id 不是 UUID"):
        await adapter.belongs(PRINCIPAL, "thread-1", "https://cdn.test/a.png")


def test_the_generate_tool_is_not_offered_to_the_agent() -> None:
    """生图现阶段由人自己做：要用的图片模型接上了也不登记生图工具，检查照常装配。"""

    built = build_plugin_registry(
        workspace_store=FakeFileStore(),
        material_ledger=FakeMaterialLedger(),
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(500))),
        fetch_url=as_is,
        resolve_principal=FakePrincipals(),
        generation_service=film_image_service(InMemoryGenerationRepository()),
        object_store=MemoryObjectStore(),
        image_models=frozenset({"nano_banana_pro", "gpt-image-2.5"}),
    )

    capability = built["iclip_studio"].from_spec()
    assert isinstance(capability, IclipStudio)
    tools = capability.get_toolset().tools
    assert "generate_images" not in tools
    assert "check_film" in tools
