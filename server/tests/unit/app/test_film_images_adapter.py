from __future__ import annotations

import re
import uuid
from typing import Any

import pytest
from iclip_video.iclip_studio.ports import InvalidNodeImageRequest, NodeImageRequest

from iclip.app.film_images import FILM_NODE_KEY, FilmImagesAdapter
from iclip.domains.generation.schemas import KIND_IMAGE
from iclip.domains.identity.models import Principal
from tests.helpers.generation import InMemoryGenerationRepository, film_image_service

OWNER = uuid.UUID("77777777-7777-7777-7777-777777777777")
PRINCIPAL = Principal(
    kind="user",
    user_id=OWNER,
    permissions=frozenset({"generation:submit"}),
    audit_label="tester",
    username="tester",
)
CONVERSATION = uuid.uuid4()


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
