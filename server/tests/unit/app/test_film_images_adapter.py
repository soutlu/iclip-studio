"""验证工程文件的生图节点与生成域之间的适配：出图时标上节点名，按节点名找最近的结果，按地址认图。"""

from __future__ import annotations

import re
import uuid
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import pytest

from iclip.app.capability_table import build_capability_table
from iclip.app.film_images import FILM_NODE_KEY, FilmImagesAdapter
from iclip.capabilities.iclip_studio.capability import IclipStudio
from iclip.capabilities.iclip_studio.ports import InvalidNodeImageRequest, NodeImageRequest
from iclip.config import ResolvedIclipStudio
from iclip.domains.generation.models import (
    STATUS_COMPLETED,
    STATUS_FAILED,
    GenerationJob,
    GenerationStatus,
)
from iclip.domains.generation.schemas import KIND_IMAGE, OPERATION_UPLOAD
from iclip.domains.identity.models import Principal
from tests.helpers.file_store import FakeFileStore
from tests.helpers.generation import (
    FixedLineage,
    InMemoryGenerationRepository,
    MemoryObjectStore,
    film_image_service,
    image_request,
    make_job,
)
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
    status: GenerationStatus = STATUS_COMPLETED,
    conversation: uuid.UUID = CONVERSATION,
) -> GenerationJob:
    moment = START + timedelta(minutes=minutes)
    return make_job(
        image_request(),
        status=status,
        owner_user_id=OWNER,
        conversation_id=conversation,
        metadata=None if node is None else {FILM_NODE_KEY: node},
        output_url=url,
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


async def test_latest_is_the_newest_successful_image_of_each_node() -> None:
    repo = InMemoryGenerationRepository(
        [
            image_row("短发女生参考图", minutes=1, url="https://cdn.test/a.png"),
            image_row("短发女生参考图", minutes=2, url="https://cdn.test/b.png"),
            image_row("短发女生参考图", minutes=3, url=None, status=STATUS_FAILED),
            image_row("镜01机位图", minutes=4, url=None, status=STATUS_FAILED),
            image_row(
                "公园跑道参考图",
                minutes=5,
                url="https://cdn.test/elsewhere.png",
                conversation=OTHER_CONVERSATION,
            ),
        ]
    )
    adapter = FilmImagesAdapter(film_image_service(repo))

    found = await adapter.latest(
        PRINCIPAL, str(CONVERSATION), ["短发女生参考图", "镜01机位图", "公园跑道参考图"]
    )

    assert found == {"短发女生参考图": "https://cdn.test/b.png"}


async def test_an_edited_image_never_becomes_the_latest_however_many_there_are() -> None:
    generated = image_row("镜01机位图", minutes=0, url="https://cdn.test/generated.png")
    edits = [
        replace(
            image_row("镜01机位图", minutes=minute, url=f"https://cdn.test/edit-{minute}.png"),
            source_url="https://cdn.test/generated.png",
        )
        for minute in range(1, 26)
    ]
    adapter = FilmImagesAdapter(
        film_image_service(InMemoryGenerationRepository([generated, *edits]))
    )

    found = await adapter.latest(PRINCIPAL, str(CONVERSATION), ["镜01机位图"])

    assert found == {"镜01机位图": "https://cdn.test/generated.png"}


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
        output_url="https://cdn.test/upload.png",
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
        output_url="https://cdn.test/before-fork.png",
        created_at=START,
        finished_at=START + timedelta(minutes=1),
    )
    after = make_job(
        image_request(),
        status=STATUS_COMPLETED,
        owner_user_id=someone_else,
        conversation_id=CONVERSATION,
        metadata={FILM_NODE_KEY: "短发女生参考图"},
        output_url="https://cdn.test/after-fork.png",
        created_at=START + timedelta(minutes=20),
        finished_at=START + timedelta(minutes=21),
    )
    adapter = FilmImagesAdapter(
        film_image_service(
            InMemoryGenerationRepository([before, after]),
            FixedLineage({fork: ((CONVERSATION, forked_at),)}),
        )
    )

    assert await adapter.latest(PRINCIPAL, str(fork), ["短发女生参考图"]) == {
        "短发女生参考图": "https://cdn.test/before-fork.png"
    }
    assert await adapter.belongs(PRINCIPAL, str(fork), "https://cdn.test/before-fork.png")
    assert not await adapter.belongs(PRINCIPAL, str(fork), "https://cdn.test/after-fork.png")


async def test_a_conversation_id_that_is_not_a_uuid_is_a_broken_run() -> None:
    adapter = FilmImagesAdapter(film_image_service(InMemoryGenerationRepository()))

    with pytest.raises(RuntimeError, match="对话 id 不是 UUID"):
        await adapter.latest(PRINCIPAL, "thread-1", ["镜01机位图"])


def test_the_generate_tool_is_not_offered_to_the_agent() -> None:
    """生图现阶段由人自己做：要用的图片模型接上了也不登记生图工具，检查和导出照常装配。"""

    built = build_capability_table(
        workspace_store=FakeFileStore(),
        material_ledger=FakeMaterialLedger(),
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(500))),
        generation_service=film_image_service(InMemoryGenerationRepository()),
        object_store=MemoryObjectStore(),
        iclip_studio=ResolvedIclipStudio(
            breakdown_url="https://vision.test/responses",
            breakdown_api_key="ark",
            breakdown_model="seed-vision",
        ),
        image_models=frozenset({"nano_banana_pro", "gpt-image-2.5"}),
    )

    (capability,) = built["iclip_studio"]
    assert isinstance(capability, IclipStudio)
    tools = capability.get_toolset().tools
    assert "generate_images" not in tools
    assert {"check_film", "export_shots"} <= set(tools)
